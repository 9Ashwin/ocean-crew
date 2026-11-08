// The live feed: the Server-Sent Events stream a window watches instead of polling. The
// the `message` port that parts.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { FEED_ROUTE, install as installFeed } from "../src/host/chat/feed.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { type FakeContext, type FakeListener, type FakeRoute, fakeContext } from "./fake-ctx.ts";

const TEAM = {
	version: 1,
	mainBotIds: ["m1"],
	revision: 3,
	bots: {
		m1: {
			id: "m1",
			sessionId: "m1c",
			segments: [{ sessionId: "m1", endedAt: 50 }],
			name: "Chief",
			role: "Chief of Staff",
			instructions: "",
			createdAt: 1,
		},
		b2: { id: "b2", sessionId: "b2", name: "Writer", role: "Writer", instructions: "", createdAt: 2 },
	},
	rooms: {},
	exchanges: [],
	// Chief's turn 7 answers another Bot, so the chat does not show it.
	exchangeTurns: { m1c: [7] },
	questions: {},
};

const userMessage = (text: string, time: number) => ({
	type: "user/message",
	time,
	data: { source: { kind: "user" }, content: [{ type: "text", text }] },
});

interface SseEvent {
	event: string;
	data: any;
}

// Reads Server-Sent Events off a response; `nextRaw` returns one block, comments included.
function reader(response: Response) {
	const source = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const nextRaw = async (): Promise<string | undefined> => {
		for (;;) {
			const end = buffer.indexOf("\n\n");
			if (end >= 0) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				return block;
			}
			const { value, done } = await source.read();
			if (done) return undefined;
			buffer += decoder.decode(value, { stream: true });
		}
	};
	const nextEvent = async (): Promise<SseEvent | undefined> => {
		for (;;) {
			const block = await nextRaw();
			if (block === undefined) return undefined;
			if (block.startsWith(":")) continue;
			const field = (name: string): string | undefined =>
				block
					.split("\n")
					.find((line) => line.startsWith(`${name}: `))
					?.slice(name.length + 2);
			const event = field("event");
			const data = field("data");
			assert.ok(event !== undefined && data !== undefined, `malformed event block: ${block}`);
			return { event, data: JSON.parse(data) as unknown };
		}
	};
	return { nextRaw, nextEvent };
}

const listener = (ctx: FakeContext, name: string): FakeListener => {
	const found = ctx.listeners.get(name)?.at(-1);
	assert.ok(found !== undefined, `no ${name} listener`);
	return found;
};

interface FeedRuntime {
	ctx: FakeContext;
	rt: Runtime & Record<string, any>;
	routes: Map<string, FakeRoute>;
}

// Installs the store and then the feed, in the order the plugin's module list uses, and
// loads the team as the channel module does once the host is ready.
async function start(t: TestContext): Promise<FeedRuntime> {
	const home = fs.mkdtempSync(join(tmpdir(), "ocean-crew-feed-"));
	fs.writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	const ctx = fakeContext();
	const routes = new Map<string, FakeRoute>();
	const register = ctx.connection.fetch.register;
	ctx.connection.fetch.register = (route) => {
		routes.set(route.path, route);
		return register(route);
	};
	const rt = {
		ctx,
		home,
		statePath: join(home, "state.json"),
		autoRoomName: () => "Room",
		retitleRoom: async () => {},
		warn: () => {},
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);
	installFeed(rt);
	await rt.load();
	t.after(async () => {
		await ctx.dispose();
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	});
	return { ctx, rt, routes };
}

async function openFeed(routes: Map<string, FakeRoute>, signal?: AbortSignal): Promise<Response> {
	const route = routes.get(FEED_ROUTE);
	assert.ok(route !== undefined, "the feed route is registered");
	return route.fetch(new Request("http://localhost/api/bot/feed", signal === undefined ? {} : { signal }));
}

test("the feed reports saves, own-chat entries and the reply being written", async (t) => {
	const { ctx, rt, routes } = await start(t);
	const abort = new AbortController();
	t.after(() => abort.abort());
	const response = await openFeed(routes, abort.signal);
	assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
	assert.equal(response.headers.get("cache-control"), "no-store");
	const next = reader(response);
	assert.deepEqual(await next.nextEvent(), { event: "hello", data: { revision: rt.state.revision } });

	rt.state.prefs.motion = "lively";
	await rt.save();
	assert.deepEqual(await next.nextEvent(), { event: "revision", data: { revision: rt.state.revision } });

	const onEvent = listener(ctx, "session/event");
	// Without the parts port the feed has no items to show, so it sends no `message`.
	onEvent({ id: "m1c" }, userMessage("no port", 59));
	// The stand-in for parts.ts's displayItems: user messages become chat entries.
	rt.displayItems = (_sessionId: string, events: any[]) =>
		events.flatMap((event: any) =>
			event.type === "user/message" ? [{ kind: "user", text: event.data.content[0].text, time: event.time }] : [],
		);
	onEvent({ id: "m1c" }, userMessage("hello", 60));
	assert.deepEqual(await next.nextEvent(), {
		event: "message",
		data: { botId: "m1", sessionId: "m1c", item: { kind: "user", text: "hello", time: 60 } },
	});

	onEvent({ id: "m1" }, userMessage("old", 1));

	const onStream = listener(ctx, "agent/assistant-stream");
	const agent = { id: "m1c" };
	const target = { botId: "m1", sessionId: "m1c", attemptId: "a1" };
	// Chief's turn 7 answers another Bot: hidden, so its text is not streamed.
	onStream({ agent, frame: { type: "start", attemptId: "a7", turn: 7 } });
	onStream({ agent, frame: { type: "chunk", attemptId: "a7", chunk: { type: "text-delta", text: "hidden" } } });
	onStream({ agent, frame: { type: "start", attemptId: "a1", turn: 8 } });
	onStream({ agent, frame: { type: "chunk", attemptId: "a1", chunk: { type: "reasoning-delta", text: "hmm" } } });
	onStream({ agent, frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "Hi " } } });
	onStream({ agent, frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "there" } } });
	onStream({ agent, frame: { type: "end", attemptId: "a1" } });
	onStream({ agent, frame: { type: "end", attemptId: "a7" } });
	assert.deepEqual(await next.nextEvent(), { event: "stream", data: { ...target, phase: "start" } });
	assert.deepEqual(await next.nextEvent(), { event: "stream", data: { ...target, text: "Hi " } });
	assert.deepEqual(await next.nextEvent(), { event: "stream", data: { ...target, text: "there" } });
	assert.deepEqual(await next.nextEvent(), { event: "stream", data: { ...target, phase: "end" } });

	abort.abort();
	assert.equal(await next.nextEvent(), undefined);
});

test("hidden Bot-to-Bot turns are not streamed", async (t) => {
	const { ctx, routes } = await start(t);
	const abort = new AbortController();
	t.after(() => abort.abort());
	const next = reader(await openFeed(routes, abort.signal));
	assert.equal((await next.nextEvent())?.event, "hello");
	const onStream = listener(ctx, "agent/assistant-stream");
	const agent = { id: "m1c" };
	onStream({ agent, frame: { type: "start", attemptId: "a7", turn: 7 } });
	onStream({ agent, frame: { type: "chunk", attemptId: "a7", chunk: { type: "text-delta", text: "hidden" } } });
	onStream({ agent, frame: { type: "end", attemptId: "a7" } });
	onStream({ agent, frame: { type: "start", attemptId: "a1", turn: 8 } });
	onStream({ agent, frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "visible" } } });
	onStream({ agent, frame: { type: "end", attemptId: "a1" } });
	assert.deepEqual(await next.nextEvent(), {
		event: "stream",
		data: { botId: "m1", sessionId: "m1c", attemptId: "a1", phase: "start" },
	});
	assert.deepEqual(await next.nextEvent(), {
		event: "stream",
		data: { botId: "m1", sessionId: "m1c", attemptId: "a1", text: "visible" },
	});
	assert.deepEqual(await next.nextEvent(), {
		event: "stream",
		data: { botId: "m1", sessionId: "m1c", attemptId: "a1", phase: "end" },
	});
});

test("a burst of status changes sends one live notice", async (t) => {
	const { ctx, routes } = await start(t);
	const abort = new AbortController();
	t.after(() => abort.abort());
	const next = reader(await openFeed(routes, abort.signal));
	assert.equal((await next.nextEvent())?.event, "hello");
	const onStatus = listener(ctx, "agent/status");
	for (const id of ["b2", "m1c", "b2"]) onStatus({ agent: { id }, status: "running" });
	onStatus({ agent: { id: "not-a-bot" }, status: "running" });
	assert.deepEqual(await next.nextEvent(), { event: "live", data: {} });
	// The 150 ms window closed with that one notice; nothing else is waiting.
	const quiet = await Promise.race([
		next.nextEvent().then(() => "event"),
		new Promise((resolve) => setTimeout(resolve, 250, "quiet")),
	]);
	assert.equal(quiet, "quiet");
});

test("an idle feed gets a keepalive comment", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { routes } = await start(t);
	const abort = new AbortController();
	t.after(() => abort.abort());
	const next = reader(await openFeed(routes, abort.signal));
	assert.equal((await next.nextEvent())?.event, "hello");
	t.mock.timers.tick(20_000);
	assert.equal(await next.nextRaw(), ": keepalive");
	t.mock.timers.tick(20_000);
	assert.equal(await next.nextRaw(), ": keepalive");
});

test("a window that stops reading the feed is dropped", { timeout: 10_000 }, async (t) => {
	const { ctx, rt, routes } = await start(t);
	const response = await openFeed(routes);
	rt.displayItems = (_sessionId: string, events: any[]) =>
		events.map((event: any) => ({ kind: "user", text: event.data.content[0].text, time: event.time }));
	const next = reader(response);
	assert.equal((await next.nextEvent())?.event, "hello");
	const onEvent = listener(ctx, "session/event");
	for (let index = 0; index < 1000; index += 1) onEvent({ id: "m1c" }, userMessage(`line ${index}`, index));
	// What was queued before the drop still arrives, then the stream ends.
	let count = 0;
	while ((await next.nextEvent()) !== undefined) count += 1;
	assert.equal(count > 1 && count < 1000, true, String(count));
});

test("closing one window leaves the other feeds open", async (t) => {
	const { rt, routes } = await start(t);
	const firstAbort = new AbortController();
	t.after(() => firstAbort.abort());
	const first = reader(await openFeed(routes, firstAbort.signal));
	assert.equal((await first.nextEvent())?.event, "hello");
	const second = reader(await openFeed(routes));
	assert.equal((await second.nextEvent())?.event, "hello");
	firstAbort.abort();
	assert.equal(await first.nextEvent(), undefined);
	rt.state.prefs.motion = "calm";
	await rt.save();
	assert.equal((await second.nextEvent())?.event, "revision");
});
