// Notification policy: what is delivered now, what waits for quiet hours, what the
// daily budget can defer (only optional suggestions), dedupe by source version, and
// why a policy decision must never be recorded as a platform receipt.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	DailyBudget,
	DeliveredDecision,
	HeldDecision,
	NotificationDecision,
	NotificationEvent,
	NotificationInput,
	NotificationPreferences,
	NotificationReceipt,
	QuietHours,
} from "../src/host/work/notify.ts";
import { decideNotification } from "../src/host/work/notify.ts";

// A fixed Monday, 2026-11-09, so no test reads a clock.
const at = (hour: number, minute = 0, day = 9): number => Date.UTC(2026, 10, day, hour, minute);
const NOW = at(10);

const SILENT: NotificationPreferences = { noChange: "silent" };
const ALL_CLEAR: NotificationPreferences = { noChange: "all_clear" };
const SUGGESTIONS: NotificationPreferences = {
	noChange: "silent",
	suggestions: { minValue: 0.5, minGapMs: 3 * 60 * 60_000, rejectionCooldownMs: 2 * 60 * 60_000 },
};
const QUIET: QuietHours = { startMinute: 22 * 60, endMinute: 7 * 60, utcOffsetMinutes: 0 };

const budget = (used: number, resetsAt = at(0, 0, 10), limit = 2): DailyBudget => ({ limit, used, resetsAt });
const suggestion = (noticeId = "suggestion-1", value = 0.9): NotificationEvent => ({
	kind: "optional_suggestion",
	noticeId,
	value,
});
const change = (noticeId: string, sourceVersion: string, changed = true): NotificationEvent => ({
	kind: "subscribed_change",
	noticeId,
	subscriptionId: "release-feed",
	sourceVersion,
	changed,
});
const result = (noticeId: string): NotificationEvent => ({ kind: "requested_result", noticeId });
const input = (event: NotificationEvent, extra: Partial<NotificationInput> = {}): NotificationInput => ({
	now: NOW,
	event,
	preferences: SILENT,
	...extra,
});

function expectDelivered(decision: NotificationDecision): DeliveredDecision {
	assert.ok(decision.deliver);
	return decision;
}

function expectHeld(decision: NotificationDecision): HeldDecision {
	assert.ok(!decision.deliver);
	return decision;
}

test("a requested result is delivered even when the suggestion budget is spent", () => {
	const decision = expectDelivered(
		decideNotification(
			input(result("result-1"), {
				preferences: SUGGESTIONS,
				budget: budget(2),
				history: {
					receipts: [{ dedupeKey: "suggestion:old", kind: "optional_suggestion", acceptedAt: at(9) }],
				},
			}),
		),
	);
	assert.equal(decision.reason, "requested_result");
	assert.equal(decision.countsBudget, false);
});

test("quiet hours defer a requested result without dropping it", () => {
	const event = result("result-quiet");
	const deferred = expectHeld(
		decideNotification(input(event, { now: at(23), preferences: SUGGESTIONS, quietHours: QUIET })),
	);
	assert.equal(deferred.reason, "quiet_hours");
	assert.equal(deferred.deferred, at(7, 0, 10));

	const released = expectDelivered(
		decideNotification(input(event, { now: at(7, 0, 10), preferences: SUGGESTIONS, quietHours: QUIET })),
	);
	assert.equal(released.reason, "requested_result");
});

test("pending approvals, blockers and failures are one actionable notice through quiet hours", () => {
	const event: NotificationEvent = {
		kind: "pending",
		noticeId: "pending-1",
		items: [
			{ itemId: "approval-1", kind: "approval", title: "Approve the release", since: at(9) },
			{ itemId: "blocked-1", kind: "blocked", title: "Waiting for deploy credentials", since: at(9) },
			{ itemId: "failure-1", kind: "failure", title: "The publish step failed", since: at(9) },
		],
	};
	const decision = expectDelivered(
		decideNotification(
			input(event, {
				now: at(23),
				preferences: SUGGESTIONS,
				quietHours: QUIET,
				budget: budget(2),
				history: { lastRejectedAt: at(22) },
			}),
		),
	);
	assert.equal(decision.reason, "pending_action");
	assert.equal(decision.countsBudget, false);
});

test("an empty pending batch sends nothing", () => {
	const event: NotificationEvent = { kind: "pending", noticeId: "pending-empty", items: [] };
	const decision = expectHeld(decideNotification(input(event)));
	assert.equal(decision.reason, "nothing_pending");
	assert.equal(decision.deferred, undefined);
});

test("a subscribed change is delivered once per source version", () => {
	const event = change("notice-a", "v7");
	const first = expectDelivered(decideNotification(input(event)));
	assert.equal(first.kind, "subscribed_change");
	assert.equal(first.reason, "subscribed_change");
	assert.equal(first.countsBudget, false);

	const receipt: NotificationReceipt = { dedupeKey: first.dedupeKey, kind: first.kind, acceptedAt: NOW };
	const again = expectHeld(decideNotification(input(event, { history: { receipts: [receipt] } })));
	assert.equal(again.reason, "duplicate");

	// A new notice id for the same version is still the same content.
	const sameVersion = change("notice-b", "v7");
	const duplicate = expectHeld(decideNotification(input(sameVersion, { history: { receipts: [receipt] } })));
	assert.equal(duplicate.reason, "duplicate");
});

test("a check with no change is silent or all-clear by agreement", () => {
	const unchanged = change("check-1", "v7", false);
	const silent = expectHeld(decideNotification(input(unchanged)));
	assert.equal(silent.reason, "no_change_silent");

	const allClear = expectDelivered(decideNotification(input(unchanged, { preferences: ALL_CLEAR })));
	assert.equal(allClear.reason, "no_change_all_clear");

	// An all-clear is a heartbeat: the same source version under a new check still sends.
	const nextCheck = change("check-2", "v7", false);
	const next = expectDelivered(
		decideNotification(
			input(nextCheck, {
				now: at(11),
				preferences: ALL_CLEAR,
				history: {
					receipts: [{ dedupeKey: allClear.dedupeKey, kind: allClear.kind, acceptedAt: NOW }],
				},
			}),
		),
	);
	assert.equal(next.reason, "no_change_all_clear");
});

test("a real change waits out quiet hours but never spends the suggestion budget", () => {
	const deferred = expectHeld(
		decideNotification(
			input(change("check-quiet", "v8"), {
				now: at(23),
				preferences: ALL_CLEAR,
				quietHours: QUIET,
				budget: budget(2),
			}),
		),
	);
	assert.equal(deferred.reason, "quiet_hours");
	assert.equal(deferred.deferred, at(7, 0, 10));

	const released = expectDelivered(
		decideNotification(
			input(change("check-quiet", "v8"), { now: at(7, 0, 10), quietHours: QUIET, budget: budget(2) }),
		),
	);
	assert.equal(released.reason, "subscribed_change");
	assert.equal(released.countsBudget, false);
});

test("quiet hours defer an optional suggestion until the window ends", () => {
	const event = suggestion();
	const deferred = expectHeld(
		decideNotification(input(event, { now: at(23), preferences: SUGGESTIONS, quietHours: QUIET })),
	);
	assert.equal(deferred.reason, "quiet_hours");
	assert.equal(deferred.deferred, at(7, 0, 10));

	const released = expectDelivered(
		decideNotification(input(event, { now: at(7, 0, 10), preferences: SUGGESTIONS, quietHours: QUIET })),
	);
	assert.equal(released.reason, "optional_suggestion");
	assert.equal(released.countsBudget, true);
});

test("quiet hours follow the host-supplied local offset", () => {
	const event = suggestion("suggestion-offset");
	// 15:00 UTC is 23:00 at UTC+8, inside 22:00-07:00 local; that window ends at 23:00 UTC.
	const deferred = expectHeld(
		decideNotification(
			input(event, {
				now: Date.UTC(2026, 10, 9, 15, 0),
				preferences: SUGGESTIONS,
				quietHours: { ...QUIET, utcOffsetMinutes: 8 * 60 },
			}),
		),
	);
	assert.equal(deferred.reason, "quiet_hours");
	assert.equal(deferred.deferred, Date.UTC(2026, 10, 9, 23, 0));
});

test("a spent daily budget defers an optional suggestion to the next window", () => {
	const deferred = expectHeld(
		decideNotification(input(suggestion(), { now: at(23), preferences: SUGGESTIONS, budget: budget(2) })),
	);
	assert.equal(deferred.reason, "budget_exhausted");
	assert.equal(deferred.deferred, at(0, 0, 10));

	const released = expectDelivered(
		decideNotification(
			input(suggestion("suggestion-2"), { now: at(0, 0, 10), preferences: SUGGESTIONS, budget: budget(0) }),
		),
	);
	assert.equal(released.reason, "optional_suggestion");
	assert.equal(released.countsBudget, true);
});

test("a recent rejection lowers the optional-notice frequency", () => {
	const history = { lastRejectedAt: at(9) };
	const deferred = expectHeld(
		decideNotification(input(suggestion(), { now: at(10), preferences: SUGGESTIONS, history })),
	);
	assert.equal(deferred.reason, "recent_rejection");
	assert.equal(deferred.deferred, at(11));

	const released = expectDelivered(
		decideNotification(input(suggestion("suggestion-2"), { now: at(11), preferences: SUGGESTIONS, history })),
	);
	assert.equal(released.reason, "optional_suggestion");

	// Rejection feedback constrains suggestions, never the user's own result.
	const requested = expectDelivered(
		decideNotification(input(result("result-2"), { now: at(10), preferences: SUGGESTIONS, history })),
	);
	assert.equal(requested.reason, "requested_result");
});

test("optional notices keep a minimum gap between accepted deliveries", () => {
	const receipt: NotificationReceipt = {
		dedupeKey: "suggestion:previous",
		kind: "optional_suggestion",
		acceptedAt: at(9),
	};
	const deferred = expectHeld(
		decideNotification(
			input(suggestion(), { now: at(10), preferences: SUGGESTIONS, history: { receipts: [receipt] } }),
		),
	);
	assert.equal(deferred.reason, "frequency_limited");
	assert.equal(deferred.deferred, at(12));

	const released = expectDelivered(
		decideNotification(
			input(suggestion("suggestion-2"), {
				now: at(12),
				preferences: SUGGESTIONS,
				history: { receipts: [receipt] },
			}),
		),
	);
	assert.equal(released.reason, "optional_suggestion");
});

test("optional suggestions need an opt-in and enough value", () => {
	const off = expectHeld(decideNotification(input(suggestion())));
	assert.equal(off.reason, "suggestions_off");

	const low = expectHeld(decideNotification(input(suggestion("suggestion-low", 0.2), { preferences: SUGGESTIONS })));
	assert.equal(low.reason, "below_value");
	assert.equal(low.deferred, undefined);
});

test("a policy decision is not a platform receipt", () => {
	const event = suggestion("suggestion-1");
	const first = expectDelivered(decideNotification(input(event, { preferences: SUGGESTIONS })));
	const second = expectDelivered(decideNotification(input(event, { preferences: SUGGESTIONS })));
	assert.deepEqual(first, second);

	// Deciding twice, even with an empty receipt list, still leaves the notice undelivered.
	const neverAccepted = expectDelivered(
		decideNotification(input(event, { preferences: SUGGESTIONS, history: { receipts: [] } })),
	);
	assert.equal(neverAccepted.dedupeKey, first.dedupeKey);

	// Only the delivery path's receipt turns the next decision into a duplicate.
	const accepted = expectHeld(
		decideNotification(
			input(event, {
				preferences: SUGGESTIONS,
				history: {
					receipts: [{ dedupeKey: first.dedupeKey, kind: first.kind, acceptedAt: NOW }],
				},
			}),
		),
	);
	assert.equal(accepted.reason, "duplicate");
});
