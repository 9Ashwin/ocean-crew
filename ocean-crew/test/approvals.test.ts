// Approvals: the group-card path, the own-chat race with DSH's own answerer, the

// arguments hash, its target and the permission revision it was asked under, so a
// click after a permission change, an expiry or a mismatched ref never approves it.
// Roster-side gluing is stubbed (a small group and chat index); the assertions are the

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/work/approvals.ts";

type AnyFn = (...args: any[]) => any;
type R = Runtime & Record<string, any>;

interface ApprovalTest {
	rt: R;
	events: Array<{ kind: string; data: Record<string, any> }>;
	notes: Array<{ sessionId: string; approval?: { tool?: string; reason?: string } }>;
	yields: string[];
	revisions: Map<string, string>;
	warnings: string[];
	// Starts one approval request; the returned promise is what DSH waits for.
	ask: (request: Record<string, any>) => { promise: Promise<unknown>; nextCalls: () => number };
	close: () => void;
}

function runtime(
	t: { after(fn: () => void | Promise<void>): void },
	options: { config?: Record<string, unknown>; detail?: Record<string, any> } = {},
): ApprovalTest {
	const listeners: Array<{ event: string; listener: AnyFn; options?: Record<string, unknown> }> = [];
	const events: ApprovalTest["events"] = [];
	const notes: ApprovalTest["notes"] = [];
	const yields: string[] = [];
	const revisions = new Map<string, string>();
	const warnings: string[] = [];
	const groupOwners = new Map([["gb", { botId: "b", roomId: "r1" }]]);
	const chatOwners = new Map([
		["a", "a"],
		["b", "b"],
		["b2", "b"],
	]);
	const rt = {
		ctx: {
			on(event: string, listener: AnyFn, handlerOptions?: Record<string, unknown>) {
				listeners.push({ event, listener, options: handlerOptions });
				return () => {};
			},
		},
		config: options.config ?? {},
		warn: (..._args: unknown[]) => {
			warnings.push(_args.map(String).join(" "));
		},
		groupOwners,
		chatOwners,
		callDetail: (sessionId: string, callId: string) =>
			options.detail?.[`${sessionId}/${callId}`] ?? { text: `${sessionId} ${callId}` },
		noteApproval: (sessionId: string, approval?: { tool?: string; reason?: string }) =>
			notes.push({ sessionId, approval }),
		yieldRoomTurn: (sessionId: string) => yields.push(sessionId),
		permissionRevision: (sessionId: string) => revisions.get(sessionId),
	} as unknown as R;
	install(rt as Runtime);
	const handler = listeners.find((entry) => entry.event === "approval/request");
	assert.equal(handler?.options?.prepend, true);
	rt.onApproval((kind: string, data: Record<string, any>) => events.push({ kind, data }));
	t.after(() => {});
	return {
		rt,
		events,
		notes,
		yields,
		revisions,
		warnings,
		ask: (request) => {
			let nextCalls = 0;
			const next = async (): Promise<string> => {
				nextCalls += 1;
				return "allowed-once";
			};
			const promise = (handler as NonNullable<typeof handler>).listener(request, next);
			return { promise: promise as Promise<unknown>, nextCalls: () => nextCalls };
		},
		close: () => {},
	};
}

const request = (over: Record<string, any> = {}): Record<string, any> => ({
	agent: { session: { id: "gb" } },
	toolName: "pwsh",
	reason: "run the tests",
	callId: "c1",
	args: { command: "npm test" },
	signal: new AbortController().signal,
	...over,
});

test("a group Session's approval becomes a card here and is answered from the group", async (t) => {
	const host = runtime(t);
	const { promise } = host.ask(request());
	assert.equal(host.rt.waitsForApproval("gb"), true);
	assert.equal(host.yields[0], "gb");
	const [entry] = host.rt.approvalsView();
	assert.deepEqual(
		[entry.sessionId, entry.botId, entry.roomId, entry.tool, entry.reason, entry.answerable],
		["gb", "b", "r1", "pwsh", "run the tests", true],
	);
	assert.equal(entry.ref.toolCallId, "c1");
	assert.equal(entry.ref.audience, "group");
	assert.equal(entry.ref.argsHash.length, 16);
	assert.equal(entry.detail.text, "gb c1");
	assert.deepEqual(host.notes[0], { sessionId: "gb", approval: { tool: "pwsh", reason: "run the tests" } });
	assert.deepEqual(
		host.events.map((event) => event.kind),
		["open"],
	);
	assert.equal(host.rt.answerApproval(entry.id, "allow"), undefined);
	assert.equal(await promise, "allowed-once");
	assert.deepEqual(host.rt.approvalsView(), []);
	assert.equal(host.rt.waitsForApproval("gb"), false);
	assert.deepEqual(host.notes.at(-1), { sessionId: "gb", approval: undefined });
	assert.deepEqual(host.events.at(-1)?.kind, "settled");
	assert.deepEqual(host.events.at(-1)?.data, { id: entry.id, outcome: "allowed-once" });
});

test("a rejected card answers rejected, and a bad or unknown answer is refused", async (t) => {
	const host = runtime(t);
	const { promise } = host.ask(request());
	const [entry] = host.rt.approvalsView();
	host.rt.answerApproval(entry.id, "reject");
	assert.equal(await promise, "rejected");
	assert.throws(() => host.rt.answerApproval("nope", "allow"), { code: "bot/stale" });
	assert.throws(() => host.rt.answerApproval(entry.id, "allow"), { code: "bot/stale" });
	const wrong = host.ask(request({ callId: "c2", args: { command: "npm run build" } }));
	const [second] = host.rt.approvalsView().filter((candidate: any) => candidate.id !== entry.id);
	assert.throws(() => host.rt.answerApproval(second.id, "maybe"), { code: "bot/invalid" });
	host.rt.answerApproval(second.id, "allow");
	assert.equal(await wrong.promise, "allowed-once");
});

// A refused action is answered, not postponed: the same call is not put to the user twice.
test("a refused action is not asked again, and a different one still is", async (t) => {
	const host = runtime(t);
	const first = host.ask(request());
	const [entry] = host.rt.approvalsView();
	host.rt.answerApproval(entry.id, "reject");
	assert.equal(await first.promise, "rejected");

	// The same tool with the same arguments: no card, and the caller is told no.
	const again = host.ask(request({ callId: "c9" }));
	assert.equal(host.rt.approvalsView().length, 0, "no second card for a refused action");
	assert.equal(await again.promise, "cancelled");

	// A different argument is a different action, so it is asked about normally.
	const other = host.ask(request({ callId: "c10", args: { command: "npm run build" } }));
	const [second] = host.rt.approvalsView();
	assert.ok(second, "a different action gets its own card");
	host.rt.answerApproval(second.id, "allow");
	assert.equal(await other.promise, "allowed-once");
});

test("an expired card closes that action too", async (t) => {
	// A card that waits out its time is the case: the user was asked and never answered.
	const host = runtime(t, { config: { approvalTtlMs: 1 } });
	const first = host.ask(request());
	await new Promise((done) => setTimeout(done, 8));
	const [entry] = host.rt.approvalsView();
	assert.ok(entry === undefined || entry.ref.expiry <= Date.now(), "the card's time ran out");
	assert.equal(await first.promise, "cancelled");
	const again = host.ask(request({ callId: "c11" }));
	assert.equal(host.rt.approvalsView().length, 0, "an unanswered card is not shown again");
	assert.equal(await again.promise, "cancelled");
});

test("a card withdrawn because the world changed is not a refusal: it can be asked again", async (t) => {
	const host = runtime(t);
	const first = host.ask(request());
	const [entry] = host.rt.approvalsView();
	// The conversation changed hands, so this card no longer holds; the user never answered.
	host.rt.invalidateApprovals([entry.sessionId]);
	assert.equal(await first.promise, "cancelled");
	const again = host.ask(request({ callId: "c12" }));
	assert.equal(host.rt.approvalsView().length, 1, "the same action is asked about again");
	const [second] = host.rt.approvalsView();
	host.rt.answerApproval(second.id, "allow");
	assert.equal(await again.promise, "allowed-once");
});

test("an own-chat approval races DSH's card: the first answer wins, the other withdraws", async (t) => {
	// DSH answers first: its outcome is adopted.
	const own = runtime(t);
	const whole = own.ask(request({ agent: { session: { id: "a" } }, callId: "own1" }));
	assert.equal(whole.nextCalls(), 1);
	const [card] = own.rt.approvalsView();
	assert.equal(card.ref.audience, "bot");
	assert.equal(card.roomId, undefined);
	own.rt.answerApproval(card.id, "allow");
	assert.equal(await whole.promise, "allowed-once");
	assert.equal(own.rt.approvalsView().length, 0);

	// Ocean Crew answers first: the request resolves here, the DSH card's linked signal
	// is aborted and the original signal is put back.
	const controller = new AbortController();
	const raw = request({ agent: { session: { id: "a" } }, callId: "own2", signal: controller.signal });
	const ours = own.ask(raw);
	const [second] = own.rt.approvalsView();
	own.rt.answerApproval(second.id, "allow");
	assert.equal(await ours.promise, "allowed-once");
	assert.equal(raw.signal, controller.signal);
	assert.equal(controller.signal.aborted, false);
});

test("an aborted request and a cancelled Session settle as cancelled", async (t) => {
	const host = runtime(t);
	const controller = new AbortController();
	const aborted = host.ask(request({ signal: controller.signal }));
	controller.abort();
	assert.equal(await aborted.promise, "cancelled");
	assert.deepEqual(host.rt.approvalsView(), []);

	const cancelled = host.ask(request({ callId: "c3" }));
	const [entry] = host.rt.approvalsView();
	const cancel = host.rt.cancelApprovals as (sessionId: string) => void;
	cancel("gb");
	assert.equal(await cancelled.promise, "cancelled");
	assert.equal(entry.answerable, true);
	assert.deepEqual(host.rt.approvalsView(), []);
	// A second cancel of the same Session does nothing.
	cancel("gb");
});

test("a request for a Session that belongs to no Bot is left to DSH", async (t) => {
	const host = runtime(t);
	const promise = host.ask(request({ agent: { session: { id: "unknown" } } }));
	assert.equal(promise.nextCalls(), 1);
	assert.equal(await promise.promise, "allowed-once");
	assert.deepEqual(host.rt.approvalsView(), []);
});

test("a card whose action changed cannot approve the new action", async (t) => {
	const host = runtime(t);
	const { promise } = host.ask(request({ callId: "c4", args: { command: "npm test" } }));
	const [entry] = host.rt.approvalsView();
	assert.throws(() => host.rt.answerApproval(entry.id, "allow", { argsHash: "another-action" }), {
		code: "bot/stale",
		message: "The action changed since this card was shown; ask again.",
	});
	assert.deepEqual(host.rt.approvalsView(), []);
	assert.equal(await promise, "cancelled");
	// A matching ref answers normally.
	const ok = host.ask(request({ callId: "c5", args: { command: "npm test" } }));
	const [second] = host.rt.approvalsView();
	host.rt.answerApproval(second.id, "allow", { argsHash: second.ref.argsHash, toolCallId: "c5" });
	assert.equal(await ok.promise, "allowed-once");
});

test("a permission change invalidates the card before it can approve anything", async (t) => {
	const host = runtime(t);
	host.revisions.set("gb", "b1:r0:s0");
	const hostRequest = host.ask(request({ callId: "c6" }));
	const [entry] = host.rt.approvalsView();
	assert.equal(entry.ref.permissionRevision, "b1:r0:s0");
	// Tightening the Bot's permission moves the revision: the card is withdrawn, and the
	// turn gets cancelled before the action could run.
	host.revisions.set("gb", "b2:r0:s1");
	assert.deepEqual(host.rt.approvalsView(), []);
	assert.equal(await hostRequest.promise, "cancelled");
	assert.throws(() => host.rt.answerApproval(entry.id, "allow"), { code: "bot/stale" });

	// The same through an explicit invalidation (a roster permission change calls this).
	host.revisions.set("gb", "b3:r0:s2");
	const invalidated = host.ask(request({ callId: "c7" }));
	host.rt.invalidateApprovals(["gb", "other"]);
	assert.equal(await invalidated.promise, "cancelled");
	assert.equal(host.events.at(-1)?.data.outcome, "expired");
});

test("an expired card is withdrawn and refused as stale", async (t) => {
	const host = runtime(t, { config: { approvalTtlMs: 50 } });
	const { promise } = host.ask(request({ callId: "c8" }));
	const [entry] = host.rt.approvalsView();
	assert.equal(entry.answerable, true);
	await new Promise((resolve) => setTimeout(resolve, 70));
	// Answering a lapsed card withdraws it itself and says why.
	assert.throws(() => host.rt.answerApproval(entry.id, "allow"), {
		code: "bot/stale",
		message: "This approval expired; ask for it again.",
	});
	assert.deepEqual(host.rt.approvalsView(), []);
	assert.equal(await promise, "cancelled");
});

test("the ref carries the target and the whole action; the window sees answerable", async (t) => {
	const host = runtime(t);
	host.ask(request({ callId: "c9", target: "https://example.test/run", args: { b: 1, a: [2, 3] } }));
	const [entry] = host.rt.approvalsView();
	assert.equal(entry.ref.target, "https://example.test/run");
	assert.equal(entry.ref.toolCallId, "c9");
	assert.match(entry.ref.argsHash, /^[0-9a-f]{16}$/);
	assert.deepEqual(host.rt.approvalRefOf(entry), entry.ref);
	assert.deepEqual(
		host.rt.approvalsView().map((candidate: any) => candidate.answerable),
		[true],
	);
});

test("a throwing approval listener is warned about, not propagated", async (t) => {
	const host = runtime(t);
	host.rt.onApproval(() => {
		throw new Error("listener broke");
	});
	host.ask(request({ callId: "c10" }));
	assert.ok(host.warnings.some((line) => line.includes("approval listener failed")));
	assert.equal(host.rt.approvalsView().length, 1);
});

test("the entry is the same object the settled event names", async (t) => {
	const host = runtime(t);
	const { promise } = host.ask(request({ callId: "c11" }));
	const [entry] = host.rt.approvalsView();
	assert.equal(host.rt.answerApproval(entry.id, "reject"), undefined);
	await promise;
	const settled = host.events.find((event) => event.kind === "settled");
	assert.deepEqual(settled?.data, { id: entry.id, outcome: "rejected" });
	assert.equal(host.rt.waitsForApproval("gb"), false);
});
