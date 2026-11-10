// The gate a strict call passes before it runs, and the memory of what the user already said
// about it. Reading is free; sending, deleting or paying becomes DSH's own approval card. The
// answer is observed rather than returned: a call the user allowed dispatches, and a call they
// did not never does, so "a card was shown and the call did not run" is a refusal. That keeps a
// refusal terminal inside the turn, and it is why a different tool aimed at the same target
// cannot route around it.
import type { Runtime } from "../core/runtime.ts";
import { effectOfTool, effectReason, needsApproval, type ToolEffect } from "./effects.ts";
import { refusedMessage, type SideEffect, sideEffectLedger, sideEffectOf } from "./side-effects.ts";

/** What the tool layer hands this module: the call about to run. */
export interface PendingCall {
	agent?: { session?: { id?: string }; id?: string };
	name?: string;
	arguments?: Record<string, unknown>;
	callId?: string;
	turn?: number;
	[key: string]: unknown;
}

/** The team state key holding the standing grants, so the page and the gate agree. */
export const STANDING_GRANTS = "sideEffectGrants";

export interface StandingGrant {
	tool: string;
	/** The target the user allowed, or empty for any target of that tool. */
	target?: string;
	at: number;
}

export interface DecisionRecord {
	tool: string;
	target?: string;
	effect: ToolEffect;
	answer: string;
}

export interface SideEffectGate {
	/** The denial reason for a call that must not run now, or undefined to let it through. */
	blockedBy(call: PendingCall): string | undefined;
	/** True when this call needs a card the user has not been shown yet. */
	needsAnswer(call: PendingCall): boolean;
	/** The sentence the approval card shows. */
	questionFor(call: PendingCall): string;
	/** Record that the card was shown, so its outcome becomes observable. */
	markAsked(call: PendingCall): void;
	/** Record that the call actually ran. */
	markDispatched(call: PendingCall): void;
	/** The turn ended: a card still open can no longer be answered. */
	expireTurn(sessionId: string, turn?: number): void;
	/** What the user decided in this Session's recent turns, for the residual report. */
	decisionsOf(sessionId: string): DecisionRecord[];
	grants(): StandingGrant[];
	/** Allow a tool (and optionally one target) for good; the settings page owns the list. */
	grant(tool: string, target?: string): Promise<void>;
	revoke(tool: string, target?: string): Promise<void>;
}

interface Found {
	tool: string;
	effect: ToolEffect;
	held: SideEffect;
	sessionId: string;
	turn?: number;
	ledger: ReturnType<typeof sideEffectLedger>;
}

export function sideEffectGate(rt: Runtime): SideEffectGate {
	// Answers are per Session and per turn: a new turn starts a fresh ledger, because an
	// approval covered the call it was shown for, never the rest of the conversation.
	const ledgers = new Map<string, ReturnType<typeof sideEffectLedger>>();
	const nameOf = (sessionId: string, turn: number | undefined): string => `${sessionId}:${turn ?? 0}`;
	const ledgerFor = (sessionId: string, turn: number | undefined): ReturnType<typeof sideEffectLedger> => {
		const name = nameOf(sessionId, turn);
		let held = ledgers.get(name);
		if (held === undefined) {
			held = sideEffectLedger();
			ledgers.set(name, held);
			// Keep only recent turns: a ledger is one turn's memory, not a history.
			if (ledgers.size > 64) for (const old of [...ledgers.keys()].slice(0, 32)) ledgers.delete(old);
		}
		return held;
	};

	const storedGrants = (): StandingGrant[] => {
		const team = rt.state as unknown as Record<string, unknown>;
		const list = team[STANDING_GRANTS];
		if (!Array.isArray(list)) return [];
		return list.flatMap((entry) => {
			if (entry === null || typeof entry !== "object") return [];
			const raw = entry as Record<string, unknown>;
			if (typeof raw.tool !== "string" || raw.tool === "") return [];
			return [
				{
					tool: raw.tool,
					...(typeof raw.target === "string" && raw.target !== "" ? { target: raw.target } : {}),
					at: typeof raw.at === "number" ? raw.at : 0,
				},
			];
		});
	};
	const grantedFor = (tool: string, target: string | undefined): boolean =>
		storedGrants().some((grant) => grant.tool === tool && (grant.target === undefined || grant.target === target));

	const resolve = (call: PendingCall): Found | undefined => {
		const tool = String(call.name ?? "");
		if (tool === "") return undefined;
		const effect = effectOfTool(tool);
		if (!needsApproval(effect)) return undefined;
		const held = sideEffectOf(tool, effect, call.arguments ?? {});
		if (held === undefined) return undefined;
		const sessionId = call.agent?.session?.id ?? call.agent?.id ?? "";
		const turn = typeof call.turn === "number" ? call.turn : undefined;
		return {
			tool,
			effect,
			held,
			sessionId,
			...(turn === undefined ? {} : { turn }),
			ledger: ledgerFor(sessionId, turn),
		};
	};

	return {
		blockedBy(call) {
			const found = resolve(call);
			if (found === undefined) return undefined;
			if (grantedFor(found.tool, found.held.summary.target)) return undefined;
			// A call that already ran in this turn needs no second answer.
			if (found.ledger.stateOf(found.held) === "allowed") return undefined;
			const exact = found.ledger.stateOf(found.held);
			if (exact === "asked" || exact === "refused" || exact === "expired")
				return refusedMessage(found.held, exact === "expired" ? "expired" : "refused");
			// A card was shown for this target through another tool and the call never ran.
			const intent = found.ledger.stateOfIntent(found.held);
			if (intent === "asked" || intent === "refused" || intent === "expired")
				return refusedMessage(found.held, intent === "expired" ? "expired" : "refused");
			return undefined;
		},
		needsAnswer(call) {
			const found = resolve(call);
			if (found === undefined) return false;
			if (grantedFor(found.tool, found.held.summary.target)) return false;
			return found.ledger.stateOf(found.held) === undefined && found.ledger.stateOfIntent(found.held) === undefined;
		},
		questionFor(call) {
			const found = resolve(call);
			if (found === undefined) return "";
			const target = found.held.summary.target;
			return `${effectReason(found.effect)}${target === undefined ? "" : `\n\nTo: ${target}`}`;
		},
		markAsked(call) {
			const found = resolve(call);
			found?.ledger.asked(found.held);
		},
		markDispatched(call) {
			const found = resolve(call);
			found?.ledger.dispatched(found.held);
		},
		expireTurn(sessionId, turn) {
			ledgerFor(sessionId, turn).expire();
		},
		decisionsOf(sessionId) {
			const out: DecisionRecord[] = [];
			for (const [name, ledger] of ledgers) {
				if (!name.startsWith(`${sessionId}:`)) continue;
				for (const decision of ledger.decisions())
					out.push({
						tool: decision.effect.summary.tool,
						...(decision.effect.summary.target === undefined ? {} : { target: decision.effect.summary.target }),
						effect: decision.effect.summary.effect,
						answer: decision.answer,
					});
			}
			return out;
		},
		grants: storedGrants,
		async grant(tool, target) {
			await rt.load();
			const team = rt.state as unknown as Record<string, unknown>;
			const list = storedGrants().filter((entry) => !(entry.tool === tool && entry.target === target));
			list.push({ tool, ...(target === undefined ? {} : { target }), at: Date.now() });
			team[STANDING_GRANTS] = list;
			await rt.save();
		},
		async revoke(tool, target) {
			await rt.load();
			const team = rt.state as unknown as Record<string, unknown>;
			team[STANDING_GRANTS] = storedGrants().filter((entry) => !(entry.tool === tool && entry.target === target));
			await rt.save();
		},
	};
}
