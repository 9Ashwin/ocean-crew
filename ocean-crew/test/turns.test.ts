// Turns behavior: the session-event state machine (a turn's text and tool sequence, the
// views the client reads), routing a finished turn's reply to the Bot that asked, the
// joined/later queues of a busy turn, the failure contract behind the repair card, and
// the subagent run tracking.
// assertions; async work is settled on the clock rather than asserted mid-flight.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { install as installDelivery } from "../src/host/chat/delivery.ts";
import {
	BLOCKING_CODES,
	failureLine,
	install as installTurns,
	promisesWork,
	stripWrittenCalls,
	turnFailure,
	writesToolCall,
} from "../src/host/chat/turns.ts";
import { STEER_CUT } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { fakeContext } from "./fake-ctx.ts";

const textBlock = (text: string) => [{ type: "text", text }];
const assistantText = (text: string) => ({ message: { content: textBlock(text) } });
const allText = (message: any): string => message.content.map((block: any) => block.text ?? "").join("\n");

interface HostOptions {
	bots?: Record<string, any>;
	botSessions?: string[];
	roomOf?: (id?: string) => any;
	sessionController?: any;
	services?: Record<string, any>;
	agent?: any;
	deliver?: (args: any) => Promise<any>;
	closeWork?: (id: string, name: string, text: string) => any;
}

function turnsHost(options: HostOptions = {}) {
	const listeners = new Map<string, Array<(...args: any[]) => any>>();
	const delivered: any[] = [];
	const noted: any[] = [];
	const warnings: any[][] = [];
	const saves: number[] = [];
	const cancels: any[] = [];
	const answered: string[] = [];
	const wrote: string[] = [];
	const effects: Array<() => unknown> = [];
	const events: string[] = [];
	const bots = options.bots ?? { a: { id: "a", name: "Chief" }, b: { id: "b", name: "Writer" } };
	const botSessions = new Set(options.botSessions ?? ["a", "b", "gb", "ga"]);
	const state: any = { exchangeTurns: {}, questions: {}, views: {}, works: {}, bots };
	const agents = new Map<string, any>();
	const agentOf = (id: string): any => {
		if (id === "b" && options.agent !== undefined) return options.agent;
		if (!agents.has(id)) {
			agents.set(id, {
				session: { id },
				status: "idle",
				inbox: {
					nextStep: [] as any[],
					nextTurn: [] as any[],
					remove(id: string) {
						for (const list of [this.nextStep, this.nextTurn]) {
							const at = list.findIndex((message: any) => message.id === id);
							if (at !== -1) return list.splice(at, 1).length === 1;
						}
						return false;
					},
				},
				calls: [] as any[],
				cancel(cause: any) {
					cancels.push(cause);
				},
			});
		}
		return agents.get(id);
	};
	const closeWork = options.closeWork ?? (() => undefined);
	const ctx: any = {
		on(name: string, fn: any) {
			listeners.set(name, [...(listeners.get(name) ?? []), fn]);
			return () => {};
		},
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") effects.push(dispose as () => unknown);
		},
		get: (name: string) => options.services?.[name],
		sessionController: options.sessionController,
	};
	const rt: any = {
		ctx,
		state,
		bots,
		chatOwners: new Map<string, string>(),
		groupOwners: new Map<string, any>(),
		isBotSession: (id?: string) => id !== undefined && botSessions.has(id),
		roomOf: options.roomOf ?? (() => undefined),
		botOf: (id?: string) => (id === undefined ? undefined : bots[id]),
		selfOf: (id?: string) =>
			id === undefined ? undefined : (rt.chatOwners.get(id) ?? rt.groupOwners.get(id)?.botId ?? id),
		save: async () => {
			saves.push(1);
		},
		deliver:
			options.deliver ??
			(async (args: any) => {
				delivered.push(args);
				return args.exchangeId;
			}),
		noteFailure: (entry: any) => noted.push(entry),
		warn: (...args: unknown[]) => warnings.push(args),
		switchJobs: () => [],
		approvalsView: () => [],
		waitingView: () => ({}),
		userWrote: (id: string) => wrote.push(id),
		userAnswered: (id: string) => answered.push(id),
		closeWork: (id: string, name: string, text: string) => {
			events.push(`closeWork:${id}`);
			return closeWork(id, name, text);
		},
		forgetDelivery: (id: string) => events.push(`forget:${id}`),
		answerMissed: (id: string) => events.push(`missed:${id}`),
		readOnly: () => undefined,
		load: async () => {},
		resolveAgent: async (id: string) => agentOf(id),
	};
	installTurns(rt);
	let seq = 0;
	const emit = (id: string, type: string, data: any, session?: any) => {
		for (const listener of listeners.get("session/event") ?? [])
			listener(session ?? { id }, { type, seq: ++seq, data });
	};
	const fire = (name: string, payload?: any) => {
		for (const listener of listeners.get(name) ?? []) listener(payload);
	};
	return {
		rt,
		ctx,
		listeners,
		agents,
		agentOf,
		delivered,
		noted,
		warnings,
		saves,
		cancels,
		answered,
		wrote,
		effects,
		events,
		state,
		bots,
		emit,
		fire,
	};
}

const settle = async (check: () => boolean, what = "condition"): Promise<void> => {
	for (let count = 0; count < 500 && !check(); count += 1) await delay(2);
	assert.ok(check(), `${what} not reached`);
};

const failed = { kind: "error", error: { code: "SERVER", message: "upstream busy", status: 503 } };
const replySource = (role: string, extra: Record<string, any> = {}) => ({
	kind: "bot",
	role,
	senderSessionId: "a",
	senderName: "Chief",
	exchangeId: "x1",
	...extra,
});

test("turnFailure drops AUTH messages and keeps the facts", () => {
	assert.deepEqual(turnFailure({ code: "AUTH", message: "bad key sk-12***34", status: 401 }), {
		code: "AUTH",
		message: "",
		status: 401,
	});
	assert.deepEqual(turnFailure({ code: "RATE_LIMIT", message: " slow down ", requestId: "r1" }), {
		code: "RATE_LIMIT",
		message: "slow down",
		requestId: "r1",
	});
	assert.deepEqual(turnFailure(undefined), { code: "UNKNOWN", message: "" });
	assert.equal(failureLine({ code: "SERVER", status: 503, message: "busy" }), "SERVER 503: busy");
});

test("the failures that block a Bot are the ones only the user can fix", () => {
	assert.deepEqual(
		[...BLOCKING_CODES],
		[
			"MISSING_CREDENTIAL",
			"INVALID_CREDENTIAL",
			"AUTH",
			"QUOTA",
			"ACCOUNT_QUOTA",
			"ACCOUNT_SIGN_IN_REQUIRED",
			"ACCOUNT_SIGNED_OUT",
			"ACCOUNT_TOKEN_INVALID",
			"LOCAL_AGENT_MISSING",
			"LOCAL_AGENT_SIGNIN",
			"LOCAL_AGENT_QUOTA",
			"LOCAL_AGENT_EXIT",
		],
	);
});

test("a written tool call is told apart from text about one", () => {
	const written =
		"Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem E:\\\n</parameter>\n</function>\n</tool_call>";
	assert.equal(writesToolCall(written), true);
	assert.equal(writesToolCall("<function=read>\n<parameter=path>a.md</parameter></function>"), true);
	assert.equal(writesToolCall("Models such as Step write `<tool_call>` tags in their template."), false);
	assert.equal(writesToolCall(undefined), false);
	assert.equal(stripWrittenCalls(written), "Checking now.");
	assert.equal(promisesWork("I'll check the logs now."), true);
	assert.equal(promisesWork("我马上开始排查这个问题。"), true);
	assert.equal(promisesWork("已经排查过了。"), false);
});

test("a stopped notice routes the acknowledgement back like a request", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Stopped by Chief]\nwhy"),
		source: replySource("stopped", { exchangeId: "s1" }),
	});
	assert.deepEqual(rt.state.exchangeTurns.b, [1]);
	emit("b", "assistant/message", assistantText("understood"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.equal(delivered[0].toId, "a");
	assert.equal(delivered[0].role, "reply");
	assert.equal(delivered[0].replyTo, "s1");
	assert.equal(delivered[0].text, "understood");
});

test("a request that joins a user-started turn is handed back, not answered with the turn's text", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("write the letter"), source: { kind: "user" } });
	emit("b", "assistant/message", assistantText("first half"));
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\nmake it shorter"),
		source: replySource("request", { exchangeId: "e1" }),
	});
	emit("b", "assistant/message", assistantText("second half"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	const deferredOf = (job: any) => [
		job.fromId,
		job.toId,
		job.sessionId,
		job.role,
		job.exchangeId,
		job.deferred,
		job.text,
	];
	assert.deepEqual(delivered.map(deferredOf), [["a", "b", "b", "request", "e1", true, "make it shorter"]]);
	assert.deepEqual(rt.state.exchangeTurns, {});

	// The handed-back request opens a hidden turn whose text is the reply.
	emit("b", "turn/start", { turn: 2 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief · you read it during your last task; answer it now]\nmake it shorter"),
		source: replySource("request", { exchangeId: "e1", deferred: true }),
	});
	emit("b", "assistant/message", assistantText("done, it is shorter"));
	emit("b", "turn/end", { turn: 2, reason: { kind: "completed" } });
	await settle(() => delivered.length === 2);
	assert.deepEqual(
		delivered.slice(1).map((job) => [job.toId, job.role, job.replyTo, job.text]),
		[["a", "reply", "e1", "done, it is shorter"]],
	);
	assert.deepEqual(rt.state.exchangeTurns, { b: [2] });
});

test("a request that joins a Bot-triggered turn is handed back; the trigger gets the whole turn", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("first half"));
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\nmore"),
		source: replySource("request", { exchangeId: "e1" }),
	});
	emit("b", "assistant/message", assistantText("second half"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 2);
	assert.deepEqual(rt.state.exchangeTurns.b, [1]);
	assert.deepEqual(
		delivered.map((job) => [job.role, job.replyTo ?? job.exchangeId, job.text]),
		[
			["reply", "e0", "first half\n\nsecond half"],
			["request", "e1", "more"],
		],
	);
});

test("a joined request in a stopped turn tells its sender, and is not handed back", async () => {
	const { emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("write the letter"), source: { kind: "user" } });
	emit("b", "assistant/message", assistantText("first half"));
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\nmore"),
		source: replySource("request", { exchangeId: "e1" }),
	});
	emit("b", "assistant/message", assistantText("second half"));
	emit("b", "turn/end", {
		turn: 1,
		reason: { kind: "aborted", reason: { kind: "hook", reason: "ocean-crew/stopped" } },
	});
	await settle(() => delivered.length === 1);
	assert.equal(delivered[0].toId, "a");
	assert.equal(delivered[0].replyTo, "e1");
	assert.match(delivered[0].text, /was stopped before it could answer/);
});

test("a joined request gets the failure notice when the model call fails", async () => {
	const { emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("write the letter"), source: { kind: "user" } });
	emit("b", "assistant/message", assistantText("first half"));
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\nmore"),
		source: replySource("request", { exchangeId: "e1" }),
	});
	emit("b", "turn/end", { turn: 1, reason: failed });
	await settle(() => delivered.length === 1);
	assert.equal(delivered[0].replyTo, "e1");
	assert.match(
		delivered[0].text,
		/^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/,
	);
});

test("a request that joins a user-started turn never claims the next turn", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("write the letter"), source: { kind: "user" } });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\nmore"),
		source: replySource("request", { exchangeId: "e1" }),
	});
	emit("b", "assistant/message", assistantText("answer"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	emit("b", "turn/start", { turn: 2 });
	emit("b", "user/message", { content: textBlock("next task"), source: { kind: "user" } });
	emit("b", "assistant/message", assistantText("for the user"));
	emit("b", "turn/end", { turn: 2, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.deepEqual(
		delivered.map((job) => [job.role, job.exchangeId, job.deferred]),
		[["request", "e1", true]],
	);
	assert.deepEqual(rt.state.exchangeTurns, {});
});

test("a schedule-started turn stays visible when a request joins", async () => {
	const { emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("routine"), source: { kind: "schedule" } });
	emit("b", "assistant/message", assistantText("before"));
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\nmore"),
		source: replySource("request", { exchangeId: "e1" }),
	});
	emit("b", "assistant/message", assistantText("after"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.deepEqual(
		delivered.map((job) => [job.role, job.exchangeId, job.text]),
		[["request", "e1", "more"]],
	);
});

test("a duplicate exchangeId joins no second reply", async () => {
	const { emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("answer"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].replyTo, "e0");
});

test("a result read during other work comes back in a turn of its own", async () => {
	const { emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("half"));
	// A result for another work than this turn's arrives while it runs: it informs the
	// turn and is handed back once it ends.
	emit("b", "user/message", {
		content: textBlock("[Reply from Tester]\nreviewed"),
		source: { kind: "bot", role: "reply", exchangeId: "z1", replyTo: "r1", work: "w-other", senderSessionId: "c" },
	});
	emit("b", "assistant/message", assistantText("done"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 2);
	// The result is handed back to the Bot in a turn of its own first; the trigger's
	// reply follows.
	assert.equal(delivered[0].deferred, true);
	assert.equal(delivered[0].work, "w-other");
	assert.equal(delivered[0].replyTo, "r1");
	assert.equal(delivered[0].text, "reviewed");
	assert.equal(delivered[1].text, "half\n\ndone");
});

test("a reply that closes its turn links nothing twice and the delivered text is the turn's", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("all of it"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.equal(delivered[0].text, "all of it");
	assert.deepEqual(rt.state.exchangeTurns.b, [1]);
});

test("a model that writes its tool call as text gets one more turn on the same trigger", async () => {
	const written =
		"Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>";
	const { emit, delivered, warnings } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText(written));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	const retry = delivered[0];
	assert.deepEqual(
		[retry.fromId, retry.toId, retry.sessionId, retry.role, retry.exchangeId, retry.retried],
		["a", "b", "b", "request", "e0", true],
	);
	assert.match(retry.text, /^Your last reply wrote a tool call as plain text/);
	// A second time the text goes on without the call.
	assert.equal(warnings.length, 0);
});

test("in its own chat a Bot that wrote a tool call as text is asked to make it", async () => {
	const written = "<tool_call>\n<function=pwsh>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>";
	const { emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("move the docs"), source: { kind: "user" } });
	// A call made for real, with or without text around it, is no retry.
	emit("b", "assistant/message", {
		message: {
			content: [
				{ type: "text", text: "On it." },
				{ type: "tool-call", id: "k1", name: "pwsh", arguments: "{}" },
			],
		},
	});
	emit("b", "assistant/message", assistantText(written));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.deepEqual([delivered[0].role, delivered[0].retried], ["retry", true]);
	assert.match(delivered[0].text, /^Your last reply wrote a tool call as plain text/);
});

test("a reply that only promises work gets one retry on its round slot", async () => {
	const promiseOnly = "收到，我现在开始排查这个问题。";
	const steps: any[] = [];
	const { rt, emit, delivered } = turnsHost();
	rt.roomStepText = (id: string, info: any, text: string, first: boolean) => steps.push([id, info.role, text, first]);
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock('[Group chat "Ops" · speak]\ngo'),
		source: replySource("room", { exchangeId: "r1", roomId: "r1" }),
	});
	emit("b", "assistant/message", assistantText(promiseOnly));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.deepEqual(steps, [["b", "room", promiseOnly, true]]);
	assert.equal(delivered[0].role, "room");
	assert.equal(delivered[0].retried, true);
	assert.match(delivered[0].text, /^Your last reply said you would start working/);
});

test("a steer cut carries the turn's answered state into the fresh turn", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("first half"));
	rt.markSteerCut("b");
	emit("b", "turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "hook", reason: STEER_CUT } } });
	// Nothing is answered or delivered for the cut turn.
	assert.equal(delivered.length, 0);
	emit("b", "turn/start", { turn: 2 });
	emit("b", "user/message", { content: textBlock("also check the header"), source: { kind: "user" } });
	emit("b", "assistant/message", assistantText("second half"));
	emit("b", "turn/end", { turn: 2, reason: { kind: "completed" } });
	await settle(() => delivered.length === 1);
	assert.equal(delivered[0].replyTo, "e0");
	assert.equal(delivered[0].text, "first half\n\nsecond half");
});

test("the live views say what each Bot is doing and when it was last steered", () => {
	const { rt, emit, fire } = turnsHost();
	rt.chatOwners.set("b", "b");
	emit("b", "turn/start", { turn: 1 });
	assert.equal(typeof rt.turnsView().b, "number");
	emit("b", "tool/call", {
		callId: "c1",
		name: "pwsh",
		arguments: JSON.stringify({ command: "ls", description: "List files" }),
	});
	assert.equal(rt.activityView().b, "working");
	assert.equal(rt.workView().b.tool, "pwsh");
	assert.equal(rt.workView().b.note, "List files");
	assert.deepEqual(rt.callDetail("b", "c1"), { text: "List files", code: "ls" });
	emit("b", "tool/result", { callId: "c1" });
	emit("b", "assistant/message", assistantText("still thinking"));
	assert.equal(rt.workView().b.tool, undefined);
	// A steer into the running turn marks when it landed.
	emit("b", "agent/inbox/spliced", { target: "next-step", inserted: [{ source: { kind: "user" } }] });
	assert.equal(typeof rt.steeredView().b, "number");
	// A running subagent run is work the Bot is doing, even without a call of its own.
	(rt.ctx as any).get = (name: string) =>
		name === "agents"
			? { get: () => ({ id: "child-1", session: { header: { parentSession: "b" } } }), list: () => [] }
			: undefined;
	fire("subagent/start", { id: "child-1" });
	assert.equal(rt.hasSubagents("b"), true);
	fire("subagent/end", { id: "child-1" });
	assert.equal(rt.hasSubagents("b"), false);
});

test("a group Session's turn shows on its group's work row and activity", () => {
	const { rt, emit } = turnsHost();
	rt.groupOwners.set("gb", { botId: "b", roomId: "r1" });
	emit("gb", "turn/start", { turn: 1 });
	emit("gb", "tool/call", { callId: "c1", name: "group_relay", arguments: "{}" });
	assert.equal(rt.activityView().b, "orbit");
	assert.deepEqual(
		rt.roomWorkView().r1.map((item: any) => [item.botId, item.tool]),
		[["b", "group_relay"]],
	);
	assert.equal(rt.workView().b.roomId, "r1");
});

test("stopping a chat cancels its running turn and spawned subagents", async () => {
	const agent: any = {
		session: { id: "b" },
		status: "running",
		inbox: { nextStep: [] as any[], nextTurn: [] as any[], remove: () => false },
		cancel(this: any, cause: any) {
			this.cancelled = cause;
		},
	};
	const children: string[] = [];
	const { rt, emit, fire } = turnsHost({
		agent,
		services: {
			agents: {
				get: (id: string) => ({ id, session: { header: { parentSession: "b" } }, cancel: () => children.push(id) }),
				list: () => [],
			},
			subagents: {
				interrupt: async (id: string, options: any) => {
					children.push(`${id}:${options.parentSessionId}`);
				},
			},
		},
	});
	rt.chatOf = (id: string) => id;
	assert.equal(await rt.stopChat("b"), false);
	emit("b", "turn/start", { turn: 1 });
	fire("subagent/start", { id: "child-1" });
	assert.equal(rt.hasSubagents("b"), true);
	assert.equal(await rt.stopChat("b"), true);
	assert.deepEqual(agent.cancelled, { kind: "user" });
	assert.equal(rt.hasSubagents("b"), false);
	assert.deepEqual(children, ["child-1:b", "child-1"]);
});

test("a stopped round stops the member work it started", async () => {
	const agent: any = {
		session: { id: "b" },
		status: "running",
		inbox: { nextStep: [] as any[], nextTurn: [] as any[], remove: () => false },
		cancel(this: any, cause: any) {
			this.cancelled = cause;
		},
	};
	const { rt, emit } = turnsHost({ agent });
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock('[Group chat "Ops" · speak]\ngo'),
		source: replySource("room", { exchangeId: "r1", roomId: "r1" }),
	});
	await rt.stopRoomTurn("b", "r1");
	assert.deepEqual(agent.cancelled, { kind: "hook", reason: "ocean-crew/stopped" });
});

test("deleting a Bot tells every sender that waits for its answer", async () => {
	const { rt, emit, delivered } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	await rt.releaseBot("b", ["b"]);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].toId, "a");
	assert.equal(delivered[0].replyTo, "e0");
	assert.equal(delivered[0].text, "Writer was deleted before it could answer your message.");
});

test("a failure only the user can fix blocks its Bot with the facts, never the message", () => {
	const { rt, emit } = turnsHost();
	const fail = (turn: number, error: any, session?: any) => {
		emit("b", "turn/start", { turn }, session);
		emit("b", "turn/end", { turn, reason: { kind: "error", error } }, session);
	};
	rt.bots.b.appliedModel = "deepseek-official/deepseek-v4-flash";
	fail(1, { code: "AUTH", message: "bad key sk-12***34", status: 401, requestId: "r1" });
	const { at, ...facts } = rt.bots.b.blocked;
	assert.deepEqual(facts, { code: "AUTH", status: 401, requestId: "r1", provider: "deepseek-official" });
	assert.equal(typeof at, "number");
	// The route of the request that failed names the provider.
	const account = {
		id: "b",
		requestHeader: () => ({ config: { provider: "deepseek-account", model: "deepseek-v4-flash" } }),
	};
	fail(2, { code: "ACCOUNT_TOKEN_INVALID", message: "" }, account);
	assert.deepEqual(Object.keys(rt.bots.b.blocked), ["code", "provider", "at"]);
	assert.equal(rt.bots.b.blocked.provider, "deepseek-account");
	// A failure a retry can fix, or a stopped turn, leaves the block as it is.
	fail(3, { code: "SERVER", message: "busy", status: 503 });
	emit("b", "turn/start", { turn: 4 });
	emit("b", "turn/end", { turn: 4, reason: { kind: "aborted", reason: { kind: "user" } } });
	assert.equal(rt.bots.b.blocked.code, "ACCOUNT_TOKEN_INVALID");
	emit("b", "turn/start", { turn: 5 });
	emit("b", "turn/end", { turn: 5, reason: { kind: "completed" } });
	assert.equal(rt.bots.b.blocked, undefined);
});

test("a greeting a key, a sign-in or a balance stopped is held again; one that failed otherwise is not", () => {
	const { rt, emit } = turnsHost();
	const held: string[] = [];
	rt.chatOwners.set("b", "b");
	rt.holdKickoffAgain = (id: string) => held.push(id);
	rt.userAnswered = () => {};
	const greet = (turn: number, error: any) => {
		emit("b", "turn/start", { turn });
		emit("b", "user/message", {
			content: textBlock("[Bot team setup]\nhi"),
			source: replySource("kickoff", { exchangeId: `k${turn}` }),
		});
		emit("b", "turn/end", { turn, reason: { kind: "error", error } });
	};
	greet(1, { code: "QUOTA", message: "Insufficient Balance", status: 402 });
	greet(2, { code: "SERVER", message: "busy", status: 503 });
	assert.deepEqual(held, ["b"]);
});

test("a completed turn the user opened, or a Retry, answers the message a greeting was held for", () => {
	const { rt, emit, answered } = turnsHost();
	rt.chatOwners.set("b", "b");
	const run = (turn: number, source: any) => {
		emit("b", "turn/start", { turn });
		emit("b", "user/message", { content: textBlock("hi"), source });
		emit("b", "turn/end", { turn, reason: { kind: "completed" } });
	};
	run(1, { kind: "user" });
	run(2, { kind: "bot", role: "request", senderSessionId: "a", exchangeId: "x1" });
	run(3, { kind: "bot", role: "continue", exchangeId: "c1" });
	assert.deepEqual(answered, ["b", "b"]);
});

test("a key lifts the key failures of the providers that read it, a sign-in the account ones, nothing a balance", async () => {
	const { rt } = turnsHost();
	const blocked: Record<string, any> = {
		official: { code: "AUTH", provider: "deepseek-official" },
		stepfun: { code: "MISSING_CREDENTIAL", provider: "stepfun" },
		unknown: { code: "INVALID_CREDENTIAL" },
		keyless: { code: "AUTH", provider: "ollama" },
		account: { code: "ACCOUNT_TOKEN_INVALID", provider: "deepseek-account" },
		lapsed: { code: "ACCOUNT_SIGNED_OUT", provider: "deepseek-account" },
		balance: { code: "QUOTA", provider: "deepseek-official" },
		accountBalance: { code: "ACCOUNT_QUOTA", provider: "deepseek-account" },
	};
	const reset = () => {
		rt.state.bots = Object.fromEntries(
			Object.entries(blocked).map(([id, facts]) => [id, { id, name: id, blocked: { ...facts, at: 1 } }]),
		);
	};
	const released: string[] = [];
	rt.releaseKickoff = async (bot: any) => {
		released.push(bot.id);
		return false;
	};
	rt.keyRefs = () =>
		new Map([
			["deepseek-official", "DEEPSEEK_API_KEY"],
			["stepfun", "STEPFUN_API_KEY"],
		]);
	const still = () =>
		Object.values(rt.state.bots as Record<string, any>)
			.filter((bot: any) => bot.blocked !== undefined)
			.map((bot: any) => bot.id);

	reset();
	rt.unblockBots({ ref: "DEEPSEEK_API_KEY" });
	assert.deepEqual(released, ["official", "unknown", "keyless"]);
	assert.deepEqual(still(), ["stepfun", "account", "lapsed", "balance", "accountBalance"]);

	released.length = 0;
	reset();
	rt.unblockBots({ signedIn: true });
	assert.deepEqual(released, ["account", "lapsed"]);

	// With no provider map to read, any key may be the fix.
	released.length = 0;
	reset();
	rt.keyRefs = () => {
		throw new Error("no settings");
	};
	rt.unblockBots({ ref: "DEEPSEEK_API_KEY" });
	assert.deepEqual(released, ["official", "stepfun", "unknown", "keyless"]);

	// A provider listed with its key again lifts only what its missing key blocked.
	released.length = 0;
	reset();
	rt.unblockBots({ keyed: new Set(["stepfun", "deepseek-official", "ollama"]) });
	assert.deepEqual(released, ["stepfun"]);

	released.length = 0;
	reset();
	rt.unblockBots();
	assert.deepEqual(released, []);
});

test("Retry adds no turn while a greeting is on its way or a turn runs in the Bot's chat", async () => {
	const { rt, emit, delivered } = turnsHost();
	rt.chatOf = (id: string) => id;
	rt.releaseKickoff = async () => false;
	let out = true;
	rt.greetingOut = () => out;
	await rt.resumeBot(rt.bots.b);
	out = false;
	emit("b", "turn/start", { turn: 1 });
	await rt.resumeBot(rt.bots.b);
	assert.equal(delivered.length, 0);
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await rt.resumeBot(rt.bots.b);
	assert.deepEqual(
		delivered.map((args) => args.role),
		["continue"],
	);
});

test("a turn refused for not being a model endpoint refuses that route", async () => {
	const { rt, emit } = turnsHost();
	const calls: any[][] = [];
	rt.routeRefused = async (ref: string, bot: any) => {
		calls.push([ref, bot?.id]);
	};
	const session = { id: "b", requestHeader: () => ({ config: { provider: "external", model: "default" } }) };
	emit("b", "turn/start", { turn: 1 }, session);
	emit(
		"b",
		"turn/end",
		{ turn: 1, reason: { kind: "error", error: { code: "HOSTED_ENGINE_ROUTE", message: "not a model endpoint" } } },
		session,
	);
	await settle(() => calls.length === 1);
	assert.deepEqual(calls, [["external/default", "b"]]);
	emit("b", "turn/start", { turn: 2 }, session);
	emit("b", "turn/end", { turn: 2, reason: failed }, session);
	await delay(5);
	assert.equal(calls.length, 1);
});

test("a failed turn whose model call failed tells the sender instead of leaving it waiting", async () => {
	const { emit, delivered, noted } = turnsHost();
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("hi"), source: replySource("request", { exchangeId: "x1" }) });
	emit("b", "turn/end", { turn: 1, reason: failed });
	await settle(() => delivered.length === 1);
	assert.equal(delivered[0].toId, "a");
	assert.equal(delivered[0].role, "reply");
	assert.equal(delivered[0].replyTo, "x1");
	assert.match(
		delivered[0].text,
		/^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/,
	);
	assert.deepEqual(
		noted.map((entry: any) => [entry.source, entry.code, entry.bot, entry.where]),
		[["turn", "SERVER", "Writer", "own chat"]],
	);
});

test("a failed group turn fails its waiter; a stopped one counts as no answer", () => {
	const { rt, emit } = turnsHost();
	const failure: any = {};
	rt.roomWaiters.set("r1", {
		resolve: () => assert.fail("resolved"),
		fail: (value: any) => {
			failure.value = value;
		},
		touch: () => {},
		approval: () => {},
	});
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: [], source: replySource("room", { exchangeId: "r1" }) });
	emit("b", "turn/end", { turn: 1, reason: failed });
	assert.deepEqual(failure.value, { code: "SERVER", message: "upstream busy", status: 503 });
	let value: any = "unset";
	rt.roomWaiters.set("r2", {
		resolve: (reply: any) => {
			value = reply;
		},
		fail: () => assert.fail("failed"),
		touch: () => {},
		approval: () => {},
	});
	emit("b", "turn/start", { turn: 2 });
	emit("b", "user/message", { content: [], source: replySource("room", { exchangeId: "r2" }) });
	emit("b", "turn/end", { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } });
	assert.equal(value, null);
});

test("the reply a finished turn routes is delivered before its work closes", async () => {
	const { emit, events } = turnsHost({
		deliver: async (args: any) => {
			events.push(`deliver:${args.role}:${args.replyTo ?? args.exchangeId ?? "new"}`);
			return args.exchangeId;
		},
	});
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("answer"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => events.includes("closeWork:e0"));
	assert.deepEqual(events, ["deliver:reply:e0", "closeWork:e0"]);
});

test("a reply that cannot reach its asker is compensated: the notice carries the answer", async () => {
	const notices: any[] = [];
	const { rt, emit, events } = turnsHost({
		deliver: async (args: any) => {
			if (args.exchangeId !== undefined) {
				events.push(`deliver:reply:${args.replyTo}`);
				throw Object.assign(new Error("Session a is gone"), { code: "session/not-found" });
			}
			events.push("deliver:notice");
			notices.push(args);
			return "notice";
		},
	});
	// The work the answer goes on with: the request's parent, read before delivery.
	rt.state.works.e0 = { parent: "w0" };
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", {
		content: textBlock("[Message from Chief]\ntask"),
		source: replySource("request", { exchangeId: "e0" }),
	});
	emit("b", "assistant/message", assistantText("the answer"));
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });
	await settle(() => events.includes("deliver:notice"));
	// The reply is attempted first; only its failure closes the work, marks the result
	// and sends the notice carrying what it had answered.
	assert.deepEqual(
		events.filter((event) => !event.startsWith("forget:")),
		["deliver:reply:e0", "closeWork:e0", "missed:e0", "deliver:notice"],
	);
	assert.ok(events.some((event) => event.startsWith("forget:")));
	assert.equal(notices.length, 1);
	assert.equal(notices[0].toId, "a");
	assert.equal(notices[0].work, "w0");
	assert.equal(notices[0].replyTo, "e0");
	assert.match(
		notices[0].text,
		/^Writer could not send its reply to you \(session\/not-found: Session a is gone\); what it had answered:\nthe answer$/,
	);
});

test("the prompt admission notes the wrapped failure reason and keeps it readable", async () => {
	const originalPrompt = async () => {
		throw Object.assign(new Error("session/agent-busy"), {
			code: "bot/busy",
			details: { reason: "key sk-secret at /home/user/x" },
		});
	};
	const sessionController = {
		prompt: async () => {
			throw Object.assign(new Error("session/agent-busy"), {
				code: "bot/busy",
				details: { reason: "key sk-secret at /home/user/x" },
			});
		},
	};
	const { ctx, noted } = turnsHost({ sessionController });
	assert.notEqual(ctx.sessionController.prompt, originalPrompt);
	await assert.rejects((ctx.sessionController.prompt as any)({ sessionId: "b" }), (error: any) => {
		assert.match(error.message, /^session\/agent-busy — key sk-secret at \/home\/user\/x$/);
		assert.equal(error.details.reason, "key sk-secret at /home/user/x");
		return true;
	});
	assert.deepEqual(
		noted.map((entry: any) => [entry.source, entry.sessionId]),
		[["prompt", "b"]],
	);
	// A Session the team does not own is not ours to explain.
	const other = Object.assign(new Error("boom"), { details: { reason: "x" } });
	const host = turnsHost({ sessionController: { prompt: async () => Promise.reject(other) } });
	await assert.rejects(
		(host.ctx.sessionController.prompt as any)({ sessionId: "someone-else" }),
		(error: any) => error === other,
	);
	assert.equal(host.noted.length, 0);
	assert.equal(host.warnings.length, 0);
});

test("a user message in a room queues a post and closes the open cards", () => {
	const { rt, emit, state, wrote, saves } = turnsHost({
		roomOf: (id?: string) => (id === "r1" ? { id: "r1", name: "Ops" } : undefined),
	});
	rt.roomInbox = rt.roomInbox ?? new Map();
	state.questions.b = { callId: "q1" };
	state.views.b = { callId: "v1" };
	const closed: any[] = [];
	rt.closeCard = (sessionId: string, card: any, outcome: string) => closed.push([sessionId, card.callId, outcome]);
	rt.roomOf = (id?: string) => (id === "r1" || id === "b" ? { id: "r1", name: "Ops" } : undefined);
	rt.chatOwners.set("b", "b");
	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: textBlock("hello group"), source: { kind: "user", rpcId: "im:feishu:chat" } });
	assert.deepEqual(rt.roomInbox.get("r1"), [{ text: "hello group", via: "feishu" }]);
	assert.deepEqual(wrote, ["b"]);
	assert.deepEqual(closed, [
		["b", "q1", "replied"],
		["b", "v1", "replied"],
	]);
	assert.ok(saves.length >= 1);
});

// A two-Bot team with real store, turns and delivery: Chief asks Writer, Writer's turn
// answers, and the reply lands in Chief's own Session.
function integration(t: { after(fn: () => Promise<void>): void }) {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-turns-"));
	writeFileSync(
		join(home, "state.json"),
		JSON.stringify({
			version: 1,
			mainBotIds: ["a"],
			bots: {
				a: { id: "a", name: "Chief", role: "Boss", sessionId: "a", createdAt: 1 },
				b: { id: "b", name: "Writer", role: "Write", sessionId: "b", createdAt: 2 },
			},
			rooms: {},
			agents: {},
			exchanges: [],
			exchangeTurns: {},
			questions: {},
			prefs: {},
			revision: 0,
		}),
	);
	const ctx = fakeContext() as any;
	const agents = new Map<string, any>();
	const agentOf = (id: string): any => {
		if (!agents.has(id)) {
			const calls: any[] = [];
			agents.set(id, {
				session: { id },
				status: "idle",
				calls,
				followup(message: any) {
					calls.push(["followup", message]);
				},
				steer(message: any) {
					calls.push(["steer", message]);
				},
			});
		}
		return agents.get(id);
	};
	ctx.sessionController = { resolveAgent: async (sessionId: string) => ({ agent: agentOf(sessionId) }) };
	ctx.sessions = { flush: async () => {} };
	const rt = {
		ctx,
		home,
		statePath: join(home, "state.json"),
		config: {},
		defaults: { mainName: "Chief", mainRole: "Chief of Staff" },
		teamTools: [],
		warn: () => {},
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);
	installTurns(rt);
	installDelivery(rt);
	t.after(async () => {
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	});
	let seq = 0;
	const emit = (id: string, type: string, data: any) => {
		for (const listener of ctx.listeners.get("session/event") ?? []) listener({ id }, { type, seq: ++seq, data });
	};
	return { rt, ctx, agentOf, emit };
}

test("A asks B; B's answer is delivered into A's own Session", async (t) => {
	const { rt, agentOf, emit } = integration(t);
	await rt.load();
	const exchangeId = await rt.deliver({ fromId: "a", toId: "b", role: "request", text: "carry out the plan" });
	const [[, request]] = agentOf("b").calls;
	assert.equal(request.source.role, "request");
	assert.equal(request.source.exchangeId, exchangeId);

	emit("b", "turn/start", { turn: 1 });
	emit("b", "user/message", { content: request.content, source: request.source });
	emit("b", "assistant/message", { message: { content: textBlock("done") } });
	emit("b", "turn/end", { turn: 1, reason: { kind: "completed" } });

	await settle(() => agentOf("a").calls.length === 1);
	const [[, reply]] = agentOf("a").calls;
	assert.equal(allText(reply), "[Reply from Writer]\ndone");
	assert.deepEqual(
		[reply.source.role, reply.source.replyTo, reply.source.senderSessionId, reply.source.exchangeId],
		["reply", exchangeId, "b", reply.source.exchangeId],
	);
	// Both messages are recorded as exchanges once they are in the Sessions.
	await settle(() => rt.state.exchanges.length === 2);
	assert.deepEqual(
		rt.state.exchanges.map((entry: any) => [entry.role, entry.from, entry.to]),
		[
			["request", "a", "b"],
			["reply", "b", "a"],
		],
	);
	// The turn that answered a request of another Bot is marked as an exchange turn.
	assert.deepEqual(rt.state.exchangeTurns.b, [1]);
});
