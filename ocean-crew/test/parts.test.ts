import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	canonicalHeadings,
	checkpointCount,
	checkpointTail,
	checkpointText,
	historyEntry,
	install as installParts,
	linesFor,
	noteText,
	parseDecision,
	parseReplies,
	stackReplies,
	stewardRequest,
} from "../src/host/chat/parts.ts";
import { HANDOFF_ACK, SOURCE_KIND } from "../src/host/core/constants.ts";
import { fakeContext } from "./fake-ctx.ts";

const textBlock = (text: string) => [{ type: "text", text }];
const userMessage = (text: string, source: any = { kind: "user" }) => ({
	type: "user/message",
	seq: 1,
	time: 1000,
	data: { content: textBlock(text), source },
});
const assistantMessage = (text: string) => ({
	type: "assistant/message",
	seq: 2,
	time: 1001,
	data: { message: { content: textBlock(text) } },
});

function makeSession(
	id: string,
	{ messages = [] as any[], config = undefined as any, cwd = undefined as any, seq = 1 } = {},
) {
	const session: any = {
		id,
		seq,
		header: { cwd },
		messages,
		writes: 0,
		deriveMessages: () => session.messages.map((message: any) => ({ ...message })),
		toolHistory: () => [],
		requestHeader: () => ({ config, tools: [] }),
		eventAt: (at: number) =>
			at === 0 ? { type: "turn/end", data: { reason: { kind: "completed" } } } : { type: "agent/status", data: {} },
	};
	return session;
}

function makeAgent(sessionId: string, session = makeSession(sessionId)) {
	const agent: any = {
		id: sessionId,
		session,
		status: "idle",
		inbox: {
			nextStep: [] as any[],
			nextTurn: [] as any[],
			remove(id: string) {
				for (const list of [agent.inbox.nextStep, agent.inbox.nextTurn]) {
					const at = list.findIndex((message: any) => message.id === id);
					if (at !== -1) return list.splice(at, 1).length === 1;
				}
				return false;
			},
			prepend(list: string, message: any) {
				agent.inbox[list].unshift(message);
			},
		},
		followed: [] as any[],
		followup(message: any) {
			agent.followed.push(message);
		},
		sent: [] as any[],
		send(message: any) {
			agent.sent.push(message);
		},
		whenIdle: async () => {},
		runMaintenance: async (work: (signal: AbortSignal) => Promise<void>) => work(new AbortController().signal),
	};
	return agent;
}

interface Env {
	rt: any;
	state: any;
	ctx: any;
	agents: Map<string, any>;
	created: string[];
	archived: string[];
	unarchived: string[];
	saves(): number;
	events(list: Event[]): any;
	page(records: any[], extra?: Record<string, unknown>): void;
}

interface Event {
	type: string;
	seq?: number;
	time?: number;
	data?: any;
}

async function start(): Promise<Env> {
	const ctx: any = fakeContext();
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-parts-"));
	const state: any = {
		bots: {
			b1: {
				id: "b1",
				name: "Chief",
				sessionId: "s-now",
				createdAt: 1,
				segments: [{ sessionId: "s-old", endedAt: 1000, note: "## note one", noteFrom: 1 }],
			},
			b3: { id: "b3", name: "Solo", sessionId: "s3", createdAt: 1 },
		},
		rooms: {
			r1: {
				id: "r1",
				name: "Ops",
				members: ["b1"],
				admin: "b1",
				sessionId: "g-now",
				parts: [{ sessionId: "g-old", endedAt: 900 }],
				sessions: { b1: "gb-now" },
				segments: { b1: [{ sessionId: "gb-old", endedAt: 800 }] },
			},
		},
		exchangeTurns: {},
		questions: {},
		views: {},
		closedCards: {},
		switching: {},
	};
	const agents = new Map<string, any>();
	const created: string[] = [];
	const archived: string[] = [];
	const unarchived: string[] = [];
	const saves = { count: 0 };
	const pages = new Map<string, { records: any[]; hasMore: boolean }>();
	const eventsBackward = new Map<string, any[]>();
	const services: Record<string, any> = {
		sessionProjections: { register() {}, stateOf: () => undefined },
		tokenMeter: undefined,
	};
	ctx.get = (name: string) => services[name];
	ctx.logger = { info: () => {}, warn: () => {} };
	ctx.llm = {
		resolveModelInfo: async () => ({
			context: { contextWindow: 100_000 },
			defaultMaxTokens: 8000,
			reasoning: { efforts: [] },
		}),
		async *stream() {
			yield { type: "text-delta", index: 0, text: "summary" };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
	ctx.sessionController = {
		resolveAgent: async (sessionId: string) => {
			const agent = agents.get(sessionId);
			if (agent === undefined) throw new Error(`no session ${sessionId}`);
			return { agent };
		},
		page: async (request: any) => {
			const found = pages.get(request.address.sessionId) ?? { records: [], hasMore: false };
			return found;
		},
	};
	ctx.sessions = { flush: async () => {} };
	ctx.workspaceRegistry = {
		archiveSession: async (id: string) => {
			archived.push(id);
		},
		unarchiveSession: async (id: string) => {
			unarchived.push(id);
		},
	};
	const reindex = (): void => {
		rt.chatOwners.clear();
		rt.groupOwners.clear();
		rt.roomOwners.clear();
		rt.pastOwners.clear();
		for (const bot of Object.values(state.bots) as any[]) {
			for (const segment of bot.segments ?? []) rt.pastOwners.set(segment.sessionId, { botId: bot.id });
			rt.chatOwners.set(bot.sessionId ?? bot.id, bot.id);
		}
		for (const room of Object.values(state.rooms) as any[]) {
			rt.roomOwners.set(room.sessionId ?? room.id, room.id);
			for (const segment of room.parts ?? []) rt.pastOwners.set(segment.sessionId, { roomId: room.id });
			for (const [botId, segments] of Object.entries(room.segments ?? {})) {
				for (const segment of segments as any[]) rt.pastOwners.set(segment.sessionId, { botId, roomId: room.id });
			}
			for (const [botId, sessionId] of Object.entries(room.sessions ?? {}))
				rt.groupOwners.set(sessionId as string, { botId, roomId: room.id });
		}
	};
	const rt: any = {
		ctx,
		state,
		config: {},
		home,
		bots: state.bots,
		chatOwners: new Map(),
		groupOwners: new Map(),
		roomOwners: new Map(),
		pastOwners: new Map(),
		live: new Map(),
		liveOf: (id: string) => rt.live.get(id),
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		roomOf: (id?: string) =>
			id === undefined ? undefined : (state.rooms[id] ?? state.rooms[rt.roomOwners.get(id) as string]),
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		sessionOfRoom: (room?: any) => (room === undefined ? undefined : (room.sessionId ?? room.id)),
		selfOf: (id?: string) =>
			id === undefined ? undefined : (rt.chatOwners.get(id) ?? rt.groupOwners.get(id)?.botId),
		isBotSession: (id?: string) => id !== undefined && (rt.chatOwners.has(id) || rt.groupOwners.has(id)),
		isMain: () => true,
		groupSessionsOf: (botId: string) =>
			(Object.values(state.rooms) as any[]).map((room) => room.sessions?.[botId]).filter(Boolean),
		readOnly: () => undefined,
		save: async () => {
			saves.count += 1;
			reindex();
		},
		load: async () => {},
		warn: () => {},
		ensureCapabilities: async () => {},
		createSession: async () => {
			const id = `fresh-${created.length + 1}`;
			created.push(id);
			return id;
		},
		resolveAgent: async (sessionId: string) => {
			let agent = agents.get(sessionId);
			if (agent === undefined) {
				agent = makeAgent(sessionId);
				agents.set(sessionId, agent);
			}
			return agent;
		},
		applyPermission: async () => {},
		desiredModel: async () => undefined,
		desiredEffort: async () => undefined,
		selectSessionModel: async () => {},
		workDirOf: () => undefined,
		isFolder: async () => false,
		teamFolder: () => undefined,
		ensureWorkspace: async () => {},
		moveSchedules: async () => {},
		renewMemory: () => {},
		eventsBackwards: async function* (sessionId: string) {
			yield* (eventsBackward.get(sessionId) ?? []) as any;
		},
		btwPartCards: async (botId: string, partId: string) =>
			botId === "b1" && partId === "s-old" ? [{ id: "card-1" }] : [],
		own: (table: any, key: string) =>
			table !== null && table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined,
		deleteBot: async () => {},
	};
	reindex();
	installParts(rt);
	return {
		rt,
		state,
		ctx,
		agents,
		created,
		archived,
		unarchived,
		saves: () => saves.count,
		events: (list: Event[]) => {
			const log = [...list].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
			eventsBackward.set("s-now", [...log].reverse());
			return log;
		},
		page: (records: any[], extra = {}) => {
			pages.set("s-now", { records, hasMore: false, ...extra });
			pages.set("s-old", { records: [], hasMore: false });
		},
	};
}

test("historyEntry reads answers, user and Bot messages, and drops kickoffs and old group turns", () => {
	assert.deepEqual(historyEntry(assistantMessage("hi"), false), { answer: true, text: "hi" });
	assert.deepEqual(historyEntry(userMessage("hello"), false), {
		answer: false,
		who: "user",
		text: "hello",
		keepAnswers: true,
	});
	const post = userMessage("post", { kind: SOURCE_KIND, role: "post", senderName: "Writer" });
	assert.deepEqual(historyEntry(post, true), { answer: false, who: "bot", text: "post", keepAnswers: true });
	const kickoff = userMessage("", { kind: SOURCE_KIND, role: "kickoff" });
	assert.deepEqual(historyEntry(kickoff, false), { answer: false, who: "bot", text: "", keepAnswers: false });
	assert.equal(
		historyEntry(
			{
				type: "tool/call",
				data: { name: "ask_user", arguments: { question: "Ship it?", options: [{ label: "Yes" }] } },
			},
			false,
		)?.text,
		"[Question card] Ship it?\nOptions: Yes",
	);
	assert.equal(
		historyEntry({ type: "tool/call", data: { name: "ask_user", arguments: { question: "" } } }, false),
		undefined,
	);
	const answer = userMessage(
		JSON.stringify({
			kind: "answer_to_pending_question",
			tool: "ask_user",
			callId: "c1",
			questions: [{ id: "q1", question: "Ship it?" }],
			answers: [{ id: "q1", selected: ["Yes"] }],
		}),
		{ kind: "user-question-reply" },
	);
	assert.deepEqual(historyEntry(answer, true), {
		answer: false,
		who: "user",
		text: "[Answer to question card] Ship it?\nAnswer: Yes",
		keepAnswers: true,
	});
});

test("canonicalHeadings fixes translated headings only when all are known and in order", () => {
	const names = ["Goals", "Progress"];
	assert.equal(canonicalHeadings("## Goals\n- a\n\n## Progress\n- b", names), "## Goals\n- a\n\n## Progress\n- b");
	assert.equal(canonicalHeadings("## 目标\n- a\n\n## 进展\n- b", names), "## Goals\n- a\n\n## Progress\n- b");
	assert.equal(canonicalHeadings("## Progress\n- b\n\n## Goals\n- a", names), "## Progress\n- b\n\n## Goals\n- a");
	assert.equal(canonicalHeadings("no headings", names), "no headings");
});

test("partsOf numbers the saved parts and adds the current one", async (t) => {
	const env = await start();
	t.after(() => rmSync(join(tmpdir(), "nothing"), { recursive: true, force: true }));
	assert.deepEqual(
		env.rt.partsOf("b1").map((part: any) => [part.number, part.sessionId]),
		[
			[1, "s-old"],
			[2, "s-now"],
		],
	);
	assert.deepEqual(
		env.rt.partsOf(undefined, "r1").map((part: any) => [part.number, part.sessionId]),
		[
			[1, "g-old"],
			[2, "g-now"],
		],
	);
	assert.deepEqual(
		env.rt.partsOf("b1", "r1").map((part: any) => [part.number, part.sessionId]),
		[
			[1, "gb-old"],
			[2, "gb-now"],
		],
	);
	assert.deepEqual(env.rt.partsOf("nobody"), []);
});

test("partLines reads a part newest first, with the Bot's answers before their messages", async (t) => {
	const env = await start();
	t.after(() => {});
	const log = env.events([
		userMessage("first", { kind: "user" }),
		{ type: "user/message", seq: 2, time: 1002, data: { content: textBlock("second"), source: { kind: "user" } } },
		{ type: "assistant/message", seq: 3, time: 1003, data: { message: { content: textBlock("answer two") } } },
	]);
	void log;
	const lines: any[] = [];
	for await (const line of env.rt.partLines("s-now", AbortSignal.timeout(1000), { group: false }))
		lines.push(line.text);
	assert.deepEqual(lines, ["You: answer two", "User: second", "User: first"]);
});

test("displayItems draws chat rows: text blocks, user messages, hidden turns, cards and relay replies", async (t) => {
	const env = await start();
	t.after(() => {});
	env.state.exchangeTurns["s-now"] = ["2"];
	env.state.closedCards["s-now"] = { "call-9": { selected: ["Yes"], at: 5 } };
	const events: Event[] = [
		{ type: "turn/start", seq: 1, data: { turn: 1 } },
		userMessage("look", { kind: "user" }),
		{ type: "assistant/message", seq: 2, data: { message: { content: textBlock("two blocks") } } },
		{
			type: "tool/call",
			seq: 3,
			data: {
				turn: 1,
				name: "ask_user",
				callId: "call-9",
				arguments: JSON.stringify({ question: "Ship it?", options: [{ label: "Yes" }], multiSelect: false }),
			},
		},
		{ type: "turn/start", seq: 4, data: { turn: 2 } },
		{ type: "assistant/message", seq: 5, data: { turn: 2, message: { content: textBlock("hidden") } } },
		{ type: "tool/call", seq: 6, data: { turn: 2, name: "group_relay", callId: "relay-1" } },
		{
			type: "tool/result",
			seq: 7,
			data: {
				turn: 2,
				message: {
					toolCallId: "relay-1",
					content: textBlock(
						JSON.stringify({
							replies: [
								{ botId: "b1", name: "Chief", text: "one", time: 10 },
								{ botId: "b1", name: "Chief", text: "two", time: 11 },
								{ kind: "working", botId: "b1", name: "Chief", time: 12 },
								{ kind: "user", text: "from the user", time: 13 },
							],
						}),
					),
				},
			},
		},
	];
	const items = env.rt.displayItems("s-now", events, undefined);
	assert.deepEqual(
		items.map((item: any) => [
			item.kind,
			item.texts?.[0] ?? item.text ?? item.reply?.kind ?? item.question?.question ?? item.role,
		]),
		[
			["user", "look"],
			["bot", "two blocks"],
			["closed", "Ship it?"],
			["post", "one"],
			["relay", "working"],
			["user", "from the user"],
		],
	);
	assert.deepEqual(items.find((item: any) => item.kind === "post").texts, ["one", "two"]);
	assert.deepEqual(
		items.slice(4).map((item: any) => item.seq),
		[undefined, undefined],
	);
});

test("noteText and handoffPackage explain where a note came from and where the rest is", async (t) => {
	const env = await start();
	t.after(() => {});
	assert.equal(noteText({ note: "## n" }), "## n");
	assert.match(String(noteText({ fallback: "whole" })), /every message of the part was carried over/);
	assert.match(
		String(noteText({ fallback: "overflow", note: "## n", noteFrom: 2 })),
		/overflowed the model's window[\s\S]*part 2/,
	);
	const text = env.rt.handoffPackage({
		segment: { note: "## Goals\n- ship" },
		lines: { recent: ["User: look"], earlier: ["User: older"], unlisted: 2, complete: false, whole: false },
		number: 2,
		resume: true,
	});
	assert.match(text, /\[Handoff · part 2\]/);
	assert.match(text, /## Handoff note\n## Goals\n- ship/);
	assert.match(text, /## Messages to you in part 1, before the latest ones \(oldest first\)/);
	assert.match(text, /2 older messages are not listed/);
	assert.match(text, /You were in the middle of a turn\. Go on with it now/);
	// A group's own Session carries no note list; the package still says where the record is.
	const own = env.rt.handoffPackage({
		room: { name: "Ops" },
		self: true,
		segment: {},
		lines: { recent: [], earlier: [], unlisted: 0, complete: true, whole: false },
		number: 1,
		folder: "/work/ops",
	});
	assert.match(own, /the group chat "Ops"/);
	assert.match(own, /working folder changed to \/work\/ops/);
	assert.match(own, /## Latest messages \(oldest first\)\n\(none\)/);
});

test("checkpoint text and tail helpers keep the numbered summary and the kept messages", () => {
	const kept = ["[part 1 #2 · 10-08 12:00] User: hi"];
	assert.equal(
		checkpointText({ number: 2, summary: "done so far", kept, more: true }),
		"[Checkpoint 2]\ndone so far\n\nYour own replies up to here are condensed above; read_own_chat finds them word for word.\n\n## Messages to you, word for word (oldest first)\n(Older messages are not shown here; read_own_chat finds them.)\n[part 1 #2 · 10-08 12:00] User: hi",
	);
	assert.equal(checkpointCount([{ role: "user", content: textBlock("<compacted-summary>[Checkpoint 3]\nx") }]), 3);
	assert.deepEqual(checkpointTail([{ role: "user" }], [{ role: "user" }, { role: "tool" }]), [{ role: "tool" }]);
	assert.deepEqual(checkpointTail([{ role: "assistant" }], [{ role: "user" }]), []);
	assert.deepEqual(linesFor({ window: 100_000, reserve: 8000, checkRatio: 0.5 }), {
		window: 100_000,
		usable: 92_000,
		hard: 87_400,
		check: 46_000,
	});
	assert.equal(parseDecision('{"action":"compact"}'), "compact");
	assert.equal(parseDecision('{"action":"switch"} {"action":"whatever"}'), undefined);
	assert.equal(parseDecision("no answer"), undefined);
	assert.match(
		stewardRequest({ lines: [{ who: "user", text: "do it" }], midTurn: true, checkpoints: 1, group: false }),
		/Now: the assistant is in the middle of a turn/,
	);
});

test("group_relay results survive a pruned tool result, and replies stack by Bot", () => {
	const full = JSON.stringify({
		replies: [
			{ botId: "b", name: "B", text: "one" },
			{ kind: "working", botId: "b", name: "B" },
		],
	});
	assert.deepEqual(parseReplies(full).replies.length, 2);
	const pruned = `{"replies":[{"botId":"b","name":"B","text":"one"},[... tool result middle pruned ...]{"botId":"b","name":"B","text":"three"}]}`;
	const recovered = parseReplies(pruned);
	assert.deepEqual([recovered.broken, recovered.replies.map((reply) => reply.text)], [true, ["one", "three"]]);
	const stacked = stackReplies([
		{ botId: "b", text: "one", time: 1 },
		{ botId: "b", text: "two", time: 2 },
		{ kind: "working", botId: "b", time: 3 },
	]);
	assert.deepEqual(stacked.length, 2);
	assert.deepEqual(stacked[0].texts, ["one", "two"]);
});

test("chatPage and earlierPage draw a part's rows and its saved aside cards", async (t) => {
	const env = await start();
	t.after(() => {});
	env.page([
		{ event: userMessage("hi", { kind: "user" }) },
		{ event: { type: "assistant/message", seq: 2, data: { message: { content: textBlock("hello") } } } },
	]);
	const current = await env.rt.chatPage("b1", {});
	assert.equal(current.sessionId, "s-now");
	assert.deepEqual(
		current.items.map((item: any) => [item.kind, item.text]),
		[
			["divider", undefined],
			["user", "hi"],
			["bot", "hello"],
		],
	);
	const earlier = await env.rt.earlierPage("s-now", {});
	assert.deepEqual(earlier.btw, [{ id: "card-1" }]);
	assert.deepEqual(earlier.cursor, null);
});

test("a manual move to a fresh part carries the handoff package and archives the old part", async (t) => {
	const env = await start();
	t.after(() => {});
	const agent = await env.rt.resolveAgent("s-now");
	env.agents.set("s-now", agent);
	// A route is needed for the note attempt to fail: the deterministic package is used.
	agent.session.header = { cwd: undefined };
	assert.equal(await env.rt.newPart("s-now"), true);
	// The switch runs asynchronously: wait for the fresh part to appear in the state.
	const until = Date.now() + 3000;
	while (env.state.bots.b1.sessionId === "s-now" && Date.now() < until)
		await new Promise((resolve) => setImmediate(resolve));
	assert.equal(env.state.bots.b1.sessionId, "fresh-1");
	assert.deepEqual(
		env.state.bots.b1.segments.map((segment: any) => segment.sessionId),
		["s-old", "s-now"],
	);
	assert.deepEqual(env.archived, ["s-now"]);
	const fresh = await env.rt.resolveAgent("fresh-1");
	const handoff = fresh.followed[0];
	assert.equal(handoff.source.handoff, true);
	assert.equal(handoff.source.role, "handoff");
	assert.match(handoff.content[0].text, /\[Handoff · part 3\]/);
	assert.match(handoff.content[0].text, /a fresh conversation was started/);
	assert.match(handoff.content[0].text, /## Latest messages/);
	assert.equal([...env.rt.switchJobs()].length, 0);
});

test("opening an earlier part makes it current and moves the part it replaced into place", async (t) => {
	const env = await start();
	t.after(() => {});
	assert.equal(await env.rt.switchPart("b1", "s-old"), true);
	assert.equal(env.state.bots.b1.sessionId, "s-old");
	assert.deepEqual(
		env.state.bots.b1.segments.map((segment: any) => segment.sessionId),
		["s-now"],
	);
	assert.equal(env.unarchived.includes("s-old"), true);
	assert.equal(env.archived.includes("s-now"), true);
	assert.deepEqual(env.rt.chatOwners.get("s-old"), "b1");
	assert.deepEqual(env.rt.pastOwners.get("s-now"), { botId: "b1" });
	// Opening the current part again is a no-op; an unknown one is not found.
	assert.equal(await env.rt.switchPart("b1", "s-old"), false);
	await assert.rejects(env.rt.switchPart("b1", "nope"), /Unknown part/);
	await assert.rejects(env.rt.switchPart("nobody", "s-old"), /Unknown Bot/);
});

test("the handoff package's bare opening is answered with a fixed line, not a model call", async (t) => {
	const env = await start();
	t.after(() => {});
	const listener = env.ctx.listeners.get("llm/stream").at(-1);
	const bare = [{ role: "user", source: { kind: SOURCE_KIND, handoff: true } }];
	const events: any[] = [];
	for await (const event of listener({ sessionId: "s-now", messages: bare }, () => [])) events.push(event);
	assert.deepEqual(
		events.map((event) => [event.type, event.text ?? event.block?.text]),
		[
			["block-start", undefined],
			["text-delta", HANDOFF_ACK],
			["block-end", HANDOFF_ACK],
			["finish", undefined],
		],
	);
	// A resumed handoff is real work: the model call passes through.
	const next = () =>
		(async function* pass() {
			yield { type: "finish", reason: { kind: "stop" } };
		})();
	const passed: any[] = [];
	for await (const event of listener(
		{ sessionId: "s-now", messages: [{ role: "user", source: { kind: SOURCE_KIND, handoff: true, resume: true } }] },
		next,
	))
		passed.push(event);
	assert.deepEqual(passed, [{ type: "finish", reason: { kind: "stop" } }]);
});
