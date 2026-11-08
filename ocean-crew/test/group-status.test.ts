// Where a member turn stands in the group view: approval, missed, failed, left, the
// late replies and failures after the round moved on, and the report a post with
// report_back gets.
// this file asserts the
// round result, the group log and the relayed posts groups owns).
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
	},
	rooms: {
		r1: {
			id: "r1",
			name: "Ops",
			members: ["a", "b"],
			mode: "admin",
			admin: "b",
			named: true,
			sessions: { a: "ga", b: "gb" },
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
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-status-"));
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
	const sent: Record<string, unknown>[] = [];
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
		sent.push(item);
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
	rt.stopRoomTurn = async () => {};
	rt.stopSubagents = async () => {};
	rt.ensureCapabilities = async () => {};
	rt.workDirOf = () => home;
	rt.desiredModel = async () => undefined;
	rt.desiredEffort = async () => undefined;
	rt.selectSessionModel = async () => {};
	rt.applyPermission = async () => {};
	rt.ownChatBrief = async () => undefined;
	rt.uiLanguage = () => "English";
	rt.hasSubagents = () => false;
	rt.waitsForApproval = () => false;
	rt.groupTiming = { replyTimeoutMs: 300, workGraceMs: 50, stepGapMs: 20 };
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
	const run = (callId: string, post: Record<string, unknown>) => {
		const list = (rt.roomInbox.get("r1") ?? []) as Record<string, unknown>[];
		rt.roomInbox.set("r1", [...list, post]);
		const controller = new AbortController();
		let result: any;
		const done = tool("group_relay", {}, "r1", { callId, signal: controller.signal }).then((value) => {
			result = JSON.parse(String(value));
		});
		return { read: () => result, done };
	};
	const begin = (sessionId: string) => {
		const message = agentOf(sessionId).calls.at(-1)!;
		rt.live ??= new Map();
		rt.live.set(sessionId, { turn: 1 });
		rt.touchRoomTurn?.(sessionId);
		return message;
	};
	const finish = async (sessionId: string, text: string, shown = true) => {
		const info = delivered.get(sessionId) as any;
		const lines = rt.takeRoomSteps?.(sessionId) ?? "";
		const reply = rt.withRoomSteps?.(lines, text) ?? text;
		const waiter = info?.exchangeId === undefined ? undefined : rt.roomWaiters.get(info.exchangeId);
		if (waiter !== undefined) {
			rt.roomWaiters.delete(info.exchangeId);
			waiter.resolve(reply);
		} else if (info !== undefined) await rt.lateRoomReply?.(sessionId, info, reply, { shown });
		rt.live?.delete(sessionId);
	};
	const fail = async (
		sessionId: string,
		failure: { code: string; status?: number; message: string },
		late = false,
	) => {
		const info = delivered.get(sessionId) as any;
		const waiter = late
			? undefined
			: info?.exchangeId === undefined
				? undefined
				: rt.roomWaiters.get(info.exchangeId);
		if (waiter !== undefined) {
			rt.roomWaiters.delete(info.exchangeId);
			waiter.fail(failure);
		} else if (info !== undefined) await rt.lateRoomFailure?.(sessionId, info, failure);
		rt.live?.delete(sessionId);
	};
	const approve = (sessionId: string) => {
		rt.yieldRoomTurn?.(sessionId);
		rt.live?.delete(sessionId);
	};
	const nextPost = () => agentOf("r1").calls.shift()!;
	const state = () => JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
	const stop = async () => {
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	const abort = (sessionId: string) => {
		const info = delivered.get(sessionId) as any;
		const waiter = info?.exchangeId === undefined ? undefined : rt.roomWaiters.get(info.exchangeId);
		if (waiter !== undefined) {
			rt.roomWaiters.delete(info.exchangeId);
			waiter.resolve(null);
		}
		rt.live?.delete(sessionId);
	};
	return { rt, ctx, home, agentOf, tool, run, begin, finish, fail, approve, abort, nextPost, state, sent, stop };
}

const settle = async (check: () => boolean) => {
	const until = Date.now() + 3000;
	while (!check() && Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(check(), "condition not reached");
};
const kinds = (result: any) => result.replies.map((reply: any) => [reply.kind ?? "message", reply.name]);

test("an approval frees the round; the late reply reaches the group and was not a pass", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", { text: "@Writer 复制文档" });
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.approve("gb");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["approval", "Writer"]]);
	assert.deepEqual(round.read().passed, []);
	assert.equal(host.rt.roomProgress.size, 0, "the round leaves the progress map");
	await host.finish("gb", "复制好了。");
	await settle(() => host.agentOf("r1").calls.length === 1);
	const post = host.nextPost();
	assert.deepEqual([post.source.role, post.source.late], ["post", true]);
	assert.equal(post.content[0].text, "[Group post from Writer]\n复制好了。");
});

test("a member that fails after the round moved on shows the failure and nobody answers it", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", { text: "@Writer 复制文档" });
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	host.approve("gb");
	await settle(() => round.read() !== undefined);
	await host.fail("gb", { code: "RATE_LIMIT", status: 429, message: "Too many requests" }, true);
	await settle(() => host.agentOf("r1").calls.length === 1);
	const post = host.nextPost();
	assert.deepEqual(
		[post.source.late, post.source.quiet, post.source.failed],
		[true, true, { code: "RATE_LIMIT", status: 429, message: "Too many requests" }],
	);
	const log = (host.rt.roomOf("r1") as any).log;
	assert.deepEqual([log.at(-1).reason, log.at(-1).names], ["failed", ["Writer"]]);
	// Relaying the failure post shows the failed row; the failed member is not called again.
	const again = host.run("c2", { ...post.source, text: post.content[0].text ?? "", botId: "b", name: "Writer" });
	await settle(() => again.read() !== undefined);
	assert.deepEqual(
		again.read().replies.map((reply: any) => [reply.kind, reply.name, reply.code, reply.status]),
		[["failed", "Writer", "RATE_LIMIT", 429]],
	);
	assert.equal(host.agentOf("gb").calls.length, 1);
});

test("a member quiet for the whole reply wait is missed; a later [PASS] reaches nothing", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", { text: "@Writer 看一下" });
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(kinds(round.read()), [["missed", "Writer"]]);
	await host.finish("gb", "[PASS]");
	assert.equal(host.agentOf("r1").calls.length, 0);
	const log = (host.rt.roomOf("r1") as any).log;
	assert.deepEqual([log.at(-1).reason, log.at(-1).names], ["missed", ["Writer"]]);
});

test("a member removed before its turn starts is marked left, and the round ends", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	// Everyone answers in turn: Writer is the admin and speaks first, Chief waits for it.
	const room = host.rt.roomOf("r1") as any;
	room.mode = "everyone";
	room.admin = "b";
	host.rt.updateRoom = async () => ({});
	const round = host.run("c1", { text: "大家说说" });
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	room.members = ["b"];
	await host.finish("gb", "我先说。");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(
		round.read().replies.map((reply: any) => reply.name),
		["Writer"],
	);
});

test("a post with report_back gets its report after the round ends", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", { text: "帮我看一下文档", botId: "b", name: "Writer", reportBack: true });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	await host.finish("ga", "看完了，没问题。");
	await settle(() => round.read() !== undefined);
	await settle(() => host.sent.some((item) => item.role === "report"));
	const report = host.sent.find((item) => item.role === "report") as any;
	assert.deepEqual([report.toId, report.roomId], ["b", "r1"]);
	assert.match(report.text, /Replies to your post \(oldest first\):\nChief: 看完了，没问题。/);
});

test("a failed turn in the round is a row and a log notice, not a pass", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", { text: "@Writer 看一下" });
	await settle(() => host.agentOf("gb").calls.length === 1);
	host.begin("gb");
	await host.fail("gb", { code: "SESSION", message: "Session could not be opened" });
	await settle(() => round.read() !== undefined);
	assert.deepEqual(
		round.read().replies.map((reply: any) => [reply.kind, reply.name, reply.code]),
		[["failed", "Writer", "SESSION"]],
	);
	assert.deepEqual(round.read().passed, []);
	const log = (host.rt.roomOf("r1") as any).log;
	assert.deepEqual([log.at(-1).reason, log.at(-1).names], ["failed", ["Writer"]]);
});

test("stopping the group stops the member turn it started and logs it once", async (t) => {
	const host = await start(t);
	t.after(host.stop);
	const round = host.run("c1", { text: "@Chief 写个周报" });
	await settle(() => host.agentOf("ga").calls.length === 1);
	host.begin("ga");
	const stopped = await host.rt.stopRoomWork?.("r1");
	assert.equal(stopped, true);
	assert.deepEqual(host.agentOf("ga").cancelled, [{ kind: "user" }]);
	// The stop is posted into the running round, and the turn it cancelled ends with nothing.
	host.abort("ga");
	await settle(() => round.read() !== undefined);
	assert.deepEqual(
		round.read().replies.map((reply: any) => reply.kind),
		["stopped"],
	);
	const log = (host.rt.roomOf("r1") as any).log;
	assert.deepEqual([log.at(-1).kind, log.at(-1).who], ["stopped", "Chief"]);
});
