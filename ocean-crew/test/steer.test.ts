// Steer behavior: a user steer in a Bot's private chat cuts a running model call and is
// moved to the front of next-turn, and a foreground shell call detaches into the jobs
// registry so the step ends while the command keeps running. The detach path is timed
// with an injected grace window instead of the one-second default.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { install } from "../src/host/chat/steer.ts";
import { STEER_CUT } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { fakeContext } from "./fake-ctx.ts";

interface SteerHostOptions {
	services?: Record<string, any>;
	live?: Map<string, any>;
	chatOwners?: Map<string, string>;
	groupOwners?: Map<string, any>;
	readOnly?: () => string | undefined;
	isBotSession?: (id?: string) => boolean;
	steerGraceMs?: number;
}

function steerHost(options: SteerHostOptions = {}) {
	const ctx = fakeContext({ services: options.services ?? {} }) as any;
	const live = options.live ?? new Map<string, any>();
	const chatOwners = options.chatOwners ?? new Map<string, string>([["b", "b"]]);
	const groupOwners = options.groupOwners ?? new Map<string, any>();
	const events: string[] = [];
	const rt = {
		ctx,
		live,
		chatOwners,
		groupOwners,
		readOnly: options.readOnly ?? (() => undefined),
		isBotSession: options.isBotSession ?? ((id?: string) => id === "b"),
		steerGraceMs: options.steerGraceMs,
		warn: (...args: unknown[]) => events.push(`warn:${String(args[0])}`),
		markSteerCut: (id: string) => events.push(`cut:${id}`),
		switchJobs: () => [],
		sessionFolder: () => "/work",
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	const emit = (id: string, type: string, data: any) => {
		for (const listener of ctx.listeners.get("session/event") ?? []) listener({ id }, { type, seq: 1, data });
	};
	return { rt, ctx, live, emit, events };
}

const userMessage = { id: "m1", source: { kind: "user" } };

function privateAgent() {
	const calls: any[][] = [];
	const agent: any = {
		id: "b",
		session: { id: "b" },
		status: "running",
		inbox: {
			nextStep: [] as any[],
			nextTurn: [] as any[],
			remove(this: any, id: string) {
				for (const list of [this.nextStep, this.nextTurn]) {
					const at = list.findIndex((message: any) => message.id === id);
					if (at !== -1) return list.splice(at, 1).length === 1;
				}
				return false;
			},
			prepend(this: any, where: string, message: any) {
				if (where === "next-turn") this.nextTurn.unshift(message);
				else this.nextStep.unshift(message);
			},
		},
		cancel(cause: any, how: any) {
			calls.push(["cancel", cause, how]);
		},
		send(message: any, where: string, front: boolean) {
			calls.push(["send", message, where, front]);
			if (where === "next-turn") this.inbox.nextTurn.push(message);
		},
		inject(message: any) {
			calls.push(["inject", message]);
		},
		followup(message: any) {
			calls.push(["followup", message]);
		},
	};
	return { agent, calls };
}

test("a user steer into a running model call cuts it and moves the message to next-turn", async () => {
	const { agent, calls } = privateAgent();
	agent.inbox.nextStep.push(userMessage);
	const agents = { get: () => agent };
	const { live, emit, events } = steerHost({ services: { agents } });
	live.set("b", { turn: 1, calls: new Map() });
	emit("b", "step/start", {});
	emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
	await delay(0);
	assert.deepEqual(events, ["cut:b"]);
	assert.deepEqual(calls, [
		["cancel", { kind: "hook", reason: STEER_CUT }, { keepInbox: true }],
		["send", userMessage, "next-turn", true],
	]);
	assert.deepEqual(agent.inbox.nextStep, []);
	assert.deepEqual(agent.inbox.nextTurn, [userMessage]);
});

test("a steer does not cut while a tool runs, in a group, on a read-only host or with no running turn", async () => {
	{
		const { agent } = privateAgent();
		const { live, emit, events } = steerHost({ services: { agents: { get: () => agent } } });
		live.set("b", { turn: 1, calls: new Map([["c1", {}]]) });
		emit("b", "step/start", {});
		emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
		await delay(0);
		assert.deepEqual(events, []);
	}
	{
		const { agent } = privateAgent();
		const { live, emit, events } = steerHost({
			services: { agents: { get: () => agent } },
			groupOwners: new Map([["b", { botId: "b", roomId: "r1" }]]),
		});
		live.set("b", { turn: 1, calls: new Map() });
		emit("b", "step/start", {});
		emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
		await delay(0);
		assert.deepEqual(events, []);
	}
	{
		const { agent } = privateAgent();
		const { live, emit, events } = steerHost({
			services: { agents: { get: () => agent } },
			readOnly: () => "another host",
		});
		live.set("b", { turn: 1, calls: new Map() });
		emit("b", "step/start", {});
		emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
		await delay(0);
		assert.deepEqual(events, []);
	}
	{
		const { agent } = privateAgent();
		const { live, emit, events } = steerHost({ services: { agents: { get: () => agent } } });
		live.set("b", { calls: new Map() });
		emit("b", "step/start", {});
		emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
		await delay(0);
		assert.deepEqual(events, []);
	}
});

test("one cut per model call, even when the steer event arrives twice", async () => {
	const { agent } = privateAgent();
	agent.inbox.nextStep.push(userMessage);
	const { live, emit, events } = steerHost({ services: { agents: { get: () => agent } } });
	live.set("b", { turn: 1, calls: new Map() });
	emit("b", "step/start", {});
	emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
	emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
	await delay(0);
	assert.deepEqual(events, ["cut:b"]);
});

test("a foreground shell call detaches into the jobs registry on a steer", async () => {
	let registered: any;
	let nativeResolve: (value: any) => void = () => {};
	const { agent, calls } = privateAgent();
	agent.ctx = {
		tools: {
			register(tool: any) {
				registered = tool;
				return () => {};
			},
		},
	};
	const def = {
		name: "bash",
		output: {
			schema: {
				oneOf: [{ properties: { kind: { const: "promoted" }, cwd: {}, jobId: {}, timeoutMs: {}, output: {} } }],
			},
			render: (_args: any, value: any) => [{ text: `exit ${value?.code ?? 0}` }],
		},
		execute: () =>
			new Promise((resolve) => {
				nativeResolve = resolve;
			}),
	};
	const jobs = {
		read: () => ({
			chunks: [{ channel: "stdout", text: "half done" }],
			job: { status: "running", output: { spillPaths: [] } },
			lossy: false,
		}),
	};
	const ctx = fakeContext({ services: { agents: { get: () => agent }, jobs } }) as any;
	ctx.tools.get = (name: string) => (name === "bash" ? def : undefined);
	const rt = {
		ctx,
		live: new Map([["b", { turn: 1, calls: new Map() }]]),
		chatOwners: new Map([["b", "b"]]),
		groupOwners: new Map(),
		readOnly: () => undefined,
		isBotSession: (id?: string) => id === "b",
		steerGraceMs: 5,
		warn: () => {},
		markSteerCut: () => {},
		switchJobs: () => [],
		sessionFolder: () => "/work",
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	const emit = (id: string, type: string, data: any) => {
		for (const listener of ctx.listeners.get("session/event") ?? []) listener({ id }, { type, seq: 1, data });
	};
	const disposers = rt.shadowShells(agent);
	assert.equal(disposers.length, 1);
	assert.equal(registered.name, "bash");
	const pending = registered.execute({ command: "ls" }, { agent, callId: "c1" });
	// A steer ends the wait, a short grace keeps a fast command inline, and the job id
	// the native call registers lets the call detach.
	emit("b", "step/start", {});
	emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [userMessage] });
	await delay(2);
	emit("b", "job/registered", { toolCall: { callId: "c1" }, jobId: "j1" });
	const result = await pending;
	assert.deepEqual([result.kind, result.jobId, result.cwd], ["promoted", "j1", "/work"]);
	assert.match(result.output, /half done/);
	// The command ends after the detach: its output reaches the Bot as a background job
	// notice, which the routing ignores.
	nativeResolve({ kind: "completed", code: 0 });
	await delay(10);
	const injected = calls.find(([kind]) => kind === "inject");
	assert.ok(injected !== undefined);
	const notice = injected[1];
	assert.equal(notice.source.kind, "tool-jobs");
	assert.match(notice.content[0].text, /^background job j1 \(bash: ls\) finished:\nexit 0$/);
});

test("a shadowed shell that has no promoted result format is left alone", () => {
	const { agent } = privateAgent();
	agent.ctx = { tools: { register: () => () => {} } };
	const ctx = fakeContext() as any;
	ctx.tools.get = () => ({ name: "bash", execute: async () => ({}) });
	const rt = {
		ctx,
		live: new Map(),
		chatOwners: new Map([["b", "b"]]),
		groupOwners: new Map(),
		readOnly: () => undefined,
		isBotSession: (id?: string) => id === "b",
		warn: () => {},
		markSteerCut: () => {},
		switchJobs: () => [],
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	// Nothing can be shadowed, so there is nothing to lift; a non-Bot Session is not
	// shadowed at all.
	assert.deepEqual(rt.shadowShells(agent), []);
	// A non-Bot Session is never shadowed.
	assert.equal(rt.shadowShells({ session: { id: "other" }, ctx: { tools: { register: () => () => {} } } }), undefined);
});
