// Tool effect classification: reading is free, and anything that could send, delete or pay is
// treated strictly — including a tool name this build has never seen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectOfTool, effectReason, needsApproval, summariseCall } from "../src/host/work/effects.ts";

test("a read verb stays a read, even with a strict word after it", () => {
	assert.equal(effectOfTool("get_message"), "read");
	assert.equal(effectOfTool("list_issues"), "read");
	assert.equal(effectOfTool("search_pages"), "read");
	assert.equal(effectOfTool("mcp__notion__fetch_page"), "read");
	assert.equal(needsApproval("read"), false);
});

test("sending, deleting and paying are each their own strict kind", () => {
	assert.equal(effectOfTool("send_message"), "external_send");
	assert.equal(effectOfTool("post_comment"), "external_send");
	assert.equal(effectOfTool("create_issue"), "external_send");
	assert.equal(effectOfTool("mcp__linear__create_issue"), "external_send");
	assert.equal(effectOfTool("delete_page"), "destructive");
	assert.equal(effectOfTool("pay_invoice"), "payment");
	assert.equal(effectOfTool("charge_customer"), "payment");
	for (const strict of ["external_send", "destructive", "payment"] as const)
		assert.equal(needsApproval(strict), true, strict);
});

// The plugin's own tools reach no further than the team and the conversation that asked. A card in
// front of them is not protection, it is an outage: an unanswered card denied the Bot its own voice.
test("the plugin's own tools never need a card", () => {
	for (const name of ["speak", "send_file", "message_bot", "post_to_group", "ask_user", "remember", "recall"]) {
		assert.equal(effectOfTool(name), "read", name);
		assert.equal(needsApproval(effectOfTool(name)), false, name);
	}
	// A third-party write is still a card, whatever the team's own tools do.
	assert.equal(needsApproval(effectOfTool("mcp__linear__create_issue")), true);
	assert.equal(needsApproval(effectOfTool("mail_send")), true);
});

test("a name nothing recognises is treated as sending", () => {
	// A tool this build has never seen could do anything; showing the card costs one tap.
	assert.equal(effectOfTool("frobnicate_widget"), "external_send");
	assert.equal(effectOfTool(""), "external_send");
});

test("the card names the target and shows the arguments, cut not summarised", () => {
	const summary = summariseCall("send_email", "external_send", {
		to: "friend@example.com",
		body: "x".repeat(2000),
	});
	assert.equal(summary.target, "friend@example.com");
	assert.equal(summary.effect, "external_send");
	assert.ok(summary.detail.length <= 601, "the detail is bounded");
	assert.match(effectReason("payment"), /spends money/);
	assert.match(effectReason("destructive"), /deletes or overwrites/);
	assert.match(effectReason("external_send"), /outside the team/);
});

// The ledger records what is observable: a card was shown, and the call ran or it did not.
test("a card that was shown and never dispatched is a refusal, and it covers the target", async () => {
	const { sideEffectLedger, sideEffectOf, refusedMessage } = await import("../src/host/work/side-effects.ts");
	const ledger = sideEffectLedger();
	const send = sideEffectOf("send_message", "external_send", { to: "bob", text: "hi" });
	assert.ok(send);
	assert.equal(ledger.stateOf(send), undefined);
	ledger.asked(send);
	assert.equal(ledger.stateOf(send), "asked");
	assert.equal(ledger.stateOfIntent(send), "asked");
	// Asked but never dispatched: the user did not allow it.
	assert.match(refusedMessage(send, "refused"), /Do not try another tool/);
	assert.match(refusedMessage(send, "expired"), /expired unanswered/);
	// Another tool aimed at the same target reads the same intent.
	const other = sideEffectOf("post_comment", "external_send", { to: "bob", text: "x" });
	assert.ok(other);
	assert.equal(ledger.stateOfIntent(other), "asked");
	// A dispatch is a grant, and it is the strongest fact the intent keeps.
	const carol = sideEffectOf("send_message", "external_send", { to: "carol", text: "y" });
	assert.ok(carol);
	ledger.asked(carol);
	ledger.dispatched(carol);
	assert.equal(ledger.stateOf(carol), "allowed");
	assert.equal(ledger.stateOfIntent(carol), "allowed");
	assert.equal(ledger.decisions().length, 2);
	// A read never becomes a question.
	assert.equal(sideEffectOf("get_message", "read", {}), undefined);
});

test("expiring a turn closes the cards it left open", async () => {
	const { sideEffectLedger, sideEffectOf } = await import("../src/host/work/side-effects.ts");
	const ledger = sideEffectLedger();
	const held = sideEffectOf("delete_page", "destructive", { id: "p1" });
	assert.ok(held);
	ledger.asked(held);
	ledger.expire();
	assert.equal(ledger.stateOf(held), "expired");
	assert.equal(ledger.stateOfIntent(held), "expired");
});
