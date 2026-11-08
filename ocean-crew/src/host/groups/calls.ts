// The recoverable side of a group's calls: the batch a Bot's "@" opened, the summary it
// still owes once every callee settled, the replay of a group_relay call by its callId,
// and the member/summary budgets kept apart from the idle ping-pong guard.
//
// The in-memory CallBatch stays the live object a round mutates; every change is also
// written into the room in state.json, so a restart can go on with a pending summary or
// fail an interrupted call out loud instead of losing it.

import { randomUUID } from "node:crypto";
import { headOf } from "../core/text.ts";
import type {
	BudgetSide,
	CallBatch,
	CallGoal,
	GroupBudgetView,
	GroupHost,
	GroupRoom,
	SavedCallBatch,
	SavedRelayCall,
} from "./types.ts";
import { asRoom } from "./types.ts";

// Bounded retention: a room keeps the recent calls, never an unresolved one.
const BATCHES_KEPT = 24;
const RELAYS_KEPT = 12;
// What state.json keeps of a result for a restart: the group log keeps it whole.
const RESULT_TEXT_KEPT = 800;
const REPLAY_TEXT_KEPT = 1000;
const LATE_GOALS_KEPT = 20;
const SUMMARY_ATTEMPTS_MAX = 3;
const SUMMARY_TEXT_KEPT = 300;

// A saved summary that names a caller the group lost fails instead of waiting forever.
const goneCaller = "the member that called them is gone";

export function installCalls(host: GroupHost): void {
	const { rt } = host;
	const now = () => host.now();
	// One per host process: a record with another writer was left by an earlier process.
	const writer = randomUUID();

	const table = (room: GroupRoom): Record<string, SavedCallBatch> => {
		room.calls ??= {};
		return room.calls;
	};

	// The goal as the member was called sees it. A result that comes back later answers
	// this revision; the goal may have moved on since.
	host.goalAt = (roomId) => {
		const saved = rt.roomOf(roomId);
		if (saved === undefined) return undefined;
		const goal = asRoom(saved).goal;
		if (goal === undefined) return undefined;
		const at: CallGoal = {
			...(typeof goal.id === "string" && goal.id !== "" ? { id: goal.id } : {}),
			...(typeof goal.revision === "number" ? { revision: goal.revision } : {}),
			...(typeof goal.objectiveRevision === "number" ? { objectiveRevision: goal.objectiveRevision } : {}),
		};
		return Object.keys(at).length === 0 ? undefined : at;
	};

	host.batchKeyOf = (roomId, botId) => `${roomId}:${botId}`;

	const notice = (room: GroupRoom, text: string): void => {
		host.appendRoom(room, { who: "Ocean Crew", kind: "notice", reason: "calls", text });
	};

	// Save one live batch into the room. The in-memory Set is not saved: state.json keeps
	// the callees still working as a plain list.
	host.saveBatch = (room, batch) => {
		const kept = table(room);
		const previous = kept[batch.key];
		const summary = batch.summary;
		kept[batch.key] = {
			key: batch.key,
			roomId: batch.roomId,
			...(batch.callId !== undefined ? { callId: batch.callId } : {}),
			by: batch.by,
			callees: [...batch.callees],
			pending: [...batch.pending],
			done: [...batch.done],
			worked: batch.worked,
			answered: batch.answered,
			...(batch.goal !== undefined ? { goal: batch.goal } : {}),
			state: batch.state ?? previous?.state ?? "open",
			createdAt: previous?.createdAt ?? now(),
			updatedAt: now(),
			writer,
			...(batch.pending.size === 0 ? { completedAt: previous?.completedAt ?? now() } : {}),
			...(batch.error !== undefined ? { error: batch.error } : {}),
			...(previous?.results !== undefined ? { results: previous.results } : {}),
			...(previous?.resultsNoted !== undefined ? { resultsNoted: previous.resultsNoted } : {}),
			...(summary !== undefined ? { summary: { ...summary } } : {}),
		};
		pruneBatches(room);
		void rt.save().catch(() => {});
	};

	// The result itself, kept with the batch: a restart that finds a pending summary must
	// still know what it is summarizing.
	host.noteBatchResult = (room, batch, botId, name, text) => {
		const record = table(room)[batch.key] ?? {
			key: batch.key,
			roomId: batch.roomId,
			by: batch.by,
			callees: [...batch.callees],
			pending: [...batch.pending],
			done: [...batch.done],
			worked: batch.worked,
			answered: batch.answered,
			state: batch.state ?? "open",
			createdAt: now(),
			updatedAt: now(),
		};
		const results = record.results ?? [];
		record.results = [
			...results.filter((result) => result.botId !== botId),
			{ botId, name, text: headOf(text, RESULT_TEXT_KEPT), at: now() },
		];
		record.updatedAt = now();
		table(room)[record.key] = record;
		void rt.save().catch(() => {});
	};

	const pruneBatches = (room: GroupRoom): void => {
		const kept = table(room);
		const entries = Object.values(kept).sort((left, right) => left.updatedAt - right.updatedAt);
		for (const entry of entries.slice(0, Math.max(0, entries.length - BATCHES_KEPT))) {
			// An unresolved call is never dropped silently; it is failed first.
			if (entry.state === "open" || entry.state === "awaiting-summary") continue;
			delete kept[entry.key];
		}
	};

	// The batch every callee list is held in, so a late reply finds it after a restart of
	// the in-memory maps (the saved record is then the only copy).
	const batchOf = (room: GroupRoom, key: string): SavedCallBatch | undefined => table(room)[key];

	// Settle the batch once every callee has. A worked batch whose callers were not
	// answered by a callee still owes the caller's final summary: that is the
	// `awaiting-summary` state the user-visible result reaches `delivered` from.
	host.settleBatch = (room, batch) => {
		if (batch.pending.size > 0) {
			batch.state = "open";
			host.saveBatch(room, batch);
			return;
		}
		batch.state ??= "open";
		const needsSummary = batch.done.length > 0 && batch.worked && !batch.answered;
		if (needsSummary) {
			batch.state = "awaiting-summary";
			batch.summary = {
				...(batch.summary ?? {}),
				state: batch.summary?.state === "posted" ? "posted" : "pending",
				attempts: batch.summary?.attempts ?? 0,
				...(batch.summary?.text !== undefined ? { text: batch.summary.text } : {}),
			};
		} else if (batch.done.length > 0 || batch.answered) {
			// A callee that answered the caller, or a chat that did no tool work, is
			// already in the group: there is nothing left to summarize for the user.
			batch.state = "delivered";
			batch.summary = {
				state: "posted",
				at: now(),
				attempts: batch.summary?.attempts ?? 0,
				...(batch.summary?.text !== undefined ? { text: batch.summary.text } : {}),
			};
		} else {
			batch.state = "failed";
			batch.error = "no member of the call finished the work";
			batch.summary = { state: "failed", at: now(), attempts: batch.summary?.attempts ?? 0, error: batch.error };
		}
		host.saveBatch(room, batch);
	};

	// Whether the batch still owes a summary to the user.
	const owesSummary = (record: SavedCallBatch): boolean =>
		record.state === "awaiting-summary" && record.summary?.state !== "posted" && record.summary?.state !== "failed";

	// Ask the caller for its final summary. One round asks once for the same batch; a
	// later round, or a restarted host, may ask again up to a hard limit, then the batch
	// fails out loud instead of staying in the ledger forever.
	host.askSummary = (room, round, batch, note) => {
		if (batch.pending.size > 0) return false;
		if (!(batch.done.length > 0 && batch.worked && !batch.answered)) {
			host.settleBatch(room, batch);
			return false;
		}
		const record = batchOf(room, batch.key) ?? {
			key: batch.key,
			roomId: batch.roomId,
			by: batch.by,
			callees: [...batch.callees],
			pending: [...batch.pending],
			done: [...batch.done],
			worked: batch.worked,
			answered: batch.answered,
			state: "awaiting-summary" as const,
			createdAt: now(),
			updatedAt: now(),
		};
		const summary = record.summary;
		if (summary?.state === "requested" && summary.requestedIn === round.callId) return false;
		const attempts = (summary?.attempts ?? 0) + 1;
		const caller = rt.botOf(record.by);
		if (caller === undefined || !room.members.includes(caller.id)) {
			failSummary(room, record, goneCaller);
			return false;
		}
		if (!host.allowSummary(room)) {
			failSummary(room, record, "the group's summary budget is used up");
			return false;
		}
		if (attempts > SUMMARY_ATTEMPTS_MAX) {
			failSummary(room, record, `the summary was asked ${SUMMARY_ATTEMPTS_MAX} times and never posted`);
			return false;
		}
		host.chargeWork(room, "summary");
		record.state = "awaiting-summary";
		record.writer = writer;
		record.summary = {
			state: "requested",
			at: now(),
			by: caller.id,
			attempts,
			...(round.callId !== undefined ? { requestedIn: round.callId } : {}),
		};
		batch.state = "awaiting-summary";
		batch.summary = record.summary;
		table(room)[record.key] = record;
		const goalNote =
			record.goal?.revision !== undefined
				? ` The results were asked for at goal revision ${record.goal.revision}${goalMoved(room, record.goal)}.`
				: "";
		const slot = round.slots.find((other) => other.id === caller.id && other.status === "waiting");
		if (slot !== undefined) {
			slot.summaryBatch = record.key;
			slot.note = `${note}${goalNote}`;
		} else {
			host.callIn(round, [caller], `${note}${goalNote}`, undefined);
			const woken = round.slots.find((other) => other.id === caller.id && other.status === "waiting");
			if (woken !== undefined) woken.summaryBatch = record.key;
		}
		void rt.save().catch(() => {});
		return true;
	};

	// The goal moved on since the call: say so next to the revision the result answers.
	const goalMoved = (room: GroupRoom, at: CallGoal): string => {
		const current = room.goal?.revision;
		if (typeof current !== "number" || current === at.revision) return "";
		return `; it is now at revision ${current}`;
	};

	// The caller's line reached the group, which is where the user reads it: the batch's
	// summary is delivered, not merely taken by a Bot. A Bot line in the group also
	// settles any hand-off result the same Bot still owed that room.
	host.deliverSummary = (room, botId, text) => {
		let changed = false;
		for (const record of Object.values(table(room))) {
			const summary = record.summary;
			if (summary?.state !== "requested" || summary.by !== botId) continue;
			record.summary = {
				...summary,
				state: "posted",
				at: now(),
				text: headOf(text, SUMMARY_TEXT_KEPT),
			};
			record.state = "delivered";
			record.completedAt ??= now();
			record.updatedAt = now();
			changed = true;
		}
		if (changed) void rt.save().catch(() => {});
		if (typeof rt.deliverWorkInRoom === "function") rt.deliverWorkInRoom(room.id, botId);
	};

	const failSummary = (room: GroupRoom, record: SavedCallBatch, reason: string): void => {
		record.state = "failed";
		record.error = reason;
		record.summary = {
			...(record.summary ?? { attempts: 0 }),
			state: "failed",
			at: now(),
			error: reason,
		};
		record.updatedAt = now();
		record.writer = writer;
		table(room)[record.key] = record;
		notice(room, `The results of ${nameOf(record.by)}'s call will not be summarized: ${reason}.`);
		void rt.save().catch(() => {});
	};

	const nameOf = (botId: string): string => rt.botOf(botId)?.name ?? "a member";

	// A new round or a restarted host finds every batch that still owes a summary and
	// either asks its caller or fails it. Running this on every round is what makes the
	// duty recoverable rather than a memory-only promise.
	host.restoreSummaries = (room, round) => {
		for (const record of Object.values(table(room))) {
			if (!owesSummary(record)) continue;
			const caller = rt.botOf(record.by);
			if (caller === undefined || !room.members.includes(caller.id)) {
				failSummary(room, record, goneCaller);
				continue;
			}
			const existing = round.slots.find((slot) => slot.id === caller.id && slot.status === "waiting");
			if (existing !== undefined) {
				// It is already answering other work in this round; its answer owes the
				// summary too, and a second call would only fork its place.
				if (!host.allowSummary(room)) {
					failSummary(room, record, "the group's summary budget is used up");
					continue;
				}
				existing.summaryBatch = record.key;
				if (record.summary?.state === "pending") {
					host.chargeWork(room, "summary");
					record.summary = {
						...record.summary,
						state: "requested",
						by: caller.id,
						at: now(),
						attempts: (record.summary.attempts ?? 0) + 1,
						requestedIn: round.callId,
					};
					record.updatedAt = now();
					void rt.save().catch(() => {});
				}
				continue;
			}
			if (record.summary?.state === "requested" && record.summary.requestedIn === round.callId) continue;
			const batch = liveBatch(record);
			if (batch !== undefined)
				host.askSummary(
					room,
					round,
					batch,
					`${nameOf(record.by)}: the results of your call are back; post your final summary for the user.`,
				);
		}
	};

	// The batches a done post's caller still owes a summary for, as live shapes. A late
	// barrier completion needs them before the new round exists.
	host.summaryBatches = (room, by) =>
		Object.values(table(room))
			.filter((record) => owesSummary(record) && record.by === by)
			.map((record) => liveBatch(record))
			.filter((batch): batch is CallBatch => batch !== undefined);

	// A saved record as the live shape settle/ask expect.
	const liveBatch = (record: SavedCallBatch): CallBatch | undefined => {
		const batch: CallBatch = {
			key: record.key,
			roomId: record.roomId,
			by: record.by,
			callees: [...record.callees],
			pending: new Set(record.pending),
			done: [...record.done],
			worked: record.worked,
			answered: record.answered,
			...(record.callId !== undefined ? { callId: record.callId } : {}),
			...(record.goal !== undefined ? { goal: record.goal } : {}),
			state: record.state,
			...(record.summary !== undefined ? { summary: { ...record.summary } } : {}),
			...(record.error !== undefined ? { error: record.error } : {}),
		};
		return batch.pending.size === 0 && owesSummary(record) ? batch : undefined;
	};

	// What a restart left behind. An open call cannot continue (its member turns died
	// with the process): its finished results move on to the caller's summary when there
	// are any, and otherwise it fails. A summary the dead process asked for is askable
	// again; its caller is rechecked.
	host.recoverCalls = (room) => {
		let changed = false;
		for (const record of Object.values(table(room))) {
			const lost = record.pending;
			// This process wrote the record last: nothing about it is a restart leftover.
			if (record.writer === writer) continue;
			if (record.state === "open") {
				record.pending = [];
				record.completedAt ??= now();
				record.lost = [...new Set([...(record.lost ?? []), ...lost])];
				if (record.done.length > 0 && record.worked && !record.answered) {
					record.state = "awaiting-summary";
					record.summary = {
						state: "pending",
						attempts: record.summary?.attempts ?? 0,
					};
				} else {
					record.state = "failed";
					record.error = "DeepSeek Harness restarted while this call was still out";
					record.summary = {
						state: "failed",
						at: now(),
						attempts: record.summary?.attempts ?? 0,
						error: record.error,
					};
				}
				record.updatedAt = now();
				record.writer = writer;
				const names = lost.map(nameOf);
				const results =
					record.results !== undefined && record.results.length > 0
						? ` Recovered results: ${record.results
								.map((result) => `${result.name}: ${headOf(result.text, SUMMARY_TEXT_KEPT)}`)
								.join("; ")}`
						: "";
				if (results !== "") record.resultsNoted = true;
				notice(
					room,
					names.length > 0
						? `DeepSeek Harness restarted while ${nameOf(record.by)}'s call to ${names.join(" and ")} was out. What those members had not finished is lost; what came back is kept${record.done.length > 0 ? `, and ${nameOf(record.by)} is asked to summarize it` : ""}.${results}`
						: `DeepSeek Harness restarted while ${nameOf(record.by)}'s call was out; it is closed.${results}`,
				);
				changed = true;
				continue;
			}
			if (record.state !== "awaiting-summary") continue;
			const caller = rt.botOf(record.by);
			if (caller === undefined || !room.members.includes(caller.id)) {
				failSummary(room, record, goneCaller);
				changed = true;
				continue;
			}
			if (record.summary?.state === "requested") {
				// The process that asked died before its caller answered: ask again.
				record.summary = { ...record.summary, state: "pending", requestedIn: undefined };
				record.updatedAt = now();
				changed = true;
			}
			// The results may have died with the process before their group lines were
			// written; put them in front of the caller once, as a notice it can summarize.
			if (record.results !== undefined && record.results.length > 0 && record.resultsNoted !== true) {
				notice(
					room,
					`Results recovered after a restart (${nameOf(record.by)}'s call): ${record.results
						.map((result) => `${result.name}: ${headOf(result.text, SUMMARY_TEXT_KEPT)}`)
						.join("; ")}`,
				);
				record.resultsNoted = true;
				changed = true;
			}
			record.writer = writer;
			record.updatedAt = now();
			changed = true;
		}
		if (changed) void rt.save().catch(() => {});
	};

	// A late result keeps the goal snapshot it was asked under until the group line is
	// written: the post travels through the group Session, which does not carry it.
	host.noteLateGoal = (room, botId, goal) => {
		if (goal === undefined) return;
		room.lateGoals ??= {};
		const list = room.lateGoals[botId] ?? [];
		room.lateGoals[botId] = [...list, goal].slice(-LATE_GOALS_KEPT);
	};

	host.takeLateGoal = (room, botId) => {
		const late = room.lateGoals;
		const list = late?.[botId];
		if (late === undefined || list === undefined || list.length === 0) return undefined;
		const [first, ...rest] = list;
		if (rest.length === 0) delete late[botId];
		else late[botId] = rest;
		if (Object.keys(late).length === 0) delete room.lateGoals;
		return first;
	};

	// Replay identity: a group_relay callId is the one key. The same words sent as a new
	// call get a new callId and run; a replay of a finished call returns its saved
	// result without calling another member.
	host.beginRelay = (room, callId) => {
		room.callRuns ??= {};
		const saved = room.callRuns[callId];
		if (saved === undefined) {
			room.callRuns[callId] = { callId, at: now(), state: "running" };
			pruneRelays(room);
			void rt.save().catch(() => {});
			return undefined;
		}
		if (saved.state === "done" && saved.result !== undefined) return { ...saved.result, replayed: true };
		if (saved.state === "failed") return { replies: [], passed: [], replayed: true, error: saved.error };
		// It started in the process that died here: running it again would duplicate
		// every member turn, so it fails out loud instead.
		saved.state = "failed";
		saved.error = "DeepSeek Harness restarted while this relay was running";
		void rt.save().catch(() => {});
		return { replies: [], passed: [], interrupted: true, error: saved.error };
	};

	host.finishRelay = (room, callId, result) => {
		room.callRuns ??= {};
		const saved: SavedRelayCall = {
			callId,
			at: room.callRuns[callId]?.at ?? now(),
			state: "done",
			result: {
				replies: result.replies.map((reply) => ({
					...reply,
					...(typeof reply.text === "string" ? { text: headOf(reply.text, REPLAY_TEXT_KEPT) } : {}),
				})),
				passed: [...result.passed],
				...(result.failed !== undefined ? { failed: [...result.failed] } : {}),
			},
		};
		room.callRuns[callId] = saved;
		pruneRelays(room);
		void rt.save().catch(() => {});
	};

	host.failRelay = (room, callId, error) => {
		room.callRuns ??= {};
		room.callRuns[callId] = {
			callId,
			at: room.callRuns[callId]?.at ?? now(),
			state: "failed",
			error: String((error as Error)?.message ?? error).slice(0, 300),
		};
		pruneRelays(room);
		void rt.save().catch(() => {});
	};

	const pruneRelays = (room: GroupRoom): void => {
		const kept = room.callRuns ?? {};
		const entries = Object.values(kept).sort((left, right) => left.at - right.at);
		for (const entry of entries.slice(0, Math.max(0, entries.length - RELAYS_KEPT))) {
			if (entry.state === "running") continue;
			delete kept[entry.callId];
		}
	};

	// Member work and summary work are counted apart. The idle guard's `idleRelays` is a
	// different mechanism and never lands in either side.
	const side = (room: GroupRoom, which: "members" | "summary"): BudgetSide => {
		room.budget ??= {};
		const current = room.budget[which];
		if (current !== undefined) return current;
		const created: BudgetSide = { spent: 0 };
		room.budget[which] = created;
		return created;
	};

	const configuredLimit = (which: "members" | "summary"): number | undefined => {
		// Profile patches may set these even though the typed config does not name them.
		const config = rt.config as unknown as { groupMemberTurns?: number; groupSummaryTurns?: number };
		const value = which === "members" ? config.groupMemberTurns : config.groupSummaryTurns;
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	};

	const limitOf = (room: GroupRoom, which: "members" | "summary"): number | undefined => {
		const local = room.budget?.[which]?.limit;
		return local ?? configuredLimit(which);
	};

	// A token budget is enforced from what DSH already reports; without that projection
	// it cannot be measured, so it is not guessed at.
	const tokensOver = (room: GroupRoom, which: "members" | "summary"): boolean => {
		const budget = room.budget?.[which];
		return budget?.tokenLimit !== undefined && budget.tokens !== undefined && budget.tokens >= budget.tokenLimit;
	};

	const remaining = (room: GroupRoom, which: "members" | "summary"): number | undefined => {
		const limit = limitOf(room, which);
		if (limit === undefined) return undefined;
		return Math.max(0, limit - side(room, which).spent);
	};

	// A new scope resets what was spent, keeping the limits. A goal runs until its
	// objective revision changes; without one, each ask from the user is its own scope.
	host.beginBudget = (room, round) => {
		const goal = room.goal;
		const scope =
			goal?.id !== undefined && goal.status === "active"
				? `goal:${goal.id}:${goal.objectiveRevision ?? goal.revision ?? 0}`
				: round.userMessage === true
					? `ask:${round.startSeq}`
					: undefined;
		if (scope === undefined) return;
		room.budget ??= {};
		if (room.budget.scope === scope) return;
		room.budget.scope = scope;
		delete room.budget.noticed;
		for (const which of ["members", "summary"] as const) {
			const current = room.budget[which];
			room.budget[which] = {
				...(current?.limit !== undefined ? { limit: current.limit } : {}),
				...(current?.tokenLimit !== undefined ? { tokenLimit: current.tokenLimit } : {}),
				spent: 0,
			};
		}
	};

	host.allowMemberWork = (room) => {
		const limit = limitOf(room, "members");
		if (limit !== undefined && side(room, "members").spent >= limit) return false;
		return !tokensOver(room, "members");
	};

	host.allowSummary = (room) => {
		const limit = limitOf(room, "summary");
		if (limit !== undefined && side(room, "summary").spent >= limit) return false;
		return !tokensOver(room, "summary");
	};

	host.chargeWork = (room, which) => {
		const budget = side(room, which);
		budget.spent += 1;
	};

	host.chargeTokens = (room, summary, tokens) => {
		if (tokens === undefined || tokens <= 0) return;
		const budget = side(room, summary ? "summary" : "members");
		budget.tokens = (budget.tokens ?? 0) + tokens;
	};

	// The DSH token-meter projection of one Session: the budget consumes what the team
	// already reports instead of keeping a second token ledger.
	host.sessionTokens = async (sessionId) => {
		try {
			const registry = (rt.ctx as { get?: (name: string) => unknown }).get?.("sessionProjections") as
				| { snapshot?: (session: unknown) => { values?: { tokenUsage?: Record<string, unknown> } } }
				| undefined;
			if (registry?.snapshot === undefined) return undefined;
			const agent = (await rt.resolveAgent?.(sessionId)) as { session?: unknown } | undefined;
			if (agent?.session === undefined) return undefined;
			const usage = registry.snapshot(agent.session)?.values?.tokenUsage;
			if (usage === undefined) return undefined;
			const count = (key: string): number => Number(usage[key]) || 0;
			return (
				count("uncachedInputTokens") + count("outputTokens") + count("cacheReadTokens") + count("cacheWriteTokens")
			);
		} catch {
			return undefined;
		}
	};

	host.budgetOf = async (room) => {
		const registry = (() => {
			try {
				return (rt.ctx as { get?: (name: string) => unknown }).get?.("sessionProjections");
			} catch {
				return undefined;
			}
		})() as { snapshot?: unknown } | undefined;
		const view = (which: "members" | "summary"): BudgetSide & { remaining?: number } => {
			const spent = side(room, which);
			const limit = limitOf(room, which);
			const left = remaining(room, which);
			return {
				...(limit !== undefined ? { limit } : {}),
				...(spent.tokenLimit !== undefined ? { tokenLimit: spent.tokenLimit } : {}),
				spent: spent.spent,
				...(spent.tokens !== undefined ? { tokens: spent.tokens } : {}),
				...(left !== undefined ? { remaining: left } : {}),
			};
		};
		return {
			available: registry?.snapshot !== undefined,
			...(room.budget?.scope !== undefined ? { scope: room.budget.scope } : {}),
			members: view("members"),
			summary: view("summary"),
			idle: { streak: room.idleRelays ?? 0, paused: room.idlePaused !== undefined },
		} satisfies GroupBudgetView;
	};

	// A view for the group's own settings and for the host's checks.
	rt.groupBudgetView = async (roomId: string): Promise<GroupBudgetView | undefined> => {
		const saved = rt.roomOf(roomId);
		return saved === undefined ? undefined : host.budgetOf(asRoom(saved));
	};

	// What the group may spend before its calls are refused. A limit is a whole number of
	// turns or tokens; an explicit null clears it, and `clear` removes both sides at once.
	// The user sets this from the group's settings, so the shape is checked here.
	rt.setGroupBudget = async (roomId: string, patch: Record<string, unknown>): Promise<GroupBudgetView | undefined> => {
		const saved = rt.roomOf(roomId);
		if (saved === undefined) return undefined;
		const room = asRoom(saved);
		room.budget ??= {};
		const budget = room.budget;
		const whole = (value: unknown, label: string): number | undefined => {
			if (value === null) return undefined;
			const number = Number(value);
			if (!Number.isInteger(number) || number <= 0) {
				throw Object.assign(new Error(`${label} must be a whole number above zero`), { code: "bot/invalid" });
			}
			return number;
		};
		const apply = (which: "members" | "summary", given: Record<string, unknown> | undefined): void => {
			if (given === undefined || given === null || typeof given !== "object") return;
			budget[which] ??= { spent: 0 };
			const side = budget[which];
			if ("limit" in given) side.limit = whole(given.limit, "The turn limit");
			if ("tokenLimit" in given) side.tokenLimit = whole(given.tokenLimit, "The token limit");
		};
		if (patch.clear === true) {
			budget.members = undefined;
			budget.summary = undefined;
		}
		apply("members", patch.members as Record<string, unknown> | undefined);
		apply("summary", patch.summary as Record<string, unknown> | undefined);
		// A fresh limit says nothing about the notices already posted: the next overrun is
		// a new event for the user.
		if (budget.noticed !== undefined) budget.noticed = {};
		await rt.save();
		return host.budgetOf(room);
	};
}
