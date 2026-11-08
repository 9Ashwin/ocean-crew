// Round races: a post that lands while a round runs, a user message that arrives
// mid-round, two posts queued together, a late reply that races the round ending, and
// a stopped round.
// create/update;
// class of race inside the round, which is the part groups owns.)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { install as installGroups } from "../src/host/groups/index.ts";
import { fakeContext } from "./fake-ctx.ts";

interface Message {
	content: { type: string; text?: string }[];
	source: Record<string, unknown>;
}

const seed = () => ({
	version: 1,
	mainBotIds: ["a"],
	bots: {
		a: { id: "a", name: "Chief", role: "Boss", sessionId: "a", createdAt: 1 },
		b: { id: "b", name: "Writer", role: "Write", sessionId: "b", createdAt: 2 },
		c: { id: "c", name: "Tester", role: "Test", sessionId: "c", createdAt: 3 },
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
		},
	},
	agents: {},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
	prefs: {},
	revision: 0,
});

async function start(_t: { after(fn: () => void | Promise<void>): void }) {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-races-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(seed()));
	const ctx = fakeContext();
	const agents = new Map<
		string,
		{
			session: { id: string };
			calls: Message[];
			cancelled: unknown[];
			followup(m: Message): void;
			steer(m: Message): void;
			cancel(r: unknown): void;
			inbox: { nextStep: unknown[]; nextTurn: unknown[]; remove(id: string): boolean };
		}
	>();
	const delivered = new Map<string, Record<string, unknown>>();
	const stoppedTurns: unknown[] = [];
	const agentOf = (sessionId: string) => {
		let agent = agents.get(sessionId);
		if (agent === undefined) {
			const calls: Message[] = [];
			const cancelled: unknown[] = [];
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
	Object.assign(ctx, {
		llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
		workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
		sessionController: {
			create: async () => ({ sessionId: "g1" }),
			resolveAgent: async (sessionId: string) => agentOf(sessionId),
			selectModel: async () => {},
		},
		sessionTitle: { rename: async () => {} },
		sessions: { flush: async () => {} },
	});
	// Only the store and the group module are installed: the test drives the module

	const rt = {
		ctx,
		config: {},
		dshHome: home,
		home,
		statePath: join(home, "state.json"),
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief" },
		warn: () => {},
	} as unknown as Runtime;
	installStore(rt);
	rt.deliver = async (item: Record<string, unknown>) => {
		const sessionId = String(item.sessionId);
		const source = {
			kind: "bot",
			role: item.role,
			roomId: item.roomId,
			exchangeId: item.exchangeId,
			note: item.note,
			askedBy: item.askedBy,
		};
		delivered.set(sessionId, source);
		agentOf(sessionId).calls.push({ content: [{ type: "text", text: String(item.text ?? "") }], source });
	};
	rt.roomWaiters ??= new Map();
	rt.roomProgress ??= new Map();
	rt.roomInbox ??= new Map();
	rt.resolveAgent = async (sessionId: string) => agentOf(String(sessionId));
	rt.stopRoomTurn = async (sessionId: string, exchangeId: string) => {
		stoppedTurns.push([sessionId, exchangeId]);
	};
	rt.stopSubagents = async () => {};
	rt.ensureCapabilities = async () => {};
	rt.workDirOf = () => home;
	rt.desiredModel = async () => undefined;
	rt.desiredEffort = async () => undefined;
	rt.selectSessionModel = async () => {};
	rt.applyPermission = async () => {};
	rt.ownChatBrief = async () => undefined;
	rt.uiLanguage = () => "English";
	rt.groupTiming = { replyTimeoutMs: 300, workGraceMs: 60, stepGapMs: 20 };
	await rt.load();
	installGroups(rt);

	const tool = async (
		name: string,
		args: Record<string, unknown>,
		sessionId: string,
		exec: Record<string, unknown> = {},
	) => {
		const definition = rt.teamTools.find((entry) => entry.name === name);
		const execute = definition?.execute as (...values: unknown[]) => Promise<unknown>;
		return execute(args, { agent: { id: sessionId }, ...exec });
	};
	const enqueue = (post: Record<string, unknown>) => {
		const list = (rt.roomInbox.get("r1") ?? []) as Record<string, unknown>[];
		rt.roomInbox.set("r1", [...list, post]);
	};
	const run = (
		callId: string,
		posts: Record<string, unknown>[],
		options: { agent?: unknown; signal?: AbortSignal } = {},
	) => {
		for (const post of posts) enqueue(post);
		const controller = options.signal ? undefined : new AbortController();
		const signal = options.signal ?? controller!.signal;
		let result: any;
		const done = tool("group_relay", {}, "r1", {
			callId,
			signal,
			...(options.agent ? { agent: options.agent } : {}),
		}).then((value) => {
			result = JSON.parse(String(value));
		});
		return { read: () => result, done, stop: () => controller?.abort() };
	};
	const begin = (sessionId: string) => {
		const message = agentOf(sessionId).calls.at(-1)!;
		rt.live ??= new Map();
		rt.live.set(sessionId, { turn: 1 });
		rt.touchRoomTurn?.(sessionId);
		return message;
	};
	const finish = async (sessionId: string, text: string) => {
		const info = delivered.get(sessionId) as any;
		const lines = rt.takeRoomSteps?.(sessionId) ?? "";
		const reply = rt.withRoomSteps?.(lines, text) ?? text;
		const waiter = info?.exchangeId === undefined ? undefined : rt.roomWaiters.get(info.exchangeId);
		if (waiter !== undefined) {
			rt.roomWaiters.delete(info.exchangeId);
			waiter.resolve(reply);
		} else if (info !== undefined) await rt.lateRoomReply?.(sessionId, info, reply, { shown: true });
		rt.live?.delete(sessionId);
	};
	const room = () => rt.roomOf("r1") as any;
	const sender = (id: string) => rt.botOf(id) as any;
	const deliver = async (id: string, text: string, extra: Record<string, unknown> = {}) => {
		await rt.postToRoom?.(room(), sender(id), text, extra);
	};
	const stop = async () => {
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return {
		rt,
		ctx,
		home,
		agentOf,
		tool,
		run,
		begin,
		finish,
		room,
		sender,
		deliver,
		enqueue,
		stoppedTurns,
		state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")),
		stop,
	};
}

const settle = async (check: () => boolean) => {
	const until = Date.now() + 3000;
	while (!check() && Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(check(), "condition not reached");
};

test("a Bot post during a running round is logged at once and calls its member in that round (#663)", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", [{ text: "安排一下" }]);
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	// Writer posts while the round runs: the post is in the log and calls Tester in this round.
	await host.deliver("b", "@Tester 帮个忙");
	await settle(() => host.agentOf("gc").calls.length === 1);
	const live = [...host.rt.roomProgress.values()][0] as any;
	assert.deepEqual(
		live.replies.map((reply: any) => reply.name),
		["Writer"],
	);
	const log = host.room().log;
	assert.deepEqual([log.at(-1).who, log.at(-1).text], ["Writer", "@Tester 帮个忙"]);
	// Nothing was queued for the group Session: the running round took the post itself.
	assert.equal(host.agentOf("r1").calls.length, 0);
	host.begin("gc");
	await host.finish("gc", "来了。");
	await host.finish("ga", "好。");
	await settle(() => round.read() !== undefined);
	// The Chief is still speaking when Writer's post lands, so Writer's line and Tester's
	// reply come before the Chief's own message.
	assert.deepEqual(
		round.read().replies.map((reply: any) => reply.name),
		["Writer", "Tester", "Chief"],
	);
});

test("two posts queued together are posted in order and the newest picks the speakers", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", [{ text: "第一句" }, { text: "@Writer 第二句" }]);
	await settle(() => host.agentOf("gb").calls.length === 1);
	// Both user lines are in the log, oldest first; only the newest chooses who answers.
	assert.deepEqual(
		host.room().log.map((line: any) => [line.who, line.text]),
		[
			["User", "第一句"],
			["User", "@Writer 第二句"],
		],
	);
	assert.equal(host.agentOf("ga").calls.length, 0);
	host.begin("gb");
	await host.finish("gb", "看到了。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(
		round.read().replies.map((reply: any) => reply.name),
		["Writer"],
	);
});

test("a user message that arrives mid-round is drained into that round", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const taking = new Set<string>(["u2"]);
	const inbox = {
		nextStep: [] as unknown[],
		nextTurn: [] as unknown[],
		remove(id: string): boolean {
			if (!taking.delete(id)) return false;
			inbox.nextTurn.length = 0;
			return true;
		},
	};
	const agent = { id: "r1", inbox };
	const round = host.run("c1", [{ text: "开始" }], { agent });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	// The user writes while the round runs; DSH hands the message to the group Session.
	inbox.nextTurn.push({ id: "u2", content: [{ type: "text", text: "接着做" }], source: { kind: "user" } });
	host.rt.nudgeRoom?.("r1");
	await settle(() => host.room().log.some((line: any) => line.text === "接着做"));
	const live = [...host.rt.roomProgress.values()][0] as any;
	assert.deepEqual(live.replies.at(-1), { kind: "user", text: "接着做", time: live.replies.at(-1).time });
	await host.finish("ga", "先说我。");
	// The admin is called again for the message it took in.
	await settle(() => host.agentOf("ga").calls.length === 2);
	const second = host.begin("ga");
	await host.finish("ga", "接着说。");
	await settle(() => round.read() !== undefined);
	void second;
	// The mid-round user line posts at once, before the speaker's message it interrupted.
	assert.deepEqual(
		host.room().log.map((line: any) => line.text),
		["开始", "接着做", "先说我。", "接着说。"],
	);
});

test("a late reply that races the round ending is delivered to the group Session once", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", [{ text: "@Writer 看一下" }]);
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	await host.finish("gb", "看完了。");
	await settle(() => round.read() !== undefined);
	// The round has ended: the late reply reaches the group's Session, not the dead round.
	const info = { kind: "bot", role: "room", roomId: "r1", exchangeId: "late-x", askedBy: "a" };
	await host.rt.lateRoomReply?.("gb", info as any, "迟到的结果。", { shown: true });
	assert.equal(host.agentOf("r1").calls.length, 1);
	assert.equal(host.agentOf("r1").calls[0].content[0].text, "[Group post from Writer]\n迟到的结果。");
});

test("a round whose signal aborts stops the member turns it started", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const controller = new AbortController();
	const round = host.run("c1", [{ text: "@Writer @Tester 一起看" }], { signal: controller.signal });
	await settle(() => host.agentOf("gb").calls.length === 1 && host.agentOf("gc").calls.length === 1);
	host.begin("gb");
	host.begin("gc");
	controller.abort();
	await settle(() => round.read() !== undefined);
	assert.equal(host.stoppedTurns.length, 2);
	assert.deepEqual(host.stoppedTurns.map((entry: any) => entry[0]).sort(), ["gb", "gc"]);
});
