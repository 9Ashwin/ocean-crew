// The gate a strict tool call passes before it runs, and the memory of what the user already
// said about it. A refused call stays refused for that exact call for the rest of the turn, so
// a model that tries another tool or another recipient does not get around the answer.
import { createHash } from "node:crypto";
import { type CallSummary, needsApproval, summariseCall, type ToolEffect } from "./effects.ts";

/** One strict call, as the user's answer applies to it: the tool, its target and its arguments. */
export interface SideEffect {
	/** The exact call: tool plus the argument hash. A different call is a different question. */
	key: string;
	/** The intent: the target. A refusal covers the same target through another tool. */
	intent: string;
	summary: CallSummary;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The call the card asks about, or undefined when this tool may run as called. */
export function sideEffectOf(tool: string, effect: ToolEffect, args: unknown): SideEffect | undefined {
	if (!needsApproval(effect)) return undefined;
	const summary = summariseCall(tool, effect, args);
	let detail = "";
	try {
		detail = JSON.stringify(args ?? {});
	} catch {
		detail = String(args);
	}
	return {
		key: `${tool}:${hash(detail)}`,
		// The target alone is the intent: "send this to bob" stays refused when the next tool is
		// named differently, and a call with no target is its own intent by tool.
		intent: summary.target === undefined ? `tool:${tool}` : `target:${summary.target}`,
		summary,
	};
}

/**
 * What the turn knows about one strict call. `asked` means the user was shown a card for it;
 * it becomes `allowed` once the call actually dispatches. That is the only way a refusal is
 * observable: a card that was answered with a grant dispatches, and one that was not never
 * does — so "asked but never dispatched" is a refusal, not an unknown.
 */
export type SideEffectAnswer = "asked" | "allowed" | "refused" | "expired";

/**
 * One turn's memory of its strict calls. Nothing carries into the next turn: an approval covers
 * the call it was shown for, and a refusal covers the same target for the rest of that turn.
 */
export interface SideEffectLedger {
	/** What is known about this exact call. */
	stateOf(effect: SideEffect): SideEffectAnswer | undefined;
	/** What is known about the target, whatever tool names it. */
	stateOfIntent(effect: SideEffect): SideEffectAnswer | undefined;
	/** A card was shown for this call and its target. */
	asked(effect: SideEffect): void;
	/** The call actually ran: whatever the user answered, it was a grant. */
	dispatched(effect: SideEffect): void;
	/** The turn ended while a card was still open, so its answer can no longer arrive. */
	expire(): void;
	/** Everything decided in this turn, for the residual report after a stop. */
	decisions(): Array<{ effect: SideEffect; answer: SideEffectAnswer }>;
}

export function sideEffectLedger(): SideEffectLedger {
	const byKey = new Map<string, SideEffectAnswer>();
	const byIntent = new Map<string, SideEffectAnswer>();
	const order: SideEffect[] = [];
	const remember = (effect: SideEffect): void => {
		if (!order.some((held) => held.key === effect.key)) order.push(effect);
	};
	return {
		stateOf(effect) {
			return byKey.get(effect.key);
		},
		stateOfIntent(effect) {
			return byIntent.get(effect.intent);
		},
		asked(effect) {
			byKey.set(effect.key, "asked");
			// An intent keeps the strongest fact: a grant already seen is not downgraded by a
			// later card the user has not answered yet.
			if (byIntent.get(effect.intent) !== "allowed") byIntent.set(effect.intent, "asked");
			remember(effect);
		},
		dispatched(effect) {
			byKey.set(effect.key, "allowed");
			byIntent.set(effect.intent, "allowed");
			remember(effect);
		},
		expire() {
			for (const [key, answer] of byKey) if (answer === "asked") byKey.set(key, "expired");
			for (const [intent, answer] of byIntent) if (answer === "asked") byIntent.set(intent, "expired");
		},
		decisions() {
			return order.flatMap((effect) => {
				const answer = byKey.get(effect.key);
				return answer === undefined ? [] : [{ effect, answer }];
			});
		},
	};
}

/** The sentence a refused call returns to the model instead of running. */
export const refusedMessage = (effect: SideEffect, answer: SideEffectAnswer): string => {
	const what =
		effect.summary.target === undefined ? effect.summary.tool : `${effect.summary.tool} → ${effect.summary.target}`;
	if (answer === "expired")
		return `The approval for ${what} expired unanswered. Do not ask again in this turn; tell the user it needs their approval.`;
	return `The user did not allow ${what}. Do not try another tool, recipient or phrasing for it: ask them what they want instead.`;
};
