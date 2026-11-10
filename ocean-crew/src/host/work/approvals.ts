// Approvals. A member's group Session is hidden, so DSH's approval card never shows there
// and the turn would wait forever: Ocean Crew answers those requests itself, from the
// group chat. A Bot's own chat keeps DSH's card, but Ocean Crew can answer those too
// (IM chats, the phone app): the request is raced — whichever side answers first wins,
// and the other card withdraws.
//

// arguments hash, target, audience) and the permission revision of the Session it came
// from. A refused or expired card closes that action for the conversation, so it is not asked
// again as if the question had never been put. Answering reloads the world first: an expired
// card, a Session that changed
// hands, changed permissions, or a mismatched ref is settled as cancelled and refused as
// stale, so a click can never approve an action other than the one it was shown for.

import { createHash, randomUUID } from "node:crypto";
import type { Runtime } from "../core/runtime.ts";

const OUTCOMES: Record<string, string> = { allow: "allowed-once", reject: "rejected" };
// A card that waits this long is settled unanswerable. The action it described is then closed as
// refused for this conversation: asking the same question again is a retry of a decision the user
// has already been asked for, and a refusal must be an answer rather than a pause.
const DEFAULT_TTL_MS = 15 * 60_000;
// How long a settled refusal answers for the same action.
const REFUSAL_TTL_MS = 6 * 60 * 60_000;

// The action an approval was asked for. Stored on the pending entry and shown with it,
// so a click can be checked against what it approves; never upgraded to a lasting grant.
export interface ApprovalRef {
	workId?: string;
	runId?: string;
	toolCallId: string;
	argsHash: string;
	target?: string;
	audience: "bot" | "group";
	permissionRevision?: string;
	expiry: number;
}

export interface ApprovalEntry {
	id: string;
	sessionId: string;
	botId: string;
	roomId?: string;
	tool: string;
	reason: string;
	detail: { text?: string; code?: string };
	at: number;
	ref: ApprovalRef;
	answer?: (outcome: string) => void;
}

interface ApprovalRequest {
	agent?: { session?: { id?: string }; id?: string };
	toolName?: string;
	reason?: string;
	callId?: string;
	signal?: AbortSignal;
	args?: unknown;
	arguments?: unknown;
	input?: unknown;
	target?: unknown;
	workId?: string;
	runId?: string;
	[key: string]: unknown;
}

// What this module reads and writes on the runtime.
interface ApprovalRuntime extends Runtime {
	groupOwners: Map<string, { botId: string; roomId: string }>;
	chatOwners: Map<string, string>;
	callDetail?: (sessionId: string, callId: string) => { text?: string; code?: string } | undefined;
	noteApproval?: (sessionId: string, approval: { tool?: string; reason?: string } | undefined) => void;
	yieldRoomTurn?: (sessionId: string) => void;
	permissionRevision?: (sessionId: string) => string | undefined;
}

interface PendingApproval extends ApprovalEntry {
	/** Resolves the DSH request with the outcome the entry settled on. */
	resolve?: (outcome: string) => void;
	/** Everything the own-chat race must undo when the entry settles. */
	cleanup?: () => void;
}

// A stable hash of the action's arguments: two approvals of the same tool with different
// arguments must never share a ref, and the same arguments must always hash the same.
export function argsHashOf(value: unknown): string {
	const seen = new Set<object>();
	const stable = (input: unknown): unknown => {
		if (input === null || typeof input !== "object") return input;
		if (seen.has(input as object)) return "[circular]";
		seen.add(input as object);
		if (Array.isArray(input)) return input.map(stable);
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(input as Record<string, unknown>).sort())
			out[key] = stable((input as Record<string, unknown>)[key]);
		return out;
	};
	let text: string;
	try {
		text = JSON.stringify(stable(value) ?? "");
	} catch {
		text = String(value);
	}
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const refOf = (
	request: ApprovalRequest,
	owner: { roomId: string } | undefined,
	permissionRevision: string | undefined,
	now: number,
	ttlMs: number,
): ApprovalRef => {
	const args = request.args ?? request.arguments ?? request.input;
	const targetInput = request.target;
	const target =
		typeof targetInput === "string"
			? targetInput
			: targetInput !== null && typeof targetInput === "object"
				? JSON.stringify(targetInput)
				: undefined;
	return {
		...(typeof request.workId === "string" ? { workId: request.workId } : {}),
		...(typeof request.runId === "string" ? { runId: request.runId } : {}),
		toolCallId: typeof request.callId === "string" ? request.callId : "",
		argsHash: argsHashOf(args),
		...(target !== undefined ? { target } : {}),
		audience: owner === undefined ? "bot" : "group",
		...(permissionRevision !== undefined ? { permissionRevision } : {}),
		expiry: now + ttlMs,
	};
};

export function install(rt: Runtime): void {
	const runtime = rt as ApprovalRuntime;
	const { ctx } = rt;
	const pending = new Map<string, PendingApproval>();
	// Settled refusals: conversation + action → when they stop answering for it.
	const refused = new Map<string, number>();
	const approvalListeners = new Set<(kind: string, data: Record<string, unknown>) => void>();
	const onApproval = (listener: (kind: string, data: Record<string, unknown>) => void): (() => void) => {
		approvalListeners.add(listener);
		return () => approvalListeners.delete(listener);
	};
	const emit = (kind: string, data: Record<string, unknown>): void => {
		for (const listener of approvalListeners) {
			try {
				listener(kind, data);
			} catch (error) {
				rt.warn("ocean-crew: approval listener failed: %s", error);
			}
		}
	};
	const ttlOf = (): number => {
		const configured = (rt.config as Record<string, unknown> | undefined)?.approvalTtlMs;
		return typeof configured === "number" && Number.isFinite(configured) && configured > 0
			? configured
			: DEFAULT_TTL_MS;
	};

	// Settles an entry: it leaves the pending set, the approval note goes, and listeners
	// hear how it ended. Idempotent; false when it was already settled elsewhere.
	const settle = (entry: PendingApproval, outcome: string): boolean => {
		if (!pending.has(entry.id)) return false;
		pending.delete(entry.id);
		runtime.noteApproval?.(entry.sessionId, undefined);
		emit("settled", { id: entry.id, outcome });
		return true;
	};
	// Resolves the DSH request with one outcome: the card withdraws for that answer.
	const respond = (entry: PendingApproval, outcome: string): void => {
		if (!settle(entry, outcome)) return;
		// A rejection answers for this action; an allowance covers the one call it was shown for.
		if (outcome === OUTCOMES.reject) remember(entry);
		entry.resolve?.(outcome);
		entry.cleanup?.();
	};
	// The same, settled under a different name for the window (expired, refused).
	const withdraw = (entry: PendingApproval, settledAs: string): void => {
		if (!pending.has(entry.id)) return;
		// Only a card that ran out of time reads as a refusal. A card withdrawn because the action,
		// the conversation or the permissions changed is a different case: the user never answered,
		// and the same action may legitimately be asked about again once the world settles.
		if (entry.ref.expiry <= Date.now()) remember(entry);
		pending.delete(entry.id);
		runtime.noteApproval?.(entry.sessionId, undefined);
		emit("settled", { id: entry.id, outcome: settledAs });
		entry.resolve?.("cancelled");
		entry.cleanup?.();
	};

	const remember = (entry: PendingApproval): void => {
		const key = `${entry.sessionId}\u0000${entry.tool}\u0000${entry.ref.argsHash}`;
		refused.set(key, Date.now() + REFUSAL_TTL_MS);
		// An old refusal is only worth keeping while it still answers.
		if (refused.size > 200) for (const [held, until] of refused) if (until <= Date.now()) refused.delete(held);
	};

	// Why an open approval can no longer be trusted, or undefined while it still holds.
	// Checked both by the window's poll (a stale card is withdrawn) and by the answer.
	const staleReason = (entry: PendingApproval, now = Date.now()): string | undefined => {
		if (entry.ref.expiry <= now) return "This approval expired; ask for it again.";
		const owner = runtime.groupOwners.get(entry.sessionId);
		const chatOwner = runtime.chatOwners.get(entry.sessionId);
		if (entry.roomId !== undefined && (owner === undefined || owner.roomId !== entry.roomId))
			return "This approval is no longer open: its group chat changed.";
		if (entry.roomId === undefined && chatOwner !== entry.botId)
			return "This approval is no longer open: its conversation changed.";
		if (entry.ref.permissionRevision !== undefined && typeof runtime.permissionRevision === "function") {
			const current = runtime.permissionRevision(entry.sessionId);
			if (current !== entry.ref.permissionRevision)
				return "The Bot's permissions changed after it asked; ask again.";
		}
		return undefined;
	};

	const sweep = (): void => {
		const now = Date.now();
		for (const entry of [...pending.values()]) {
			if (staleReason(entry, now) !== undefined) withdraw(entry, "expired");
		}
	};

	// One action, as a refusal remembers it: the conversation and the exact call it was shown for.
	const refusalOf = (sessionId: string, request: ApprovalRequest, now: number): string | undefined => {
		const key = `${sessionId}\u0000${String(request.toolName ?? "")}\u0000${argsHashOf(request.args ?? request.arguments ?? request.input)}`;
		const until = refused.get(key);
		if (until === undefined) return undefined;
		if (until > now) return key;
		refused.delete(key);
		return undefined;
	};

	// Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
	ctx.on(
		"approval/request",
		(request: ApprovalRequest, next: () => Promise<unknown>) => {
			const sessionId = request.agent?.session?.id ?? request.agent?.id;
			const owner = sessionId === undefined ? undefined : runtime.groupOwners.get(sessionId);
			const botId = owner?.botId ?? (sessionId === undefined ? undefined : runtime.chatOwners.get(sessionId));
			if (botId === undefined || sessionId === undefined) return next();
			const now = Date.now();
			// This action was already refused or left unanswered: the answer is no, and it is not
			// asked again until the window passes. The model is told so it can say why.
			if (refusalOf(sessionId, request, now) !== undefined) return "cancelled";
			const id = randomUUID();
			const entry: PendingApproval = {
				id,
				sessionId,
				botId,
				...(owner ? { roomId: owner.roomId } : {}),
				tool: String(request.toolName ?? ""),
				reason: String(request.reason ?? "").slice(0, 500),
				detail: runtime.callDetail?.(sessionId, String(request.callId ?? "")) ?? {},
				at: now,
				ref: refOf(request, owner, runtime.permissionRevision?.(sessionId), now, ttlOf()),
			};
			pending.set(id, entry);
			runtime.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) });
			emit("open", { ...entry, answerable: true });
			if (owner === undefined) {
				// An own-chat approval races DSH's card. The card sees `linked`, our own
				// AbortSignal: answering here resolves the request, then withdraws the card;
				// an answer there settles `next()` first and is adopted. An abort of the
				// original signal cancels either way.
				const original = request.signal;
				const linked = new AbortController();
				request.signal = linked.signal;
				return new Promise((resolve, reject) => {
					const complete = (outcome: string): void => {
						respond(entry, outcome);
					};
					entry.answer = complete;
					entry.resolve = (outcome) => resolve(outcome);
					entry.cleanup = (): void => {
						linked.abort();
						if (request.signal === linked.signal) request.signal = original;
					};
					if (original?.aborted) entry.answer("cancelled");
					else original?.addEventListener("abort", () => entry.answer?.("cancelled"), { once: true });
					Promise.resolve(next()).then(
						(outcome) => {
							if (!pending.has(id)) return;
							complete(String(outcome));
						},
						// DSH's answerer threw: close the entry and give the caller the error
						// the way the pre-race code did, instead of hanging forever.
						(error) => {
							if (!settle(entry, "cancelled")) return;
							reject(error);
							entry.cleanup?.();
						},
					);
				});
			}
			runtime.yieldRoomTurn?.(sessionId);
			return new Promise((resolve) => {
				entry.answer = (outcome: string): void => {
					respond(entry, outcome);
				};
				entry.resolve = (outcome) => resolve(outcome);
				if (request.signal?.aborted) entry.answer("cancelled");
				request.signal?.addEventListener("abort", () => entry.answer?.("cancelled"), { once: true });
			});
		},
		{ prepend: true },
	);

	const approvalsView = (): Array<Record<string, unknown>> => {
		sweep();
		return [...pending.values()].map((entry) => {
			const { answer, resolve: _resolve, cleanup: _cleanup, ...card } = entry;
			return { ...card, answerable: answer !== undefined };
		});
	};
	const waitsForApproval = (sessionId: string): boolean =>
		[...pending.values()].some((entry) => entry.sessionId === sessionId);

	// The user answered a card. The world is reloaded before the answer is applied: the
	// action must still be the one the card was shown for, with the same permissions and
	// in the same conversation. A card that no longer holds is withdrawn and refused.
	function answerApproval(id: string, choice: string, expected?: Partial<ApprovalRef>): void {
		const entry = pending.get(String(id ?? ""));
		if (entry?.answer === undefined)
			throw Object.assign(new Error("This approval is no longer open"), { code: "bot/stale" });
		const outcome = OUTCOMES[choice];
		if (outcome === undefined) throw Object.assign(new Error("Choose allow or reject"), { code: "bot/invalid" });
		const stale = staleReason(entry);
		if (stale !== undefined) {
			withdraw(entry, "expired");
			throw Object.assign(new Error(stale), { code: "bot/stale" });
		}
		if (expected !== undefined) {
			if (expected.toolCallId !== undefined && expected.toolCallId !== entry.ref.toolCallId) {
				withdraw(entry, "mismatched");
				throw Object.assign(new Error("This card no longer matches the action it was asked for; ask again."), {
					code: "bot/stale",
				});
			}
			if (expected.argsHash !== undefined && expected.argsHash !== entry.ref.argsHash) {
				withdraw(entry, "mismatched");
				throw Object.assign(new Error("The action changed since this card was shown; ask again."), {
					code: "bot/stale",
				});
			}
			if (expected.target !== undefined && expected.target !== entry.ref.target) {
				withdraw(entry, "mismatched");
				throw Object.assign(new Error("The target changed since this card was shown; ask again."), {
					code: "bot/stale",
				});
			}
			if (
				expected.permissionRevision !== undefined &&
				expected.permissionRevision !== entry.ref.permissionRevision
			) {
				withdraw(entry, "expired");
				throw Object.assign(new Error("The Bot's permissions changed after it asked; ask again."), {
					code: "bot/stale",
				});
			}
		}
		entry.answer(outcome);
	}

	// A group Session that leaves its group has no card left to answer from.
	const cancelApprovals = (sessionId: string): void => {
		for (const entry of pending.values()) {
			if (entry.sessionId === sessionId) entry.answer?.("cancelled");
		}
	};

	// A permission change after a card was shown invalidates it: the grant cannot outlive
	// the authority it was asked under. The turn gets `cancelled`, so tightening takes
	// effect before the action runs.
	const invalidateApprovals = (sessionIds: Iterable<string>): void => {
		const wanted = new Set(sessionIds);
		for (const entry of [...pending.values()]) {
			if (wanted.has(entry.sessionId)) withdraw(entry, "expired");
		}
	};

	// What a turn's work view shows for a Bot waiting on one of its approvals.
	const approvalFor = (botId: string): Record<string, unknown> | undefined =>
		approvalsView().find((entry) => entry.botId === botId);

	Object.assign(rt, {
		approvalsView,
		waitsForApproval,
		answerApproval,
		cancelApprovals,
		invalidateApprovals,
		onApproval,
		approvalFor,
		approvalRefOf: (entry: ApprovalEntry) => entry.ref,
	});
}
