// Resume behavior: every delivery is noted in inflight.json before it is sent and until a
// turn takes it up, and every running Bot turn is noted; at the next start what is still
// noted is picked up once.
// message;
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { install } from "../src/host/chat/resume.ts";
import { fakeContext } from "./fake-ctx.ts";

interface ResumeHostOptions {
	readOnly?: () => string | undefined;
	resolveAgent?: (sessionId: string) => Promise<any>;
	deliver?: (args: any) => Promise<any>;
	bots?: Record<string, any>;
}

const bots = { a: { id: "a", name: "Chief", sessionId: "a" }, b: { id: "b", name: "Writer", sessionId: "b" } };

function resumeHost(home: string, options: ResumeHostOptions = {}) {
	const ctx = fakeContext() as any;
	const delivered: any[] = [];
	const warnings: unknown[][] = [];
	const team: Record<string, any> = options.bots ?? bots;
	const rt: any = {
		ctx,
		home,
		resumeDelayMs: 0,
		load: async () => {},
		readOnly: options.readOnly ?? (() => undefined),
		isBotSession: (id?: string) => id === "a" || id === "b",
		botOf: (id?: string) => (id === undefined ? undefined : team[id]),
		chatOf: (id: string) => team[id]?.sessionId ?? id,
		roomOf: () => undefined,
		groupOwners: new Map<string, any>(),
		chatOwners: new Map<string, string>([
			["a", "a"],
			["b", "b"],
		]),
		live: new Map<string, any>(),
		resolveAgent:
			options.resolveAgent ??
			(async (sessionId: string) => ({
				session: { id: sessionId },
				status: "idle",
				inbox: { nextStep: [] as any[], nextTurn: [] as any[] },
			})),
		deliver: async (args: any) => {
			if (options.deliver !== undefined) return options.deliver(args);
			delivered.push(args);
			return args.exchangeId ?? "generated";
		},
		warn: (...args: unknown[]) => warnings.push(args),
	};
	install(rt);
	pendingDispose.push(() => ctx.dispose());
	const emit = (id: string, type: string, data: any, time?: number) => {
		for (const listener of ctx.listeners.get("session/event") ?? []) listener({ id }, { type, seq: 1, time, data });
	};
	return { rt, ctx, delivered, warnings, emit };
}

const notes = (home: string): any => {
	try {
		return JSON.parse(readFileSync(join(home, "inflight.json"), "utf8"));
	} catch {
		return { turns: {}, queued: {} };
	}
};
// The hosts write the inflight file asynchronously; close them before removing the home,
// or the removal races a write.
const pendingDispose: Array<() => Promise<unknown>> = [];
const freshHome = (t: { after(fn: () => Promise<void>): void }, seed?: any): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-resume-"));
	if (seed !== undefined) writeFileSync(join(home, "inflight.json"), JSON.stringify(seed));
	pendingDispose.length = 0;
	t.after(async () => {
		for (const dispose of pendingDispose.splice(0).reverse()) await dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
	});
	return home;
};
const settle = async (check: () => boolean, what = "condition"): Promise<void> => {
	for (let count = 0; count < 500 && !check(); count += 1) await delay(2);
	assert.ok(check(), `${what} not reached`);
};

test("a delivery is noted before it is sent and is unread until a turn takes it up", async (t) => {
	const home = freshHome(t);
	const { rt } = resumeHost(home);
	await rt.deliver({ fromId: "a", toId: "b", text: "Draft the plan", role: "request" });
	const [noted] = rt.unreadOf("b");
	assert.equal(noted.text, "Draft the plan");
	assert.equal(typeof noted.exchangeId, "string");
	await settle(() => (notes(home).queued.b ?? []).length === 1, "the note is written");
	assert.equal(notes(home).queued.b[0].args.text, "Draft the plan");
	// The turn that takes the message up is done with the note.
	rt.ctx.listeners.get("agent/inbox/discarded")[0]({
		message: { source: { kind: "bot", exchangeId: noted.exchangeId } },
	});
	assert.deepEqual(rt.unreadOf("b"), []);
	await settle(() => (notes(home).queued.b ?? []).length === 0, "the note is dropped");
});

test("a message a turn took up is not noted any more", async (t) => {
	const home = freshHome(t);
	const { rt, emit } = resumeHost(home);
	await rt.deliver({ fromId: "a", toId: "b", text: "Draft the plan", role: "request" });
	const [noted] = rt.unreadOf("b");
	emit("b", "user/message", { content: [], source: { kind: "bot", exchangeId: noted.exchangeId } });
	assert.deepEqual(rt.unreadOf("b"), []);
	const { rt: next } = resumeHost(home);
	await delay(5);
	assert.deepEqual(next.unreadOf("b"), []);
});

test("a restart resends what a shutdown cancelled", async (t) => {
	const home = freshHome(t);
	const first = resumeHost(home);
	await first.rt.deliver({ fromId: "a", toId: "b", text: "Draft the plan", role: "request" });
	await first.ctx.dispose();
	assert.equal(notes(home).queued.b.length, 1);

	const second = resumeHost(home);
	await settle(() => second.delivered.length === 1, "the resend");
	assert.deepEqual(
		[second.delivered[0].role, second.delivered[0].resent, second.delivered[0].sessionId],
		["request", true, "b"],
	);
	// The note stays until a turn takes the message up, not just until it is sent.
	await settle(() => (notes(home).queued.b ?? []).length === 1, "the note stays queued");
});

test("a message taken up before the resend is not sent again", async (t) => {
	const home = freshHome(t, {
		turns: {},
		queued: { b: [{ at: 1, args: { toId: "b", text: "old", role: "request", exchangeId: "x1" } }] },
	});
	const host = resumeHost(home);
	host.emit("b", "user/message", { content: [], source: { kind: "bot", exchangeId: "x1" } });
	await delay(10);
	assert.deepEqual(host.delivered, []);
});

test("a delivery that failed stays queued for the next start", async (t) => {
	const home = freshHome(t);
	const first = resumeHost(home, {
		deliver: async () => {
			throw Object.assign(new Error("Session b is gone"), { code: "session/not-found" });
		},
	});
	await assert.rejects(first.rt.deliver({ fromId: "a", toId: "b", text: "Draft the plan", role: "request" }), {
		code: "session/not-found",
	});
	await settle(() => (notes(home).queued.b ?? []).length === 1, "the failed send is still noted");
	await first.ctx.dispose();

	const second = resumeHost(home);
	await settle(() => second.delivered.length === 1, "the retry at the next start");
	assert.equal(second.delivered[0].text, "Draft the plan");
	assert.equal(second.delivered[0].resent, true);
});

test("a delivery whose Bot is gone is dropped", async (t) => {
	const home = freshHome(t);
	const host = resumeHost(home, {
		deliver: async () => {
			throw new Error("Unknown Bot");
		},
	});
	await assert.rejects(host.rt.deliver({ fromId: "a", toId: "gone", text: "hello", role: "request" }), /Unknown Bot/);
	assert.deepEqual(host.rt.unreadOf("gone"), []);
	await settle(() => Object.keys(notes(home).queued).length === 0, "the dead note is dropped");
});

test("a running turn is noted, and a restart while it still runs notes it again", async (t) => {
	const home = freshHome(t);
	const first = resumeHost(home);
	first.emit("b", "turn/start", { turn: 1 }, 111);
	await settle(() => notes(home).turns.b !== undefined, "the turn is noted");
	assert.deepEqual([notes(home).turns.b.botId, notes(home).turns.b.since], ["b", 111]);
	await first.ctx.dispose();

	const second = resumeHost(home, {
		resolveAgent: async (sessionId: string) => ({
			session: { id: sessionId },
			status: "running",
			inbox: { nextStep: [], nextTurn: [] },
		}),
	});
	// The restart reads the inflight file on its own schedule; wait for it rather than
	// assuming a fixed delay is enough on a slow runner.
	await settle(() => notes(home).turns.b !== undefined, "the running turn is noted after the restart");
	assert.deepEqual(second.delivered, []);
});

test("a turn the restart cut off is picked up in the chat, naming a dropped approval", async (t) => {
	const home = freshHome(t, {
		turns: { b: { botId: "b", since: 1, approval: { tool: "pwsh", reason: "escalate sandbox" } } },
		queued: {},
	});
	const host = resumeHost(home);
	await settle(() => host.delivered.length === 1, "the picked-up turn");
	const message = host.delivered[0];
	assert.deepEqual([message.toId, message.role, message.resumed], ["b", "resume", true]);
	assert.match(message.text, /^DeepSeek Harness restarted while you were working on this/);
	assert.match(message.text, /You were waiting for the user's approval to run pwsh \(escalate sandbox\)/);
});

test("a request cut off by a restart goes on under the same exchange", async (t) => {
	const home = freshHome(t, {
		turns: { b: { botId: "b", since: 1, trigger: { role: "request", exchangeId: "x1", senderSessionId: "a" } } },
		queued: {},
	});
	const host = resumeHost(home);
	await settle(() => host.delivered.length === 1, "the picked-up request");
	assert.deepEqual(
		[
			host.delivered[0].fromId,
			host.delivered[0].toId,
			host.delivered[0].role,
			host.delivered[0].exchangeId,
			host.delivered[0].resumed,
		],
		["a", "b", "request", "x1", true],
	);
});

test("a turn DSH stopped as it shuts down stays noted; a finished one does not", async (t) => {
	const home = freshHome(t);
	const first = resumeHost(home);
	// Chief's turn was stopped by the shutdown; Writer's finished before it.
	first.emit("a", "turn/start", { turn: 1 });
	first.emit("a", "turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "disposed" } } });
	first.emit("b", "turn/start", { turn: 2 });
	first.emit("b", "turn/end", { turn: 2, reason: { kind: "completed" } });
	await first.ctx.dispose();
	assert.ok(notes(home).turns.a !== undefined);
	assert.equal(notes(home).turns.b, undefined);
});

test("a resend that cannot open the Session keeps the whole queue", async (t) => {
	const home = freshHome(t, {
		turns: {},
		queued: {
			b: [
				{ at: 1, args: { toId: "b", text: "one", role: "request", exchangeId: "x1" } },
				{ at: 2, args: { toId: "b", text: "two", role: "request", exchangeId: "x2" } },
			],
		},
	});
	const host = resumeHost(home, {
		resolveAgent: async () => {
			throw Object.assign(new Error("Session b is gone"), { code: "session/not-found" });
		},
	});
	await settle(
		() => host.warnings.some((args) => /sending again/.test(String(args[0]))),
		"the resend failure is reported",
	);
	assert.deepEqual(host.delivered, []);
	await settle(() => (notes(home).queued.b ?? []).length === 2, "both notes stay queued");
});

test("an approval is noted with the running turn and cleared when it stops mattering", async (t) => {
	const home = freshHome(t);
	const host = resumeHost(home);
	host.emit("b", "turn/start", { turn: 1 });
	host.rt.noteApproval("b", { tool: "pwsh", reason: "escalate" });
	await settle(() => notes(home).turns.b?.approval !== undefined, "the approval note");
	assert.deepEqual(notes(home).turns.b.approval, { tool: "pwsh", reason: "escalate" });
	host.rt.noteApproval("b", undefined);
	await settle(() => notes(home).turns.b?.approval === undefined, "the approval note cleared");
});
