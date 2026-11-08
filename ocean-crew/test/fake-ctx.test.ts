// The fake context is the base every host-module test is written against, so its own
// behavior is pinned here: registration order, listener dispatch, disposal order and the
// tool, route, prompt and llm records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeApproval, fakeAttachments, fakeContext } from "./fake-ctx.ts";

test("registrations are recorded in apply order", () => {
	const ctx = fakeContext();
	ctx.effect(() => {}, "boot");
	ctx.on("agent/created", () => {});
	ctx.tools.register({ name: "send_message" });
	ctx.tools.guard(() => undefined);
	ctx.systemPrompt.section({ name: "bot-identity", order: 10 });
	ctx.connection.fetch.register({ methods: ["GET", "POST"], path: "/api/bot" });
	assert.deepEqual(ctx.calls, [
		"effect boot",
		"on agent/created",
		"tool send_message",
		"tools guard",
		"prompt bot-identity 10",
		"route GET,POST /api/bot",
	]);
});

test("listeners run in registration order and emit skips middleware", () => {
	const ctx = fakeContext();
	const seen: string[] = [];
	ctx.on("evt", () => {
		seen.push("first");
	});
	ctx.on(
		"evt",
		() => {
			seen.push("prepended registration, still recorded in order");
		},
		{ prepend: true },
	);
	ctx.on("evt", (_payload, _next) => {
		seen.push("middleware");
	});
	ctx.emit("evt", {});
	assert.deepEqual(seen, ["first", "prepended registration, still recorded in order"]);
	assert.deepEqual(ctx.calls, ["on evt", "on evt (prepend)", "on evt"]);
	assert.equal(ctx.listeners.get("evt")?.length, 3);
});

test("emit does not wait for async listeners, emitAsync does", async () => {
	const ctx = fakeContext();
	const seen: string[] = [];
	ctx.on("evt", async () => {
		await Promise.resolve();
		seen.push("async");
	});
	ctx.on("evt", () => {
		seen.push("sync");
	});
	ctx.emit("evt", {});
	assert.deepEqual(seen, ["sync"]);
	await Promise.resolve();
	assert.deepEqual(seen, ["sync", "async"]);

	seen.length = 0;
	await ctx.emitAsync("evt", {});
	assert.deepEqual(seen, ["async", "sync"]);
});

test("dispose invokes cleanups in reverse order and awaits them", async () => {
	const ctx = fakeContext();
	const order: string[] = [];
	ctx.effect(
		() => () => {
			order.push("first");
		},
		"first",
	);
	ctx.effect(
		() => async () => {
			order.push("second starts");
			await Promise.resolve();
			order.push("second ends");
		},
		"second",
	);
	await ctx.dispose();
	// Cleanups are invoked in reverse registration order; a cleanup that is still running
	// is awaited, so the slow one finishes after the fast one, not before it.
	assert.deepEqual(order, ["second starts", "first", "second ends"]);
	assert.deepEqual(ctx.calls, ["effect first", "effect second"]);
	// Cleanups are taken once: a second dispose has nothing left to settle.
	assert.deepEqual(await ctx.dispose(), []);
	assert.deepEqual(order, ["second starts", "first", "second ends"]);
});

test("an effect whose setup returns no cleanup adds no disposer", async () => {
	const ctx = fakeContext();
	ctx.effect(() => undefined, "bare");
	ctx.effect(async () => "a promise is not a cleanup", "async setup");
	assert.deepEqual(await ctx.dispose(), []);
});

test("scopeAgent registers tools in the map the global registrations use", () => {
	const ctx = fakeContext();
	const agent = ctx.scopeAgent("session-1");
	assert.equal(agent.id, "session-1");
	assert.equal(agent.session.id, "session-1");
	agent.ctx.tools.register({ name: "send_message", execute: () => "ok" });
	assert.equal(ctx.registeredTools.get("send_message")?.execute(), "ok");
	// A scoped registration is an Agent tool; the fake lists global calls only.
	assert.deepEqual(ctx.calls, []);
});

test("connection.fetch.register records the route and returns a disposer", () => {
	const ctx = fakeContext();
	const dispose = ctx.connection.fetch.register({
		methods: ["POST"],
		path: "/api/bot",
		handler: () => {},
	});
	assert.deepEqual(ctx.calls, ["route POST /api/bot"]);
	assert.equal(typeof dispose, "function");
	dispose();
});

test("tools.guard records guards and tools.schemas lists none", () => {
	const ctx = fakeContext();
	const guard = (call: unknown) => ((call as { name?: string }).name === "bash" ? "not allowed" : undefined);
	const dispose = ctx.tools.guard(guard);
	assert.equal(ctx.guards.length, 1);
	assert.equal(ctx.guards[0]({ name: "bash" }), "not allowed");
	assert.equal(ctx.guards[0]({ name: "send_message" }), undefined);
	assert.deepEqual(ctx.tools.schemas(), []);
	assert.equal(typeof dispose, "function");
});

test("systemPrompt.section keeps the registered section object", () => {
	const ctx = fakeContext();
	const section = { name: "bot-identity", order: 10, text: () => "hi" };
	ctx.systemPrompt.section(section);
	assert.equal(ctx.sections.get("bot-identity"), section);
	assert.equal(ctx.sections.get("bot-identity")?.text({ agent: { id: "b1" } }), "hi");
	assert.deepEqual(ctx.calls, ["prompt bot-identity 10"]);
});

test("llm.registerAdapter records adapters and replaces the latest routes", () => {
	const ctx = fakeContext();
	assert.deepEqual(ctx.llm.listProviders(), []);
	const first = ctx.llm.registerAdapter({ chat: "a" }, "adapter-a");
	assert.deepEqual(ctx.adapters, [{ routes: { chat: "a" }, adapter: "adapter-a" }]);
	first.replace({ chat: "b" });
	assert.deepEqual(ctx.adapters, [{ routes: { chat: "b" }, adapter: "adapter-a" }]);
	ctx.llm.registerAdapter({ chat: "c" }, "adapter-b");
	first.replace({ chat: "d" });
	// The replacement routes the adapter registered last, not the one this handle added:
	// a host module registers a single adapter, which is the only one ever replaced.
	assert.deepEqual(
		ctx.adapters?.map((entry) => entry.routes),
		[{ chat: "b" }, { chat: "d" }],
	);
});

test("reading subagents throws the cordis inject error", () => {
	const ctx = fakeContext();
	assert.throws(() => ctx.subagents, { message: 'cannot get property "subagents" without inject' });
});

test("services come from get() and reflect; the logger is quiet", () => {
	const sessions = { list: () => [] };
	const ctx = fakeContext({ services: { sessions } });
	assert.equal(ctx.get("sessions"), sessions);
	assert.equal(ctx.reflect.get("sessions"), sessions);
	assert.equal(ctx.get("missing"), undefined);
	ctx.logger.warn("warned");
	ctx.logger.info("informed");
});

test("fakeAttachments saves a file and streams it back in chunks", async () => {
	const attachments = fakeAttachments();
	const data = new Uint8Array(2500).map((_, index) => index % 256);
	const ref = await attachments.saveFile({ data, name: "a.bin" });
	assert.deepEqual(ref, { attachmentId: "sha256:1", name: "a.bin", bytes: 2500 });
	assert.equal(attachments.files.get("sha256:1"), data);

	const chunks: Uint8Array[] = [];
	for await (const chunk of attachments.readFileStream(ref)) chunks.push(chunk);
	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[1001, 1001, 498],
	);
	assert.deepEqual(chunks[0], data.subarray(0, 1001));

	await assert.rejects(
		async () => {
			for await (const chunk of attachments.readFileStream({ attachmentId: "missing" })) chunks.push(chunk);
		},
		{ message: "no such file" },
	);
});

test("fakeApproval records requests and answers with the outcome or its function", async () => {
	const approval = fakeApproval();
	assert.equal(await approval.request({ name: "bash" }), "allowed-once");
	assert.deepEqual(approval.requests, [{ name: "bash" }]);

	const byCount = fakeApproval((count: number) => (count === 1 ? "allowed-once" : "rejected"));
	assert.equal(await byCount.request({ name: "bash" }), "allowed-once");
	assert.equal(await byCount.request({ name: "bash" }), "rejected");
	assert.deepEqual(byCount.requests, [{ name: "bash" }, { name: "bash" }]);
});
