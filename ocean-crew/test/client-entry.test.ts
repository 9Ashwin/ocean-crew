// The client entry's assembly: the inject list, what `apply` registers in its first moments
// (effects in order, the shell and conversation slot groups, the first roster pull) and that
// disposing the fiber takes everything back down. The h() components stay unrendered; the

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const pluginRoot = resolve(import.meta.dirname, "..");
const repoRoot = dirname(pluginRoot);
const harnessRoot = process.env.DSH_HARNESS ?? join(repoRoot, "dev", "harness");
const requireHarness = createRequire(join(harnessRoot, "package.json"));
const requireRoot = createRequire(join(repoRoot, "package.json"));
const { buildSync } = requireRoot("esbuild") as any;
const { JSDOM } = requireHarness("jsdom") as any;

// The runtime modules the browser window seeds for a plugin; the entry imports them but the
// assembly under test renders nothing, so the stand-ins only need the names.
class ReactComponent {
	props: any;
	state: any = {};
	constructor(props: any) {
		this.props = props;
	}
	setState(next: any) {
		this.state = { ...this.state, ...(typeof next === "function" ? next(this.state, this.props) : next) };
	}
	forceUpdate() {}
	render() {
		return null;
	}
}

const reactStandIn = {
	Component: ReactComponent,
	createElement: () => null,
	Fragment: Symbol("Fragment"),
	createContext: () => ({ Provider: () => null }),
	useCallback: (fn: any) => fn,
	useContext: () => undefined,
	useEffect: () => {},
	useId: () => "id",
	useLayoutEffect: () => {},
	useMemo: (make: any) => make(),
	useRef: (current: any) => ({ current }),
	useState: (initial: any) => [initial, () => {}],
	useSyncExternalStore: (_subscribe: any, getSnapshot: any) => getSnapshot(),
	startTransition: (fn: any) => fn(),
	memo: (component: any) => component,
};

function bundleEntry(): string {
	const { outputFiles } = buildSync({
		stdin: {
			contents: "export { inject, apply } from './src/client/index.ts'",
			resolveDir: pluginRoot,
			loader: "ts",
		},
		bundle: true,
		format: "cjs",
		platform: "browser",
		write: false,
		logLevel: "silent",
		external: ["react", "react-dom", "deep-view/core", "deep-view/react", "@deepseek-ai/dsh-client-ui-primitives"],
		// A plugin dependency the local checkout has not installed; the reference
		// checkout carries the same version. `alias` works with the synchronous build.
		alias: { "qrcode-generator": requireRoot.resolve("qrcode-generator") },
	});
	return outputFiles[0].text;
}

interface Registration {
	entry: any;
	component: unknown;
}

function fakeStore(initial: any) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => value,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next: any) {
			value = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

// A team answer shaped like the host's `state` reply, with the fields the poll reads.
function stateFixture() {
	return {
		revision: 1,
		workspaceId: "ws-1",
		mainBotId: "chief",
		mainBotIds: ["chief"],
		bots: [{ id: "chief", name: "Chief", sessionId: "chief", parts: [] }],
		rooms: [],
		agents: [{ id: "agent-1", sessions: ["agent-s1"] }],
		exchangeTurns: {},
		questions: {},
		btwCards: {},
		sideChats: {},
		learning: {},
		secrets: [],
		capabilities: [],
		capabilityStatuses: {},
		secretRequests: {},
		models: [],
		defaultModel: null,
		modelsKey: "models-key",
		prefs: { theme: "deepseek" },
		liveKey: "live:1",
		activity: {},
		work: { bots: {}, approvals: [] },
		memoryNews: {},
		connectors: [],
		imStatus: {},
		imVia: {},
	};
}

function makeWindow(document: any) {
	const listeners = new Map<string, Set<(...args: any[]) => void>>();
	return {
		innerWidth: 1400,
		innerHeight: 900,
		document,
		localStorage: null as any,
		visualViewport: undefined,
		addEventListener(name: string, listener: (...args: any[]) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(listener);
			listeners.set(name, set);
		},
		removeEventListener(name: string, listener: (...args: any[]) => void) {
			listeners.get(name)?.delete(listener);
		},
		listenerCount() {
			let count = 0;
			for (const set of listeners.values()) count += set.size;
			return count;
		},
	};
}

interface Rig {
	effects: Array<{ label: string; dispose: () => unknown }>;
	fibers: Array<{ dispose: () => unknown }>;
	registrations: Registration[];
	slotDisposals: string[];
	fetches: Array<[string, any]>;
	opened: string[];
	moduleExports: { inject: readonly string[]; apply(ctx: any): void };
	apply(): void;
	disposeAll(): unknown[];
	storage: any;
	document: any;
}

function makeRig(): Rig {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://bots.local/" });
	const document = dom.window.document;
	const window = makeWindow(document);
	Object.assign(window, { localStorage: dom.window.localStorage, MutationObserver: dom.window.MutationObserver });
	const storage = dom.window.localStorage;

	const effects: Rig["effects"] = [];
	const fibers: Rig["fibers"] = [];
	const registrations: Registration[] = [];
	const slotDisposals: string[] = [];
	const fetches: Array<[string, any]> = [];
	const opened: string[] = [];
	const list = fakeStore({ byId: {} });
	const locale = { register: () => () => {}, bind: () => (key: string) => key, getLocale: () => ({ active: "en" }) };

	const fakeFetch = async (_url: unknown, init: any) => {
		const body = JSON.parse(init.body);
		fetches.push([body.endpoint, body.payload]);
		const value =
			body.endpoint === "state"
				? stateFixture()
				: body.endpoint === "update-check"
					? { available: false, phase: "idle" }
					: body.endpoint === "learning-answer"
						? true
						: null;
		return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
	};

	const injectDisposers: Array<() => void> = [];
	const slots = {
		inject(_name: string, callback: () => unknown) {
			const result = callback();
			const disposer = typeof result === "function" ? (result as () => void) : () => {};
			injectDisposers.push(disposer);
			return disposer;
		},
		register(entry: any, component: unknown) {
			registrations.push({ entry, component });
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				slotDisposals.push(entry.name);
			};
		},
		entries(_name: string) {
			return [];
		},
		spec() {
			return undefined;
		},
		subscribe() {
			return () => {};
		},
	};
	const ctx = {
		effect(setup: () => unknown, label = "") {
			const dispose = setup();
			effects.push({ label, dispose: typeof dispose === "function" ? (dispose as () => unknown) : () => {} });
		},
		get(name: string) {
			if (name === "locale") return locale;
			return undefined;
		},
		inject(_names: string[], callback: (scope: any) => void) {
			const scope = {
				effect(setup: () => unknown, label = "") {
					const dispose = setup();
					effects.push({ label, dispose: typeof dispose === "function" ? (dispose as () => unknown) : () => {} });
				},
				shortcuts: {},
				inputTriggers: {
					sessionOf: () => ({
						launcher: { getSnapshot: () => null },
						toggleSource() {},
					}),
					registerSource: () => () => {},
				},
			};
			callback(scope);
			const fiber = { dispose: () => {} };
			fibers.push(fiber);
			return fiber;
		},
		slots,
		sessions: {
			list,
			refreshProjections: async () => {},
			refresh: async () => {},
			binding: () => undefined,
		},
		uiWorkspace: {
			openSession(id: string) {
				opened.push(id);
			},
		},
		uiConversation: {
			binding: () => ({ target: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) }),
			imageUrl: () => "",
		},
		theme: { overrideTokens: () => () => {} },
		layout: { selectPanel() {}, toggleSidebar() {} },
	};

	const bundle = bundleEntry();
	const module = { exports: {} as any };
	const sandbox: any = {
		module,
		exports: module.exports,
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		Promise,
		Date,
		JSON,
		Math,
		Intl,
		TextEncoder,
		TextDecoder,
		URL,
		URLSearchParams,
		fetch: fakeFetch,
		window,
		document,
		localStorage: storage,
		MutationObserver: dom.window.MutationObserver,
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: any) => clearTimeout(id),
		CSS: { escape: (value: string) => value },
		navigator: dom.window.navigator,
		btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
		atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
		require: (name: string) =>
			name === "react"
				? reactStandIn
				: name === "react-dom"
					? { createPortal: (node: unknown) => node }
					: name === "deep-view/core" || name === "deep-view/react"
						? { validateViewAnswer: () => ({}), viewReply: () => undefined }
						: {},
	};
	// The DOM constructors the styles installer and the shell helpers name directly.
	for (const name of [
		"HTMLElement",
		"HTMLStyleElement",
		"HTMLLinkElement",
		"HTMLDivElement",
		"HTMLInputElement",
		"HTMLTextAreaElement",
		"HTMLButtonElement",
		"HTMLImageElement",
		"CSSStyleSheet",
		"Node",
		"Element",
		"DocumentFragment",
		"Event",
		"CustomEvent",
		"KeyboardEvent",
		"MouseEvent",
	]) {
		sandbox[name] = (dom.window as any)[name];
	}
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;
	runInNewContext(bundle, sandbox, { timeout: 10000 });

	return {
		effects,
		fibers,
		registrations,
		slotDisposals,
		fetches,
		opened,
		moduleExports: module.exports as Rig["moduleExports"],
		apply() {
			module.exports.apply(ctx);
		},
		disposeAll() {
			const results: unknown[] = [];
			for (const effect of [...effects].reverse()) results.push(effect.dispose());
			for (const fiber of [...fibers].reverse()) results.push(fiber.dispose());
			for (const disposer of [...injectDisposers].reverse()) disposer();
			return results;
		},
		storage,
		document,
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((done) => setTimeout(done, 10));
	}
	assert.fail("condition not reached in time");
}

test("the client entry injects the shell services and exports apply", () => {
	const rig = makeRig();
	assert.deepEqual(
		[...rig.moduleExports.inject],
		["sessions", "uiWorkspace", "uiConversation", "slots", "theme", "layout"],
	);
	assert.equal(typeof rig.moduleExports.apply, "function");
});

test("apply installs the locale, polls the roster, paints the surface and closes the panels", async (t) => {
	const rig = makeRig();
	t.after(() => {
		rig.disposeAll();
	});
	rig.apply();
	// The first pull goes out with the empty roster's revision and the window language.
	assert.equal(rig.fetches[0]?.[0], "state");
	assert.equal(rig.fetches[0]?.[1].since, -1);
	assert.equal(rig.fetches[0]?.[1].locale, "en");
	assert.ok(
		rig.fetches.some(([endpoint]) => endpoint === "update-check"),
		"the update check is asked once at start",
	);
	// The roster answer lands: the theme's local prefs are written once the team is ready.
	// The roster answer lands: the agent Session cache and the visit record are written.
	await waitFor(() => rig.storage.getItem("ocean-crew:agent-sessions") !== null);
	assert.equal(rig.storage.getItem("ocean-crew:agent-sessions"), '["agent-s1"]');
	assert.ok(rig.storage.getItem("ocean-crew:seen") !== null, "the first pull records the team as seen");
	assert.equal(rig.document.body.dataset.btMotion, "normal", "the theme render set the motion level");

	// Effect order: interface copy first, then the page/storage listeners, then the poll,
	// update check, registry and finally the surface that paints the slots.
	const labels = rig.effects.map((effect) => effect.label);
	const at = (label: string) => labels.indexOf(label);
	assert.equal(labels[0], "ocean-crew: interface copy");
	assert.ok(at("ocean-crew: remember visits on page hide") > 0);
	assert.ok(at("ocean-crew: follow other windows") > at("ocean-crew: remember visits on page hide"));
	assert.ok(at("ocean-crew: roster poll") > at("ocean-crew: follow other windows"));
	assert.ok(at("ocean-crew: update check") > at("ocean-crew: roster poll"));
	assert.ok(at("ocean-crew: registry") > at("ocean-crew: update check"));
	assert.ok(at("ocean-crew: surface") > at("ocean-crew: registry"));
	// The shell and the conversation groups both mounted.
	const names = rig.registrations.map((registration) => registration.entry.name);
	for (const name of [
		"sidebar.workspaces",
		"sidebar.brand.mark",
		"settings.trigger",
		"settings.launcher",
		"shell.overlay",
		"conversation.session.header",
		"conversation.chat.node",
		"conversation.chat.turnTail",
		"conversation.input.dock",
		"conversation.input.left",
		"conversation.composer",
	]) {
		assert.ok(names.includes(name), `${name} registered`);
	}
	const shellOverlays = rig.registrations
		.filter((registration) => registration.entry.name === "shell.overlay")
		.map((registration) => registration.entry.id);
	assert.deepEqual(shellOverlays, ["bot", "bot-signin", "bot-toast"]);
	const docks = rig.registrations
		.filter((registration) => registration.entry.name === "conversation.input.dock")
		.map((registration) => registration.entry.id);
	assert.deepEqual(docks, [
		"bot-members",
		"bot-model",
		"bot-question",
		"bot-view",
		"bot-secret",
		"bot-connector",
		"bot-mail",
		"bot-handoff",
		"bot-learning",
		"queue",
	]);
	const footer = rig.registrations
		.filter((registration) => registration.entry.name === "sidebar.footer.action")
		.map((registration) => registration.entry.id);
	assert.deepEqual(footer, ["bot-return", "bot-account"]);
	const branding = rig.registrations.find((registration) => registration.entry.name === "sidebar.workspaces");
	assert.equal(branding?.entry.priority, -100, "a Bot slot lands below the shell's own entries");
	const header = rig.registrations.find((registration) => registration.entry.name === "conversation.session.header");
	assert.ok(header !== undefined, "the header navigation face is re-registered");
	// The character-markup and theme styles went in with the shell group.
	assert.ok(rig.document.querySelectorAll("style").length >= 3, "the shell styles are installed");
});

test("disposing the entry takes the slots and listeners down and stops the poll", async (t) => {
	const rig = makeRig();
	t.after(() => {
		rig.disposeAll();
	});
	rig.apply();
	await waitFor(() => rig.storage.getItem("ocean-crew:agent-sessions") !== null);
	const registered = rig.registrations.length;
	assert.ok(registered > 30, `the surface registered ${registered} slots`);
	rig.disposeAll();
	assert.deepEqual(
		rig.slotDisposals.slice().sort(),
		rig.registrations.map((registration) => registration.entry.name).sort(),
	);
	const fetches = rig.fetches.length;
	await new Promise((done) => setTimeout(done, 60));
	assert.equal(rig.fetches.length, fetches, "no state pull after dispose");
});
