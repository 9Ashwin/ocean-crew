// The sidebar's and model menu's pure parts, the small overlay helpers, and the two
// rules the shell-facing buttons live by. The React components themselves are checked
// by tsc and the client build; these tests run the modules' pure exports through an
// esbuild bundle so React stays the page's own platform module.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { headerNavigation, installHeaderNavigation } from "../src/client/shell/header-navigation.ts";
import { listedOpener } from "../src/client/shell/open-listed.ts";
import { reserveWindow } from "../src/client/shell/open-window.ts";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, "..", "dev", "harness");
const requireHarness = createRequire(join(harness, "package.json"));
const { build } = requireHarness("esbuild");

// React and the DSH primitives are platform modules in the page; here they are the
// smallest stand-ins the bundled module needs to evaluate its top level.
const platform: Record<string, any> = {
	react: {
		Fragment: "fragment",
		createElement: (type: any, props?: any, ...children: any[]) => ({
			type,
			props: props ?? {},
			children: children.flat(Infinity),
		}),
		useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
		useRef: (initial: any) => ({ current: initial }),
		useEffect: () => {},
		useLayoutEffect: () => {},
		useMemo: (make: () => any) => make(),
		useCallback: (fn: any) => fn,
		useSyncExternalStore: (_subscribe: any, getSnapshot: () => any) => getSnapshot(),
	},
	"react-dom": {},
	"@deepseek-ai/dsh-client-ui-primitives": {},
};

// only evaluates the pure exports, so they are left out and never run.
const pending = /(?:^|\/)enter-key\.ts$|(?:^|\/)im-platforms\.ts$|^deep-view\//;
const { outputFiles } = await build({
	stdin: {
		contents:
			"export * from './src/client/pages/model-menu.ts';" +
			"export * from './src/client/shell/palette.ts';" +
			"export { SIDEBAR_CSS, RETURN_CSS, MODELS_STEP, MODELS_STEP_ORDER } from './src/client/shell/sidebar.ts';",
		resolveDir: PLUGIN,
	},
	bundle: true,
	format: "cjs",
	platform: "node",
	write: false,
	external: ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"],
	plugins: [
		{
			name: "pending-modules",
			setup(build: any) {
				build.onResolve({ filter: /.*/ }, (args: any) =>
					pending.test(args.path) ? { path: args.path, external: true } : null,
				);
			},
		},
	],
	logLevel: "silent",
});
const sandboxModule = { exports: {} as Record<string, any> };
runInNewContext(outputFiles[0]!.text, {
	module: sandboxModule,
	exports: sandboxModule.exports,
	require: (name: string) => {
		if (name in platform) return platform[name];
		// A stubbed pending module exports anything the component would have used.
		if (pending.test(name) || name.startsWith("deep-view/")) return new Proxy({}, { get: () => () => undefined });
		throw new Error(`no platform module ${name}`);
	},
	document: { activeElement: null },
	window: {},
	console,
});
const {
	groupModels,
	modelOf,
	effortRows,
	effortStops,
	groupOpen,
	toggledGroup,
	manualFor,
	MODEL_CSS,
	paletteMatches,
	SIDEBAR_CSS,
	RETURN_CSS,
	MODELS_STEP,
	MODELS_STEP_ORDER,
} = sandboxModule.exports as Record<string, any>;

const models = [
	{ ref: "official/flash", provider: "official", providerName: "DeepSeek", name: "DeepSeek Flash" },
	{ ref: "local/flash", provider: "local", providerName: "Ollama", name: "DeepSeek Flash" },
	{ ref: "official/pro", provider: "official", providerName: "DeepSeek", name: "DeepSeek Pro" },
];

test("models group by provider, and two providers with one display name stay distinct", () => {
	assert.deepEqual(
		Array.from(groupModels(models), ([label, list]) => [label, Array.from(list, (model: any) => model.ref)]),
		[
			["DeepSeek", ["official/flash", "official/pro"]],
			["Ollama", ["local/flash"]],
		],
	);
	const entries = [
		{ ...models[0], providerName: "Cloud" },
		{ ...models[1], providerName: "Cloud" },
		{ ref: "custom/flash", provider: "custom", name: "Flash" },
	];
	assert.deepEqual(
		Array.from(groupModels(entries), ([label, list]) => [label, Array.from(list, (model: any) => model.ref)]),
		[
			["Cloud (official)", ["official/flash"]],
			["Cloud (local)", ["local/flash"]],
			["custom", ["custom/flash"]],
		],
	);
	assert.equal(groupModels(undefined).length, 0);
});

test("a Bot's model is the served one, else the ref it was pinned to", () => {
	const roster = { models };
	// The bundle's objects come from another realm; compare their data, not identities.
	const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
	assert.deepEqual(plain(modelOf({ model: "official/flash" }, roster)), {
		ref: "official/flash",
		name: "DeepSeek Flash",
		provider: "DeepSeek",
		served: true,
	});
	assert.deepEqual(plain(modelOf({ appliedModel: "local/flash" }, roster)), {
		ref: "local/flash",
		name: "DeepSeek Flash",
		provider: "Ollama",
		served: true,
	});
	assert.deepEqual(plain(modelOf({ model: "gone/flash" }, roster)), {
		ref: "gone/flash",
		name: "flash",
		provider: "gone",
		served: false,
	});
	assert.equal(modelOf({}, roster), undefined);
});

test("the Thinking rows always offer Default, so a picked level can be cleared", () => {
	const efforts = [
		{ id: "low", name: "Low" },
		{ id: "high", name: "High" },
	];
	assert.deepEqual(
		Array.from(effortRows({ efforts, defaultEffort: "high" }), (row: any) => row.effort),
		[undefined, "low", "high"],
	);
	assert.deepEqual(
		Array.from(effortRows({ efforts }), (row: any) => row.effort),
		[undefined, "low", "high"],
	);
	assert.equal(effortRows({ efforts: [] }).length, 0);
	assert.equal(effortRows(undefined).length, 0);
	// Slider stops use the model's levels when defaultEffort is known (reset clears to
	// Default), and include a leading Default stop when the provider did not name one.
	assert.deepEqual(
		Array.from(effortStops({ efforts, defaultEffort: "high" }), (row: any) => row.effort),
		["low", "high"],
	);
	assert.deepEqual(
		Array.from(effortStops({ efforts }), (row: any) => row.effort),
		[undefined, "low", "high"],
	);
	assert.equal(effortStops(undefined).length, 0);
});

test("one provider group is open at a time, until the user opens or closes one", () => {
	const base = { index: 1, currentId: "official", filtering: false, manual: {} };
	assert.equal(groupOpen({ ...base, id: "official" }), true);
	assert.equal(groupOpen({ ...base, id: "local" }), false);
	// A search opens every matched group, so a result is never behind a heading.
	assert.equal(groupOpen({ ...base, id: "local", filtering: true }), true);
	// The current model's provider is open; with no current model the first one is.
	assert.equal(groupOpen({ index: 0, currentId: undefined, filtering: false, manual: {}, id: "local" }), true);
	assert.equal(groupOpen({ index: 1, currentId: undefined, filtering: false, manual: {}, id: "local" }), false);
	// The manual state wins over both.
	const manual = { local: true, official: false };
	assert.equal(groupOpen({ ...base, id: "local", manual }), true);
	assert.equal(groupOpen({ ...base, id: "official", manual }), false);
	assert.deepEqual(JSON.parse(JSON.stringify(toggledGroup({}, "local", false))), { local: true });
	assert.deepEqual(JSON.parse(JSON.stringify(toggledGroup({ local: true }, "local", true))), { local: false });
});

test("the manual group state belongs to one opening of the menu", () => {
	const state = { opening: 1, manual: { local: true } };
	assert.deepEqual(JSON.parse(JSON.stringify(manualFor(state, 1))), { local: true });
	// A reopen reuses mounted rows under its exit animation: the old choices are gone.
	assert.deepEqual(JSON.parse(JSON.stringify(manualFor(state, 2))), {});
});

test("the palette matches on every field, and an empty search shows everything", () => {
	assert.equal(paletteMatches("", "anything", undefined), true);
	assert.equal(paletteMatches("writer", "Writer", "writing"), true);
	assert.equal(paletteMatches("ada", "Writer", "writing"), false);
	assert.equal(paletteMatches("2", undefined, null), false);
});

test("the style sheets keep the selectors the components draw", () => {
	assert.match(MODEL_CSS, /\.bt-model-trigger\{/);
	assert.match(MODEL_CSS, /\.bt-effort-track\{/);
	assert.match(MODEL_CSS, /\.bt-model-dock\{/);
	assert.match(SIDEBAR_CSS, /\.bt-update-pop\{/);
	assert.match(SIDEBAR_CSS, /\.bt-agent-sub\[data-open\]/);
	assert.match(SIDEBAR_CSS, /\.bt-confirm-go\{/);
	assert.match(RETURN_CSS, /\.bt-return\{/);
	assert.match(RETURN_CSS, /--bt-ink-deepseek:#4D6BFE/);
	// The onboarding step the shell's first-run pass meets last.
	assert.equal(MODELS_STEP, "ocean-crew-models");
	assert.equal(MODELS_STEP_ORDER, 1000);
});

// ---------------------------------------------------------------------------
// open-listed: a Session the shell has not listed yet is opened when it arrives.

const store = (ids: string[] = []) => {
	const listeners = new Set<() => void>();
	const snapshot: { byId: Record<string, any> } = { byId: {} };
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	const put = (id: string, main = false): void => {
		snapshot.byId[id] = main ? { id, retainedBy: { mainView: 1 } } : { id };
	};
	for (const id of ids) put(id);
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (id: string) => {
			put(id);
			notify();
		},
		setMain: (id: string) => {
			for (const row of Object.values(snapshot.byId)) delete row.retainedBy;
			put(id, true);
			notify();
		},
	};
};
const mainViewOf = (list: ReturnType<typeof store>): string | undefined =>
	Object.values(list.getSnapshot().byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
const rig = (list: ReturnType<typeof store>) => {
	const opened: string[] = [];
	let refreshes = 0;
	const show = listedOpener({
		list,
		open: (id: string) => opened.push(id),
		refresh: () => {
			refreshes += 1;
		},
		current: () => mainViewOf(list),
	});
	return { show, opened, refreshes: () => refreshes };
};

test("a listed Session opens at once and no refresh is asked for", () => {
	const { show, opened, refreshes } = rig(store(["a"]));
	show("a");
	assert.deepEqual(opened, ["a"]);
	assert.equal(refreshes(), 0);
});

test("an unlisted Session opens when the list reaches it, only once", () => {
	const list = store();
	const { show, opened, refreshes } = rig(list);
	show("a");
	assert.deepEqual(opened, []);
	assert.equal(refreshes(), 1);
	list.set("a");
	assert.deepEqual(opened, ["a"]);
	list.set("b");
	assert.deepEqual(opened, ["a"]);
});

test("a newer navigation drops the wait for the old one", () => {
	const list = store(["b"]);
	const { show, opened } = rig(list);
	show("a");
	show("b");
	assert.deepEqual(opened, ["b"]);
	list.set("a");
	assert.deepEqual(opened, ["b"]);
});

test("two waits in a row keep only the last one", () => {
	const list = store();
	const { show, opened } = rig(list);
	show("a");
	show("b");
	list.set("a");
	list.set("b");
	assert.deepEqual(opened, ["b"]);
});

test("a navigation elsewhere drops the wait", () => {
	const list = store(["x"]);
	list.setMain("x");
	const { show, opened } = rig(list);
	show("a");
	list.setMain("y");
	list.set("a");
	assert.deepEqual(opened, []);
});

// ---------------------------------------------------------------------------
// header-navigation: the shell's own header face is reused, never replaced blind.

const slots = (initial: any[] = []) => {
	const registered: Array<{ entry: any; component: unknown }> = [];
	const listeners = new Set<() => void>();
	let entries = [...initial];
	return {
		registered,
		entries() {
			return entries;
		},
		set(next: any[]) {
			entries = next;
			for (const listener of listeners) listener();
		},
		slots: {
			entries: () => entries,
			register: (entry: any, component: unknown) => {
				registered.push({ entry, component });
				return () => {};
			},
			subscribe: (_name: string, listener: () => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
	};
};

test("the header face keeps the replaced navigation's store and hooks", () => {
	const source = {
		store: { view: "chat" },
		inject: (...args: unknown[]) => ({ navigation: args.length, hooks: { fromShell: true } }),
	};
	const face = () => ({ own: true, hooks: { fromFace: true } });
	const merged = headerNavigation([source], face);
	assert.deepEqual(merged.store, { view: "chat" });
	assert.deepEqual(merged.inject("a", "b"), {
		navigation: 2,
		own: true,
		hooks: { fromShell: true, fromFace: true },
	});
	// With no shell navigation there is no store to carry and no hooks to merge.
	assert.equal(headerNavigation([], face).store, undefined);
	assert.deepEqual((headerNavigation([], face).inject as any)(), { own: true, hooks: { fromFace: true } });
});

test("the header registration follows the shell's own registration and steps aside", () => {
	const shell = slots([]);
	const dispose = installHeaderNavigation(shell.slots as any, () => ({ own: 1 }), "our-header", 10);
	assert.equal(shell.registered.length, 1);
	assert.equal(shell.registered[0]!.entry.name, "conversation.session.header");
	assert.equal(shell.registered[0]!.component, "our-header");
	const source = { store: { view: "chat" }, inject: () => ({}) };
	shell.set([source]);
	assert.equal(shell.registered.length, 2);
	assert.deepEqual(shell.registered[1]!.entry.store, { view: "chat" });
	// Our own registration is not a source; a host reload of the same entry is no change.
	shell.set([source]);
	assert.equal(shell.registered.length, 2);
	dispose();
	assert.equal(shell.registered.length, 2);
});

// ---------------------------------------------------------------------------
// open-window: the page opens inside the click, and the Desktop hands it on.

test("a browser window is reserved in the gesture and addressed later", (t) => {
	const previous = (globalThis as any).window;
	const opened: any[] = [];
	const fake = {
		open: (url: string, target: string) => {
			const reserved = {
				opener: {},
				location: { href: "" },
				closed: false,
				close() {
					this.closed = true;
				},
				url,
				target,
			};
			opened.push(reserved);
			return reserved;
		},
	};
	(globalThis as any).window = fake;
	t.after(() => {
		(globalThis as any).window = previous;
	});
	const windowRef = reserveWindow();
	assert.equal(opened[0]!.opener, null);
	assert.equal(windowRef.go("https://example.test/a"), true);
	assert.equal(opened[0]!.location.href, "https://example.test/a");
	windowRef.close();
	assert.equal(opened[0]!.closed, true);
});

test("a blocked popup reports that it did not open", (t) => {
	const previous = (globalThis as any).window;
	(globalThis as any).window = { open: () => null };
	t.after(() => {
		(globalThis as any).window = previous;
	});
	assert.equal(reserveWindow().go("https://example.test/a"), false);
});

test("the Desktop hands the address to the system browser, with no reserved window", (t) => {
	const previous = (globalThis as any).window;
	const calls: Array<[string, string]> = [];
	(globalThis as any).window = {
		dshDesktop: {},
		open: (url: string, target: string) => {
			calls.push([url, target]);
			return null;
		},
	};
	t.after(() => {
		(globalThis as any).window = previous;
	});
	assert.equal(reserveWindow().go("https://example.test/a"), true);
	assert.deepEqual(calls, [["https://example.test/a", "_blank"]]);
});
