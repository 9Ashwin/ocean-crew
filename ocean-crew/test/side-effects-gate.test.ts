// The gate strict calls pass: a read is free, a send asks once, a card that is never answered
// by a dispatch is a refusal that covers the target, and a standing grant the user made in
// Settings answers without a card.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { STANDING_GRANTS, sideEffectGate } from "../src/host/work/side-effects-gate.ts";
import { emptyTeam } from "../src/shared/state.ts";

function setup() {
	const rt: any = {
		state: emptyTeam(),
		home: mkdtempSync(join(tmpdir(), "ocean-crew-effects-")),
		load: async () => {},
		save: async () => {},
	} as unknown as Runtime;
	return { rt, gate: sideEffectGate(rt as Runtime) };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
	agent: { session: { id: "s1" } },
	name,
	arguments: args,
	callId: `${name}-1`,
});

test("a read runs as called; a send needs an answer first", () => {
	const { gate } = setup();
	assert.equal(gate.needsAnswer(call("get_message", { id: "m1" })), false);
	assert.equal(gate.blockedBy(call("get_message", { id: "m1" })), undefined);
	const send = call("send_message", { to: "bob", text: "hi" });
	assert.equal(gate.needsAnswer(send), true);
	assert.match(gate.questionFor(send), /outside the team/);
	assert.match(gate.questionFor(send), /To: bob/);
	// Until the card is shown there is nothing to refuse, so the call is not blocked.
	assert.equal(gate.blockedBy(send), undefined);
});

test("a card that was shown and did not dispatch refuses that call and its target", () => {
	const { gate } = setup();
	const send = call("send_message", { to: "bob", text: "hi" });
	gate.markAsked(send);
	// The card was answered without a grant, so the call never runs and is not asked again.
	assert.match(String(gate.blockedBy(send)), /did not allow/);
	assert.equal(gate.needsAnswer(send), false, "the same call is not asked twice");
	// Another tool aimed at the same target reads the same refusal.
	const other = call("post_comment", { to: "bob", text: "hi" });
	assert.match(String(gate.blockedBy(other)), /Do not try another tool/);
	// A different target is a different question.
	const carol = call("send_message", { to: "carol", text: "hi" });
	assert.equal(gate.blockedBy(carol), undefined);
	assert.equal(gate.needsAnswer(carol), true);
});

test("a call that dispatched was allowed, and is not asked again in the turn", () => {
	const { gate } = setup();
	const send = call("send_message", { to: "bob", text: "hi" });
	gate.markAsked(send);
	gate.markDispatched(send);
	assert.equal(gate.blockedBy(send), undefined);
	assert.equal(gate.needsAnswer(send), false);
});

test("a standing grant answers without a card, for its target only", async () => {
	const { rt, gate } = setup();
	await gate.grant("delete_page", "p3");
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p3" })), false);
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p4" })), true);
	assert.deepEqual(
		gate.grants().map((entry) => `${entry.tool}:${entry.target}`),
		["delete_page:p3"],
	);
	// The list lives in the team state, so the page and the gate cannot disagree.
	assert.deepEqual(
		((rt.state as any)[STANDING_GRANTS] as any[]).map((entry) => entry.tool),
		["delete_page"],
	);
	await gate.revoke("delete_page", "p3");
	assert.equal(gate.grants().length, 0);
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p3" })), true);
});

test("a card left open by a finished turn expires instead of blocking the next one", () => {
	const { gate } = setup();
	const send = call("send_message", { to: "dave", text: "hi" });
	gate.markAsked(send);
	gate.expireTurn("s1");
	const denial = gate.blockedBy(call("send_message", { to: "dave", text: "hi" }));
	assert.match(String(denial), /expired unanswered/);
});

test("the residual report lists what the user decided", () => {
	const { gate } = setup();
	gate.markAsked(call("send_message", { to: "a", text: "1" }));
	gate.markDispatched(call("send_message", { to: "a", text: "1" }));
	gate.markAsked(call("send_message", { to: "b", text: "2" }));
	const decisions = gate.decisionsOf("s1");
	assert.deepEqual(
		decisions.map((entry) => `${entry.tool}:${entry.target}:${entry.answer}`),
		["send_message:a:allowed", "send_message:b:asked"],
	);
});

// The wiring the host actually installs: the pipeline asks, and a dispatch is the grant.
test("the installed pipeline asks once and refuses the second attempt", async () => {
	const { install } = await import("../src/host/work/side-effects-install.ts");
	const listeners = new Map<string, (exec: any, next: () => Promise<any>) => Promise<any>>();
	const rt: any = {
		state: emptyTeam(),
		home: mkdtempSync(join(tmpdir(), "ocean-crew-effects-wired-")),
		load: async () => {},
		save: async () => {},
		isBotSession: () => true,
		ctx: {
			on: (name: string, listener: any) => {
				listeners.set(name, listener);
			},
		},
	};
	install(rt as Runtime);
	const pre = listeners.get("tools/pre-execute");
	assert.ok(pre, "the pipeline hook is installed");
	const allow = async () => ({ kind: "allow" });
	const call = {
		agent: { session: { id: "s1" }, id: "s1" },
		name: "send_message",
		arguments: { to: "bob", text: "hi" },
		callId: "c1",
	};
	// Nothing recorded yet: the first attempt asks.
	const first = await pre?.(call, allow);
	assert.equal(first.kind, "ask");
	assert.match(String(first.reason), /outside the team/);
	// The user declined, so no dispatch happened: the retry is refused, not asked again.
	const second = await pre?.(call, allow);
	assert.equal(second.kind, "deny");
	assert.match(String(second.reason), /did not allow/);
});

test("a dispatched call is a grant and is not asked again", async () => {
	const { install } = await import("../src/host/work/side-effects-install.ts");
	const listeners = new Map<string, (exec: any, next: () => Promise<any>) => Promise<any>>();
	const rt: any = {
		state: emptyTeam(),
		home: mkdtempSync(join(tmpdir(), "ocean-crew-effects-grant-")),
		load: async () => {},
		save: async () => {},
		isBotSession: () => true,
		ctx: {
			on: (name: string, listener: any) => {
				listeners.set(name, listener);
			},
		},
	};
	install(rt as Runtime);
	const pre = listeners.get("tools/pre-execute");
	const run = listeners.get("tools/execute");
	const allow = async () => ({ kind: "allow" });
	const call = { agent: { session: { id: "s1" } }, name: "delete_page", arguments: { id: "p1" }, callId: "c2" };
	assert.equal((await pre?.(call, allow))?.kind, "ask");
	// DSH resolved the card with allowed-once, so the call reaches dispatch.
	await run?.(call, async () => ({ ok: true }));
	assert.equal((await pre?.(call, allow))?.kind, "allow");
});

// A turn that read outside content always shows a card: a standing grant answers for the tool the
// user knows, not for a turn that has just been fed someone else's words.
test("a tainted turn needs a card even for a granted tool", async () => {
	const { gate } = setup();
	await gate.grant("delete_page", "p9");
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p9" })), false);
	gate.markUntrusted("s1");
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p9" })), true, "the card comes back");
	// The next turn starts clean again.
	gate.clearUntrusted("s1");
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p9" })), false);
	gate.markUntrusted("s1");
	gate.expireTurn("s1");
	assert.equal(gate.needsAnswer(call("delete_page", { id: "p9" })), false, "a finished turn clears it");
});
