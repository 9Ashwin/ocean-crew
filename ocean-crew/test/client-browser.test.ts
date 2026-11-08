// The browser half's state machine: address-bar input, per-Bot tab strips, saved-strip
// restore and migration, guest placement, and the long poll that answers read_browser.
// The panel and settings components are React and are covered by tsc/build, not here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE } from "../src/client/core/storage.ts";
import {
	blockedAddress,
	browserAddress,
	createBotBrowsers,
	PREVIEW_SCRIPT,
	READ_PAGE_SCRIPT,
	serveBrowserReads,
} from "../src/client/pages/bot-browsers.ts";

function createSource<T>(initial: T) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: (): T => value,
		subscribe: (listener: () => void): (() => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next: T | ((previous: T) => T)): void {
			const resolved = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
			if (resolved === value) return;
			value = resolved;
			for (const listener of [...listeners]) listener();
		},
	};
}

// Just enough of a webview: attributes, listeners, navigation state. capturePage only
// records a call: the plugin must never make one (it crashes the app renderer on Windows).
function fakeWebview() {
	const listeners: Record<string, Set<(event: any) => void>> = {};
	const element: any = {
		dataset: {},
		style: {},
		attributes: {},
		isConnected: true,
		url: "",
		loads: [] as string[],
		stopped: false,
		captured: false,
		setAttribute(name: string, value: string) {
			this.attributes[name] = value;
			if (name === "src") this.url = value;
		},
		addEventListener(name: string, listener: (event: any) => void, { signal }: { signal?: AbortSignal } = {}) {
			let set = listeners[name];
			if (set === undefined) {
				set = new Set();
				listeners[name] = set;
			}
			set.add(listener);
			signal?.addEventListener("abort", () => listeners[name]?.delete(listener));
		},
		emit(name: string, event: any = {}) {
			for (const listener of listeners[name] ?? []) listener(event);
		},
		remove() {
			this.isConnected = false;
		},
		getURL: () => element.url,
		getTitle: () => `Title of ${element.url}`,
		isLoading: () => false,
		canGoBack: () => false,
		canGoForward: () => false,
		clearHistory() {},
		stop() {
			this.stopped = true;
		},
		goBack() {},
		goForward() {},
		reload() {
			this.reloaded = true;
		},
		focus() {
			this.focused = true;
		},
		async capturePage() {
			this.captured = true;
			return null;
		},
		async loadURL(url: string) {
			this.loads.push(url);
			this.url = url;
			this.emit("did-navigate");
		},
		async executeJavaScript() {
			return { url: this.url, title: element.getTitle(), text: "hello", items: [] };
		},
	};
	return element;
}

function fakeDesktop() {
	const created: any[] = [];
	const released: string[] = [];
	const openHandlers: Record<string, (url: string) => void> = {};
	let lease = 0;
	const doc = {
		body: { append() {} },
		createElement(tag: string) {
			if (tag === "webview") {
				const view = fakeWebview();
				created.push(view);
				return view;
			}
			return { className: "", style: {}, isConnected: true, append() {}, remove() {} };
		},
	};
	const bridge = {
		acquire: async (workspace: string) => ({ lease: `lease-${++lease}`, partition: `persist:${workspace}` }),
		release: async (id: string) => {
			released.push(id);
		},
		onOpenRequested: (leaseId: string, handler: (url: string) => void) => {
			openHandlers[leaseId] = handler;
			return () => {
				delete openHandlers[leaseId];
			};
		},
	};
	const store = new Map<string, string>();
	const storage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key),
	};
	return { doc, bridge, storage, created, released, openHandlers };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const BOX = { left: 600, top: 90, width: 500, height: 700 };

const browsersFor = (desktop: ReturnType<typeof fakeDesktop>) =>
	createBotBrowsers({
		bridge: desktop.bridge,
		createSource,
		storage: desktop.storage as any,
		document: desktop.doc as any,
	});

test("an address-bar entry becomes a URL, a local address, or a web search", () => {
	assert.equal(browserAddress("https://example.com/a?b=1"), "https://example.com/a?b=1");
	assert.equal(browserAddress("http://example.com"), "http://example.com/");
	assert.equal(browserAddress("example.com"), "https://example.com/");
	assert.equal(browserAddress("docs.python.org/3/library"), "https://docs.python.org/3/library");
	assert.equal(browserAddress("localhost:5173"), "http://localhost:5173/");
	assert.equal(browserAddress("192.168.1.8/admin"), "http://192.168.1.8/admin");
	assert.equal(browserAddress("127.0.0.1:8080"), "http://127.0.0.1:8080/");
	assert.equal(browserAddress("deepseek harness"), "https://www.bing.com/search?q=deepseek%20harness");
	assert.equal(
		browserAddress("小红书 运营"),
		"https://www.bing.com/search?q=%E5%B0%8F%E7%BA%A2%E4%B9%A6%20%E8%BF%90%E8%90%A5",
	);
	assert.equal(browserAddress("  "), null);
	assert.equal(browserAddress("file:///etc/passwd"), null);
	assert.equal(browserAddress("javascript:alert(1)"), null);
	assert.equal(browserAddress("ftp://example.com"), null);
	assert.equal(browserAddress(undefined), null);
});

test("cloud metadata addresses are the only hosts refused for safety", () => {
	assert.equal(blockedAddress("http://169.254.169.254/latest/meta-data"), true);
	assert.equal(blockedAddress("http://metadata.google.internal/"), true);
	assert.equal(blockedAddress("https://example.com/"), false);
	assert.equal(blockedAddress("not a url"), false);
});

test("each Bot gets its own partition, and only the shown tab is visible", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const a = browsers.openTab("a");
	const b = browsers.openTab("b");
	await browsers.show(a, BOX);
	await browsers.show(b, BOX);
	const [va, vb] = desktop.created;
	assert.equal(va.attributes.partition, "persist:bot:a");
	assert.equal(vb.attributes.partition, "persist:bot:b");
	// Agent mode withdraws the Bot styles; a guest must still stay out of the page flow.
	assert.equal(va.style.position, "fixed");
	assert.equal(va.style.visibility, "hidden");
	assert.equal(vb.style.visibility, "visible");
	// Hidden while the panel shows its own state, but kept at the panel's size.
	await browsers.show(b);
	assert.equal(vb.style.visibility, "hidden");
	assert.equal(vb.style.width, "500px");
	browsers.dispose();
});

test("openTab activates the new tab; closing the active one activates a neighbor", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const t1 = browsers.openTab("a");
	const t2 = browsers.openTab("a");
	const t3 = browsers.openTab("a");
	assert.deepEqual(browsers.tabs.getSnapshot().a, { ids: [t1, t2, t3], active: t3 });
	browsers.activate("a", t1);
	assert.equal(browsers.tabs.getSnapshot().a.active, t1);
	await browsers.closeTab("a", t1);
	assert.deepEqual(browsers.tabs.getSnapshot().a, { ids: [t2, t3], active: t2 });
	await browsers.closeTab("a", t3);
	assert.equal(browsers.tabs.getSnapshot().a.active, t2);
	await browsers.closeTab("a", t2);
	assert.equal(browsers.tabs.getSnapshot().a, undefined);
	// Another Bot's strip is untouched.
	const other = browsers.openTab("b");
	await browsers.closeTab("b", "not-a-tab");
	assert.deepEqual(browsers.tabs.getSnapshot().b.ids, [other]);
	browsers.dispose();
});

test("a navigation before the guest is ready waits for dom-ready, and the address is saved", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const tab = browsers.openTab("a");
	assert.equal(await browsers.navigate(tab, "example.com"), true);
	const [view] = desktop.created;
	assert.deepEqual(view.loads, []);
	view.emit("dom-ready");
	assert.deepEqual(view.loads, ["https://example.com/"]);
	assert.equal(browsers.pages.getSnapshot()[tab].url, "https://example.com/");
	assert.deepEqual(browsers.openPages(), {
		a: { url: "https://example.com/", title: "Title of https://example.com/" },
	});
	// A new manager (a reload of the app) restores the saved strip.
	const again = browsersFor(desktop);
	again.ensureTabs("a");
	const restored = again.tabs.getSnapshot().a;
	assert.equal(restored.ids.length, 1);
	assert.equal(restored.active, restored.ids[0]);
	await again.show(restored.active, BOX);
	desktop.created.at(-1).emit("dom-ready");
	assert.deepEqual(desktop.created.at(-1).loads, ["https://example.com/"]);
	assert.equal(await browsers.navigate(tab, "file:///etc/passwd"), false);
	assert.match(browsers.pages.getSnapshot()[tab].error as string, /http/);
	// Cloud metadata stays shut, typed or reached by a link; LAN pages open.
	assert.equal(await browsers.navigate(tab, "169.254.169.254/latest/meta-data"), false);
	assert.match(browsers.pages.getSnapshot()[tab].error as string, /metadata/);
	view.emit("did-start-navigation", { isMainFrame: true, url: "http://169.254.169.254/" });
	assert.equal(view.stopped, true);
	assert.equal(await browsers.navigate(tab, "192.168.1.8"), true);
	assert.equal(browsers.pages.getSnapshot()[tab].error, null);
	browsers.dispose();
	again.dispose();
});

test("a read reaches the Bot's active tab", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const t1 = browsers.openTab("a");
	const t2 = browsers.openTab("a");
	await browsers.navigate(t1, "one.example.com");
	await browsers.navigate(t2, "two.example.com");
	for (const view of desktop.created) view.emit("dom-ready");
	let page = await browsers.read("a");
	assert.equal(page.url, "https://two.example.com/");
	browsers.activate("a", t1);
	page = await browsers.read("a");
	assert.equal(page.url, "https://one.example.com/");
	browsers.dispose();
});

test("a page that asks for a new window opens a new tab in the same Bot", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const tab = browsers.openTab("a");
	await browsers.show(tab, BOX);
	const [view] = desktop.created;
	view.emit("dom-ready");
	desktop.openHandlers[view.attributes.name]("https://pop.example.com/");
	await tick();
	const state = browsers.tabs.getSnapshot().a;
	assert.equal(state.ids.length, 2);
	const popped = state.ids[1];
	assert.equal(state.active, popped);
	await tick();
	// The popup tab loads its address in the same Bot partition.
	const guest = desktop.created.at(-1);
	assert.equal(guest.attributes.partition, "persist:bot:a");
	guest.emit("dom-ready");
	assert.deepEqual(guest.loads, ["https://pop.example.com/"]);
	browsers.dispose();
});

test("retain forgets Bots that are gone, saved tabs included", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const ta = browsers.openTab("a");
	const tb = browsers.openTab("b");
	await browsers.navigate(ta, "example.com");
	await browsers.navigate(tb, "example.org");
	for (const view of desktop.created) view.emit("dom-ready");
	await browsers.retain(["a"]);
	assert.equal(browsers.tabs.getSnapshot().b, undefined);
	assert.equal(browsers.pages.getSnapshot()[tb], undefined);
	assert.deepEqual(Object.keys(JSON.parse(desktop.storage.getItem(STORAGE.browsers) as string)), ["a"]);
	assert.equal(desktop.released.length, 1);
	browsers.dispose();
});

test("a bridge that keeps logins on disk forgets a deleted Bot's storage", async () => {
	const desktop = fakeDesktop();
	const forgotten: string[] = [];
	const bridge = { ...desktop.bridge, forget: async (key: string) => forgotten.push(key) };
	const browsers = createBotBrowsers({
		bridge,
		createSource,
		storage: desktop.storage as any,
		document: desktop.doc as any,
	});
	await browsers.navigate(browsers.openTab("a"), "example.com");
	await browsers.retain(["a", "b", "c"]);
	assert.deepEqual(forgotten, []);
	// a had a tab, b never had one; both go, c stays.
	await browsers.retain(["c"]);
	assert.deepEqual(forgotten.sort(), ["bot:a", "bot:b"]);
	await browsers.retain(["c"]);
	assert.equal(forgotten.length, 2);
	browsers.dispose();
});

test("serveBrowserReads answers each request once and re-polls when the open pages change", async () => {
	const desktop = fakeDesktop();
	const browsers = browsersFor(desktop);
	const tab = browsers.openTab("a");
	await browsers.navigate(tab, "example.com");
	desktop.created[0].emit("dom-ready");
	const calls: Array<[string, any]> = [];
	const polls: Array<(value: any) => void> = [];
	const post = (endpoint: string, payload: any, signal?: AbortSignal): Promise<any> => {
		calls.push([endpoint, payload]);
		if (endpoint !== "browser-wait") return Promise.resolve(true);
		return new Promise((resolve, reject) => {
			polls.push(resolve);
			signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
		});
	};
	const stop = serveBrowserReads({ browsers, post, clientId: "w1" });
	await tick();
	assert.deepEqual(calls[0], [
		"browser-wait",
		{ clientId: "w1", open: { a: { url: "https://example.com/", title: "Title of https://example.com/" } } },
	]);
	// The same request twice (a resend) is read once; the cached answer posts again.
	polls.at(-1)?.([
		{ id: "read-1", botId: "a" },
		{ id: "read-1", botId: "a" },
	]);
	await tick();
	await tick();
	const results = calls.filter(([endpoint]) => endpoint === "browser-result");
	assert.equal(results.length, 2);
	assert.deepEqual(results[1][1], results[0][1]);
	assert.equal(results[0][1].ok, true);
	assert.equal(results[0][1].page.text, "hello");
	assert.ok((browsers.pages.getSnapshot()[tab].readAt as number) > 0);
	// A read for a Bot with no page reports the error.
	polls.at(-1)?.([{ id: "read-2", botId: "zzz" }]);
	await tick();
	await tick();
	assert.equal(calls.filter(([endpoint]) => endpoint === "browser-result").at(-1)?.[1].ok, false);
	// A new page ends the poll so the host learns at once, and the next poll reports it.
	const before = calls.filter(([endpoint]) => endpoint === "browser-wait").length;
	await browsers.navigate(tab, "example.org");
	await tick();
	assert.equal(calls.filter(([endpoint]) => endpoint === "browser-wait").length, before + 1);
	assert.equal(calls.at(-1)?.[1].open.a.url, "https://example.org/");
	stop();
	browsers.dispose();
});

test("the page reader is one valid expression, and the preview script closes cleanly", () => {
	assert.doesNotThrow(() => new Function(`return ${READ_PAGE_SCRIPT}`));
	assert.equal(typeof PREVIEW_SCRIPT, "string");
	assert.match(PREVIEW_SCRIPT, /meta\('description'\)/);
});
