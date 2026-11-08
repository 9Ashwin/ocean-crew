// The settings and details client modules: the pure rules the forms are built on — the
// Create Bot draft helpers, the folder label, the permission labels, the group mode and
// subtitle, and the page reader's Markdown — loaded without a DOM where possible and
// through a small bundle for the modules that import React.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createPayload, freshBotName, startModel } from "../src/client/pages/bot-draft.ts";
import { READ_LIMITS, READ_PAGE_SCRIPT, readPageScript } from "../src/client/pages/read-page.ts";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, "..", "dev", "harness");
const requireHarness = createRequire(join(harness, "package.json"));
const { build } = requireHarness("esbuild");
const { JSDOM } = requireHarness("jsdom");

// The pure helpers of the React modules, bundled once with the platform modules left
// external, as the client bundle leaves them.
const { outputFiles } = await build({
	stdin: {
		contents:
			"export { folderName } from './src/client/pages/folder-menu.ts';" +
			"export { presetDanger, presetName } from './src/client/pages/permission-picker.ts';" +
			"export { ROOM_MODES, shownMode, roomSubtitle } from './src/client/pages/group-settings.ts';" +
			"export { PermissionPicker } from './src/client/pages/permission-picker.ts';" +
			"export { BotSettingsForm } from './src/client/pages/bot-settings.ts';",
		resolveDir: PLUGIN,
	},
	bundle: true,
	format: "cjs",
	platform: "browser",
	write: false,
	logLevel: "silent",
	external: ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"],
});

const cells: any[] = [];
const prevDeps: any[] = [];
let hook = 0;
let dirty = false;
let pendingEffects: Array<{ i: number; fn: () => unknown; deps?: unknown[] }> = [];
const changed = (deps: unknown[] | undefined, prev: unknown[] | undefined): boolean =>
	deps === undefined ||
	prev === undefined ||
	deps.length !== prev.length ||
	deps.some((dep, index) => !Object.is(dep, prev[index]));
const react = {
	createContext: (initial: unknown) => {
		const context: any = { value: initial };
		context.Provider = ({ value, children }: any) => {
			context.value = value;
			return children;
		};
		return context;
	},
	useContext: (context: any) => context.value,
	useCallback: (fn: unknown) => fn,
	useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
	createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
		type,
		props: { ...(props as any), children: children.flat(Number.POSITIVE_INFINITY) },
	}),
	useState(initial: unknown) {
		const index = hook++;
		if (!(index in cells)) cells[index] = typeof initial === "function" ? (initial as any)() : initial;
		return [
			cells[index],
			(next: any) => {
				cells[index] = typeof next === "function" ? next(cells[index]) : next;
				dirty = true;
			},
		];
	},
	useRef(initial: unknown) {
		const index = hook++;
		if (!(index in cells)) cells[index] = { current: initial };
		return cells[index];
	},
	useEffect(fn: () => unknown, deps?: unknown[]) {
		pendingEffects.push({ i: hook++, fn, deps });
	},
	useLayoutEffect(fn: () => unknown, deps?: unknown[]) {
		pendingEffects.push({ i: hook++, fn, deps });
	},
	useMemo: (make: () => unknown) => make(),
	useId: () => "id",
	Fragment: Symbol("Fragment"),
};

const render = (component: any, props: any): any => {
	let tree: any;
	do {
		dirty = false;
		hook = 0;
		pendingEffects = [];
		tree = component(props);
		for (const { i, fn, deps } of pendingEffects) {
			if (changed(deps, prevDeps[i])) {
				prevDeps[i] = deps;
				fn();
			}
		}
	} while (dirty);
	return tree;
};

const loaded = (() => {
	const module = { exports: {} as any };
	runInNewContext(outputFiles[0].text, {
		module,
		exports: module.exports,
		require: (name: string) =>
			name === "react" ? react : name === "react-dom" ? { createPortal: (node: unknown) => node } : {},
		setTimeout,
		clearTimeout,
		console,
	});
	return module.exports;
})();
const helpers = (): any => loaded;

// ---------------------------------------------------------------------------
// Create Bot draft helpers.

test("freshBotName picks the first free copy of the base name", () => {
	const roster = (names: string[]) => ({ bots: names.map((name) => ({ name })) });
	assert.equal(freshBotName(roster([])), "New Bot");
	assert.equal(freshBotName(roster(["Chief"])), "New Bot");
	assert.equal(freshBotName(roster(["New Bot"])), "New Bot 2");
	assert.equal(freshBotName(roster(["New Bot", "New Bot 2"])), "New Bot 3");
	assert.equal(freshBotName(roster(["new bot", "NEW BOT 2"]), "New Bot"), "New Bot 3");
	assert.equal(freshBotName(roster(["Writer"]), "Writer"), "Writer 2");
});

test("startModel prefers the team pick, skips keyless models, then the DSH default", () => {
	const models = [{ ref: "deepseek/a" }, { ref: "deepseek/b" }, { ref: "other/c", needsKey: true }];
	assert.equal(
		startModel({ bots: [], models, prefs: { defaultBotModel: "deepseek/b" }, defaultModel: "deepseek/a" }),
		"deepseek/b",
	);
	// A team pick the catalog no longer serves falls through to the DSH default.
	assert.equal(
		startModel({ bots: [], models, prefs: { defaultBotModel: "gone/x" }, defaultModel: "deepseek/a" }),
		"deepseek/a",
	);
	// A model that needs a key is never the form's start.
	assert.equal(startModel({ bots: [], models, defaultModel: "other/c" }), "deepseek/a");
	assert.equal(startModel({ bots: [], models: [{ ref: "other/c", needsKey: true }] }), "");
	assert.equal(startModel({ bots: [] }), "");
});

test("createPayload sends the look, and the optional fields only when set", () => {
	const look = { shape: "whale", color: "deepseek" };
	assert.deepEqual(createPayload({ name: "Writer", look }), {
		name: "Writer",
		color: "deepseek",
		avatar: { shape: "whale" },
	});
	assert.deepEqual(createPayload({ name: "Writer", look, image: "data:image/png;base64,AAAA" }), {
		name: "Writer",
		color: "deepseek",
		avatar: { shape: "whale", image: "data:image/png;base64,AAAA" },
	});
	assert.deepEqual(createPayload({ name: "Writer", look, model: "deepseek/v4", effort: "high", brief: "Write" }), {
		name: "Writer",
		color: "deepseek",
		avatar: { shape: "whale" },
		model: "deepseek/v4",
		effort: "high",
		brief: "Write",
	});
	// An explicit Default thinking level is sent too (an empty string); left out is not.
	assert.equal("effort" in createPayload({ name: "Writer", look, effort: "" }), true);
	assert.equal("effort" in createPayload({ name: "Writer", look }), false);
	assert.equal("model" in createPayload({ name: "Writer", look, model: "" }), false);
});

// ---------------------------------------------------------------------------
// Folder and permission labels.

test("folderName keeps the last path segment and a root's own spelling", () => {
	const { folderName } = helpers();
	assert.equal(folderName("/home/user/projects/crew"), "crew");
	assert.equal(folderName("/home/user/projects/crew/"), "crew");
	assert.equal(folderName("C:\\Users\\ada\\crew"), "crew");
	assert.equal(folderName("/"), "/");
	assert.equal(folderName("C:\\"), "C:");
});

test("permission labels and the dangerous preset", () => {
	const { presetDanger, presetName } = helpers();
	assert.equal(presetDanger("danger-full-access"), true);
	assert.equal(presetDanger("workspace-write"), false);
	assert.equal(presetName("read-only", undefined), "Read only");
	assert.equal(presetName("workspace-write", undefined), "Workspace");
	assert.equal(presetName("danger-full-access", undefined), "Full access");
	// A preset DSH adds beyond the known three keeps its own name.
	const catalog = { options: [{ value: "custom", name: "Custom review" }] };
	assert.equal(presetName("custom", catalog), "Custom review");
	assert.equal(presetName("unknown", catalog), "unknown");
});

// ---------------------------------------------------------------------------
// Group settings rules.

test("the group mode follows the admin, and its subtitle names them", () => {
	const { ROOM_MODES, shownMode, roomSubtitle } = helpers();
	// The module runs in its own realm in the bundle; spread it into this one first.
	assert.deepEqual(
		[...ROOM_MODES].map(([id]: readonly [string, string, string]) => id),
		["admin", "everyone"],
	);
	const roster = {
		byId: { a: { id: "a", name: "Chief" } },
		bots: [],
		rooms: [],
	};
	// Without an admin the host answers as everyone, whatever the stored mode says.
	assert.equal(shownMode({ admin: "a", mode: "admin" }, roster), "admin");
	assert.equal(shownMode({ admin: "gone", mode: "admin" }, roster), "everyone");
	assert.equal(shownMode({ admin: null, mode: "everyone" }, roster), "everyone");
	assert.equal(roomSubtitle({ members: ["a", "b"], admin: "a" }, roster), "2 members · Admin Chief");
	assert.equal(roomSubtitle({ members: ["b"], admin: null }, roster), "1 members · No admin");
});

// ---------------------------------------------------------------------------
// The page reader.

// A page that uses every rule the reader has: headings, lists, tables, code, quotes,
// hidden text, images, shadow roots and same-origin iframes.
const PAGE = `<!doctype html><html lang="en"><head><title>Sample</title>
<meta name="description" content="About the sample">
<style>.gone{display:none} .ghost{visibility:hidden} .chip{display:inline-block} .folded{overflow-x:hidden;overflow-y:hidden}</style></head>
<body>
<h1>Sample <a href="#top">page</a></h1>
<p>Some <code>code</code> and a <a href="/docs">doc link</a>.<br>Next line.</p>
<ul><li>Fruit<ol start="3"><li>Apple</li><li>Pear <span class="chip">ripe</span><span class="chip">green</span></li></ol></li><li>Vegetables</li></ul>
<table><caption>Plan</caption>
<tr><th>Day</th><th>Who</th><th>Task</th></tr>
<tr><td rowspan="2">Mon</td><td>Writer</td><td>Draft | review</td></tr>
<tr><td>Coder</td><td>Fix</td></tr>
<tr><td colspan="2">All</td><td>Retro</td></tr>
</table>
<pre class="language-js">let a = 1
  indented()</pre>
<blockquote><p>Quoted one.</p><p>Quoted two.</p></blockquote>
<hr>
<p class="gone">HIDDEN-DISPLAY</p>
<p class="ghost">HIDDEN-VISIBILITY <span style="visibility: visible">shown child</span></p>
<div class="folded" data-zero>HIDDEN-FOLDED</div>
<details><summary>More</summary>HIDDEN-DETAILS</details>
<p><img alt="A dot"> <img src="x.png"> after.</p>
<div role="heading" aria-level="3">Aria heading</div>
<div id="host">LIGHT-UNSLOTTED<span slot="name">Chief</span></div>
<label for="user">User</label><input id="user" value="writer@example.com">
<input id="pw" type="password" value="SECRET-PASSWORD" aria-label="Password">
<input autocomplete="cc-number" value="SECRET-CARD" placeholder="Card">
<input name="otp" value="SECRET-OTP" placeholder="Code">
<label><input type="checkbox" checked> Remember</label>
<select aria-label="Color"><option>Red</option><option selected>Blue</option></select>
<button disabled>Send</button>
<textarea>DRAFT-IN-TEXTAREA</textarea>
<iframe id="same" title="Inner"></iframe>
<iframe id="cross" src="https://other.example/embed"></iframe>
<script>SCRIPT-TEXT</script>
</body></html>`;

function makePage(): any {
	const dom = new JSDOM(PAGE, {
		url: "https://example.com/sample",
		runScripts: "outside-only",
		pretendToBeVisual: true,
	});
	const { window } = dom;
	// jsdom has no layout: every box is 100×20 unless marked data-zero.
	const layout = (frame: any): void => {
		frame.Element.prototype.getBoundingClientRect = function (this: any) {
			const zero = this.hasAttribute("data-zero");
			return { width: zero ? 0 : 100, height: zero ? 0 : 20, top: 0, left: 0, right: 0, bottom: 0 };
		};
	};
	layout(window);
	const doc = window.document;
	const host = doc.getElementById("host");
	host.attachShadow({ mode: "open" }).innerHTML =
		'<style>.x{}</style><h3>Bot: <slot name="name">nobody</slot></h3><p><slot name="missing">Fallback</slot></p><button>Message</button>';
	const frameDoc = (iframe: any): any => {
		layout(iframe.contentWindow);
		return iframe.contentDocument;
	};
	const inner = frameDoc(doc.getElementById("same"));
	inner.title = "Inner title";
	inner.body.innerHTML = '<p>Level one <a href="/in">inner link</a></p><iframe id="deeper"></iframe>';
	const deeper = frameDoc(inner.getElementById("deeper"));
	deeper.body.innerHTML = "<p>Level two</p><iframe></iframe>";
	frameDoc(deeper.querySelector("iframe")).body.innerHTML = "<p>Level three</p><iframe></iframe>";
	Object.defineProperty(doc.getElementById("cross"), "contentDocument", { get: () => null });
	return window;
}

// As plain data from this realm, as executeJavaScript hands it over, without the timing.
const read = (window: any, script = READ_PAGE_SCRIPT): any => {
	const page = JSON.parse(JSON.stringify(window.eval(script)));
	delete page.stats.ms;
	return page;
};

test("the reader turns the visible page into Markdown with marked links and controls", () => {
	const page = read(makePage());
	assert.equal(page.format, "markdown");
	assert.equal(page.title, "Sample");
	assert.equal(page.lang, "en");
	assert.equal(page.description, "About the sample");
	assert.equal(page.truncated, undefined);
	const text: string = page.text;
	const has = (fragment: string): void =>
		assert.ok(text.includes(fragment), `missing:\n${fragment}\n--- in ---\n${text}`);
	has("# Sample page[#1]\n\nSome `code` and a doc link[#2].\nNext line.");
	has("- Fruit\n  3. Apple\n  4. Pear ripe green\n- Vegetables");
	has(
		"Table: Plan\n\n| Day | Who | Task |\n| --- | --- | --- |\n| Mon | Writer | Draft \\| review |\n| Mon | Coder | Fix |\n| All |  | Retro |",
	);
	has("```js\nlet a = 1\n  indented()\n```");
	has("> Quoted one.\n>\n> Quoted two.\n\n---");
	has("shown child");
	has("More[#3]");
	has("[image: A dot] after.");
	has("### Aria heading");
	has("### Bot: Chief\n\nFallback\n\nMessage[#4]");
	has("[iframe: Inner (about:blank)]\nLevel one inner link[#13]");
	has("Level three\n\n[iframe (nested too deep, not read): about:blank]");
	has("[iframe (cross-origin, not readable): https://other.example/embed]");
	for (const hidden of ["HIDDEN", "LIGHT-UNSLOTTED", "nobody", "SECRET", "SCRIPT-TEXT", ".x{}"])
		assert.ok(!JSON.stringify(page).includes(hidden), `${hidden} leaked`);
	// A text box's value is listed with the control, not repeated in the text.
	assert.ok(!text.includes("DRAFT"));
	assert.equal(page.items[11].value, "DRAFT-IN-TEXTAREA");
	assert.deepEqual(
		page.items.map((item: any) => [item.role, item.name]),
		[
			["link", "page"],
			["link", "doc link"],
			["button", "More"],
			["button", "Message"],
			["textbox", "User"],
			["textbox", "Password"],
			["textbox", "Card"],
			["textbox", "Code"],
			["checkbox", "Remember"],
			["select", "Color"],
			["button", "Send"],
			["textbox", ""],
			["link", "inner link"],
		],
	);
	const byName = Object.fromEntries(page.items.map((item: any) => [item.name, item]));
	assert.equal(byName["doc link"].href, "https://example.com/docs");
	assert.equal(byName.User.value, "writer@example.com");
	for (const secret of ["Password", "Card", "Code"]) assert.equal(byName[secret].value, undefined);
	assert.equal(byName.Remember.checked, true);
	assert.equal(byName.Color.value, "Blue");
	assert.equal(byName.Send.disabled, true);
	assert.equal(page.stats.frames, 3);
});

test("the numbers in the text and the list agree, frames and shadow roots included", () => {
	const page = read(makePage());
	const marks = [...page.text.matchAll(/\[#(\d+)\]/g)].map((match: any) => Number(match[1]));
	assert.deepEqual(
		marks,
		page.items.map((_: any, index: number) => index + 1),
	);
	assert.equal(page.items[marks[marks.length - 1] - 1].name, "inner link");
});

test("the limits stop the walk and say why", () => {
	const window = makePage();
	const page = read(window, readPageScript({ ...READ_LIMITS, nodes: 40, items: 2 }));
	assert.match(page.truncated, /more than 40 nodes/);
	assert.equal(page.items.length, 2);
	assert.ok(page.text.startsWith("# Sample page[#1]"));
});

test("a big table is cut at the row limit with a note", () => {
	const window = makePage();
	const doc = window.document;
	// Narrow layouts often restyle a table as a block; it still reads as a table.
	doc.body.innerHTML = `<table style="display:block"><tr><th>n</th><th>v</th></tr>${Array.from(
		{ length: 30 },
		(_, i) => `<tr><td>${i}</td><td>v${i}</td></tr>`,
	).join("")}</table>`;
	const { text } = read(window, readPageScript({ ...READ_LIMITS, tableRows: 11 }));
	assert.match(text, /\| 10 \| v10 \|\n… \(table cut: 19 more rows\)$/);
});

// ---------------------------------------------------------------------------
// The permission picker.

const OPTIONS = [
	{ value: "read-only", description: "read-only" },
	{ value: "workspace-write", description: "workspace-write" },
	{ value: "danger-full-access", description: "danger-full-access" },
];
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Mounts the picker on `props`; `requests` gets a deferred per `onPick` call, and
// `maxFlying` records the most requests open at once.
function mountPicker(initial: any, repick = false): any {
	const { PermissionPicker } = helpers();
	cells.length = 0;
	prevDeps.length = 0;
	const requests: any[] = [];
	let flying = 0;
	const seen = { maxFlying: 0 };
	let props: any = { ...initial, repick };
	props.onPick = (value: string) => {
		flying += 1;
		seen.maxFlying = Math.max(seen.maxFlying, flying);
		return new Promise((resolve, reject) =>
			requests.push({
				value,
				resolve: (done: any) => {
					flying -= 1;
					resolve(done);
				},
				reject: (error: any) => {
					flying -= 1;
					reject(error);
				},
			}),
		);
	};
	let tree: any;
	const rerender = (patch: any = {}): any => {
		props = { ...props, ...patch };
		tree = render(PermissionPicker, props);
		return tree;
	};
	const picker = {
		requests,
		seen,
		rerender,
		press(value: string) {
			tree.props.children.find((button: any) => button.props.title === value).props.onClick();
			rerender();
		},
		pressed() {
			return tree.props.children.find((button: any) => button.props["aria-pressed"])?.props.title;
		},
		async flush() {
			await settle();
			rerender();
		},
	};
	rerender();
	return picker;
}

test("a newer pick survives an older request failing", async () => {
	const picker = mountPicker({ catalog: { options: OPTIONS }, saved: "read-only" });
	picker.press("workspace-write");
	picker.press("danger-full-access");
	assert.equal(picker.requests.length, 1);
	assert.equal(picker.pressed(), "danger-full-access");
	picker.requests[0].resolve(false);
	await picker.flush();
	assert.equal(picker.requests.length, 2);
	assert.equal(picker.requests[1].value, "danger-full-access");
	assert.equal(picker.pressed(), "danger-full-access");
	picker.requests[1].resolve(true);
	picker.rerender({ saved: "danger-full-access" });
	await picker.flush();
	assert.equal(picker.requests.length, 2);
	assert.equal(picker.pressed(), "danger-full-access");
	assert.equal(picker.seen.maxFlying, 1);
});

test("a newer pick that fails falls back to what the server saved", async () => {
	const picker = mountPicker({ catalog: { options: OPTIONS }, saved: "read-only" });
	picker.press("workspace-write");
	picker.press("danger-full-access");
	picker.requests[0].resolve(true);
	picker.rerender({ saved: "workspace-write" });
	await picker.flush();
	assert.equal(picker.requests.length, 2);
	picker.requests[1].resolve(false);
	await picker.flush();
	assert.equal(picker.pressed(), "workspace-write");
	assert.equal(picker.seen.maxFlying, 1);
});

test("a single failed pick falls back to the saved value", async () => {
	const picker = mountPicker({ catalog: { options: OPTIONS }, saved: "read-only" });
	picker.press("workspace-write");
	assert.equal(picker.pressed(), "workspace-write");
	picker.requests[0].resolve(false);
	await picker.flush();
	assert.equal(picker.pressed(), "read-only");
	// A rejected request fails the same way.
	picker.press("workspace-write");
	assert.equal(picker.requests.length, 2);
	picker.requests[1].reject(new Error("offline"));
	await picker.flush();
	assert.equal(picker.pressed(), "read-only");
});

test("the last remembered pick wins; it is sent once even when it repeats the sent one", async () => {
	const picker = mountPicker({ catalog: { options: OPTIONS }, saved: "read-only" });
	picker.press("workspace-write");
	picker.press("danger-full-access");
	picker.press("workspace-write");
	assert.equal(picker.requests.length, 1);
	picker.requests[0].resolve(true);
	picker.rerender({ saved: "workspace-write" });
	await picker.flush();
	assert.equal(picker.requests.length, 1, "the pick that repeats the sent one is not sent again");
	assert.equal(picker.pressed(), "workspace-write");
});

test("repick still lets the shown preset be picked again", async () => {
	const picker = mountPicker({ catalog: { options: OPTIONS }, saved: "read-only" }, true);
	picker.press("read-only");
	assert.equal(picker.requests.length, 1);
	assert.equal(picker.requests[0].value, "read-only");
	picker.requests[0].resolve(true);
	await picker.flush();
});

// ---------------------------------------------------------------------------
// The Bot settings form: which switches the host accepts.

function walk(node: any, found: any[] = []): any[] {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, found);
		return found;
	}
	if (node === null || node === undefined || typeof node !== "object") return found;
	found.push(node);
	walk(node.props?.children, found);
	return found;
}

function settingsNodes(bot: any, options: { main?: boolean; rooms?: any[] } = {}): any[] {
	const { BotSettingsForm } = helpers();
	const roster: any = {
		mainBotIds: options.main ? [bot.id] : [],
		mainBotId: options.main ? bot.id : null,
		rooms: options.rooms ?? [],
		models: [],
		memory: false,
	};
	return walk(BotSettingsForm({ bot, roster, actions: {}, run: (fn: any) => fn }));
}

const SETTINGS_BOT = { id: "b", name: "Writer", role: "Writer", instructions: "", capabilities: [] };

test("the Private switch is enabled only for a state the host accepts", () => {
	const byLabel = (tree: any[], label: string): any => tree.find((node) => node.props?.label === label);
	const noFolder = byLabel(settingsNodes(SETTINGS_BOT), "Private");
	assert.equal(noFolder.props.disabled, true);
	assert.equal(noFolder.props.hint, "Choose a working folder of its own first.");

	const grouped = byLabel(
		settingsNodes({ ...SETTINGS_BOT, workDir: "/work" }, { rooms: [{ id: "r", members: ["b"] }] }),
		"Private",
	);
	assert.equal(grouped.props.disabled, true);
	assert.equal(grouped.props.hint, "Leave its group chats before making it private.");

	const main = byLabel(settingsNodes({ ...SETTINGS_BOT, workDir: "/work" }, { main: true }), "Private");
	assert.equal(main.props.disabled, true);
	assert.equal(main.props.hint, "A Main Bot cannot be private.");

	const allowed = byLabel(settingsNodes({ ...SETTINGS_BOT, workDir: "/work" }), "Private");
	assert.equal(allowed.props.disabled, false);
	assert.equal(allowed.props.on, false);
});

test("a private Bot can always turn privacy off, and cannot become Main or be duplicated", () => {
	const tree = settingsNodes({ ...SETTINGS_BOT, workDir: "/work", private: true });
	const privacy = tree.find((node) => node.props?.label === "Private");
	assert.equal(privacy.props.on, true);
	assert.equal(privacy.props.disabled, false);
	assert.equal(tree.find((node) => node.props?.label === "Main Bot").props.disabled, true);
	const duplicate = tree.find(
		(node) =>
			node.props?.onClick &&
			node.props.className === "bt-set-row bt-bs-row" &&
			JSON.stringify(node).includes("Duplicate"),
	);
	assert.equal(duplicate, undefined);
});
