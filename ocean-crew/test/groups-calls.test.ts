// Group call batches that survive a restart: the summary a completed batch still owes,
// the goal revision a result was asked for under, replay by callId, and budgets that
// count member work and the caller's summaries apart from the idle guard.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { install as installHandoffs } from "../src/host/chat/handoffs.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { install as installGroups } from "../src/host/groups/index.ts";
import { fakeContext } from "./fake-ctx.ts";

interface Message {
	content: { type: string; text?: string }[];
	source: Record<string, unknown>;
}

interface Agent {
	session: { id: string };
	calls: Message[];
	cancelled: { kind?: string }[];
	followup(message: Message): void;
	steer(message: Message): void;
	cancel(reason: { kind?: string }): void;
	inbox: {
		nextStep: unknown[];
		nextTurn: unknown[];
		remove(id: string): boolean;
	};
}

interface Projections {
	snapshot(session: unknown): { values: { tokenUsage: Record<string, number> } };
}

interface Host {
	rt: Runtime & Record<string, any>;
	ctx: ReturnType<typeof fakeContext>;
	home: string;
	agentOf(sessionId: string): Agent;
	run(callId: string, post?: Record<string, unknown>): { read(): any; done: Promise<void>; stop(): void };
	begin(sessionId: string): Message;
	finish(sessionId: string, text: string): Promise<void>;
	toolCall(sessionId: string, name: string): void;
	deliveredTo(sessionId: string): Message;
	posts(): Message[];
	nextPost(): Message;
	state(): any;
	calls(): Record<string, any>;
	callRuns(): Record<string, any>;
	close(): Promise<void>;
}

interface StartOptions {
	home?: string;
	room?: Record<string, unknown>;
	config?: Record<string, unknown>;
	projections?: Projections;
}

const seed = (room: Record<string, unknown> = {}, bots: Record<string, Record<string, unknown>> = {}) => ({
	version: 1,
	mainBotIds: ["a"],
	bots: {
		a: { id: "a", name: "Chief", role: "Boss", sessionId: "a", createdAt: 1, ...bots.a },
		b: { id: "b", name: "Writer", role: "Write", sessionId: "b", createdAt: 2, ...bots.b },
		c: { id: "c", name: "Tester", role: "Test", sessionId: "c", createdAt: 3, ...bots.c },
	},
	rooms: {
		r1: {
			id: "r1",
			name: "Ops",
			members: ["a", "b", "c"],
			mode: "admin",
			admin: "a",
			named: true,
			sessions: { a: "ga", b: "gb", c: "gc" },
			log: [],
			seq: 0,
			seen: {},
			...room,
		},
	},
	agents: {},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
	prefs: {},
	revision: 0,
});

const tempHome = (t: { after(fn: () => void): void }): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-group-calls-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};

async function start(t: { after(fn: () => void): void }, options: StartOptions = {}): Promise<Host> {
	const home = options.home ?? tempHome(t);
	const statePath = join(home, "state.json");
	if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify(seed(options.room, {})));
	const ctx = fakeContext(
		options.projections === undefined ? {} : { services: { sessionProjections: options.projections } },
	);
	const agents = new Map<string, Agent>();
	const delivered = new Map<string, Message>();
	const agentOf = (sessionId: string): Agent => {
		let agent = agents.get(sessionId);
		if (agent === undefined) {
			const calls: Message[] = [];
			const cancelled: { kind?: string }[] = [];
			const held: unknown[] = [];
			const nextStep: unknown[] = [];
			agent = {
				session: { id: sessionId },
				calls,
				cancelled,
				followup: (message) => {
					calls.push(message);
					held.push(message);
				},
				steer: (message) => {
					calls.push(message);
					nextStep.push(message);
				},
				cancel: (reason) => {
					cancelled.push(reason);
				},
				inbox: {
					nextStep,
					nextTurn: held,
					remove(id: string) {
						for (const list of [nextStep, held]) {
							const at = list.findIndex((message) => (message as { id?: string }).id === id);
							if (at !== -1) {
								list.splice(at, 1);
								return true;
							}
						}
						return false;
					},
				},
			};
			agents.set(sessionId, agent);
		}
		return agent;
	};
	let created = 0;
	Object.assign(ctx, {
		llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
		workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
		sessionController: {
			create: async () => ({ sessionId: `g${++created}` }),
			resolveAgent: async (sessionId: string) => ({ agent: agentOf(sessionId) }),
			selectModel: async () => {},
		},
		sessionTitle: { rename: async () => {} },
		sessions: { flush: async () => {} },
	});
	const rt = {
		ctx,
		config: options.config ?? {},
		dshHome: home,
		home,
		statePath,
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief" },
		warn: () => {},
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);
	installHandoffs(rt);
	rt.deliver = async (item: Record<string, unknown>) => {
		const sessionId = String(item.sessionId);
		// What turns.ts keeps of a group post's source: a late result's dispatch goal is
		// not among these fields, so the saved late-goal list has to carry it.
		const source = {
			kind: "bot",
			role: item.role,
			roomId: item.roomId,
			exchangeId: item.exchangeId,
			note: item.note,
			askedBy: item.askedBy,
			late: item.late,
			senderName: "Chief",
		};
		const message: Message = { content: [{ type: "text", text: String(item.text ?? "") }], source };
		delivered.set(sessionId, message);
		agentOf(sessionId).calls.push(message);
	};
	rt.resolveAgent = async (sessionId: string) => agentOf(String(sessionId));
	rt.sessionOfRoom = (saved: any) => saved?.sessionId ?? saved?.id;
	rt.hasSubagents = () => false;
	rt.waitsForApproval = () => false;
	rt.stopRoomTurn = async () => {};
	rt.stopSubagents = async () => {};
	rt.live ??= new Map();
	rt.roomWaiters ??= new Map();
	rt.roomProgress ??= new Map();
	rt.roomInbox ??= new Map();
	rt.updateRoom = async () => ({});
	rt.workDirOf = () => home;
	rt.ensureCapabilities = async () => {};
	rt.desiredModel = async () => undefined;
	rt.desiredEffort = async () => undefined;
	rt.selectSessionModel = async () => {};
	rt.applyPermission = async () => {};
	rt.ownChatBrief = async () => undefined;
	rt.uiLanguage = () => "English";
	rt.groupTiming = { replyTimeoutMs: 400, workGraceMs: 60, stepGapMs: 25 };
	await rt.load();
	installGroups(rt);

	const run = (callId: string, post?: Record<string, unknown>) => {
		if (post !== undefined) {
			const list = (rt.roomInbox.get("r1") ?? []) as Record<string, unknown>[];
			rt.roomInbox.set("r1", [...list, post]);
		}
		const controller = new AbortController();
		let result: any;
		const done = (async () => {
			const definition = rt.teamTools.find((entry) => entry.name === "group_relay");
			const value = await definition?.execute?.({}, { callId, signal: controller.signal, agent: { id: "r1" } });
			result = value === undefined ? undefined : JSON.parse(String(value));
		})();
		return { read: () => result, done, stop: () => controller.abort() };
	};
	const begin = (sessionId: string): Message => {
		const message = agentOf(sessionId).calls.at(-1)!;
		rt.live.set(sessionId, { turn: 1 });
		rt.touchRoomTurn?.(sessionId);
		return message;
	};
	const finish = async (sessionId: string, text: string) => {
		const info = delivered.get(sessionId)?.source as any;
		const heldLines = rt.takeRoomSteps?.(sessionId) ?? "";
		const reply = rt.withRoomSteps?.(heldLines, text) ?? text;
		const waiter = info?.exchangeId === undefined ? undefined : rt.roomWaiters.get(info.exchangeId);
		if (waiter !== undefined) {
			rt.roomWaiters.delete(info.exchangeId);
			waiter.resolve(reply);
		} else if (info !== undefined) {
			await rt.lateRoomReply?.(sessionId, info, reply, { shown: true });
		}
		rt.live.delete(sessionId);
	};
	const close = async () => {
		await ctx.dispose();
	};
	const state = () => JSON.parse(readFileSync(statePath, "utf8"));
	return {
		rt,
		ctx,
		home,
		agentOf,
		run,
		begin,
		finish,
		toolCall: (sessionId, name) => rt.workRoomTurn?.(sessionId, name),
		deliveredTo: (sessionId) => delivered.get(sessionId)!,
		posts: () => agentOf("r1").calls,
		nextPost: () => agentOf("r1").calls.shift()!,
		state,
		calls: () => state().rooms.r1.calls ?? {},
		callRuns: () => state().rooms.r1.callRuns ?? {},
		close,
	};
}

// Waits on real I/O (state writes, timers) without polling a fixed sleep.
const settle = async (check: () => boolean, timeoutMs = 3010): Promise<void> => {
	const until = Date.now() + timeoutMs;
	while (!check() && Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(check(), "condition not reached");
};
const textOf = (message: Message) => message.content.map((block) => block.text ?? "").join("\n");

test("a batch that completed before the crash still owes its summary after a restart", async (t) => {
	const home = tempHome(t);
	const first = await start(t, { home });
	const round = first.run("c1", { text: "全面检查一下" });
	await settle(() => first.agentOf("ga").calls.length === 1);
	first.begin("ga");
	await first.finish("ga", "@Writer @Tester 分别检查文档和测试");
	await settle(() => first.agentOf("gb").calls.length === 1 && first.agentOf("gc").calls.length === 1);
	first.begin("gb");
	first.begin("gc");
	first.toolCall("gb", "read");
	first.toolCall("gc", "pwsh");
	await settle(() => round.read() !== undefined);

	// Both results come back after the round moved on: the barrier completes into a done
	// post for the group's Session, and the process "dies" before a round runs it.
	await first.finish("gb", "文档检查完毕。");
	await settle(() => first.posts().length === 1);
	await first.finish("gc", "测试全部通过。");
	await settle(() =>
		Object.values(first.state().rooms.r1.calls ?? {}).some((call: any) => call.state === "awaiting-summary"),
	);
	const saved = Object.values(first.calls())[0] as any;
	assert.equal(saved.state, "awaiting-summary");
	assert.equal(typeof saved.completedAt, "number");
	assert.equal(saved.summary.state, "pending", "no round is left to ask the caller in");
	assert.equal(saved.goal, undefined, "no goal means no dispatch revision to report");
	await first.close();

	// A restarted host reads the saved batch and asks the caller again in its next round.
	const second = await start(t, { home });
	const next = second.run("c2", { text: "继续" });
	await settle(() => second.agentOf("ga").calls.length === 1);
	const delivery = textOf(second.deliveredTo("ga"));
	// The results had not reached the group log before the crash; the recovered notice
	// puts them in front of the caller that must summarize them.
	assert.match(delivery, /文档检查完毕/);
	assert.match(delivery, /测试全部通过/);
	second.begin("ga");
	await second.finish("ga", "两项都过了。");
	await settle(() => next.read() !== undefined);
	const calls = Object.values(second.calls()) as any[];
	assert.equal(calls.length, 1);
	assert.equal(calls[0].state, "delivered");
	assert.equal(calls[0].summary.state, "posted");
	assert.equal(calls[0].summary.attempts, 1);
	assert.equal(calls[0].summary.text, "两项都过了。");
	await second.close();
});

test("a late result carries the goal revision it was dispatched under, not the current one", async (t) => {
	const home = tempHome(t);
	const host = await start(t, {
		home,
		room: { goal: { id: "g1", status: "active", revision: 1, objectiveRevision: 1 } },
	});
	const round = host.run("c1", { text: "开始" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer 处理文档");
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.toolCall("gb", "read");
	await settle(() => round.read() !== undefined);

	// The goal is revised while the member works: the result still answers revision 1.
	(host.rt.state.rooms.r1 as any).goal.revision = 2;
	(host.rt.state.rooms.r1 as any).goal.objectiveRevision = 2;
	await host.rt.save();
	await host.finish("gb", "文档处理完了。");
	await settle(() => host.posts().length === 1);
	const posted = host.nextPost();
	const carried = {
		text: textOf(posted),
		botId: "b",
		name: "Writer",
		late: true,
		...(posted.source.askedBy !== undefined ? { askedBy: posted.source.askedBy } : {}),
	};
	// The group's own Session does not carry unknown source fields; only what the room
	// kept for the line can put the revision back.
	assert.equal(posted.source.goalRevision, undefined);
	const next = host.run("c2", carried);
	await settle(() => host.state().rooms.r1.log.some((line: any) => line.botId === "b" && line.goalRevision === 1));
	const line = host.state().rooms.r1.log.find((entry: any) => entry.botId === "b" && entry.goalRevision === 1);
	assert.equal(line.goalId, "g1");
	assert.equal(line.goalObjectiveRevision, 1);
	assert.equal((host.rt.state.rooms.r1 as any).goal.revision, 2);
	// The caller reading the group sees which revision the result answers.
	const chat = String(
		await host.rt.teamTools
			.find((tool) => tool.name === "read_group_chat")
			?.execute?.({ group: "Ops" }, { agent: { id: "ga" } }),
	);
	assert.match(chat, /文档处理完了。 \(asked at goal revision 1\)/);
	await settle(() => host.agentOf("ga").calls.length === 2);
	host.begin("ga");
	await host.finish("ga", "收到。");
	await settle(() => next.read() !== undefined);
	const batch = Object.values(host.calls())[0] as any;
	assert.deepEqual(batch.goal, { id: "g1", revision: 1, objectiveRevision: 1 });
	await host.close();
});

test("the same words are a new task under a new callId, and a replay does not run again", async (t) => {
	const host = await start(t);
	const first = host.run("c1", { text: "写周报" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "周报写好了。");
	await settle(() => first.read() !== undefined);
	assert.deepEqual(
		first.read().replies.map((reply: any) => reply.text),
		["周报写好了。"],
	);

	// The same text as a new call is a new task.
	const second = host.run("c2", { text: "写周报" });
	await settle(() => host.agentOf("ga").calls.length === 2);
	host.begin("ga");
	await host.finish("ga", "又写了一份。");
	await settle(() => second.read() !== undefined);
	assert.deepEqual(
		second.read().replies.map((reply: any) => reply.text),
		["又写了一份。"],
	);
	assert.equal(host.state().rooms.r1.log.filter((line: any) => line.who === "User").length, 2);

	// The replay of c1 returns the saved result and calls nobody.
	await settle(() => host.callRuns().c1?.state === "done");
	const replay = host.run("c1");
	await settle(() => replay.read() !== undefined);
	assert.equal(replay.read().replayed, true);
	assert.deepEqual(
		replay.read().replies.map((reply: any) => reply.text),
		["周报写好了。"],
	);
	assert.equal(host.agentOf("ga").calls.length, 2);
	await host.close();
});

test("a call the previous process was running is not run twice", async (t) => {
	const home = tempHome(t);
	const statePath = join(home, "state.json");
	writeFileSync(
		statePath,
		JSON.stringify({
			...seed(),
			rooms: {
				r1: {
					...seed().rooms.r1,
					callRuns: { c9: { callId: "c9", at: 1, state: "running" } },
				},
			},
		}),
	);
	const host = await start(t, { home });
	const call = host.run("c9", { text: "写周报" });
	await settle(() => call.read() !== undefined);
	assert.equal(call.read().interrupted, true);
	assert.equal(host.agentOf("ga").calls.length, 0, "no member was called again");
	await settle(() => host.callRuns().c9?.state === "failed");
	assert.match(String(host.callRuns().c9.error), /restarted while this relay was running/);
	await host.close();
});

test("the member budget stops member work without spending the summary budget", async (t) => {
	const host = await start(t, {
		room: { budget: { members: { limit: 0, spent: 0 }, summary: { limit: 5, spent: 0 } } },
	});
	const round = host.run("c1", { text: "写周报" });
	await settle(() => round.read() !== undefined);
	assert.equal(host.agentOf("ga").calls.length, 0, "no member turn started");
	assert.deepEqual(
		round.read().replies.map((reply: any) => reply.kind),
		["budget"],
	);
	// The user's message resets the idle streak, so stand the guard up afterwards: its
	// counter and pause are separate from both budgets and never spend either.
	(host.rt.state.rooms.r1 as any).idleRelays = 2;
	(host.rt.state.rooms.r1 as any).idlePaused = { from: "a", count: 2, noticed: true };
	await host.rt.save();
	const view = await host.rt.groupBudgetView("r1");
	assert.equal(view.members.limit, 0);
	assert.equal(view.members.spent, 0);
	assert.equal(view.summary.spent, 0);
	assert.equal(view.idle.streak, 2, "the idle guard is a separate counter");
	assert.equal(view.idle.paused, true);
	const notice = host.state().rooms.r1.log.find((line: any) => line.reason === "budget");
	assert.match(String(notice.text), /member work budget is used up/);
	await host.close();
});

test("the summary budget fails the batch instead of waking the caller", async (t) => {
	const host = await start(t, {
		room: { budget: { members: { limit: 5, spent: 0 }, summary: { limit: 0, spent: 0 } } },
	});
	const round = host.run("c1", { text: "开始" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer 处理文档");
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.toolCall("gb", "read");
	await host.finish("gb", "文档处理完了。");
	await settle(() => round.read() !== undefined);
	// The caller was not woken for a summary.
	assert.equal(host.agentOf("ga").calls.length, 1);
	const batch = Object.values(host.calls())[0] as any;
	assert.equal(batch.state, "failed");
	assert.match(String(batch.error), /summary budget is used up/);
	const view = await host.rt.groupBudgetView("r1");
	assert.equal(view.members.spent, 2);
	assert.equal(view.summary.spent, 0, "the refused summary did not spend its budget");
	assert.equal(view.idle.streak, 0);
	const notice = host.state().rooms.r1.log.find((line: any) => line.reason === "calls");
	assert.match(String(notice.text), /summary budget is used up/);
	await host.close();
});

test("DSH token usage is attributed to member and summary budgets separately", async (t) => {
	let tokens = 0;
	const projections: Projections = {
		snapshot() {
			tokens += 20;
			return { values: { tokenUsage: { uncachedInputTokens: 12, outputTokens: tokens, cacheReadTokens: 8 } } };
		},
	};
	const host = await start(t, { projections });
	const round = host.run("c1", { text: "开始" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer 处理文档");
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.toolCall("gb", "read");
	await host.finish("gb", "文档处理完了。");
	await settle(() => host.agentOf("ga").calls.length === 2);
	host.begin("ga");
	await host.finish("ga", "都处理好了。");
	await settle(() => round.read() !== undefined);
	await settle(() => Object.values(host.calls()).some((call: any) => call.state === "delivered"));
	const view = await host.rt.groupBudgetView("r1");
	assert.equal(view.available, true);
	assert.equal(view.members.spent, 2);
	assert.equal(view.summary.spent, 1);
	assert.ok(Number(view.members.tokens) > 0, "member turns charged DSH tokens");
	assert.ok(Number(view.summary.tokens) > 0, "the summary turn charged DSH tokens");
	assert.notEqual(view.members.tokens, view.summary.tokens);
	await host.close();
});

test("an open batch the restart cut fails out loud instead of blocking the group", async (t) => {
	const home = tempHome(t);
	const statePath = join(home, "state.json");
	const base = seed();
	writeFileSync(
		statePath,
		JSON.stringify({
			...base,
			rooms: {
				r1: {
					...base.rooms.r1,
					calls: {
						b1: {
							key: "b1",
							roomId: "r1",
							by: "a",
							callees: ["b"],
							pending: ["b"],
							done: [],
							worked: false,
							answered: false,
							state: "open",
							createdAt: 1,
							updatedAt: 1,
							writer: "an earlier process",
						},
					},
				},
			},
		}),
	);
	const host = await start(t, { home });
	const round = host.run("c1", { text: "继续" });
	await settle(() => host.calls().b1?.state === "failed");
	assert.match(String(host.calls().b1.error), /restarted while this call was still out/);
	const notice = host.state().rooms.r1.log.find((line: any) => line.reason === "calls");
	assert.match(String(notice.text), /Writer/);
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "知道了。");
	await settle(() => round.read() !== undefined);
	// A second round does not repeat the recovery notice for the same record.
	const before = host.state().rooms.r1.log.filter((line: any) => line.reason === "calls").length;
	host.run("c2", { text: "再继续" }).stop();
	await settle(() => host.state().rooms.r1.log.filter((line: any) => line.reason === "calls").length === before);
	await host.close();
});

test("a Bot line in the group delivers the hand-off result it still owed", async (t) => {
	const host = await start(t);
	host.rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	host.rt.closeWork("w1", "Writer", "整理好了，在 docs/ 下。");
	assert.equal(host.rt.publishOf("w1")?.state, "pending");
	const round = host.run("c1", { text: "写周报" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "周报写好了。");
	await settle(() => round.read() !== undefined);
	await settle(() => host.rt.publishOf("w1")?.state === "delivered");
	await host.close();
});

test("a token budget is enforced from DSH usage and stops the next member", async (t) => {
	let reported = 0;
	const projections: Projections = {
		snapshot() {
			reported += 20;
			return { values: { tokenUsage: { outputTokens: reported } } };
		},
	};
	const host = await start(t, {
		projections,
		room: {
			budget: {
				members: { limit: 5, tokenLimit: 30, spent: 0 },
				summary: { limit: 5, spent: 0 },
			},
		},
	});
	const round = host.run("c1", { text: "开始" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer 处理文档");
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.toolCall("gb", "read");
	await host.finish("gb", "@Tester 你验证一下");
	await settle(() => round.read() !== undefined);
	// Chief and Writer spent 20 tokens each; Tester's turn is refused on the token
	// budget, not on a turn count (only two member turns were charged).
	assert.equal(host.agentOf("gc").calls.length, 0);
	const view = await host.rt.groupBudgetView("r1");
	assert.equal(view.members.spent, 2);
	assert.equal(view.members.tokenLimit, 30);
	assert.equal(view.members.tokens, 40);
	const notice = host.state().rooms.r1.log.find((line: any) => line.reason === "budget");
	assert.match(String(notice.text), /member work budget is used up/);
	await host.close();
});
