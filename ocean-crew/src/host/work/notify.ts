// The low-interruption notification policy. One pure decision says whether a notice
// should be delivered now, held for a later time or dropped. It never sends, reads a
// clock or records anything: time, receipts and budget come from the caller, and only
// the delivery path may add a receipt after the transport accepts the notice.
//
// Precedence: duplicate -> pending action (always shown) -> the user's own result or
// subscribed change (budget-free; quiet hours defer) -> optional suggestion (value,
// rejection, frequency, quiet hours and budget). A decision is not a receipt.

import type { NotificationObligation } from "../../shared/coordination.ts";

/** The shared obligation kinds plus the actionable pending class. */
export type NotificationKind = NotificationObligation["kind"] | "pending";

/** What a user has to decide, answer or repair before the work can continue. */
export type PendingKind = "approval" | "blocked" | "failure";

export interface PendingItem {
	/** Stable id of the approval, blocker or failed work. */
	itemId: string;
	kind: PendingKind;
	/** Short English label the actionable card shows. */
	title: string;
	/** Epoch ms when the item started waiting. */
	since: number;
}

export interface RequestedResultEvent {
	kind: "requested_result";
	/** Stable id of this result notice. */
	noticeId: string;
}

export interface PendingEvent {
	kind: "pending";
	/** Stable id of this pending batch. A batch with new items needs a new id. */
	noticeId: string;
	/** All items one card should show; the policy never delivers an empty batch. */
	items: readonly PendingItem[];
}

export interface SubscribedChangeEvent {
	kind: "subscribed_change";
	/** Stable id of this check or notice. */
	noticeId: string;
	/** The subscription the version belongs to. */
	subscriptionId: string;
	/** Version of the source; the same version is the same content. */
	sourceVersion: string;
	/** False when a scheduled check found the source unchanged. */
	changed: boolean;
}

export interface OptionalSuggestionEvent {
	kind: "optional_suggestion";
	noticeId: string;
	/** Worth of the suggestion in [0, 1]; the caller estimates it, the prose does not. */
	value: number;
}

export type NotificationEvent = RequestedResultEvent | PendingEvent | SubscribedChangeEvent | OptionalSuggestionEvent;

/** What a scheduled check reports when the source did not change. */
export type NoChangeAgreement = "silent" | "all_clear";

export interface SuggestionPreferences {
	/** Worth a suggestion needs before it may interrupt. */
	minValue: number;
	/** Minimum time between two accepted optional notices. */
	minGapMs: number;
	/** Time to stay quiet after the user rejects an optional notice. */
	rejectionCooldownMs: number;
}

export interface NotificationPreferences {
	/** The user's agreement for a check that found no change. */
	noChange: NoChangeAgreement;
	/** Proactive suggestions are off unless the user opted in with this block. */
	suggestions?: SuggestionPreferences;
}

export interface QuietHours {
	/** Minutes after local midnight when quiet starts. */
	startMinute: number;
	/** Minutes after local midnight when quiet ends. */
	endMinute: number;
	/** Offset from UTC the host applies when reading `now` as local time. */
	utcOffsetMinutes: number;
}

export interface DailyBudget {
	/** Optional notices allowed in the current window. */
	limit: number;
	/** Units already spent by accepted optional notices. */
	used: number;
	/** Epoch ms when the allowance resets; a past time means the window is over. */
	resetsAt: number;
}

/**
 * A notice the transport accepted. Only the delivery path may append one, after the
 * platform accepted the notice: a policy decision by itself is never a receipt.
 */
export interface NotificationReceipt {
	/** The `dedupeKey` returned with the delivered decision. */
	dedupeKey: string;
	kind: NotificationKind;
	acceptedAt: number;
}

export interface NotificationHistory {
	/** Accepted notices; used for dedupe and the optional-notice frequency gap. */
	receipts?: readonly NotificationReceipt[];
	/** When the user last rejected or dismissed an optional suggestion. */
	lastRejectedAt?: number;
}

export interface NotificationInput {
	/** Current epoch ms. Passed in so the decision never reads a clock. */
	now: number;
	event: NotificationEvent;
	preferences: NotificationPreferences;
	/** The user's daily quiet window; absent means no quiet hours. */
	quietHours?: QuietHours;
	/** The daily allowance for proactive suggestions only. */
	budget?: DailyBudget;
	history?: NotificationHistory;
}

/** Why a notice is delivered now. */
export type DeliveredReason =
	| "requested_result"
	| "pending_action"
	| "subscribed_change"
	| "no_change_all_clear"
	| "optional_suggestion";

/** Why a notice is held for later or dropped. */
export type HeldReason =
	| "duplicate"
	| "nothing_pending"
	| "no_change_silent"
	| "suggestions_off"
	| "below_value"
	| "quiet_hours"
	| "budget_exhausted"
	| "recent_rejection"
	| "frequency_limited";

export interface DeliveredDecision {
	deliver: true;
	reason: DeliveredReason;
	/** The event kind, copied into the receipt once the transport accepts it. */
	kind: NotificationKind;
	/** The key to record as a receipt after acceptance; the same key is a duplicate. */
	dedupeKey: string;
	/** True only for an optional suggestion: results and decisions never spend the budget. */
	countsBudget: boolean;
}

export interface HeldDecision {
	deliver: false;
	reason: HeldReason;
	/** Epoch ms when a held notice may be considered again; absent when it is dropped. */
	deferred?: number;
}

export type NotificationDecision = DeliveredDecision | HeldDecision;

/**
 * Decide one notice. The same input always gives the same decision; the returned
 * `dedupeKey` becomes a receipt only after the transport accepts the notice.
 */
export function decideNotification(input: NotificationInput): NotificationDecision {
	const { now, event, preferences, quietHours, budget } = input;
	const receipts = input.history?.receipts ?? [];
	const dedupeKey = dedupeKeyOf(event);
	if (receipts.some((receipt) => receipt.dedupeKey === dedupeKey)) return held("duplicate");

	// A decision the user must make is never pressed down by quiet hours or budget:
	// the work is blocked until the user acts, so hiding it only extends the block.
	if (event.kind === "pending") {
		if (event.items.length === 0) return held("nothing_pending");
		return delivered(event.kind, "pending_action", dedupeKey, false);
	}

	// The user asked for this result. Quiet hours may defer it, but budget and
	// optional-suggestion preferences never suppress it.
	if (event.kind === "requested_result") {
		const deferred = quietUntil(now, quietHours);
		if (deferred !== undefined) return held("quiet_hours", deferred);
		return delivered(event.kind, "requested_result", dedupeKey, false);
	}

	// A subscribed change is the content the user asked to watch. No change is either
	// silence or an all-clear by agreement; both follow the normal quiet window.
	if (event.kind === "subscribed_change") {
		if (!event.changed && preferences.noChange === "silent") return held("no_change_silent");
		const deferred = quietUntil(now, quietHours);
		if (deferred !== undefined) return held("quiet_hours", deferred);
		return delivered(event.kind, event.changed ? "subscribed_change" : "no_change_all_clear", dedupeKey, false);
	}

	// Proactive suggestions are the only notices the budget and feedback constrain.
	const suggestions = preferences.suggestions;
	if (suggestions === undefined) return held("suggestions_off");
	if (!(event.value >= suggestions.minValue)) return held("below_value");

	const blockers: { reason: HeldReason; until: number }[] = [];
	const rejectedAt = input.history?.lastRejectedAt;
	if (rejectedAt !== undefined) {
		const until = rejectedAt + suggestions.rejectionCooldownMs;
		if (until > now) blockers.push({ reason: "recent_rejection", until });
	}
	const lastOptionalAt = lastOptionalReceiptAt(receipts);
	if (lastOptionalAt !== undefined) {
		const until = lastOptionalAt + suggestions.minGapMs;
		if (until > now) blockers.push({ reason: "frequency_limited", until });
	}
	if (quietHours !== undefined) {
		const until = quietUntil(now, quietHours);
		if (until !== undefined) blockers.push({ reason: "quiet_hours", until });
	}
	if (budget !== undefined && budget.used >= budget.limit && budget.resetsAt > now) {
		blockers.push({ reason: "budget_exhausted", until: budget.resetsAt });
	}
	const first = blockers[0];
	if (first !== undefined) {
		// Hold until every active constraint is over, not just the named reason.
		const until = Math.max(...blockers.map((blocker) => blocker.until));
		return held(first.reason, until);
	}
	return delivered(event.kind, "optional_suggestion", dedupeKey, true);
}

function delivered(
	kind: NotificationKind,
	reason: DeliveredReason,
	dedupeKey: string,
	countsBudget: boolean,
): DeliveredDecision {
	return { deliver: true, reason, kind, dedupeKey, countsBudget };
}

function held(reason: HeldReason, deferred?: number): HeldDecision {
	return deferred === undefined ? { deliver: false, reason } : { deliver: false, reason, deferred };
}

/**
 * A stable dedupe key. A real change is keyed by source version, so the same content
 * reported under a new notice id is still a duplicate. An all-clear is keyed by the
 * check's notice id: its source version does not change, and each check is a heartbeat.
 */
function dedupeKeyOf(event: NotificationEvent): string {
	switch (event.kind) {
		case "requested_result":
			return `requested:${event.noticeId}`;
		case "pending":
			return `pending:${event.noticeId}`;
		case "subscribed_change":
			return event.changed
				? `subscribed:${JSON.stringify([event.subscriptionId, event.sourceVersion])}`
				: `all_clear:${event.noticeId}`;
		case "optional_suggestion":
			return `suggestion:${event.noticeId}`;
	}
}

/** When the last optional notice was accepted; only receipts count, never decisions. */
function lastOptionalReceiptAt(receipts: readonly NotificationReceipt[]): number | undefined {
	let latest: number | undefined;
	for (const receipt of receipts) {
		if (receipt.kind !== "optional_suggestion") continue;
		if (latest === undefined || receipt.acceptedAt > latest) latest = receipt.acceptedAt;
	}
	return latest;
}

/** The minute after local midnight, with the host-supplied UTC offset. */
function localMinute(now: number, utcOffsetMinutes: number): number {
	const minute = Math.floor((now + utcOffsetMinutes * 60_000) / 60_000) % 1440;
	return minute < 0 ? minute + 1440 : minute;
}

/** True while `now` falls inside the half-open daily quiet window. */
function isQuiet(now: number, quiet: QuietHours): boolean {
	// Equal bounds mean the user configured no window.
	if (quiet.startMinute === quiet.endMinute) return false;
	const minute = localMinute(now, quiet.utcOffsetMinutes);
	if (quiet.startMinute < quiet.endMinute) {
		return minute >= quiet.startMinute && minute < quiet.endMinute;
	}
	return minute >= quiet.startMinute || minute < quiet.endMinute;
}

/** The epoch ms when the quiet window that contains `now` ends. */
function quietEndAt(now: number, quiet: QuietHours): number {
	const offsetMs = quiet.utcOffsetMinutes * 60_000;
	const minute = localMinute(now, quiet.utcOffsetMinutes);
	const minuteStart = Math.floor((now + offsetMs) / 60_000) * 60_000 - offsetMs;
	if (quiet.startMinute < quiet.endMinute) return minuteStart + (quiet.endMinute - minute) * 60_000;
	if (minute >= quiet.startMinute) return minuteStart + (1440 - minute + quiet.endMinute) * 60_000;
	return minuteStart + (quiet.endMinute - minute) * 60_000;
}

function quietUntil(now: number, quiet: QuietHours | undefined): number | undefined {
	if (quiet === undefined || !isQuiet(now, quiet)) return undefined;
	return quietEndAt(now, quiet);
}
