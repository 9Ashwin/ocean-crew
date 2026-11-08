// Side chats: new chats, questions answered from a snapshot, follow-ups, refusal
// rules, cancel/close, restart repair, and what a failed model call leaves behind.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_ERROR, install as installBtw, RESTART_ERROR, TOOL_ERROR } from "../src/host/chat/btw.ts";
import { install as installSide, SIDE_MARKER } from "../src/host/chat/side.ts";
import { fakeContext } from "./fake-ctx.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const stop = (text: string) => [
	{ type: "text-delta", index: 0, text },
	{ type: "finish", reason: { kind: "stop" } },
];
const toolCall = () => [
	{ type: "tool-call-delta", index: 0, id: "c1", name: "read", argumentsDelta: "{}" },
	{ type: "finish", reason: { kind: "tool-calls" } },
];
const empty = () => [{ type: "finish", reason: { kind: "stop" } }];
const cutOff = (text: string) => [
	{ type: "text-delta", index: 0, text },
	{ type: "finish", reason: { kind: "max-tokens" } },
];
const promptOf = (request: any): string =>
	request.messages
		.at(-1)
		.content.filter((block: any) => block.type === "text")
		.map((block: any) => block.text)
		.join("\n");

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((ok) => {
		resolve = ok;
	});
	return { promise, resolve };
}

function makeSession(id: string, { messages, header, seq = 4 }: { messages: any[]; header: any; seq?: number }) {
	const session: any = {
		id,
		seq,
		messages,
		header,
		derived: 0,
		writes: 0,
		deriveMessages() {
			session.derived += 1;
			return session.messages.map((message: any) => ({ ...message }));
		},
		toolHistory: () => [],
		requestHeader: () => session.header,
		snapshotEvents: () => [],
		eventAt() {
			throw new Error("eventAt is closed to new callers");
		},
	};
	return session;
}

interface Env {
	rt: any;
	home: string;
	ctx: any;
	session: any;
	requests: any[];
	saved: () => number;
	gates: { resolve(): void }[];
	call(endpoint: "sideNew" | "sideAsk" | "sideCancel" | "sideClose", payload: any): Promise<any>;
	file(botId?: string): any[];
	viewChat(chatId: string): any;
	setHeader(header: any): void;
	stop(): Promise<void>;
}

async function start({
	scripts = [] as any[][],
	gate = false,
	header = {
		config: {
			provider: "deepseek",
			model: "aside-model",
			reasoningEffort: "high",
			maxTokens: 8000,
			temperature: 0.2,
			stop: ["END"],
		},
		tools: [{ name: "read" }],
	},
	messages = [user("Look at the file")],
	side = {} as Record<string, unknown[]>,
} = {}): Promise<Env> {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-side-"));
	for (const [botId, list] of Object.entries(side)) {
		mkdirSync(join(home, "side"), { recursive: true });
		writeFileSync(join(home, "side", `${botId}.json`), JSON.stringify(list));
	}
	const state: any = {
		bots: {
			b1: {
				id: "b1",
				name: "Chief",
				sessionId: "s-now",
				createdAt: 1,
				segments: [{ sessionId: "s-old", endedAt: 1 }],
			},
		},
		rooms: { r1: { id: "r1", name: "Launch", members: ["b1"], admin: "b1" } },
		exchangeTurns: {},
		questions: {},
		views: {},
		closedCards: {},
		switching: {},
	};
	const session = makeSession("s-now", { messages, header });
	const ctx: any = fakeContext();
	const services: Record<string, any> = {};
	services.sessionProjections = {
		register() {},
		stateOf: () => ({ turnStartSeq: null, turn: null, messageSeq: null, starts: [] }),
	};
	const requests: any[] = [];
	const gates: { resolve(): void }[] = [];
	const queue = [...scripts];
	ctx.llm = {
		listProviders: () => [],
		listModels: async () => [],
		resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
		async *stream(options: any) {
			requests.push(options);
			if (gate) {
				const hold = deferred();
				gates.push(hold);
				const abort = () => hold.resolve();
				options.signal?.addEventListener("abort", abort, { once: true });
				try {
					if (options.signal?.aborted) abort();
					await hold.promise;
				} finally {
					options.signal?.removeEventListener("abort", abort);
				}
			}
			for (const chunk of queue.shift() ?? stop("Because of the snapshot.")) yield chunk;
		},
	};
	ctx.get = (name: string) => services[name];
	ctx.sessionController = {
		resolveAgent: async (sessionId: string) => {
			if (sessionId !== "s-now") throw new Error(`no session ${sessionId}`);
			return { agent: { id: sessionId, session } };
		},
		page: async () => ({ records: [], hasMore: false }),
		selectModel: async () => {},
	};
	ctx.sessions = { flush: async () => {} };
	ctx.workspaceRegistry = { archiveSession: async () => {} };
	ctx.dropped = [];
	const saved = { count: 0 };
	const rt: any = {
		ctx,
		state,
		home,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		isMain: () => false,
		roomOf: (id?: string) => (id !== undefined && (id === "r1" || id === "g-now") ? state.rooms.r1 : undefined),
		chatOwners: new Map([["s-now", "b1"]]),
		groupOwners: new Map([["g-now", { botId: "b1", roomId: "r1" }]]),
		roomOwners: new Map([["r1", "r1"]]),
		pastOwners: new Map([["s-old", { botId: "b1" }]]),
		resolveAgent: async (sessionId: string) => {
			if (sessionId !== "s-now") throw new Error(`no session ${sessionId}`);
			return { id: sessionId, session };
		},
		readOnly: () => undefined,
		save: async () => {
			saved.count += 1;
		},
		load: async () => {},
		refresh: async () => {},
		warn: () => {},
		deleteBot: async (id: string) => {
			ctx.dropped.push(id);
			delete state.bots[id];
		},
	};
	installBtw(rt);
	installSide(rt);
	await rt.load();
	const call = async (endpoint: string, payload: any): Promise<any> => {
		try {
			return { ok: true, value: await rt[endpoint](payload) };
		} catch (error: any) {
			return { ok: false, error: { message: error?.message, code: error?.code } };
		}
	};
	const viewChat = (chatId: string): any => (rt.sideView().b1 ?? []).find((chat: any) => chat.id === chatId);
	const stopEnv = async (): Promise<void> => {
		for (const hold of gates) hold.resolve();
		for (const chats of Object.values(rt.sideView() ?? {}) as any[][])
			for (const chat of chats) for (const entry of chat.entries ?? []) await rt.sideJoin(entry.id);
		await rt.sideDispose();
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return {
		rt,
		home,
		ctx,
		session,
		requests,
		saved: () => saved.count,
		gates,
		call: call as Env["call"],
		file: (botId = "b1") => JSON.parse(readFileSync(join(home, "side", `${botId}.json`), "utf8")),
		viewChat,
		setHeader: (next: any) => {
			session.header = next;
		},
		stop: stopEnv,
	};
}

test("a new side chat persists an empty list of entries", async (t) => {
	const env = await start();
	t.after(env.stop);
	const response = await env.call("sideNew", { sessionId: "s-now" });
	assert.equal(response.ok, true, response.error?.message);
	const chat = env.viewChat(response.value.chatId);
	assert.deepEqual([chat.botId, chat.entries], ["b1", []]);
	assert.equal(typeof chat.createdAt, "number");
	assert.deepEqual(env.file(), [chat]);
});

test("a side question answers from a snapshot and writes nothing into the session", async (t) => {
	const env = await start();
	t.after(env.stop);
	const response = await env.call("sideAsk", { sessionId: "s-now", text: "What is the file?" });
	assert.equal(response.ok, true, response.error?.message);
	await env.rt.sideJoin(response.value.entryId);
	const chat = env.viewChat(response.value.chatId);
	assert.deepEqual(
		chat.entries.map((entry: any) => [entry.question, entry.answer, entry.status]),
		[["What is the file?", "Because of the snapshot.", "done"]],
	);
	assert.equal(env.session.writes, 0, "the Session is never written");
	assert.equal(env.requests.length, 1);
	assert.match(promptOf(env.requests[0]), new RegExp(SIDE_MARKER));
	assert.deepEqual(
		env.file()[0].entries.map((entry: any) => entry.status),
		["done"],
	);
});

test("a follow-up carries the chat's finished pairs in order and skips the rest", async (t) => {
	const env = await start();
	t.after(env.stop);
	const first = await env.call("sideAsk", { sessionId: "s-now", text: "first" });
	await env.rt.sideJoin(first.value.entryId);
	const second = await env.call("sideAsk", { sessionId: "s-now", chatId: first.value.chatId, text: "second" });
	await env.rt.sideJoin(second.value.entryId);
	const messages = env.requests[1].messages;
	const pairs = messages.slice(1, -1);
	assert.deepEqual(
		pairs.map((message: any) => [message.role, message.content[0].text]),
		[
			["user", "first"],
			["assistant", "Because of the snapshot."],
		],
	);
	assert.equal(env.requests.length, 2);
});

test("group chats, an empty question, and a model-less Bot are refused", async (t) => {
	const env = await start();
	t.after(env.stop);
	assert.match((await env.call("sideAsk", { sessionId: "g-now", text: "hi" })).error.message, /only available/);
	assert.equal((await env.call("sideAsk", { sessionId: "s-now", text: "" })).error.code, "bot/invalid");
	env.setHeader({ tools: [] });
	assert.match(
		(await env.call("sideAsk", { sessionId: "s-now", text: "hi" })).error.message,
		/has not called a model yet/,
	);
	assert.equal(env.viewChat("missing"), undefined);
});

test("a chat answering one question refuses a second, and recent skips it", async (t) => {
	const env = await start({ gate: true, scripts: [stop("one"), stop("two")] });
	t.after(env.stop);
	const first = await env.call("sideAsk", { sessionId: "s-now", text: "first" });
	assert.equal(first.ok, true, first.error?.message);
	assert.match(
		(await env.call("sideAsk", { sessionId: "s-now", chatId: first.value.chatId, text: "again" })).error.message,
		/Wait for the answer/,
	);
	// `recent` reuses only a chat whose last entry is not answering: this one is, so a
	// new chat is made instead.
	const recent = await env.call("sideAsk", { sessionId: "s-now", recent: true, text: "elsewhere" });
	assert.equal(recent.ok, true, recent.error?.message);
	assert.notEqual(recent.value.chatId, first.value.chatId);
	for (const hold of env.gates) hold.resolve();
	await env.rt.sideJoin(first.value.entryId);
	await env.rt.sideJoin(recent.value.entryId);
});

test("cancel aborts the call and marks the entry cancelled", async (t) => {
	const env = await start({ gate: true });
	t.after(env.stop);
	const response = await env.call("sideAsk", { sessionId: "s-now", text: "slow" });
	assert.equal(response.ok, true, response.error?.message);
	const cancelled = await env.call("sideCancel", { chatId: response.value.chatId, entryId: response.value.entryId });
	assert.deepEqual(cancelled.value, { answering: true });
	await env.rt.sideJoin(response.value.entryId);
	const entry = env.viewChat(response.value.chatId).entries[0];
	assert.deepEqual([entry.status, entry.answer], ["cancelled", ""]);
});

test("closing a chat deletes it and rewrites the file", async (t) => {
	const env = await start();
	t.after(env.stop);
	const first = await env.call("sideNew", { sessionId: "s-now" });
	const second = await env.call("sideNew", { sessionId: "s-now" });
	assert.deepEqual((await env.call("sideClose", { chatId: first.value.chatId })).value, {});
	assert.deepEqual(
		env.file().map((chat: any) => chat.id),
		[second.value.chatId],
	);
	assert.equal(env.viewChat(first.value.chatId), undefined);
});

test("a restart marks an entry that was still answering as failed", async (t) => {
	const env = await start({
		side: {
			b1: [
				{
					id: "chat-1",
					botId: "b1",
					createdAt: 1,
					updatedAt: 1,
					entries: [{ id: "entry-1", question: "q", answer: "", status: "answering", createdAt: 1 }],
				},
			],
		},
	});
	t.after(env.stop);
	const entry = env.viewChat("chat-1").entries[0];
	assert.deepEqual([entry.status, entry.error], ["failed", RESTART_ERROR]);
	assert.equal(env.file()[0].entries[0].status, "failed");
});

test("a tool call is asked again once, then the entry fails if it calls a tool again", async (t) => {
	const env = await start({ scripts: [toolCall(), toolCall()] });
	t.after(env.stop);
	const response = await env.call("sideAsk", { sessionId: "s-now", text: "do it" });
	await env.rt.sideJoin(response.value.entryId);
	assert.deepEqual(
		[env.viewChat(response.value.chatId).entries[0].status, env.viewChat(response.value.chatId).entries[0].error],
		["failed", TOOL_ERROR],
	);
	assert.equal(env.requests.length, 2);
	assert.match(promptOf(env.requests[1]), /Do not call any tool/);
});

test("an empty answer and a cut-off answer fail the entry", async (t) => {
	const env = await start({ scripts: [empty(), cutOff("half an answer")] });
	t.after(env.stop);
	const first = await env.call("sideAsk", { sessionId: "s-now", text: "nothing" });
	await env.rt.sideJoin(first.value.entryId);
	assert.deepEqual(
		[env.viewChat(first.value.chatId).entries[0].status, env.viewChat(first.value.chatId).entries[0].error],
		["failed", EMPTY_ERROR],
	);
	const second = await env.call("sideAsk", { sessionId: "s-now", recent: true, text: "cut" });
	await env.rt.sideJoin(second.value.entryId);
	const entry = env.viewChat(second.value.chatId).entries.at(-1);
	assert.deepEqual([entry.status, entry.finish, entry.answer], ["failed", "max-tokens", "half an answer"]);
});

test("deleting a Bot aborts its flights and removes the chat file", async (t) => {
	const env = await start({ gate: true });
	t.after(env.stop);
	const response = await env.call("sideAsk", { sessionId: "s-now", text: "slow" });
	assert.equal(response.ok, true, response.error?.message);
	await env.rt.deleteBot("b1");
	assert.deepEqual(env.ctx.dropped, ["b1"]);
	assert.equal(existsSync(join(env.home, "side", "b1.json")), false);
	await env.rt.sideJoin(response.value.entryId);
});
