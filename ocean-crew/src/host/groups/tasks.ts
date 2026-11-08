// What a group task looks like to the user: the goal it was dispatched under, where the
// work stands, what came back, and whether the answer has actually reached the group.
// This is a read-only view over state the group module already keeps — it decides
// nothing and sends nothing.

import type { Runtime } from "../core/runtime.ts";
import type { CallBatchState, CallGoal, CallResult, CallSummary, GroupRoom, SavedRelayCall } from "./types.ts";

/** Where one task stands, in the terms the chat shows. */
export type TaskStatus =
	| "running"
	| "waiting_summary"
	| "waiting_user"
	| "completed"
	| "partial"
	| "failed"
	| "stopped";

/** Whether the user has been told, as far as the saved state can prove. */
export type TaskDelivery = "open" | "pending" | "delivered" | "abandoned";

export interface TaskResultView {
	botId: string;
	name: string;
	/** The start of what the member handed back. */
	text?: string;
	at: number;
}

export interface TaskCardView {
	id: string;
	kind: "call" | "relay" | "pending";
	roomId: string;
	roomName?: string;
	/** The Bot that opened the call. */
	by?: string;
	/** The Bots that were called. */
	members: string[];
	status: TaskStatus;
	/** The goal as the members were called saw it. */
	goal?: CallGoal;
	/** The goal as it stands now; a different revision means the result answers an older one. */
	currentGoal?: CallGoal;
	statusAt: number;
	completedAt?: number;
	result?: string;
	results: TaskResultView[];
	summary?: string;
	delivery: TaskDelivery;
	/** Why the task failed or its delivery was abandoned. */
	reason?: string;
	error?: string;
}

const goalOf = (room: GroupRoom): CallGoal | undefined => {
	const goal = room.goal;
	if (goal === undefined) return undefined;
	const at: CallGoal = {
		...(typeof goal.id === "string" && goal.id !== "" ? { id: goal.id } : {}),
		...(typeof goal.revision === "number" ? { revision: goal.revision } : {}),
		...(typeof goal.objectiveRevision === "number" ? { objectiveRevision: goal.objectiveRevision } : {}),
	};
	return Object.keys(at).length === 0 ? undefined : at;
};

const deliveryOf = (state: CallBatchState | undefined, summary: CallSummary | undefined): TaskDelivery => {
	if (summary?.state === "failed") return "abandoned";
	if (summary !== undefined && (summary.state === "pending" || summary.state === "requested")) return "pending";
	if (state === "delivered") return "delivered";
	if (state === "failed") return "abandoned";
	return "open";
};

// A batch is partial when it delivered fewer results than it called for, or the state
// itself recorded a lost callee: the summary is then an answer about part of the work.
const statusOf = (state: CallBatchState | undefined, settled: number, called: number, lost: number): TaskStatus => {
	if (state === "failed") return "failed";
	if (state === "delivered") return lost > 0 || settled < called ? "partial" : "completed";
	if (state === "awaiting-summary") return settled < called || lost > 0 ? "partial" : "waiting_summary";
	return "running";
};

const textStart = (value: unknown, limit = 240): string | undefined => {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text === "") return undefined;
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const resultsOf = (results: CallResult[] | undefined): TaskResultView[] =>
	(results ?? []).map((result) => ({
		botId: String(result.botId),
		name: String(result.name ?? result.botId),
		...(textStart(result.text) === undefined ? {} : { text: textStart(result.text) }),
		at: Number(result.at ?? 0),
	}));

export const cardsOfRoom = (room: GroupRoom): TaskCardView[] => {
	const cards: TaskCardView[] = [];
	const current = goalOf(room);
	for (const [key, batch] of Object.entries(room.calls ?? {})) {
		if (batch === null || typeof batch !== "object") continue;
		const members = Array.isArray(batch.callees) ? batch.callees.map(String) : [];
		const results = resultsOf(batch.results);
		const lost = Array.isArray(batch.lost) ? batch.lost.length : 0;
		const status = statusOf(batch.state, batch.done.length, members.length, lost);
		cards.push({
			id: String(batch.callId ?? key),
			kind: "call",
			roomId: room.id,
			...(typeof room.name === "string" && room.name !== "" ? { roomName: room.name } : {}),
			by: String(batch.by),
			members,
			status,
			...(batch.goal === undefined ? {} : { goal: batch.goal }),
			...(current === undefined ? {} : { currentGoal: current }),
			statusAt: Number(batch.updatedAt ?? batch.createdAt ?? 0),
			...(batch.completedAt === undefined ? {} : { completedAt: Number(batch.completedAt) }),
			...(results[0]?.text === undefined ? {} : { result: results[0].text }),
			results,
			...(textStart(batch.summary?.text) === undefined ? {} : { summary: textStart(batch.summary?.text) }),
			delivery: deliveryOf(batch.state, batch.summary),
			...(typeof batch.error === "string" && batch.error !== "" ? { error: batch.error } : {}),
			...(batch.error === undefined && batch.summary?.error !== undefined
				? { reason: String(batch.summary.error) }
				: {}),
		});
	}
	// A relay call is a task too: it is done, running, or it was cut by a restart.
	for (const [callId, run] of Object.entries(room.callRuns ?? {})) {
		const saved = run as SavedRelayCall;
		const interrupted = saved.result?.interrupted === true;
		cards.push({
			id: callId,
			kind: "relay",
			roomId: room.id,
			...(typeof room.name === "string" && room.name !== "" ? { roomName: room.name } : {}),
			members: Array.isArray(saved.result?.passed) ? (saved.result?.passed?.map(String) ?? []) : [],
			status: interrupted
				? "stopped"
				: saved.state === "failed"
					? "failed"
					: saved.state === "done"
						? saved.result?.failed !== undefined && saved.result.failed.length > 0
							? "partial"
							: "completed"
						: "running",
			statusAt: Number(saved.at ?? 0),
			results: [],
			delivery: saved.state === "failed" ? "abandoned" : saved.state === "done" ? "delivered" : "open",
			...(typeof saved.error === "string" && saved.error !== "" ? { error: saved.error } : {}),
			...(interrupted ? { reason: "The call was interrupted by a restart and was not run again." } : {}),
		});
	}
	return cards;
};

// What the group is waiting on the user for: an open question in its chat, or an approval
// a member's turn is holding. It is a task card of its own, not a note on another one.
const pendingOfRoom = (rt: Runtime, room: GroupRoom): TaskCardView | undefined => {
	const state = rt.state as Record<string, any>;
	const roomSession = rt.sessionOfRoom(room as unknown as Parameters<Runtime["sessionOfRoom"]>[0]) ?? "";
	const sessions = new Set<string>([room.id, roomSession]);
	for (const member of room.members ?? []) {
		const memberSession = room.sessions?.[member];
		if (typeof memberSession === "string") sessions.add(memberSession);
		const ownChat = rt.chatOf?.(member);
		if (typeof ownChat === "string" && rt.groupOwners?.get(ownChat)?.roomId === room.id) sessions.add(ownChat);
	}
	const waiting: string[] = [];
	for (const [sessionId, question] of Object.entries((state?.questions ?? {}) as Record<string, any>)) {
		if (!sessions.has(sessionId) || question === null || typeof question !== "object") continue;
		waiting.push(String(question.question ?? question.title ?? "A question"));
	}
	for (const approval of (rt.approvalsView?.() ?? []) as Array<Record<string, any>>) {
		if (String(approval.roomId ?? "") !== room.id) continue;
		waiting.push(String(approval.reason ?? approval.tool ?? approval.title ?? "An approval"));
	}
	if (waiting.length === 0) return undefined;
	return {
		id: `pending:${room.id}`,
		kind: "pending",
		roomId: room.id,
		...(typeof room.name === "string" && room.name !== "" ? { roomName: room.name } : {}),
		members: [],
		status: "waiting_user",
		statusAt: Date.now(),
		results: [],
		delivery: "pending",
		result: waiting[0],
		...(waiting.length > 1 ? { summary: `${waiting.length} items are waiting for you` } : {}),
	};
};

/** Every group task the user may want to check, newest first. */
export const tasksViewOf = (rt: Runtime): TaskCardView[] => {
	const state = rt.state as Record<string, any>;
	const rooms = (state?.rooms ?? {}) as Record<string, GroupRoom>;
	const cards: TaskCardView[] = [];
	for (const room of Object.values(rooms)) {
		if (room === null || typeof room !== "object") continue;
		cards.push(...cardsOfRoom(room));
		const pending = pendingOfRoom(rt, room);
		if (pending !== undefined) cards.push(pending);
	}
	return cards.sort((a, b) => b.statusAt - a.statusAt);
};

/** Install the read-only view on the runtime. */
export const installTasksView = (rt: Runtime): void => {
	(rt as unknown as Record<string, unknown>).tasksView = () => tasksViewOf(rt);
};
