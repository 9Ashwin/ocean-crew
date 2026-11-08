// The group round engine: who answers a message, in what order, what a member reads,
// when work lets the round go on, and how a late result gets back to the member that
// asked.

// published contract (rt.deliver, rt.touchRoomTurn, rt.workRoomTurn, rt.roomStepText,
// rt.takeRoomSteps, rt.roomWaiters, rt.lateRoomReply) and asserts on the round result,
// the group log and the messages the group Session would relay.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface Host {
	rt: Runtime;
	ctx: ReturnType<typeof fakeContext>;
	home: string;
	agentOf(sessionId: string): Agent;
	run(
		callId: string,
		post?: Record<string, unknown>,
		agent?: unknown,
	): { read(): any; done: Promise<void>; stop(): void };
	tool(name: string, args: Record<string, unknown>, sessionId: string): Promise<unknown>;
	begin(sessionId: string): Message;
	finish(sessionId: string, text: string): Promise<void>;
	endWithFailure(sessionId: string, failure: { code: string; status?: number; message: string }): Promise<void>;
	failTurn(sessionId: string, failure: { code: string; status?: number; message: string }): void;
	approve(sessionId: string): void;
	toolCall(sessionId: string, name: string): void;
	step(sessionId: string, text: string): Promise<void>;
	say(text: string): Record<string, unknown>;
	posts(): Message[];
	nextPost(): Message;
	state(): any;
	stop(): Promise<void>;
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

async function start(
	_t: { after(fn: () => void | Promise<void>): void },
	room: Record<string, unknown> = {},
): Promise<Host> {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-groups-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(seed(room)));
	const ctx = fakeContext();
	const agents = new Map<string, Agent>();
	const delivered = new Map<string, Record<string, unknown>>();
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
	// groups only calls these.
	rt.deliver = async (item: Record<string, unknown>) => {
		const sessionId = String(item.sessionId);
		const source = {
			kind: "bot",
			role: item.role,
			roomId: item.roomId,
			exchangeId: item.exchangeId,
			note: item.note,
			askedBy: item.askedBy,
			senderName: "Chief",
		};
		delivered.set(sessionId, source);
		agentOf(sessionId).calls.push({ content: [{ type: "text", text: String(item.text ?? "") }], source });
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
	const timing = { replyTimeoutMs: 400, workGraceMs: 60, stepGapMs: 25 };
	rt.groupTiming = timing;
	await rt.load();
	installGroups(rt);

	const enqueue = (post: Record<string, unknown>) => {
		const list = (rt.roomInbox.get("r1") ?? []) as Record<string, unknown>[];
		rt.roomInbox.set("r1", [...list, post]);
	};
	const tool = async (
		name: string,
		args: Record<string, unknown>,
		sessionId: string,
		exec: Record<string, unknown>,
	) => {
		const definition = rt.teamTools.find((entry) => entry.name === name);
		const execute = definition?.execute as (...values: unknown[]) => Promise<unknown>;
		return execute(args, { agent: { id: sessionId }, ...exec });
	};
	const run = (callId: string, post?: Record<string, unknown>, agent: unknown = { id: "r1" }) => {
		if (post !== undefined) enqueue(post);
		const controller = new AbortController();
		let result: any;
		const done = (async () => {
			const value = await tool("group_relay", {}, "r1", { callId, signal: controller.signal, agent });
			result = JSON.parse(String(value));
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
		const info = delivered.get(sessionId) as any;
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
	const failTurn = (sessionId: string, failure: { code: string; status?: number; message: string }) => {
		rt.failRoomTurn?.(sessionId, failure);
		rt.live.delete(sessionId);
	};
	const endWithFailure = async (sessionId: string, failure: { code: string; status?: number; message: string }) => {
		const info = delivered.get(sessionId) as any;
		const waiter = info?.exchangeId === undefined ? undefined : rt.roomWaiters.get(info.exchangeId);
		if (waiter !== undefined) {
			rt.roomWaiters.delete(info.exchangeId);
			waiter.fail(failure);
		} else if (info !== undefined) {
			await rt.lateRoomFailure?.(sessionId, info, failure);
		}
		rt.live.delete(sessionId);
	};
	const approve = (sessionId: string) => {
		rt.yieldRoomTurn?.(sessionId);
		rt.live.delete(sessionId);
	};
	const toolCall = (sessionId: string, name: string) => rt.workRoomTurn?.(sessionId, name);
	const step = async (sessionId: string, text: string) => {
		const info = delivered.get(sessionId) as any;
		await rt.roomStepText?.(sessionId, info, text, true);
	};
	const posts = () => agentOf("r1").calls;
	const state = () => JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
	const stop = async () => {
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return {
		rt,
		ctx,
		home,
		agentOf,
		tool: (name, args, sessionId) => tool(name, args, sessionId, {}),
		run,
		begin,
		finish,
		endWithFailure,
		failTurn,
		approve,
		toolCall,
		step,
		say: (text: string) => ({ text }),
		posts,
		nextPost: () => agentOf("r1").calls.shift()!,
		state,
		stop,
	};
}

// Waits on real I/O (state writes, timers) without polling a fixed sleep.
const settle = async (check: () => boolean) => {
	const until = Date.now() + 3000;
	while (!check() && Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(check(), "condition not reached");
};
const kinds = (result: any) => result.replies.map((reply: any) => [reply.kind ?? "message", reply.name]);
const textOf = (message: Message) => message.content.map((block) => block.text ?? "").join("\n");

test("admin mode: a plain message calls the admin alone, whose reply is the round", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("写个周报"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	assert.deepEqual(host.agentOf("gb").calls, []);
	const prompt = textOf(host.begin("ga"));
	assert.match(prompt, /Members: the user, Writer, Tester and you \(admin\)\./);
	assert.match(prompt, /You are this group's admin\./);
	assert.match(prompt, /Plain messages come to you first/);
	assert.match(prompt, /This round so far, starting with the new message/);
	await host.finish("ga", "本周完成：群聊模块。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["message", "Chief"]]);
	assert.equal(round.read().passed.length, 0);
	const saved = host.state().rooms.r1;
	assert.deepEqual(
		saved.log.map((line: any) => line.who),
		["User", "Chief"],
	);
	assert.equal(saved.log[0].seq, 1);
});

test("admin mode: the admin called with @ answers, and the admin gets the round when it passes", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer 整理文档"));
	await settle(() => host.agentOf("gb").calls.length === 1);
	const prompt = textOf(host.begin("gb"));
	assert.match(prompt, /Members: the user, Chief \(admin\), Tester and you\./);
	assert.match(prompt, /This round so far, starting with the new message/);
	assert.match(prompt, /User: @Writer 整理文档/);
	await host.finish("gb", "整理好了。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["message", "Writer"]]);
	// A @ call names one member; the admin is not called additionally.
	assert.equal(host.agentOf("ga").calls.length, 0);
});

test("everyone mode: members answer one at a time, admin first, each after the one before posted", async (t) => {
	const host = await start(t, { mode: "everyone" });
	t.after(host.stop);
	const round = host.run("c1", host.say("大家说说"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	assert.equal(host.agentOf("gb").calls.length, 0);
	const first = textOf(host.begin("ga"));
	assert.match(first, /Members answer this message one at a time: Chief \(you, now\) → Writer → Tester\./);
	assert.match(first, /You are number 1 of 3\. Nobody spoke before you; 2 after you will see your message\./);
	await host.finish("ga", "先说我。");
	await settle(() => host.agentOf("gb").calls.length === 1);
	const second = textOf(host.begin("gb"));
	assert.match(second, /You are number 2 of 3\. 1 went before you; 1 after you will see your message\./);
	assert.match(second, /Chief: 先说我。/);
	await host.finish("gb", "再说我。");
	await settle(() => host.agentOf("gc").calls.length === 1);
	host.begin("gc");
	await host.finish("gc", "最后是我。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [
		["message", "Chief"],
		["message", "Writer"],
		["message", "Tester"],
	]);
});

test("members called together start at the same time and read who they answer with", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer @Tester 分别检查文档和测试"));
	await settle(() => host.agentOf("gb").calls.length === 1 && host.agentOf("gc").calls.length === 1);
	const writer = textOf(host.begin("gb"));
	const tester = textOf(host.begin("gc"));
	assert.match(writer, /Called together with you: Tester\./);
	assert.match(tester, /Called together with you: Writer\./);
	await host.finish("gb", "文档没问题。");
	await host.finish("gc", "测试全过。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [
		["message", "Writer"],
		["message", "Tester"],
	]);
});

test("work past the grace lets the round go on, and the late result wakes the member that asked", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Chief 安排一下文档"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer 把文档整理好");
	await settle(() => host.agentOf("gb").calls.length === 1);
	const called = host.begin("gb");
	assert.equal(called.source.askedBy, "a");
	host.toolCall("gb", "pwsh");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [
		["message", "Chief"],
		["working", "Writer"],
	]);
	// The late result posts with the member that asked for it.
	await host.finish("gb", "整理好了，在 docs/ 下。");
	await settle(() => host.posts().length === 1);
	const post = host.nextPost();
	assert.deepEqual(
		[post.source.late, post.source.askedBy, textOf(post)],
		[true, "a", "[Group post from Writer]\n整理好了，在 docs/ 下。"],
	);
	// The post opens a round that calls the member that asked for the result.
	const second = host.run("c2", { text: "整理好了，在 docs/ 下。", botId: "b", name: "Writer", ...post.source });
	await settle(() => host.agentOf("ga").calls.length === 2);
	const followUp = textOf(host.begin("ga"));
	assert.match(followUp, /Writer: 整理好了，在 docs\/ 下。/);
	await host.finish("ga", "好。");
	await settle(() => second.read() !== undefined);
	assert.deepEqual(kinds(second.read()), [["message", "Chief"]]);
});

test("tool work that finishes before the grace still wakes the caller that asked (#619)", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("排查一下构建报错"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer 去读一下构建日志");
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.toolCall("gb", "read");
	// It finishes within the round and forgets to write @Chief.
	await host.finish("gb", "查清楚了，是缺少环境变量 FOO。");
	await settle(() => host.agentOf("ga").calls.length === 2);
	const follow = host.begin("ga");
	assert.equal(follow.source.note, "Writer finished the work you asked for");
	assert.match(textOf(follow), /Writer: 查清楚了，是缺少环境变量 FOO。/);
	await host.finish("ga", "默认设成 bar。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [
		["message", "Chief"],
		["message", "Writer"],
		["message", "Chief"],
	]);
});

test("a quick team tool does not let the round go on", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Chief 开始"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	host.toolCall("ga", "list_bots");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(round.read(), undefined);
	await host.finish("ga", "好了。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["message", "Chief"]]);
});

test("a member that stays quiet is missed, and the group says so once", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer 看一下"));
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["missed", "Writer"]]);
	const saved = host.state().rooms.r1;
	const notice = saved.log.find((line: any) => line.kind === "notice");
	assert.deepEqual([notice.reason, notice.names], ["missed", ["Writer"]]);
	assert.match(String(await host.tool("read_group_chat", { group: "Ops" }, "a")), /did not answer within 0 minutes/);
	// A late [PASS] does not post into the group.
	await host.finish("gb", "[PASS]");
	assert.equal(host.posts().length, 0);
});

test("a member that passes ends the round silently, and the admin alone is told to call someone", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("随便说点什么"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "[PASS]");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(round.read().passed, ["Chief"]);
	const saved = host.state().rooms.r1;
	const notice = saved.log.find((line: any) => line.kind === "notice");
	assert.deepEqual([notice.reason, notice.names], ["admin-passed", ["Chief"]]);
	assert.match(
		String(await host.tool("read_group_chat", { group: "Ops" }, "a")),
		/Chief did not answer or call anyone; call a member with @Name\./,
	);
});

test("a member's own lines while it works post at once and call the members they name", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer 整理文档"));
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	await host.step("gb", "收到，我先看看。@Tester 你等下验一下");
	await settle(() => host.agentOf("gc").calls.length === 1);
	const live = [...host.rt.roomProgress.values()][0] as any;
	assert.deepEqual(
		live.replies.map((reply: any) => [reply.name, reply.text]),
		[["Writer", "收到，我先看看。@Tester 你等下验一下"]],
	);
	await host.finish("gc", "验过了。");
	host.toolCall("gb", "read");
	await host.finish("gb", "整理好了。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [
		["message", "Writer"],
		["message", "Tester"],
		["message", "Writer"],
	]);
});

test("a parallel batch posts each late reply and wakes the caller once, after the last one finishes", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("全面检查一下"));
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "@Writer @Tester 分别检查文档和测试");
	await settle(() => host.agentOf("gb").calls.length === 1 && host.agentOf("gc").calls.length === 1);
	host.begin("gb");
	host.begin("gc");
	host.toolCall("gb", "read");
	host.toolCall("gc", "pwsh");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [
		["message", "Chief"],
		["working", "Writer"],
		["working", "Tester"],
	]);

	// Writer finishes first: its reply posts quietly, and the caller is not woken yet.
	await host.finish("gb", "文档检查完毕。");
	await settle(() => host.posts().length === 1);
	const early = host.nextPost();
	assert.deepEqual([early.source.late, early.source.quiet], [true, true]);
	const second = host.run("c2", { text: "文档检查完毕。", botId: "b", name: "Writer", ...early.source });
	await settle(() => second.read() !== undefined);
	assert.deepEqual(second.read().replies, []);
	assert.equal(host.agentOf("ga").calls.length, 1, "Chief was not woken prematurely");

	// Tester finishes last: the barrier releases and wakes the caller once.
	await host.finish("gc", "测试全部通过。");
	await settle(() => host.posts().length === 1);
	const finalPost = host.nextPost();
	assert.deepEqual([finalPost.source.late, finalPost.source.askedBy, finalPost.source.quiet], [true, "a", undefined]);
	const third = host.run("c3", { text: "测试全部通过。", botId: "c", name: "Tester", ...finalPost.source });
	await settle(() => host.agentOf("ga").calls.length === 2);
	const synth = textOf(host.begin("ga"));
	assert.match(synth, /Writer: 文档检查完毕。/);
	assert.match(synth, /Tester: 测试全部通过。/);
	await host.finish("ga", "都通过了。");
	await settle(() => third.read() !== undefined);
});

test("a member that fails in the round shows the failure and does not stop the round", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer 看一下"));
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.failTurn("gb", { code: "RATE_LIMIT", status: 429, message: "Too many requests" });
	await settle(() => round.read() !== undefined);
	assert.deepEqual(
		round.read().replies.map((reply: any) => [reply.kind, reply.name, reply.code, reply.status]),
		[["failed", "Writer", "RATE_LIMIT", 429]],
	);
	assert.deepEqual(round.read().failed, ["Writer"]);
	const notice = host.state().rooms.r1.log.find((line: any) => line.kind === "notice");
	assert.equal(notice.reason, "failed");
});

test("an approval lets the round go on; the work posts its late reply when it ends", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer 复制文档"));
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.toolCall("gb", "pwsh");
	host.approve("gb");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["approval", "Writer"]]);
	// The member's turn ends after the user answered: its result goes to the group.
	await host.finish("gb", "复制好了。");
	await settle(() => host.posts().length === 1);
	const post = host.posts()[0];
	assert.deepEqual([post.source.role, post.source.late], ["post", true]);
	assert.equal(textOf(post), "[Group post from Writer]\n复制好了。");
});

test("the round-progress map answers with callId, replies and who is speaking", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer @Tester 一起看"));
	await settle(() => host.agentOf("gb").calls.length === 1 && host.agentOf("gc").calls.length === 1);
	host.begin("gb");
	host.begin("gc");
	const [callId, live] = [...host.rt.roomProgress.entries()][0] as [string, any];
	assert.equal(callId, "c1");
	assert.equal(live.roomId, "r1");
	assert.deepEqual(
		live.slots.filter((slot: any) => slot.status === "speaking").map((slot: any) => slot.id),
		["b", "c"],
	);
	await host.step("gb", "我先看看。");
	await settle(() => live.replies.length === 1);
	assert.equal(typeof live.replies[0].duration, "number");
	await host.finish("gb", "看完了。");
	await host.finish("gc", "我也看完了。");
	await settle(() => round.read() !== undefined);
});

test("a long line is kept whole in a file of its own and read back by seq", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const long = "长".repeat(2500);
	const round = host.run("c1", host.say(`@Writer 看这段：${long}`));
	await settle(() => host.agentOf("gb").calls.length === 1);
	const saved = host.state().rooms.r1;
	const userLine = saved.log[0];
	assert.equal(userLine.length, long.length + "@Writer 看这段：".length);
	assert.equal(userLine.text.length, 2000);
	const file = join(host.home, "group-lines", "r1", `${userLine.seq}.txt`);
	assert.equal(existsSync(file), true);
	// The whole line fits GROUP_LINE_READ here, so the file keeps all of it.
	assert.equal(readFileSync(file, "utf8").length, Math.min(userLine.length, 20000));
	await host.begin("gb");
	const read = String(await host.tool("read_group_chat", { group: "Ops" }, "a"));
	assert.match(read, /read_group_chat with seq 1 reads it whole/);
	const whole = String(await host.tool("read_group_chat", { group: "Ops", seq: 1 }, "a"));
	assert.ok(whole.includes(long));
	await host.finish("gb", "看完了。");
	await settle(() => round.read() !== undefined);
});

test("group_relay returns replies, passed and failed for the Session's turn", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", host.say("@Writer @Tester 看"));
	await settle(() => host.agentOf("gb").calls.length === 1 && host.agentOf("gc").calls.length === 1);
	host.begin("gb");
	await host.finish("gb", "看完，没问题。");
	host.begin("gc");
	await host.finish("gc", "[PASS]");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(
		round.read().replies.map((reply: any) => reply.name),
		["Writer"],
	);
	assert.deepEqual(round.read().passed, ["Tester"]);
	assert.equal(round.read().failed, undefined);
});

test("the group Session's llm/stream is answered with a synthesized group_relay call", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const listener = host.ctx.listeners.get("llm/stream")?.at(-1) as any;
	assert.ok(listener);
	const options = {
		sessionId: "r1",
		messages: [{ role: "user", source: { kind: "user" } }],
		tools: [{ name: "group_relay" }],
	};
	const events: any[] = [];
	for await (const event of listener(options, () => [])) events.push(event);
	assert.deepEqual(
		events.map((event) => event.type),
		["block-start", "tool-call-delta", "block-end", "finish"],
	);
	assert.equal(events[1].name, "group_relay");
	assert.equal(events[3].reason.kind, "tool-calls");
	// An auxiliary call (title, image reading) passes through.
	const next = () =>
		(async function* pass() {
			yield { type: "finish", reason: { kind: "stop" } };
		})();
	const passed: any[] = [];
	for await (const event of listener({ sessionId: "r1", messages: [], purpose: "title" }, next)) passed.push(event);
	assert.deepEqual(passed, [{ type: "finish", reason: { kind: "stop" } }]);
});

test("read_own_chat records the lookup in the group log, and read_group_chat serves the lines", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	host.run("c1", host.say("先记一笔")).read();
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "记下了。");
	await settle(() => host.posts().length === 0);
	await host.tool("read_own_chat", { query: "周报" }, "gb");
	await settle(() => host.state().rooms.r1.log.some((line: any) => line.kind === "lookup"));
	const saved = host.state().rooms.r1;
	const lookup = saved.log.find((line: any) => line.kind === "lookup");
	assert.deepEqual([lookup.who, lookup.text], ["Writer", "周报"]);
	assert.match(
		String(await host.tool("read_group_chat", { group: "Ops" }, "a")),
		/\[Writer looked up its own chat for "周报"\]/,
	);
	assert.match(
		String(await host.tool("read_group_chat", { group: "Nope" }, "a")),
		/No group chat called "Nope" that you can see\./,
	);
});
