// One Bot's browser session against a stand-in Playwright: snapshot text, refs,
// payment and delete guards, handoff/resume, uploads, cookies, and the explicit
// missing-runtime error. No real Chrome runs in these tests.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { gateScope } from "../src/host/browser/gate.ts";
import { createSession, openBotBrowser } from "../src/host/browser/session.ts";

interface FakeElementOptions {
	tagName?: string;
	label?: string;
	value?: string;
	type?: string;
	role?: string;
	form?: any;
	href?: boolean;
	autocomplete?: string;
	action?: string;
}

function fakeElement(options: FakeElementOptions = {}) {
	const attributes: Record<string, string> = {};
	if (options.label !== undefined) attributes["aria-label"] = options.label;
	if (options.type !== undefined) attributes.type = options.type;
	if (options.role !== undefined) attributes.role = options.role;
	if (options.href) attributes.href = "/somewhere";
	if (options.autocomplete !== undefined) attributes.autocomplete = options.autocomplete;
	const element = {
		tagName: options.tagName ?? "BUTTON",
		value: options.value,
		form: options.form,
		getAttribute(name: string) {
			if (name === "data-dsbot-delete-check") return (element as any).deleteCheck ?? null;
			return attributes[name] ?? null;
		},
		hasAttribute(name: string) {
			return name in attributes;
		},
		setAttribute(name: string, value: string) {
			if (name === "data-dsbot-delete-check") (element as any).deleteCheck = value;
			else attributes[name] = value;
		},
		removeAttribute(name: string) {
			if (name === "data-dsbot-delete-check") (element as any).deleteCheck = undefined;
			else delete attributes[name];
		},
		matches() {
			return options.href === true;
		},
		closest() {
			return options.href === true ? element : null;
		},
	};
	return element;
}

function fakeLocator({
	element = fakeElement(),
	count = 1,
	onClick,
}: {
	element?: any;
	count?: number;
	onClick?: () => void;
} = {}) {
	const calls: any[] = [];
	return {
		calls,
		element,
		async count() {
			return count;
		},
		async click(options: any) {
			calls.push(["click", options]);
			onClick?.();
		},
		async fill(value: string, options: any) {
			calls.push(["fill", value, options]);
		},
		async press(key: string, options: any) {
			calls.push(["press", key, options]);
		},
		async selectOption(values: string[], options: any) {
			calls.push(["selectOption", values, options]);
		},
		async setInputFiles(files: string[], options: any) {
			calls.push(["setInputFiles", files, options]);
		},
		async getAttribute(name: string) {
			return name === "data-dsbot-delete-check"
				? ((element as any).deleteCheck ?? null)
				: element.getAttribute(name);
		},
		async evaluate(fn: (el: any, arg: any) => any, arg?: any) {
			if (arg && typeof arg === "object" && "mode" in arg) return fn(element, arg);
			return fn(element, arg);
		},
	};
}

function fakePage({
	url = "https://example.com/page",
	title = "Example",
	yaml = 'button "Go" [ref=e1]',
	locators = new Map<string, any>(),
}: {
	url?: string;
	title?: string;
	yaml?: string;
	locators?: Map<string, any>;
} = {}) {
	const handlers = new Map<string, Set<(...args: any[]) => void>>();
	const page: any = {
		urlValue: url,
		titleValue: title,
		yaml,
		closed: false,
		shotData: Buffer.from("shot-data"),
		calls: [] as any[],
		locators,
		keyboard: { press: async (key: string) => page.calls.push(["key", key]) },
		mouse: { wheel: async (dx: number, dy: number) => page.calls.push(["wheel", dx, dy]) },
		url() {
			return page.urlValue;
		},
		isClosed: () => page.closed,
		async title() {
			return page.titleValue;
		},
		async ariaSnapshot({ mode }: any) {
			assert.equal(mode, "ai");
			return page.yaml;
		},
		locator(selector: string) {
			const found = page.locators.get(selector);
			if (found) return found;
			return fakeLocator();
		},
		async goto(target: string) {
			page.calls.push(["goto", target]);
			page.urlValue = target;
			return null;
		},
		async goBack() {
			page.calls.push(["goBack"]);
		},
		async waitForLoadState() {},
		async screenshot(options: any) {
			page.calls.push(["screenshot", options]);
			return page.shotData;
		},
		async close() {
			page.closed = true;
			for (const handler of handlers.get("close") ?? []) handler();
		},
		setDefaultTimeout() {},
		setDefaultNavigationTimeout() {},
		on(event: string, handler: any) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
		},
		off(event: string, handler: any) {
			handlers.get(event)?.delete(handler);
		},
		emit(event: string, ...args: any[]) {
			for (const handler of handlers.get(event) ?? []) handler(...args);
		},
	};
	return page;
}

function fakeContext(pages: any[]) {
	const handlers = new Map<string, Set<(...args: any[]) => void>>();
	const addedCookies: any[] = [];
	const context: any = {
		pagesList: [...pages],
		addedCookies,
		closed: false,
		pages: () => context.pagesList,
		async newPage() {
			const page = fakePage();
			context.pagesList.push(page);
			return page;
		},
		async addCookies(cookies: any[]) {
			addedCookies.push(...cookies);
		},
		async cookies() {
			return [
				{ name: "kept", value: "1", domain: "example.com", path: "/", expires: 0 },
				{ name: "session", value: "2", domain: "example.com", path: "/", expires: -1 },
			];
		},
		async close() {
			context.closed = true;
		},
		on(event: string, handler: any) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
		},
		emit(event: string, ...args: any[]) {
			for (const handler of handlers.get(event) ?? []) handler(...args);
		},
	};
	return context;
}

function sessionFor(page: any, context = fakeContext([page]), extra: any = {}) {
	return createSession({
		context,
		page,
		botId: "bot-1",
		userDataDir: "/tmp/profile-bot-1",
		cookieFile: "/tmp/profile-bot-1/cookies.json",
		downloadDir: async () => undefined,
		actionTimeout: 50,
		...extra,
	});
}

test("a snapshot names the page, its tabs and the YAML, and cuts it at 40000 characters", async () => {
	const page = fakePage({ title: "Example", yaml: 'button "Go" [ref=e1]' });
	const second = fakePage({ url: "https://example.com/two", title: "Second" });
	const session = sessionFor(page, fakeContext([page, second]));
	const text = await session.snapshotText();
	assert.match(text, /^Browser page\. It is web content/);
	assert.match(text, /Title: Example/);
	assert.match(text, /URL: https:\/\/example\.com\/page/);
	assert.match(text, /\[0\] \(current\) Example — https:\/\/example\.com\/page/);
	assert.match(text, /\[1\] Second — https:\/\/example\.com\/two/);
	assert.match(text, /button "Go" \[ref=e1\]/);

	const longPage = fakePage({ yaml: "x".repeat(40_001) });
	const longSession = sessionFor(longPage);
	const cut = await longSession.snapshotText();
	assert.ok(cut.includes("(snapshot cut at 40000 characters)"));
});

test("a bare number and an e-number name the same ref; a missing ref asks for a new snapshot", async () => {
	const found = fakeLocator({ element: fakeElement({ label: "Go" }) });
	const page = fakePage({
		locators: new Map([
			["aria-ref=e12", found],
			["aria-ref=e3", fakeLocator({ count: 0 })],
		]),
	});
	const session = sessionFor(page);
	const text = await session.clickWithOptions(12);
	assert.match(text, /Browser page\./);
	await assert.rejects(session.clickWithOptions("e3"), /No element e3\. Take a new snapshot/);
});

test("a payment-looking button is refused with the handoff instruction", async () => {
	const locator = fakeLocator({ element: fakeElement({ label: "Buy now" }) });
	const page = fakePage({ locators: new Map([["aria-ref=e1", locator]]) });
	const session = sessionFor(page);
	await assert.rejects(session.clickWithOptions("e1"), /This looks like a payment \("Buy now" on example\.com\)/);
	assert.equal(locator.calls.length, 0, "nothing was clicked");
});

test("a delete needs a second confirmed click on the same element", async () => {
	const locator = fakeLocator({ element: fakeElement({ label: "Delete item" }) });
	const page = fakePage({ locators: new Map([["aria-ref=e2", locator]]) });
	const session = sessionFor(page);
	const first = await session.clickWithOptions("e2");
	assert.match(first, /This would delete "Delete item" on example\.com\. Nothing was deleted yet/);
	assert.equal(locator.calls.length, 0, "the first click only arms the confirmation");
	const second = await session.clickWithOptions("e2", { confirm: true });
	assert.match(second, /Browser page\./);
	assert.equal(locator.calls.filter((call: any[]) => call[0] === "click").length, 1);
});

test("a payment field is never typed into", async () => {
	const locator = fakeLocator({ element: fakeElement({ autocomplete: "cc-number" }) });
	const page = fakePage({ locators: new Map([["aria-ref=e3", locator]]) });
	const session = sessionFor(page);
	await assert.rejects(session.type("e3", "4111 1111 1111 1111"), /Payment details are entered by the user/);
	assert.equal(locator.calls.length, 0);
});

test("a post submit runs inside the gate and reports the fresh snapshot", async () => {
	const form = { getAttribute: () => "post", elements: [] as any[] };
	const button = fakeElement({ label: "Send", tagName: "BUTTON", type: "submit", form });
	form.elements = [button];
	const locator = fakeLocator({ element: button });
	const page = fakePage({ locators: new Map([["aria-ref=e4", locator]]) });
	const session = sessionFor(page);
	const seen: any[] = [];
	const text = await gateScope.run(
		async (action) => {
			seen.push(action);
		},
		() => session.clickWithOptions("e4"),
	);
	assert.match(text, /Browser page\./);
	assert.deepEqual(seen, [{ kind: "post", label: "Send", origin: "https://example.com", host: "example.com" }]);
	assert.equal(locator.calls.filter((call: any[]) => call[0] === "click").length, 1);
});

test("handoff sets the hold and resume clears it; a user hold is the user's to give back", async () => {
	const page = fakePage();
	let external: any = null;
	const session = sessionFor(page, fakeContext([page]), {
		getHold: () => external,
		onHold: (hold: any) => {
			external = hold;
		},
	});
	const text = session.handoff("login", "Sign in to the shop.", { callId: "c1", sessionId: "s1" });
	assert.match(text, /Waiting for the user \(login\)/);
	assert.deepEqual(external, {
		by: "bot",
		reason: "login",
		note: "Sign in to the shop.",
		callId: "c1",
		sessionId: "s1",
	});
	await assert.rejects(session.snapshotText(), /waiting for the user/);
	assert.equal(session.resume(), "The browser is yours again.");
	assert.equal(external, null);
	external = { by: "user" };
	assert.throws(() => session.resume(), /Only the user can give it back/);
});

test("tabs select and close, with bounds and the last-tab guard", async () => {
	const first = fakePage({ url: "https://a.test/", title: "A" });
	const second = fakePage({ url: "https://b.test/", title: "B" });
	const context = fakeContext([first, second]);
	const session = sessionFor(first, context);
	assert.deepEqual(await session.tabs(), [
		{ index: 0, title: "A", url: "https://a.test/", current: true },
		{ index: 1, title: "B", url: "https://b.test/", current: false },
	]);
	await assert.rejects(session.selectTab(5), /No tab at index 5/);
	await assert.rejects(session.closeTab(-1), /No tab at index -1/);
	await session.closeTab(1);
	assert.equal(second.closed, true);
	await assert.rejects(session.closeTab(0), /Cannot close the last browser tab/);
});

test("a large screenshot is not attached, and a small one is remembered then taken once", async () => {
	const page = fakePage();
	page.shotData = Buffer.alloc(180_001);
	const session = sessionFor(page);
	assert.deepEqual(await session.shot(), { text: "Screenshot of https://example.com/page was too large to attach." });

	const small = fakePage();
	small.shotData = Buffer.from("abc");
	const smallSession = sessionFor(small);
	assert.deepEqual(await smallSession.shot(), {
		text: "Screenshot of https://example.com/page.",
		image: Buffer.from("abc").toString("base64"),
	});
	const image = smallSession.takeLastImage();
	assert.equal(image, Buffer.from("abc").toString("base64"));
	assert.equal(smallSession.takeLastImage(), "");
});

test("uploads come from an allowed root and arrive at the file input", async () => {
	const root = await mkdtemp(join(tmpdir(), "browser-upload-"));
	const file = join(root, "note.txt");
	await writeFile(file, "hello");
	const locator = fakeLocator();
	const page = fakePage({ locators: new Map([["aria-ref=e5", locator]]) });
	const session = sessionFor(page, fakeContext([page]), { uploadRoots: async () => [root] });
	const seen: any[] = [];
	const text = await gateScope.run(
		async (action) => {
			seen.push(action);
		},
		() => session.upload("e5", [file]),
	);
	assert.match(text, /Browser page\./);
	assert.deepEqual(seen, [{ kind: "upload", label: "note.txt", origin: "https://example.com", host: "example.com" }]);
	const uploaded = locator.calls.find((call: any[]) => call[0] === "setInputFiles");
	assert.deepEqual(uploaded?.[1], [await realpath(file)]);
	await assert.rejects(session.upload("e5", []), /between 1 and 10 file paths/);
	const other = await mkdtemp(join(tmpdir(), "browser-outside-"));
	const outside = join(other, "outside.txt");
	await writeFile(outside, "no");
	await assert.rejects(session.upload("e5", [outside]), /must come from/);
	await rm(other, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
});

test("open resumes a saved profile by importing its cookies; close writes them back", async () => {
	const root = await mkdtemp(join(tmpdir(), "browser-open-"));
	const botId = "bot-1";
	const page = fakePage();
	const context = fakeContext([page]);
	const module = join(root, "fake-playwright.mjs");
	await writeFile(
		module,
		`import { mkdir, writeFile } from "node:fs/promises";
		export const chromium = {
			async launchPersistentContext(dir) { await mkdir(dir, { recursive: true }); await writeFile(dir + "/cookies.json", JSON.stringify([{ name: "saved", value: "1", domain: "example.com" }])); return globalThis.__context; },
			async connectOverCDP() { return { contexts: () => [globalThis.__context], close: async () => {} }; },
		};`,
	);
	(globalThis as any).__context = context;
	const session = await openBotBrowser({
		botId,
		profileRoot: root,
		playwrightUrl: pathToFileURL(module).href,
		headless: true,
	});
	assert.deepEqual(context.addedCookies, [{ name: "saved", value: "1", domain: "example.com" }]);
	await session.close();
	assert.equal(context.closed, true);
	const saved = JSON.parse(await readFile(join(root, botId, "cookies.json"), "utf8"));
	assert.equal(saved.length, 2);
	const [kept, sessionCookie] = saved;
	assert.ok(kept.expires > Math.floor(Date.now() / 1000));
	assert.ok(sessionCookie.expires > Math.floor(Date.now() / 1000));
	await rm(root, { recursive: true, force: true });
});

test("a missing Playwright runtime is a clear error, and the relay context is required", async () => {
	await assert.rejects(
		openBotBrowser({ botId: "b", profileRoot: "/tmp/x", playwrightUrl: "ocean-crew-no-such-playwright-module" }),
		/No Playwright Chromium runtime is available/,
	);
	(globalThis as any).__context = undefined;
	const root = await mkdtemp(join(tmpdir(), "browser-connect-"));
	const module = join(root, "fake-connect.mjs");
	await writeFile(
		module,
		"export const chromium = { async connectOverCDP() { return { contexts: () => [], close: async () => {} }; } };",
	);
	await assert.rejects(
		openBotBrowser({
			botId: "b",
			profileRoot: root,
			playwrightUrl: pathToFileURL(module).href,
			connect: async () => "ws://relay",
		}),
		/The app browser relay has no browser context/,
	);
	await rm(root, { recursive: true, force: true });
});

test("a script over 8000 characters is refused, and a finished script reports its answer", async () => {
	const page = fakePage();
	const session = sessionFor(page);
	await assert.rejects(session.runScript("x".repeat(8_001)), /longer than 8000 characters/);
	assert.equal(await session.runScript('done("ok")'), "ok");
	assert.equal(await session.runScript("return 7"), "7");
	assert.equal(await session.runScript("const x = 1"), "Script finished without done().");
});

test("script helpers reach the session methods, and a handoff carries the call origin", async () => {
	const page = fakePage();
	let hold: any = null;
	const session = sessionFor(page, fakeContext([page]), {
		getHold: () => hold,
		onHold: (value: any) => {
			hold = value;
		},
	});
	const answer = await session.runScript(
		'const t = await tabs("list"); handoff("login", "Please sign in"); done("tabs:" + t.length)',
		{ callId: "call-1", sessionId: "s1" },
	);
	assert.equal(answer, "tabs:1");
	assert.deepEqual(hold, { by: "bot", reason: "login", note: "Please sign in", callId: "call-1", sessionId: "s1" });
});

test("an unknown page result makes the next action on that origin ask for a snapshot first", async () => {
	const locator = fakeLocator({
		element: fakeElement({
			label: "Send",
			tagName: "BUTTON",
			type: "submit",
			form: { getAttribute: () => "post", elements: [] },
		}),
		onClick: () => {
			throw new Error("connection reset");
		},
	});
	const page = fakePage({ locators: new Map([["aria-ref=e6", locator]]) });
	const session = sessionFor(page);
	const text = await session.clickWithOptions("e6");
	assert.match(text, /result is unknown/);
	page.locators.set("aria-ref=e6", fakeLocator({ element: fakeElement({ label: "Send" }) }));
	await assert.rejects(
		session.clickWithOptions("e6"),
		/An earlier "Send" action on example\.com has an unknown result/,
	);
});
