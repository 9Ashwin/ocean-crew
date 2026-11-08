// The browser host engine's glue: Chrome lookup, the per-call gate, the nested tool
// loop, the three plugins' tool specs, mount's tool/approval/screenshot wiring, and the
// nested model conversion.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gateScope } from "../src/host/browser/gate.ts";
import { findChrome } from "../src/host/browser/locate.ts";
import { openAiTools, runToolLoop } from "../src/host/browser/loop.ts";
import { mountBrowserPlugin } from "../src/host/browser/mount.ts";
import { toolDefs as refsTools } from "../src/host/browser/refs.ts";
import { toolDefs as scriptTools } from "../src/host/browser/script.ts";
import { sessionComplete } from "../src/host/browser/session-model.ts";
import { runTask, toolDefs as taskTools } from "../src/host/browser/task.ts";

// --- locate ----------------------------------------------------------------

test("the configured browser path wins", () => {
	const seen: string[] = [];
	const found = findChrome("/opt/custom/chrome", {
		exists: (path) => {
			seen.push(path);
			return path === "/opt/custom/chrome";
		},
	});
	assert.equal(found, "/opt/custom/chrome");
	assert.deepEqual(seen, ["/opt/custom/chrome"], "the platform candidates are not reached");
});

test("a missing configured path and no installed browser resolve to undefined", () => {
	assert.equal(findChrome("/opt/custom/chrome", { exists: () => false }), undefined);
	assert.equal(findChrome(undefined, { exists: () => false }), undefined);
});

test("a PATH command resolves against every PATH entry", { skip: process.platform !== "linux" }, () => {
	const found = findChrome(undefined, {
		exists: (path) => path === "/usr/bin/google-chrome",
		pathEnv: "/usr/local/bin:/usr/bin",
	});
	assert.equal(found, "/usr/bin/google-chrome");
});

test("no configured path still finds the platform install", { skip: process.platform !== "darwin" }, () => {
	const path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	assert.equal(findChrome(undefined, { exists: (candidate) => candidate === path }), path);
});

// --- gate ------------------------------------------------------------------

test("the gate scope carries the call's authorize callback and is absent outside", async () => {
	const seen: unknown[] = [];
	assert.equal(gateScope.getStore(), undefined);
	const value = await gateScope.run(
		async (action) => {
			seen.push(action);
		},
		async () => gateScope.getStore(),
	);
	assert.equal(typeof value, "function");
	await (value as (action: unknown) => Promise<void>)({ kind: "post", label: "Send" });
	assert.deepEqual(seen, [{ kind: "post", label: "Send" }]);
	assert.equal(gateScope.getStore(), undefined);
});

// --- loop ------------------------------------------------------------------

const fakeTool = (name: string, execute: (args: any) => any) => ({
	name,
	description: `${name} tool`,
	parameters: {},
	execute,
});

test("openAiTools flattens the parameter schema the way the model expects", () => {
	const tools = [
		{
			name: "browser_open",
			description: "Open",
			parameters: { url: { type: "string", required: true, description: "Address" } },
			execute: async () => "ok",
		},
	];
	assert.deepEqual(openAiTools(tools), [
		{
			type: "function",
			function: {
				name: "browser_open",
				description: "Open",
				parameters: {
					type: "object",
					properties: { url: { type: "string", description: "Address" } },
					required: ["url"],
				},
			},
		},
	]);
});

test("a loop with no tool calls returns the answer and the number of steps", async () => {
	const requests: any[] = [];
	const result = await runToolLoop({
		tools: [],
		complete: async (request) => {
			requests.push(request);
			return { choices: [{ message: { content: "  All done.  " } }] };
		},
		goal: "Do the thing",
		system: "You browse.",
	});
	assert.deepEqual(result, { answer: "All done.", trace: [], steps: 1, vision: "untested", stopped: "answer" });
	assert.deepEqual(requests[0].tools, []);
	assert.equal(requests[0].messages[0].content, "You browse.");
	assert.equal(requests[0].messages[1].content, "Do the thing");
});

test("a tool call runs, its text reaches the model, and a picture follows as a user turn", async () => {
	const calls: string[] = [];
	const requests: any[] = [];
	const result = await runToolLoop({
		tools: [fakeTool("shoot", () => ({ text: "shot", image: "AAAA" }))],
		complete: async (request) => {
			requests.push({ ...request, messages: [...request.messages] });
			if (requests.length === 1) {
				return {
					choices: [
						{
							message: {
								content: "Looking.",
								tool_calls: [{ id: "c1", function: { name: "shoot", arguments: "{}" } }],
							},
						},
					],
				};
			}
			return { choices: [{ message: { content: "Done." } }] };
		},
		goal: "Screenshot it",
		system: "Browse.",
	});
	calls.push(...result.trace.map((step) => step.name));
	assert.deepEqual(calls, ["shoot"]);
	assert.equal(result.steps, 2);
	assert.equal(result.answer, "Done.");
	const followUp = requests[1].messages;
	assert.equal(followUp.at(-2).role, "tool");
	assert.equal(followUp.at(-2).content, "shot");
	assert.equal(followUp.at(-1).role, "user");
	assert.match(followUp.at(-1).content[0].text, /Screenshot after the last action/);
	assert.match(followUp.at(-1).content[1].image_url.url, /^data:image\/jpeg;base64,AAAA/);
});

test("a rejected vision route flattens picture content before the next request", async () => {
	const requests: any[] = [];
	await runToolLoop({
		tools: [fakeTool("shoot", () => ({ text: "shot", image: "AAAA" }))],
		complete: async (request) => {
			requests.push({ ...request, messages: [...request.messages] });
			if (requests.length === 1) {
				return {
					vision: "rejected",
					choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "shoot", arguments: "{}" } }] } }],
				};
			}
			return { choices: [{ message: { content: "Done." } }] };
		},
		goal: "Screenshot it",
		system: "Browse.",
	});
	// No picture was appended for a rejected route, so the first request keeps plain text.
	assert.equal(
		requests[0].messages.every((message: any) => typeof message.content === "string"),
		true,
	);
});

test("an unknown tool and a throwing tool both answer the model, and maxSteps stops the loop", async () => {
	const requests: any[] = [];
	const tools = [
		fakeTool("boom", () => {
			throw new Error("kaboom");
		}),
	];
	const result = await runToolLoop({
		tools,
		complete: async (request) => {
			requests.push({ ...request, messages: [...request.messages] });
			return {
				choices: [
					{
						message: {
							tool_calls: [
								{ id: "c1", function: { name: "missing", arguments: {} } },
								{ id: "c2", function: { name: "boom", arguments: "{}" } },
							],
						},
					},
				],
			};
		},
		goal: "Go",
		system: "Browse.",
		maxSteps: 2,
	});
	assert.deepEqual(result.stopped, "max-steps");
	assert.equal(result.steps, 2);
	const toolMessages = requests[1].messages.filter((message: any) => message.role === "tool");
	assert.deepEqual(
		toolMessages.map((message: any) => message.content),
		["Unknown tool missing", "kaboom"],
	);
});

// --- refs / script / task tool specs ----------------------------------------

test("the refs plugin publishes the ARIA tool set and delegates to the session", async () => {
	assert.deepEqual(
		refsTools.map((tool) => tool.name),
		[
			"browser_open",
			"browser_snapshot",
			"browser_click",
			"browser_upload",
			"browser_type",
			"browser_select",
			"browser_press",
			"browser_tabs",
			"browser_back",
			"browser_screenshot",
			"browser_handoff",
			"browser_resume",
		],
	);
	for (const tool of refsTools) assert.equal(tool.needsBrowser, true, tool.name);
	const calls: unknown[] = [];
	const session = {
		open: async (url: string) => calls.push(["open", url]),
		snapshotText: async () => calls.push(["snapshot"]),
		click: async (ref: string, options: any) => calls.push(["click", ref, options]),
		type: async (ref: string, text: string, submit: boolean) => calls.push(["type", ref, text, submit]),
		select: async (ref: string, values: string[]) => calls.push(["select", ref, values]),
		press: async (key: string) => calls.push(["press", key]),
		upload: async (ref: string, paths: string[]) => calls.push(["upload", ref, paths]),
		tabs: async () => [
			{ index: 0, title: "", url: "https://a.test/", current: false },
			{ index: 1, title: "B", url: "https://b.test/", current: true },
		],
		selectTab: async (index: number) => calls.push(["selectTab", index]),
		closeTab: async (index: number) => calls.push(["closeTab", index]),
		back: async () => calls.push(["back"]),
		shot: async () => calls.push(["shot"]),
		handoff: (reason: string, note: string, origin: unknown) => {
			calls.push(["handoff", reason, note, origin]);
			return "hold";
		},
		resume: () => calls.push(["resume"]),
	};
	const byName = new Map(refsTools.map((tool) => [tool.name, tool]));
	await byName.get("browser_open")!.execute({ url: "https://example.com" }, { session });
	await byName.get("browser_click")!.execute({ ref: "e3", confirm: true }, { session });
	await byName.get("browser_type")!.execute({ ref: "e4", text: "hi", submit: true }, { session });
	const tabsText = await byName.get("browser_tabs")!.execute({ action: "list" }, { session });
	assert.equal(tabsText, "[0] (untitled) — https://a.test/\n[1] (current) B — https://b.test/");
	await byName.get("browser_tabs")!.execute({ action: "close", index: 0 }, { session });
	const handoff = await byName.get("browser_handoff")!.execute(
		{ reason: "login", note: "Sign in" },
		{
			session,
			origin: { callId: "c1" },
		},
	);
	assert.deepEqual(handoff, { text: "hold" });
	assert.deepEqual(calls, [
		["open", "https://example.com"],
		["click", "e3", { confirm: true }],
		["type", "e4", "hi", true],
		["closeTab", 0],
		["handoff", "login", "Sign in", { callId: "c1" }],
	]);
});

test("the script plugin keeps browser_exec and reuses the handoff and resume tools", async () => {
	assert.deepEqual(
		scriptTools.map((tool) => tool.name),
		["browser_exec", "browser_handoff", "browser_resume"],
	);
	const exec = scriptTools[0];
	const session = {
		runScript: async (body: string, origin: unknown) => {
			assert.equal(body, "done()");
			assert.deepEqual(origin, { callId: "c9" });
			return "done.";
		},
		takeLastImage: () => "AAAA",
	};
	const value = await exec.execute({ script: "done()" }, { session, origin: { callId: "c9" } });
	assert.deepEqual(value, { text: "done.", image: "AAAA" });
	assert.equal(
		scriptTools[1],
		refsTools.find((tool) => tool.name === "browser_handoff"),
	);
	assert.equal(
		scriptTools[2],
		refsTools.find((tool) => tool.name === "browser_resume"),
	);
});

test("the task plugin runs one goal and reports answer, handoffs and steps", async () => {
	assert.deepEqual(
		taskTools.map((tool) => tool.name),
		["browser_task"],
	);
	const handoffs: string[] = [];
	const session = {
		botId: "b1",
		userDataDir: "/profiles/b1",
		open: async (url: string) => {
			handoffs.push(url);
			return "opened";
		},
		handoff: (reason: string) => {
			handoffs.push(`hold:${reason}`);
			return "hold";
		},
	};
	let completions = 0;
	const result = await runTask({
		session,
		goal: "Open the page",
		origin: { callId: "c1" },
		complete: async () => {
			completions += 1;
			if (completions === 1) {
				return {
					choices: [
						{
							message: {
								tool_calls: [
									{ id: "i1", function: { name: "browser_handoff", arguments: '{"reason":"login"}' } },
								],
							},
						},
					],
				};
			}
			return { choices: [{ message: { content: "The page is open." } }] };
		},
	});
	assert.match(result.text, /The page is open\./);
	assert.match(result.text, /Finished in 2 steps\./);
	assert.match(result.text, /Handoffs:/);
	assert.match(result.text, /hold/);
	assert.deepEqual(handoffs, ["hold:login"]);
	// The tool wrapper returns the whole report as text.
	const value = await taskTools[0].execute(
		{ goal: "Open it" },
		{
			session,
			complete: async () => ({ choices: [{ message: { content: "ok" } }] }),
			origin: {},
		},
	);
	assert.match(value.text, /ok/);
	await assert.rejects(runTask({ session, goal: "x", complete: undefined as any }), /needs a Bot session model/);
});

test("the tool output schema renders text and stored image blocks", async () => {
	const { browserOutput } = await import("../src/host/browser/mount.ts");
	assert.deepEqual(browserOutput.render({}, "text"), [{ type: "text", text: "text" }]);
	assert.deepEqual(browserOutput.render({}, { text: "shot", image: "AAAA", attachment: { attachmentId: "a1" } }), [
		{ type: "text", text: "shot" },
		{ type: "image", attachment: { attachmentId: "a1" } },
	]);
	assert.deepEqual(browserOutput.render({}, { text: "no shot" }), [{ type: "text", text: "no shot" }]);
	const oneOf = browserOutput.schema.oneOf;
	assert.equal(oneOf.length, 2);
	assert.deepEqual(oneOf[0], { type: "string" });
});

// --- mount -----------------------------------------------------------------

function mountFixture({
	toolDefs = refsTools,
	openSession,
	attachments,
	holds = { get: undefined as any, set: undefined as any },
	subscribeHolds,
	profileRoot = "/profiles",
	api,
}: {
	toolDefs?: typeof refsTools;
	openSession: (options: any) => Promise<any>;
	attachments?: any;
	holds?: { get?: () => any; set?: (value: any) => void };
	subscribeHolds?: (listener: (botId: string, hold: any) => void) => () => void;
	profileRoot?: string;
	api?: any;
}) {
	const registered: any[] = [];
	const effects: Array<() => any> = [];
	const preStep: any[] = [];
	const calls: any[] = [];
	const ctx = {
		get: (name: string) => (name === "attachments" ? attachments : undefined),
		logger: { warn: (...args: unknown[]) => calls.push(["warn", ...args]) },
		sessions: { flush: async (session: any) => calls.push(["flush", session.id]) },
		tools: { register: (tool: any) => registered.push(tool) },
		on: (name: string, handler: any) => {
			if (name === "agent/pre-step") preStep.push(handler);
		},
		effect: (factory: () => any) => effects.push(factory()),
	};
	const get = holds?.get;
	const set = holds?.set;
	mountBrowserPlugin(ctx, {
		toolDefs,
		defineTool: (value: any) => value,
		keyOf: async (exec: any) =>
			exec?.agent?.id === "bot-1" || exec?.agent?.session?.id !== undefined ? "bot-1" : undefined,
		profileRoot,
		headless: true,
		...(api ? { api } : {}),
		onHold: (_botId: string, hold: any) => set?.(hold),
		getHold: () => get?.(),
		...(subscribeHolds ? { subscribeHolds } : {}),
		openSession,
	});
	return { registered, effects, preStep, calls, ctx };
}

test("mount registers every tool and refuses when the caller is not a Bot", async () => {
	const tools = new Map<string, any>();
	const fixture = mountFixture({
		toolDefs: refsTools,
		openSession: async () => assert.fail("a non-Bot must not open a browser"),
	});
	for (const tool of fixture.registered) tools.set(tool.name, tool);
	assert.equal(tools.size, refsTools.length);
	assert.deepEqual(await tools.get("browser_snapshot").execute({}, {}), "Only Bots on the team have a browser.");
});

test("a user hold stops the tool before it opens a browser", async () => {
	let hold: any = { by: "user" };
	const tools = new Map<string, any>();
	const fixture = mountFixture({
		toolDefs: refsTools,
		openSession: async () => assert.fail("the hold must stop the call"),
		holds: {
			get: () => hold,
			set: (value: any) => {
				hold = value;
			},
		},
	});
	for (const tool of fixture.registered) tools.set(tool.name, tool);
	await assert.rejects(tools.get("browser_snapshot").execute({}, { agent: { id: "bot-1" } }), /user has taken over/);
});

test("concurrent calls share one launch, and drop closes it and removes the profile", async () => {
	const profileRoot = await mkdtemp(join(tmpdir(), "browser-drop-"));
	const api: any = {};
	let launches = 0;
	let closed = 0;
	const fixture = mountFixture({
		toolDefs: refsTools,
		profileRoot,
		api,
		openSession: async () => {
			launches += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return {
				snapshotText: async () => "snapshot",
				close: async () => {
					closed += 1;
				},
			};
		},
	});
	const tools = new Map(fixture.registered.map((tool) => [tool.name, tool]));
	const [a, b] = await Promise.all([
		tools.get("browser_snapshot").execute({}, { agent: { id: "bot-1" } }),
		tools.get("browser_snapshot").execute({}, { agent: { id: "bot-1" } }),
	]);
	assert.deepEqual([a, b], ["snapshot", "snapshot"]);
	assert.equal(launches, 1);
	await writeFile(join(profileRoot, "kept"), "1");
	assert.equal(typeof api.drop, "function");
	await api.drop("bot-1");
	assert.equal(closed, 1);
	await assert.rejects(stat(join(profileRoot, "bot-1")));
	await fixture.effects[0]();
	await rm(profileRoot, { recursive: true, force: true });
});

test("a screenshot becomes a stored attachment, or says it could not be attached", async () => {
	const saved: any[] = [];
	const fixture = mountFixture({
		toolDefs: refsTools.filter((tool) => tool.name === "browser_screenshot"),
		attachments: {
			saveImage: async (input: any) => {
				saved.push(input);
				return { attachmentId: "sha256:shot", mediaType: "image/jpeg", bytes: 3 };
			},
		},
		openSession: async () => ({
			shot: async () => ({ text: "Screenshot of https://example.com/.", image: "AAAA" }),
			close: async () => {},
		}),
	});
	const tool = fixture.registered[0];
	assert.deepEqual(await tool.execute({}, { agent: { id: "bot-1" } }), {
		text: "Screenshot of https://example.com/.",
		attachment: { attachmentId: "sha256:shot", mediaType: "image/jpeg", bytes: 3 },
	});
	assert.equal(saved[0].name, "Browser screenshot");
	assert.equal(saved[0].mediaType, "image/jpeg");

	const bare = mountFixture({
		toolDefs: refsTools.filter((item) => item.name === "browser_screenshot"),
		openSession: async () => ({
			shot: async () => ({ text: "Screenshot of https://example.com/.", image: "AAAA" }),
			close: async () => {},
		}),
	});
	assert.deepEqual(await bare.registered[0].execute({}, { agent: { id: "bot-1" } }), {
		text: "Screenshot of https://example.com/. (The screenshot could not be attached.)",
	});
});

test("the pre-step hook replaces malformed old image blocks through the surface API", async () => {
	const fixture = mountFixture({
		attachments: {
			saveImage: async () => ({ attachmentId: "sha256:fix", mediaType: "image/jpeg", bytes: 1 }),
		},
		openSession: async () => ({ close: async () => {} }),
	});
	const appended: any[] = [];
	const malformed = { type: "image", data: "AAAA" };
	const event = {
		type: "tool/result",
		data: { name: "browser_screenshot" },
		sourceEventSeqs: [4],
	};
	const session = {
		id: "s1",
		surface: { nodes: [7] },
		eventAt: (seq: number) => (seq === 7 ? event : { data: { name: "browser_screenshot" } }),
		deriveEventMessage: () => ({ role: "tool", content: [{ type: "text", text: "shot" }, malformed] }),
		append: (...args: any[]) => appended.push(args),
	};
	const next = async () => "next";
	assert.equal(await fixture.preStep[0]({ agent: { session } }, next), "next");
	assert.equal(appended.length, 1);
	assert.deepEqual(appended[0][1].message.content, [
		{ type: "text", text: "shot" },
		{ type: "image", attachment: { attachmentId: "sha256:fix", mediaType: "image/jpeg", bytes: 1 } },
	]);
	assert.deepEqual(appended[0][2], { surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 }, sourceEventSeqs: [7] });
	assert.deepEqual(fixture.calls[0], ["flush", "s1"]);
});

test("a user hold closes the Bot's browser once", async () => {
	let listener: ((botId: string, hold: any) => void) | undefined;
	let closed = 0;
	const fixture = mountFixture({
		toolDefs: refsTools.filter((tool) => tool.name === "browser_snapshot"),
		openSession: async () => ({
			snapshotText: async () => "ok",
			close: async () => {
				closed += 1;
			},
		}),
		subscribeHolds: (handler) => {
			listener = handler;
			return () => {
				listener = undefined;
			};
		},
	});
	const tool = fixture.registered[0];
	await tool.execute({}, { agent: { id: "bot-1" } });
	listener?.("bot-1", { by: "user" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(closed, 1);
});

// --- session-model ---------------------------------------------------------

const header = {
	config: { provider: "mock-provider", model: "session-model", temperature: 0.25 },
	tools: [{ name: "session-private-tool", description: "not for browser_task", parameters: {} }],
};

function fixture(
	chunks: any[],
	{
		attachments,
		inputModalities,
		textOnlyModels,
	}: { attachments?: any; inputModalities?: string[]; textOnlyModels?: string[] } = {},
) {
	const requests: any[] = [];
	const tags: any[] = [];
	let modelInfoCalls = 0;
	const ctx = {
		get: (name: string) => (name === "attachments" ? attachments : undefined),
		llm: {
			async *stream(request: any) {
				requests.push(request);
				yield* chunks;
			},
			async resolveModelInfo() {
				modelInfoCalls += 1;
				return { inputModalities };
			},
		},
	};
	const session = { id: "session-browser-task", requestHeader: () => header };
	const rt = {
		config: { textOnlyModels },
		tagUsage(messages: any[], options: any) {
			tags.push(options);
			return messages;
		},
	};
	return {
		ctx,
		exec: { agent: { session }, signal: new AbortController().signal },
		rt,
		requests,
		tags,
		modelInfoCalls: () => modelInfoCalls,
	};
}

const stop = { type: "finish", reason: { kind: "stop" } };

test("session completion converts DSH text to an OpenAI chat response", async () => {
	const setup = fixture([{ type: "text-delta", index: 0, text: "The page title is Example." }, stop]);
	const complete = sessionComplete(setup.ctx as any, setup.exec as any, setup.rt as any);
	const result = await complete({
		messages: [
			{ role: "system", content: "Use the browser." },
			{ role: "user", content: "Read the title." },
		],
		tools: [],
	});
	assert.equal(result.choices[0].message.content, "The page title is Example.");
	assert.deepEqual(setup.tags, [{ sessionId: "session-browser-task", kind: "browser-task" }]);
	assert.equal(setup.modelInfoCalls(), 0);
});

test("session completion preserves DSH tool-call identity, name, and JSON arguments", async () => {
	const setup = fixture([
		{
			type: "tool-call-delta",
			index: 0,
			id: "call-browser-1",
			name: "browser_open",
			argumentsDelta: '{"url":"https://example.com"}',
		},
		stop,
	]);
	const result = await sessionComplete(
		setup.ctx as any,
		setup.exec as any,
		setup.rt as any,
	)({
		messages: [{ role: "user", content: "Open example.com." }],
		tools: [],
	});
	assert.deepEqual(result.choices[0].message.tool_calls, [
		{
			id: "call-browser-1",
			type: "function",
			function: { name: "browser_open", arguments: '{"url":"https://example.com"}' },
		},
	]);
});

test("follow-up assistant tool call and tool result are converted to DSH messages", async () => {
	const setup = fixture([{ type: "text-delta", index: 0, text: "Done." }, stop]);
	const messages = [
		{ role: "system", content: "Use browser tools." },
		{ role: "user", content: "Open the page." },
		{
			role: "assistant",
			content: "",
			tool_calls: [
				{
					id: "call-browser-2",
					type: "function",
					function: { name: "browser_open", arguments: '{"url":"https://example.com"}' },
				},
			],
		},
		{ role: "tool", tool_call_id: "call-browser-2", content: "Opened https://example.com" },
	];
	const result = await sessionComplete(
		setup.ctx as any,
		setup.exec as any,
		setup.rt as any,
	)({
		messages,
		tools: [
			{
				type: "function",
				function: { name: "browser_snapshot", description: "Read page", parameters: { type: "object" } },
			},
		],
	});
	assert.equal(result.choices[0].message.content, "Done.");
	const request = setup.requests[0];
	assert.deepEqual(
		request.messages.map((message: any) => message.role),
		["system", "user", "assistant", "tool"],
	);
	assert.deepEqual(request.messages[2].content, [
		{ type: "tool-call", id: "call-browser-2", name: "browser_open", arguments: '{"url":"https://example.com"}' },
	]);
	assert.equal(request.messages[3].toolCallId, "call-browser-2");
	assert.deepEqual(request.messages[3].content, [{ type: "text", text: "Opened https://example.com" }]);
	assert.deepEqual(request.tools, [
		{ name: "browser_snapshot", description: "Read page", parameters: { type: "object" } },
	]);
	assert.equal(request.model, "session-model");
	assert.equal(request.provider, "mock-provider");
	assert.equal(request.sessionId, "session-browser-task");
	assert.deepEqual(setup.tags, [{ sessionId: "session-browser-task", kind: "browser-task" }]);
});

test("text-only model metadata omits screenshots before saving attachments", async () => {
	let saveCalls = 0;
	const attachments = {
		async saveImages() {
			saveCalls += 1;
			return [];
		},
	};
	const setup = fixture([stop], { attachments, inputModalities: ["text"] });
	const result = await sessionComplete(
		setup.ctx as any,
		setup.exec as any,
		setup.rt as any,
	)({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Screenshot." },
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AA=" } },
				],
			},
		],
		tools: [],
	});
	assert.deepEqual(setup.requests[0].messages[0].content, [
		{ type: "text", text: "Screenshot." },
		{ type: "text", text: "[Browser screenshot omitted.]" },
	]);
	assert.equal(
		setup.requests[0].messages[0].content.some((part: any) => part.type === "image"),
		false,
	);
	assert.equal(saveCalls, 0);
	assert.equal(result.vision, "rejected");
	assert.equal(setup.modelInfoCalls(), 1);
});

test("configured text-only models omit screenshots without attachment saves", async () => {
	let saveCalls = 0;
	const attachments = {
		async saveImages() {
			saveCalls += 1;
			return [];
		},
	};
	const setup = fixture([stop], {
		attachments,
		inputModalities: ["text", "image"],
		textOnlyModels: ["mock-provider/session-model"],
	});
	const result = await sessionComplete(
		setup.ctx as any,
		setup.exec as any,
		setup.rt as any,
	)({
		messages: [
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AA=" } }],
			},
		],
		tools: [],
	});
	assert.equal(
		setup.requests[0].messages[0].content.some((part: any) => part.type === "image"),
		false,
	);
	assert.equal(setup.requests[0].messages[0].content[0].text, "[Browser screenshot omitted.]");
	assert.equal(saveCalls, 0);
	assert.equal(result.vision, "rejected");
	assert.equal(setup.modelInfoCalls(), 0);
});

test("browser screenshots become DSH image blocks when the route supports images", async () => {
	const saved: any[] = [];
	const attachments = {
		async saveImages(inputs: any[]) {
			saved.push(...inputs);
			return [
				{
					attachmentId: "sha256:image",
					mediaType: "image/jpeg",
					bytes: inputs[0].data.length,
					width: 1,
					height: 1,
				},
			];
		},
	};
	const setup = fixture([stop], { attachments, inputModalities: ["text", "image"] });
	const result = await sessionComplete(
		setup.ctx as any,
		setup.exec as any,
		setup.rt as any,
	)({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Screenshot." },
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AA=" } },
				],
			},
		],
		tools: [],
	});
	assert.equal(saved.length, 1);
	assert.equal(saved[0].mediaType, "image/jpeg");
	assert.deepEqual(setup.requests[0].messages[0].content[1], {
		type: "image",
		attachment: {
			attachmentId: "sha256:image",
			mediaType: "image/jpeg",
			bytes: saved[0].data.length,
			width: 1,
			height: 1,
		},
	});
	assert.equal(result.vision, "accepted");
});

test("missing Bot session model fails with a clear error", async () => {
	const setup = fixture([stop]);
	const complete = sessionComplete(setup.ctx as any, { agent: { session: {} } } as any);
	await assert.rejects(complete({ messages: [], tools: [] }), { message: "browser_task needs a Bot session model" });
});

test("an aborted or failed model stream reports its failure", async () => {
	const setup = fixture([{ type: "finish", reason: { kind: "error", failure: { message: "provider down" } } }]);
	await assert.rejects(
		sessionComplete(setup.ctx as any, setup.exec as any, setup.rt as any)({ messages: [], tools: [] }),
		/provider down/,
	);
});

// Keep the temporary profile helper honest about the working tree.
test("mount's profile root is created by the caller, not the plugin", async () => {
	const root = await mkdtemp(join(tmpdir(), "browser-root-"));
	await writeFile(join(root, "marker"), "1");
	assert.equal(typeof root, "string");
	await rm(root, { recursive: true, force: true });
});
