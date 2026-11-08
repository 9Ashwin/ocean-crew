// Group goals: one outcome the whole group works toward, checked stage by stage.
// The state lives on the room (room.goal, archived into room.pastGoals), the admin
// runs it with the group_goal tool, the user steers it from the goal endpoints, and
// the relay wakes the admin when nothing runs and the goal is not done.
//

// stage passes only when every required task has a result for the goal's current
// objective revision (a `reported` status is not a pass), optional tasks need an
// explicit waiver, and an older revision's result never passes a newer plan. The goal
// carries a small optional budget so an unbounded string of idle checks stops instead
// of burning turns; the group round engine reports its spend through the same hooks.

import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Room } from "../../shared/state.ts";
import { GOAL_IDLE_NUDGES, SOURCE_KIND } from "../core/constants.ts";
import type { Runtime, TeamTool } from "../core/runtime.ts";
import { headOf } from "../core/text.ts";

const TITLE_MAX = 80;
const BRIEF_MAX = 2000;
const TEXT_MAX = 2000;
const RULE_MAX = 300;
const RULES_MAX = 20;
const STAGES_MAX = 20;
const STAGE_TITLE_MAX = 80;
const STAGE_ACCEPTANCE_MAX = 1000;
const TASK_ACCEPTANCE_MAX = 500;
const TASKS_MAX = 12;
const TASK_MAX = 500;
const NOTE_MAX = 300;
const REASON_MAX = 300;
const FEEDBACK_MAX = 1000;
const EVENT_TEXT_MAX = 300;
const EVENTS_MAX = 50;
const PAST_MAX = 5;
const WAIVERS_MAX = 12;

export type GoalStatus = "drafting" | "active" | "paused" | "complete" | "stopped";
export type GoalTaskStatus = "pending" | "working" | "reported" | "done" | "failed" | "unknown";

// The result a member reported for a task, stamped with the goal's objective revision
// at the time: a revise makes an older result stale instead of silently passing.
export interface GoalTaskResult {
	status: GoalTaskStatus;
	evidence?: string;
	at: number;
	revision: number;
}

// An explicit waiver of an optional task: who decided, why, and which task.
export interface GoalTaskWaiver {
	by: string;
	reason: string;
	at: number;
}

export interface GoalTask {
	id: string;
	botId: string;
	task: string;
	status: GoalTaskStatus;
	required: boolean;
	acceptance?: string;
	note?: string;
	result?: GoalTaskResult;
	waiver?: GoalTaskWaiver;
}

export interface GoalStage {
	id: string;
	title: string;
	acceptance: string;
	status: "active" | "pending" | "passed";
	tasks: GoalTask[];
	reworks: number;
	feedback?: string;
	evidence?: string;
	passedAt?: number;
	waivers?: GoalTaskWaiver[];
}

export interface GoalEvent {
	at: number;
	kind: string;
	by: string;
	text?: string;
	stage?: string;
	[key: string]: unknown;
}

// A bounded goal: at most `maxChecks` idle checks, and no work past `deadline`.
export interface GoalBudget {
	maxChecks?: number;
	deadline?: number;
}

export interface Goal {
	id: string;
	revision: number;
	/** Bumped by start and every revise: results of an older revision do not pass. */
	objectiveRevision: number;
	status: GoalStatus;
	title: string;
	brief?: string;
	objective: string;
	acceptance: string;
	constraints: string[];
	stages: GoalStage[];
	current: number;
	nudges: number;
	by: string;
	createdAt: number;
	updatedAt: number;
	events: GoalEvent[];
	counter: { stage: number; task: number };
	startedAt?: number;
	endedAt?: number;
	summary?: string;
	evidence?: string;
	reason?: string;
	pausedBy?: string;
	idle?: boolean;
	waiting?: "budget";
	budget?: GoalBudget;
	spent?: { checks: number };
}

// A room as this module stores it; shared/state.ts still types `goal` loosely. The
// group module hands its own Room here; the cast is kept in `asGoalRoom`.
interface GoalRoom {
	id: string;
	name: string;
	members: string[];
	goal?: Goal;
	pastGoals?: Goal[];
	[key: string]: unknown;
}
const asGoalRoom = (room: Room): GoalRoom => room as unknown as GoalRoom;

export const TASK_LABEL: Record<GoalTaskStatus, string> = {
	pending: "not started",
	working: "working",
	reported: "reported",
	done: "done",
	failed: "failed",
	unknown: "unknown",
};

const goalId = (): string => `goal-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

// message type does not model; delivery.ts casts createUserMessage the same way.
interface RelayMessageInput {
	content: Array<{ type: "text"; text: string }>;
	source: Record<string, unknown>;
}
const createRelayMessage = createUserMessage as unknown as (input: RelayMessageInput) => unknown;

const tooLong = (what: string, max: number): string => `${what} is too long: at most ${max}.`;
const tooMany = (what: string, max: number): string => `At most ${max} ${what}.`;
const required = (field: string, action: string): string => `${field} is required for ${action}.`;
interface NamedRoom {
	name: string;
}
const noGoal = (room: NamedRoom): string => `"${room.name}" has no goal. Start one with group_goal draft or start.`;
const wrongState = (room: NamedRoom, goal: Goal, action: string, allowed: string): string =>
	`The goal of "${room.name}" is ${goal.status}; ${action} needs it to be ${allowed}.`;
const pausedRun = (room: NamedRoom): string =>
	`The goal of "${room.name}" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.`;
const allPassed = (room: NamedRoom): string =>
	`Every stage of "${room.name}" has passed. Call group_goal complete with the evidence and a summary.`;

// The goal's own stamp on every change: a new revision the client polls, the change in
// its event list, and the idle bookkeeping reset.
export function touchGoal(
	goal: Goal,
	event: { kind: string; by: string; text?: string; stage?: string; [key: string]: unknown } | undefined,
	now = Date.now(),
	{ keepNudges = false }: { keepNudges?: boolean } = {},
): void {
	goal.revision += 1;
	goal.updatedAt = now;
	if (!keepNudges) {
		goal.nudges = 0;
		delete goal.idle;
	}
	if (event !== undefined) goal.events = [...(goal.events ?? []), { at: now, ...event }].slice(-EVENTS_MAX);
}

export function archiveGoal(room: GoalRoom): void {
	const goal = room.goal;
	if (goal === undefined) return;
	room.pastGoals = [...(room.pastGoals ?? []), goal].slice(-PAST_MAX);
	delete room.goal;
}

function newGoal(
	{
		brief = "",
		title,
		by = "user",
		event = "draft",
	}: { brief?: string; title?: string; by?: string; event?: string } = {},
	now: number,
): Goal {
	const text = String(brief).trim();
	const goal: Goal = {
		id: goalId(),
		revision: 0,
		objectiveRevision: 0,
		status: "drafting",
		title: (title !== undefined && String(title).trim() !== "" ? String(title).trim() : text.split("\n")[0]).slice(
			0,
			TITLE_MAX,
		),
		...(text !== "" ? { brief: text.slice(0, BRIEF_MAX) } : {}),
		objective: "",
		acceptance: "",
		constraints: [],
		stages: [],
		current: -1,
		nudges: 0,
		by,
		createdAt: now,
		updatedAt: now,
		events: [],
		// Stage and task ids are never reused inside a goal, not even by a revise that
		// drops the stages they were on.
		counter: { stage: 0, task: 0 },
	};
	if (event !== undefined) touchGoal(goal, { kind: event, by }, now);
	return goal;
}

// One task as the tool asks for it.
export interface StageInput {
	title?: unknown;
	acceptance?: unknown;
	tasks?: unknown;
}

interface TaskInput {
	bot?: unknown;
	task?: unknown;
	required?: unknown;
	acceptance?: unknown;
}

interface CleanStage {
	title: string;
	acceptance: string;
	tasks: Array<{ botId: string; task: string; required: boolean; acceptance?: string }>;
}

type Cleaned<T> = T | { error: string };

// What every task's Bot must be: a current member, named exactly. `memberOf` resolves a
// name to the member or undefined; `memberNames` is for the refusal.
function cleanStages(
	room: NamedRoom,
	list: unknown,
	action: string,
	memberOf: (name: string) => { id: string } | undefined,
	memberNames: string[],
): Cleaned<{ stages: CleanStage[] }> {
	if (!Array.isArray(list) || list.length === 0) return { error: required("stages", action) };
	if (list.length > STAGES_MAX) return { error: tooMany("stages", STAGES_MAX) };
	const stages: CleanStage[] = [];
	for (const [index, raw] of list.entries()) {
		const item = (raw ?? {}) as StageInput;
		const n = index + 1;
		const title = String(item.title ?? "").trim();
		if (title === "") return { error: required(`stage ${n} title`, action) };
		if (title.length > STAGE_TITLE_MAX) return { error: tooLong(`stage ${n} title`, STAGE_TITLE_MAX) };
		const acceptance = String(item.acceptance ?? "").trim();
		if (acceptance === "") return { error: required(`stage ${n} acceptance`, action) };
		if (acceptance.length > STAGE_ACCEPTANCE_MAX)
			return { error: tooLong(`stage ${n} acceptance`, STAGE_ACCEPTANCE_MAX) };
		const items = Array.isArray(item.tasks) ? (item.tasks as TaskInput[]) : [];
		if (items.length === 0) return { error: required(`stage ${n} tasks`, action) };
		if (items.length > TASKS_MAX) return { error: tooMany(`tasks in stage ${n}`, TASKS_MAX) };
		const tasks: CleanStage["tasks"] = [];
		for (const entry of items) {
			const name = String(entry?.bot ?? "").trim();
			const task = String(entry?.task ?? "").trim();
			if (task === "") return { error: required(`a task of stage ${n}`, action) };
			if (task.length > TASK_MAX) return { error: tooLong(`a task in stage ${n}`, TASK_MAX) };
			const perTask = String(entry?.acceptance ?? "").trim();
			if (perTask.length > TASK_ACCEPTANCE_MAX)
				return { error: tooLong(`a task's acceptance in stage ${n}`, TASK_ACCEPTANCE_MAX) };
			const bot = memberOf(name);
			if (bot === undefined)
				return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(", ")}.` };
			tasks.push({
				botId: bot.id,
				task,
				required: entry?.required !== false,
				...(perTask !== "" ? { acceptance: perTask } : {}),
			});
		}
		stages.push({ title, acceptance, tasks });
	}
	return { stages };
}

function cleanConstraints(list: unknown, action: string): Cleaned<{ constraints: string[] }> {
	if (list === undefined) return { constraints: [] };
	if (!Array.isArray(list)) return { error: required("constraints", action) };
	if (list.length > RULES_MAX) return { error: tooMany("constraints", RULES_MAX) };
	const constraints: string[] = [];
	for (const item of list) {
		const text = String(item ?? "").trim();
		if (text === "") continue;
		if (text.length > RULE_MAX) return { error: tooLong("a constraint", RULE_MAX) };
		constraints.push(text);
	}
	return { constraints };
}

function cleanFields(input: Record<string, unknown>, fields: Array<[string, number]>): { error?: string } {
	for (const [field, max] of fields) {
		const value = input[field];
		if (value === undefined) continue;
		if (String(value).trim().length > max) return { error: tooLong(field, max) };
	}
	return {};
}

function cleanBudgetObject(input: unknown): Cleaned<GoalBudget | undefined> {
	if (input === undefined) return undefined;
	if (input === null || typeof input !== "object" || Array.isArray(input))
		return { error: "budget must be an object." };
	const raw = input as { maxChecks?: unknown; deadline?: unknown };
	const budget: GoalBudget = {};
	if (raw.maxChecks !== undefined) {
		const maxChecks = Number(raw.maxChecks);
		if (!Number.isInteger(maxChecks) || maxChecks < 1)
			return { error: "budget.maxChecks must be a positive whole number." };
		budget.maxChecks = maxChecks;
	}
	if (raw.deadline !== undefined) {
		const deadline = Number(raw.deadline);
		if (!Number.isFinite(deadline) || deadline <= Date.now())
			return { error: "budget.deadline must be a future epoch-millisecond timestamp." };
		budget.deadline = deadline;
	}
	return Object.keys(budget).length > 0 ? budget : undefined;
}

// A cleaned stage becomes a stored one: fresh ids, tasks pending unless the same member
// had the same task in the stage this one replaces (a revise keeps it).
function buildStage(goal: Goal, stage: CleanStage, status: "active" | "pending", previous?: GoalStage): GoalStage {
	const built: GoalStage = {
		id: `s${++goal.counter.stage}`,
		title: stage.title,
		acceptance: stage.acceptance,
		status,
		tasks: stage.tasks.map((task) => {
			const kept = previous?.tasks.find((old) => old.botId === task.botId && old.task === task.task);
			return {
				id: `t${++goal.counter.task}`,
				botId: task.botId,
				task: task.task,
				required: task.required,
				...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
				status: kept?.status ?? "pending",
				// A kept result is kept, but it still names the revision it was reported
				// under: a revise makes it stale instead of a pass.
				...(kept?.result !== undefined ? { result: kept.result } : {}),
			};
		}),
		reworks: 0,
	};
	return built;
}

export function draftGoal(
	room: GoalRoom,
	{ brief = "", title, by = "user" }: { brief?: unknown; title?: unknown; by?: string } = {},
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal !== undefined && (goal.status === "active" || goal.status === "paused"))
		return { error: wrongState(room, goal, "draft", "new or drafting") };
	const text = String(brief ?? "").trim();
	if (text === "") return { error: required("brief", "draft") };
	if (text.length > BRIEF_MAX) return { error: tooLong("brief", BRIEF_MAX) };
	const cut = cleanFields({ title }, [["title", TITLE_MAX]]);
	if (cut.error !== undefined) return { error: cut.error };
	if (goal?.status === "complete" || goal?.status === "stopped") archiveGoal(room);
	const drafting = room.goal?.status === "drafting" ? room.goal : undefined;
	if (drafting !== undefined) {
		drafting.brief = text;
		drafting.title = (
			title !== undefined && String(title).trim() !== "" ? String(title).trim() : text.split("\n")[0]
		).slice(0, TITLE_MAX);
		touchGoal(drafting, { kind: "draft", by, text: headOf(text, EVENT_TEXT_MAX) }, now);
		return { goal: drafting, reply: { event: "draft", title: drafting.title, count: drafting.stages.length } };
	}
	const next = newGoal({ brief: text, title: title === undefined ? undefined : String(title), by }, now);
	room.goal = next;
	return { goal: next, reply: { event: "draft", title: next.title, count: 0 } };
}

export function startGoal(
	room: GoalRoom,
	input: Record<string, unknown>,
	by: string,
	memberOf: (name: string) => { id: string } | undefined,
	memberNames: string[],
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal !== undefined && (goal.status === "active" || goal.status === "paused"))
		return { error: wrongState(room, goal, "start", "new or drafting") };
	const objective = String(input.objective ?? "").trim();
	if (objective === "") return { error: required("objective", "start") };
	const acceptance = String(input.acceptance ?? "").trim();
	if (acceptance === "") return { error: required("acceptance", "start") };
	const cut = cleanFields(input, [
		["objective", TEXT_MAX],
		["acceptance", TEXT_MAX],
		["title", TITLE_MAX],
	]);
	if (cut.error !== undefined) return { error: cut.error };
	const rules = cleanConstraints(input.constraints, "start");
	if ("error" in rules) return { error: rules.error };
	const cleaned = cleanStages(room, input.stages, "start", memberOf, memberNames);
	if ("error" in cleaned) return { error: cleaned.error };
	const budgetInput = input.budget === undefined ? undefined : cleanBudgetObject(input.budget);
	if (budgetInput !== undefined && "error" in budgetInput) return { error: budgetInput.error };
	const budget = budgetInput as GoalBudget | undefined;
	if (goal?.status === "complete" || goal?.status === "stopped") archiveGoal(room);
	const draft = room.goal?.status === "drafting" ? room.goal : undefined;
	const next = draft ?? newGoal({ by, event: "draft" }, now);
	if (draft === undefined) room.goal = next;
	next.status = "active";
	next.objective = objective;
	next.acceptance = acceptance;
	next.constraints = rules.constraints;
	next.title = String(input.title ?? "").trim() || next.title || objective.split("\n")[0].slice(0, TITLE_MAX);
	delete next.brief;
	next.stages = cleaned.stages.map((stage, index) => buildStage(next, stage, index === 0 ? "active" : "pending"));
	next.current = 0;
	next.objectiveRevision = 1;
	next.startedAt = now;
	if (budget === undefined) delete next.budget;
	else next.budget = budget;
	next.spent = { checks: 0 };
	delete next.waiting;
	delete next.endedAt;
	delete next.summary;
	delete next.evidence;
	delete next.reason;
	delete next.pausedBy;
	touchGoal(next, { kind: "start", by }, now);
	return {
		goal: next,
		reply: { event: "start", title: next.title, stage: 1, count: next.stages.length, next: next.stages[0].title },
	};
}

export function reviseGoal(
	room: GoalRoom,
	input: Record<string, unknown>,
	by: string,
	memberOf: (name: string) => { id: string } | undefined,
	memberNames: string[],
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status !== "active" && goal.status !== "paused")
		return { error: wrongState(room, goal, "revise", "active or paused") };
	const reason = String(input.reason ?? "").trim();
	if (reason === "") return { error: required("reason", "revise") };
	if (reason.length > FEEDBACK_MAX) return { error: tooLong("reason", FEEDBACK_MAX) };
	const cut = cleanFields(input, [
		["title", TITLE_MAX],
		["objective", TEXT_MAX],
		["acceptance", TEXT_MAX],
	]);
	if (cut.error !== undefined) return { error: cut.error };
	if (input.objective !== undefined && String(input.objective).trim() === "")
		return { error: required("objective", "revise") };
	if (input.acceptance !== undefined && String(input.acceptance).trim() === "")
		return { error: required("acceptance", "revise") };
	const rules = cleanConstraints(input.constraints, "revise");
	if ("error" in rules) return { error: rules.error };
	// Everything validates before anything changes: a refused revise leaves the goal as it was.
	let cleaned: CleanStage[] | undefined;
	let keep: GoalStage[] = [];
	if (input.stages !== undefined) {
		const result = cleanStages(room, input.stages, "revise", memberOf, memberNames);
		if ("error" in result) return { error: result.error };
		cleaned = result.stages;
		keep = goal.stages.slice(0, Math.max(0, goal.current));
		if (keep.length + cleaned.length > STAGES_MAX) return { error: tooMany("stages", STAGES_MAX) };
	}
	if (input.title !== undefined && String(input.title).trim() !== "") goal.title = String(input.title).trim();
	if (input.objective !== undefined) goal.objective = String(input.objective).trim();
	if (input.acceptance !== undefined) goal.acceptance = String(input.acceptance).trim();
	if (rules.constraints.length > 0 || input.constraints !== undefined) goal.constraints = rules.constraints;
	if (cleaned !== undefined) {
		const previous = goal.stages[goal.current];
		const replacement = cleaned.map((stage, index) => {
			const position = keep.length + index;
			return buildStage(
				goal,
				stage,
				position === goal.current ? "active" : "pending",
				position === goal.current ? previous : undefined,
			);
		});
		goal.stages = [...keep, ...replacement];
	}
	// The plan moved: results reported under the old one are stale, never a pass.
	goal.objectiveRevision += 1;
	delete goal.waiting;
	touchGoal(goal, { kind: "revise", by, text: headOf(reason, EVENT_TEXT_MAX) }, now);
	return { goal, reply: { event: "revise", title: goal.title, count: goal.stages.length, text: reason } };
}

export function taskGoal(
	room: GoalRoom,
	input: Record<string, unknown>,
	by: string,
	memberOf: (name: string) => { id: string } | undefined,
	memberNames: string[],
	now = Date.now(),
): { goal?: Goal; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status !== "active") return { error: wrongState(room, goal, "task", "active") };
	const number = input.stage === undefined ? goal.current + 1 : Number(input.stage);
	const stage = Number.isInteger(number) ? goal.stages[number - 1] : undefined;
	if (stage === undefined) return { error: `The goal of "${room.name}" has no stage ${number}.` };
	const name = String(input.bot ?? "").trim();
	if (name === "") return { error: required("bot", "task") };
	const bot = memberOf(name);
	if (bot === undefined)
		return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(", ")}.` };
	const task = stage.tasks.find((item) => item.botId === bot.id);
	if (task === undefined) return { error: `${name} has no task in stage ${number} of "${room.name}".` };
	const status = input.status === undefined ? undefined : (String(input.status) as GoalTaskStatus);
	const note = input.note === undefined ? undefined : String(input.note).trim();
	const evidence = input.evidence === undefined ? undefined : String(input.evidence).trim();
	if (status === undefined && note === undefined && evidence === undefined)
		return { error: required("status or note", "task") };
	if (note !== undefined && note.length > NOTE_MAX) return { error: tooLong("note", NOTE_MAX) };
	if (evidence !== undefined && evidence.length > TEXT_MAX) return { error: tooLong("evidence", TEXT_MAX) };
	if (status !== undefined) {
		task.status = status;
		if (status === "pending") delete task.result;
		else
			task.result = {
				status,
				...(evidence !== undefined && evidence !== ""
					? { evidence }
					: task.result?.evidence !== undefined
						? { evidence: task.result.evidence }
						: {}),
				at: now,
				revision: goal.objectiveRevision,
			};
	}
	if (evidence !== undefined) {
		if (evidence === "") {
			if (task.result !== undefined) delete task.result.evidence;
		} else {
			task.result = {
				status: task.result?.status ?? (task.status === "pending" ? "reported" : task.status),
				evidence,
				at: now,
				revision: goal.objectiveRevision,
			};
		}
	}
	if (note !== undefined) {
		if (note === "") delete task.note;
		else task.note = note;
	}
	touchGoal(
		goal,
		{ kind: "task", by, stage: stage.id, text: headOf(note ?? evidence ?? status ?? "", EVENT_TEXT_MAX) },
		now,
		{ keepNudges: true },
	);
	return { goal };
}

// The tasks of one stage that keep it from passing, with the reason for each.
function stageProblem(
	goal: Goal,
	nameOf: (id: string) => string,
	planned: ReadonlySet<string> = new Set(),
): string | undefined {
	const stage = goal.stages[goal.current];
	if (stage === undefined) return undefined;
	const names = (task: GoalTask): string => nameOf(task.botId);
	for (const task of stage.tasks) {
		const who = `${names(task)}'s task "${task.task}"`;
		const passedByResult =
			task.result !== undefined && (task.result.status === "reported" || task.result.status === "done");
		if (!task.required) {
			if (task.waiver !== undefined || planned.has(task.id) || passedByResult) continue;
			return `Optional task ${who} is not reported; pass it, or waive it with a reason in group_goal pass.`;
		}
		if (task.result === undefined || !passedByResult) {
			if (task.result !== undefined && (task.result.status === "failed" || task.result.status === "unknown"))
				return `${who} is ${task.result.status}; it cannot pass the stage.`;
			return `${who} has not been reported yet; it cannot pass the stage.`;
		}
		if (task.result.revision !== goal.objectiveRevision)
			return `${who} was reported for an older version of the goal; have it reported again.`;
		if (task.result.status === "failed" || task.result.status === "unknown")
			return `${who} is ${task.result.status}; it cannot pass the stage.`;
		if (task.acceptance !== undefined && (task.result.evidence ?? "").trim() === "")
			return `${who} needs its evidence before the stage can pass.`;
	}
	return undefined;
}

// `waivers` is the explicit waiver input of a pass: [{bot, reason}, ...], optional tasks only.
// The explicit waivers of a pass, validated but not yet written: [{bot, reason}, ...],
// optional tasks only. A required task being waived is refused here, before the pass
// could otherwise succeed on its other tasks.
function waiverPlan(
	goal: Goal,
	input: Record<string, unknown>,
	by: string,
	memberOf: (name: string) => { id: string } | undefined,
	now: number,
): { plan: Array<{ task: GoalTask; waiver: GoalTaskWaiver }>; error?: string } {
	if (input.waiver === undefined) return { plan: [] };
	const list = Array.isArray(input.waiver) ? input.waiver : [input.waiver];
	if (list.length > WAIVERS_MAX) return { plan: [], error: tooMany("waivers", WAIVERS_MAX) };
	const stage = goal.stages[goal.current];
	if (stage === undefined) return { plan: [], error: allPassed({ name: "" }) };
	const plan: Array<{ task: GoalTask; waiver: GoalTaskWaiver }> = [];
	for (const raw of list) {
		const entry = (raw ?? {}) as { bot?: unknown; taskId?: unknown; reason?: unknown };
		const reason = String(entry.reason ?? "").trim();
		if (reason === "") return { plan: [], error: required("reason", "a waiver") };
		if (reason.length > REASON_MAX) return { plan: [], error: tooLong("reason", REASON_MAX) };
		let task: GoalTask | undefined;
		if (entry.taskId !== undefined) task = stage.tasks.find((item) => item.id === String(entry.taskId));
		else {
			const name = String(entry.bot ?? "").trim();
			if (name === "") return { plan: [], error: required("bot", "a waiver") };
			const bot = memberOf(name);
			if (bot === undefined) return { plan: [], error: `${name} is not a member of the room.` };
			task = stage.tasks.find((item) => item.botId === bot.id);
		}
		if (task === undefined) return { plan: [], error: "That waiver names no task of the current stage." };
		if (task.required)
			return {
				plan: [],
				error: `The task "${task.task}" is required; it cannot be waived. Have it reported instead.`,
			};
		plan.push({ task, waiver: { by, reason, at: now } });
	}
	return { plan };
}

export function passGoal(
	room: GoalRoom,
	input: Record<string, unknown>,
	by: string,
	now = Date.now(),
	nameOf: (id: string) => string = (id) => id,
	memberOf: (name: string) => { id: string } | undefined = () => undefined,
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status === "paused") return { error: pausedRun(room) };
	if (goal.status !== "active") return { error: wrongState(room, goal, "pass", "active") };
	const stage = goal.stages[goal.current];
	if (stage === undefined) return { error: allPassed(room) };
	const evidence = String(input.evidence ?? "").trim();
	if (evidence === "") return { error: required("evidence", "pass") };
	if (evidence.length > TEXT_MAX) return { error: tooLong("evidence", TEXT_MAX) };
	// Evidence-based acceptance: every required task needs a result for the current
	// objective revision, and a task with its own acceptance needs its evidence.
	const waiver = waiverPlan(goal, input, by, memberOf, now);
	if (waiver.error !== undefined) return { error: waiver.error };
	const problem = stageProblem(goal, nameOf, new Set(waiver.plan.map((entry) => entry.task.id)));
	if (problem !== undefined) return { error: problem };
	for (const entry of waiver.plan) entry.task.waiver = entry.waiver;
	stage.status = "passed";
	stage.evidence = evidence;
	stage.passedAt = now;
	if (waiver.plan.length > 0) stage.waivers = waiver.plan.map((entry) => entry.waiver);
	for (const task of stage.tasks) {
		task.status = "done";
		delete task.waiver;
	}
	goal.current += 1;
	const next = goal.stages[goal.current];
	if (next !== undefined) next.status = "active";
	touchGoal(goal, { kind: "pass", by, stage: stage.id, text: headOf(evidence, EVENT_TEXT_MAX) }, now);
	return {
		goal,
		reply: {
			event: "pass",
			title: goal.title,
			stage: goal.current,
			count: goal.stages.length,
			...(next !== undefined ? { next: next.title } : {}),
			text: evidence,
		},
	};
}

export function reworkGoal(
	room: GoalRoom,
	input: Record<string, unknown>,
	by: string,
	memberOf: (name: string) => { id: string } | undefined,
	memberNames: string[],
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status === "paused") return { error: pausedRun(room) };
	if (goal.status !== "active") return { error: wrongState(room, goal, "rework", "active") };
	const stage = goal.stages[goal.current];
	if (stage === undefined) return { error: allPassed(room) };
	const reason = String(input.reason ?? "").trim();
	if (reason === "") return { error: required("reason", "rework") };
	if (reason.length > FEEDBACK_MAX) return { error: tooLong("reason", FEEDBACK_MAX) };
	let only: { id: string } | undefined;
	if (input.bot !== undefined && String(input.bot).trim() !== "") {
		const name = String(input.bot).trim();
		only = memberOf(name);
		if (only === undefined)
			return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(", ")}.` };
	}
	for (const task of stage.tasks) {
		if (only !== undefined && task.botId !== only.id) continue;
		task.status = "pending";
		delete task.note;
		delete task.result;
		delete task.waiver;
	}
	stage.reworks += 1;
	stage.feedback = reason;
	touchGoal(goal, { kind: "rework", by, stage: stage.id, text: headOf(reason, EVENT_TEXT_MAX) }, now);
	return {
		goal,
		reply: { event: "rework", title: goal.title, stage: goal.current + 1, count: goal.stages.length, text: reason },
	};
}

export function completeGoal(
	room: GoalRoom,
	input: Record<string, unknown>,
	by: string,
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status === "paused") return { error: pausedRun(room) };
	if (goal.status !== "active") return { error: wrongState(room, goal, "complete", "active") };
	const open = goal.stages.findIndex((stage) => stage.status !== "passed");
	if (open !== -1)
		return {
			error: `Stage ${open + 1} "${goal.stages[open].title}" has not passed yet. Pass every stage before complete.`,
		};
	const evidence = String(input.evidence ?? "").trim();
	if (evidence === "") return { error: required("evidence", "complete") };
	if (evidence.length > TEXT_MAX) return { error: tooLong("evidence", TEXT_MAX) };
	const summary = String(input.summary ?? "").trim();
	if (summary === "") return { error: required("summary", "complete") };
	if (summary.length > TEXT_MAX) return { error: tooLong("summary", TEXT_MAX) };
	goal.status = "complete";
	goal.summary = summary;
	goal.evidence = evidence;
	goal.endedAt = now;
	touchGoal(goal, { kind: "complete", by }, now);
	return { goal, reply: { event: "complete", title: goal.title, count: goal.stages.length, text: summary } };
}

export function pauseGoal(
	room: GoalRoom,
	by: string,
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status !== "active") return { error: wrongState(room, goal, "pause", "active") };
	goal.status = "paused";
	goal.pausedBy = by;
	touchGoal(goal, { kind: "pause", by }, now);
	return { goal, reply: { event: "pause", title: goal.title, count: goal.stages.length } };
}

export function resumeGoal(
	room: GoalRoom,
	by: string,
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (goal.status !== "paused") return { error: wrongState(room, goal, "resume", "paused") };
	goal.status = "active";
	delete goal.pausedBy;
	// A user resume opens a fresh budget window: the goal waits for the user, not for
	// a counter that ran out before they looked.
	delete goal.waiting;
	goal.spent = { checks: 0 };
	touchGoal(goal, { kind: "resume", by }, now);
	return { goal, reply: { event: "resume", title: goal.title, count: goal.stages.length } };
}

export function stopGoal(
	room: GoalRoom,
	reason: unknown,
	by: string,
	now = Date.now(),
): { goal?: Goal; reply?: Record<string, unknown>; error?: string } {
	const goal = room.goal;
	if (goal === undefined) return { error: noGoal(room) };
	if (!["drafting", "active", "paused"].includes(goal.status))
		return { error: wrongState(room, goal, "stop", "drafting, active or paused") };
	const text = String(reason ?? "").trim();
	if (text === "") return { error: required("reason", "stop") };
	if (text.length > REASON_MAX) return { error: tooLong("reason", REASON_MAX) };
	goal.status = "stopped";
	goal.reason = text;
	goal.endedAt = now;
	touchGoal(goal, { kind: "stop", by, text: headOf(text, EVENT_TEXT_MAX) }, now);
	return { goal, reply: { event: "stop", title: goal.title, count: goal.stages.length, text } };
}

// The goal's budget, exhausted or not, for the driver and the ledger.
export function goalBudget(goal: Goal, now = Date.now()): { exhausted: boolean; reason?: string } {
	const budget = goal.budget;
	if (budget === undefined) return { exhausted: false };
	if (budget.deadline !== undefined && now > budget.deadline)
		return { exhausted: true, reason: "the deadline passed" };
	if (budget.maxChecks !== undefined && (goal.spent?.checks ?? 0) >= budget.maxChecks)
		return { exhausted: true, reason: `all ${budget.maxChecks} checks were used` };
	return { exhausted: false };
}

// Automatic task status, from what happens in the room rather than the tool: the admin
// calling a member moves its task to working, the member's answer moves it to reported,
// and a failure or a user stop puts it back to pending. A report is stamped with the
// goal's objective revision, so a result that arrives after a revise stays stale.
// No log line, no round reply — only a new revision.
export function markTasks(
	room: GoalRoom,
	botId: string,
	from: GoalTaskStatus,
	to: GoalTaskStatus,
	note?: string,
	now = Date.now(),
): boolean {
	const goal = room.goal;
	if (goal?.status !== "active") return false;
	const stage = goal.stages[goal.current];
	if (stage === undefined) return false;
	let changed = false;
	for (const task of stage.tasks) {
		if (task.botId !== botId || task.status !== from) continue;
		task.status = to;
		if (to === "reported" || to === "done") task.result = { status: to, at: now, revision: goal.objectiveRevision };
		else if (to === "failed" || to === "unknown")
			task.result = { status: to, at: now, revision: goal.objectiveRevision };
		else delete task.result;
		if (note === undefined) delete task.note;
		else task.note = note;
		changed = true;
	}
	if (!changed) return false;
	goal.nudges = 0;
	delete goal.idle;
	goal.revision += 1;
	goal.updatedAt = now;
	return true;
}

const DUTY_ACTIVE =
	'You run this goal. Hand each task of the current stage to its member with @Name; members you call in one message start together. When they report back, check the results against the stage\'s "done when" yourself or have a reviewing member check them. Then call group_goal pass with the evidence and hand out the next stage in the same reply, or call group_goal rework with what is missing and call the members again. Keep all work inside the objective and the rules. When the user corrects the direction, call group_goal revise first. Ask the user only for decisions you cannot make.';
const DUTY_PASSED =
	'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.';
const DUTY_PAUSED =
	"The user paused this goal. Do not hand out stage work or pass stages. Talk with the user, and write their corrections into the goal with group_goal revise. The user resumes it.";
const DUTY_BUDGET =
	"The goal used its budget of checks. Do not start more work until the user resumes it or changes the budget.";
const dutyOf = (goal: Goal): string =>
	goal.waiting === "budget"
		? DUTY_BUDGET
		: goal.status === "paused"
			? DUTY_PAUSED
			: goal.stages[goal.current] === undefined
				? DUTY_PASSED
				: DUTY_ACTIVE;

const DUTY_DRAFT = [
	"Align with the user before you write it, following the goal-grill skill:",
	"1. Find the facts yourself (files, code, records) or ask members with @Name. Never ask the user what you can look up.",
	'2. List the decisions only the user can make. Ask them in one message, numbered, each with your recommended answer, so the user can reply "as recommended". Skip this when nothing is open.',
	"3. Then call group_goal start: the objective, how to check it is done (commands, tests, files, evidence), the rules to keep, and the stages in order, each with its own check and its tasks for named members.",
].join("\n");
const NUDGE_LINE =
	"Goal check from Ocean Crew: nothing is running in this group and the goal is not finished. Take the next step now: hand out the current stage's tasks that are not done, check a stage whose members have reported, or complete the goal if every stage passed. If you are waiting for the user, reply [PASS].";
const RESUME_LINE = "The user resumed the goal. Take the next step now.";

// The DSH tool's string result: the same rendering tools.ts uses; it is kept private
// there, so the descriptor lives here until tools.ts exports one.
const toolOutput = {
	schema: { type: "string" as const },
	render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
		{ type: "text", text: String(value) },
	],
};

// What the round world looks like to the driver; the group module publishes these.
interface RoundView {
	roomId: string;
	slots: Array<{ id: string; status?: string; worked?: boolean }>;
	replies: Array<Record<string, unknown>>;
	stoppedOnly?: boolean;
	userMessage?: boolean;
	goalNudge?: boolean;
}

interface GoalContext {
	sessions?: { flush?(session: unknown): Promise<void> | void };
}

// A simple name resolver over a group's members.
const memberLookup =
	(rt: Runtime, room: Room) =>
	(name: string): { id: string } | undefined => {
		const bot = rt.findBot(name);
		return bot !== undefined && room.members.includes(bot.id) ? bot : undefined;
	};

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const ctxServices = ctx as unknown as GoalContext;

	const memberOf = (room: Room) => memberLookup(rt, room);
	const memberNames = (room: Room): string[] =>
		room.members.map((id) => rt.botOf(id)?.name).filter((name): name is string => name !== undefined);
	const nameOf = (id: string): string => rt.botOf(id)?.name ?? "a member";
	const roomOf = (roomId: string): Room | undefined => rt.roomOf(roomId);
	const goalIn = (room: Room | undefined): Goal | undefined =>
		room === undefined ? undefined : asGoalRoom(room).goal;

	// The admin's ledger: the whole goal, for the prompt block and the tool's answer.
	function ledgerLines(goal: Goal): string[] {
		const lines = [`Goal: ${goal.title}`, `Objective: ${goal.objective}`, `Done when: ${goal.acceptance}`];
		if (goal.constraints.length > 0) lines.push("Rules:", ...goal.constraints.map((rule) => `- ${rule}`));
		lines.push("Stages:");
		goal.stages.forEach((stage, index) => {
			const n = index + 1;
			if (stage.status === "passed") lines.push(`[passed] ${n}. ${stage.title}`);
			else if (index === goal.current) {
				lines.push(`[current] ${n}. ${stage.title} — done when: ${stage.acceptance}`);
				for (const task of stage.tasks) {
					const mark = task.required ? "" : " (optional)";
					const acceptance = task.acceptance !== undefined ? `; its check: ${task.acceptance}` : "";
					lines.push(
						`  - ${nameOf(task.botId)}: ${task.task} [${TASK_LABEL[task.status]}]${mark}${task.note ? ` — ${task.note}` : ""}${acceptance}`,
					);
				}
				if (stage.reworks > 0)
					lines.push(
						`  Sent back ${stage.reworks} ${stage.reworks === 1 ? "time" : "times"}. Latest feedback: ${stage.feedback ?? ""}`,
					);
				if (stage.waivers !== undefined && stage.waivers.length > 0)
					lines.push(`  Waived: ${stage.waivers.map((waiver) => waiver.reason).join(" / ")}`);
			} else
				lines.push(
					`[next] ${n}. ${stage.title}: ${[...new Set(stage.tasks.map((task) => nameOf(task.botId)))].join(", ")}`,
				);
		});
		const corrections = (goal.events ?? [])
			.filter((event) => event.kind === "revise" && event.text)
			.slice(-3)
			.map((event) => event.text);
		if (corrections.length > 0) lines.push(`Latest corrections from the user: ${corrections.join(" / ")}`);
		const budget = goalBudget(goal);
		if (budget.exhausted) lines.push(`Budget: ${budget.reason}; the goal waits for the user.`);
		return lines;
	}

	// A member's share of the goal: the current stage and its own task in it.
	function memberLines(goal: Goal, member: { id: string }): { lines: string[]; stage: string } {
		const count = goal.stages.length;
		const stage = goal.stages[goal.current];
		const lines = [
			`The group works toward: ${goal.title} — ${headOf(goal.objective, 600)}`,
			...(goal.constraints.length > 0 ? [`Rules: ${goal.constraints.join("; ")}`] : []),
		];
		if (stage === undefined) lines.push("Every stage passed; the admin is checking the whole goal.");
		else {
			lines.push(`Current stage ${goal.current + 1} "${stage.title}", done when: ${stage.acceptance}`);
			const tasks = stage.tasks.filter((task) => task.botId === member.id);
			if (tasks.length === 0) lines.push("You have no task in this stage.");
			else
				for (const task of tasks)
					lines.push(
						`Your task in it: ${task.task} (${TASK_LABEL[task.status]})${task.required ? "" : " [optional]"}.`,
					);
		}
		lines.push(
			"Work only toward this. When you finish your task, end your reply with the evidence: the files you changed, the commands you ran and what they printed.",
		);
		if (goal.status === "paused")
			lines.push("The goal is paused: finish only what you are doing now and start no new stage work.");
		if (goal.waiting === "budget")
			lines.push("The goal used its budget of checks; no new stage work starts until the user resumes it.");
		return { lines, stage: `${stage === undefined ? count : goal.current + 1}/${count}` };
	}

	// The <group_goal> block in every round's prompt; nudge and resume add a line after
	// it for the admin. No block at all with no goal or a finished one.
	function goalBlock(
		room: Room,
		member: { id: string },
		{ nudge = false, resume = false }: { nudge?: boolean; resume?: boolean } = {},
	): string {
		const goal = asGoalRoom(room).goal;
		if (goal === undefined || goal.status === "complete" || goal.status === "stopped") return "";
		const isAdmin = rt.isAdminOf(room, member.id);
		let block: string;
		if (goal.status === "drafting") {
			block = isAdmin
				? [
						'<group_goal status="drafting">',
						`The user wants this group to reach a goal: ${goal.brief ?? ""}`,
						DUTY_DRAFT,
						"</group_goal>",
					].join("\n")
				: [
						'<group_goal status="drafting">',
						`The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? "", 300)}. Help with facts when you are asked.`,
						"</group_goal>",
					].join("\n");
		} else if (isAdmin) {
			block = [`<group_goal status="${goal.status}">`, ...ledgerLines(goal), dutyOf(goal), "</group_goal>"].join(
				"\n",
			);
		} else {
			const view = memberLines(goal, member);
			block = [`<group_goal status="${goal.status}" stage="${view.stage}">`, ...view.lines, "</group_goal>"].join(
				"\n",
			);
		}
		if (isAdmin && nudge) block += `\n${NUDGE_LINE}`;
		if (isAdmin && resume) block += `\n${RESUME_LINE}`;
		return block;
	}

	// The tool's answer: the ledger as the caller sees it, without the block's tags.
	function goalLedger(room: Room, member: { id: string }): string {
		const goal = asGoalRoom(room).goal;
		if (goal === undefined) return noGoal(room);
		if (goal.status === "complete") return `Goal "${goal.title}" is complete.`;
		if (goal.status === "stopped") return `Goal "${goal.title}" was stopped${goal.reason ? `: ${goal.reason}` : ""}.`;
		if (goal.status === "drafting") {
			return rt.isAdminOf(room, member.id)
				? `The user wants this group to reach a goal: ${goal.brief ?? ""}`
				: `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? "", 300)}. Help with facts when you are asked.`;
		}
		if (rt.isAdminOf(room, member.id)) return ledgerLines(goal).join("\n");
		return memberLines(goal, member).lines.join("\n");
	}

	// Every non-task change is a group event: a notice in the log the members read, and
	// a goal reply in every running round of the room for the client.
	const announce = (room: Room, reply: Record<string, unknown> | undefined): void => {
		if (reply === undefined) return;
		rt.logRoom?.(room, { who: "Ocean Crew", kind: "notice", reason: "goal", ...reply });
		const rounds = (rt.roomProgress?.values?.() ?? []) as Iterable<RoundView>;
		for (const round of rounds) {
			if (round.roomId === room.id) round.replies.push({ kind: "goal", ...reply, time: Date.now() });
		}
	};

	// A goal message into the room's own Session, which relays it as a new round: the
	// user's draft request, a resume after the user continues, or an idle nudge.
	async function queueGoalRelay(room: Room, text: string, senderName = "You"): Promise<void> {
		const sessionId = rt.sessionOfRoom(room) as string;
		const agent = (await rt.resolveAgent(sessionId)) as {
			session: unknown;
			followup(message: unknown): unknown;
		};
		agent.followup(
			createRelayMessage({
				content: [{ type: "text", text }],
				source: {
					kind: SOURCE_KIND,
					form: "relay",
					role: "goal",
					goal: text.startsWith("[Goal request]")
						? "draft"
						: text.startsWith("[Goal resumed]")
							? "resume"
							: "nudge",
					goalId: asGoalRoom(room).goal?.id,
					exchangeId: randomUUID(),
					senderName,
					roomId: room.id,
				},
			}),
		);
		await ctxServices.sessions?.flush?.(agent.session);
	}

	// goal-draft { roomId, text }: the user's one-line ask opens a drafting goal.
	async function goalDraft(roomId: string, text: unknown): Promise<Record<string, unknown>> {
		const room = roomOf(roomId);
		if (room === undefined) return { error: "Unknown group chat" };
		const target = asGoalRoom(room);
		const input = String(text ?? "").trim();
		if (input === "" || input.length > BRIEF_MAX)
			return { error: "Write what this group should achieve, in at most 2000 characters.", code: "bot/invalid" };
		const admin = room.members
			.map((id) => rt.botOf(id))
			.filter((bot): bot is NonNullable<typeof bot> => bot !== undefined)
			.find((bot) => rt.isAdminOf(room, bot.id));
		if (admin === undefined) return { error: "This group has no admin. Set one in the group settings first." };
		if (target.goal !== undefined && (target.goal.status === "active" || target.goal.status === "paused"))
			return { error: "This group already has a goal. Stop it first." };
		const result = draftGoal(target, { brief: input, by: "user" });
		if (result.error !== undefined) return { error: result.error };
		announce(room, result.reply);
		await rt.save();
		await queueGoalRelay(room, `[Goal request]\n${input}`);
		return {};
	}

	// goal-control { roomId, goalId, action, stopWork? }: the user's pause, resume, stop
	// and clear from the goal panel.
	async function goalControl(roomId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const room = roomOf(roomId);
		if (room === undefined) return { error: "Unknown group chat" };
		const target = asGoalRoom(room);
		const goal = target.goal;
		if (goal === undefined || goal.id !== String(body.goalId ?? ""))
			return { error: "The goal has changed. Look again.", code: "bot/stale" };
		const action = String(body.action ?? "");
		if (action === "pause") {
			const result = pauseGoal(target, "user");
			if (result.error !== undefined) return { error: result.error };
			announce(room, result.reply);
			await rt.save();
			if (body.stopWork === true) await rt.stopRoomWork?.(room.id);
			return {};
		}
		if (action === "resume") {
			const result = resumeGoal(target, "user");
			if (result.error !== undefined) return { error: result.error };
			announce(room, result.reply);
			await rt.save();
			await queueGoalRelay(room, "[Goal resumed]");
			return {};
		}
		if (action === "stop") {
			const result = stopGoal(target, "Stopped by the user", "user");
			if (result.error !== undefined) return { error: result.error };
			announce(room, result.reply);
			await rt.save();
			await rt.stopRoomWork?.(room.id);
			return {};
		}
		if (action === "clear") {
			if (goal.status === "active" || goal.status === "paused")
				return {
					error: `The goal of "${room.name}" is ${goal.status}; clear needs it to be drafting, complete or stopped.`,
				};
			if (goal.status === "drafting") delete target.goal;
			else archiveGoal(target);
			await rt.save();
			return {};
		}
		return { error: "Nothing to do", code: "bot/invalid" };
	}

	// The idle driver: once a round ends with the goal active and nothing running, wake
	// the admin for a goal check. Progress — a user message or a member's work (the
	// admin's own tools do not count) — only resets the check count; the round still gets
	// its check. An admin that passes waits for the user, and two checks without progress
	// mark the goal idle until something happens. A budget that ran out stops the checks
	// instead: budget_wait keeps the goal and its evidence for the user.
	async function goalDrive(room: Room, round: RoundView): Promise<void> {
		const goal = asGoalRoom(room).goal;
		const admin = room.admin === undefined || room.admin === null ? undefined : rt.botOf(room.admin);
		if (
			goal === undefined ||
			goal.status !== "active" ||
			goal.idle === true ||
			admin === undefined ||
			!room.members.includes(admin.id)
		)
			return;
		// A round nobody spoke in — e.g. a stop notice or a stale check — never nudges.
		if (round.stoppedOnly === true || round.slots.length === 0) return;
		if (round.userMessage === true || round.slots.some((slot) => slot.worked === true && slot.id !== admin.id))
			goal.nudges = 0;
		if (round.goalNudge === true && round.slots.some((slot) => slot.id === admin.id && slot.status === "passed")) {
			goal.idle = true;
			goal.revision += 1;
			goal.updatedAt = Date.now();
			await rt.save();
			return;
		}
		if ((rt.workingInRoom?.(room) ?? []).length > 0) return;
		if (rt.roomBatchPending?.(room.id) === true) return;
		if (((rt.roomInbox?.get?.(room.id) as unknown[] | undefined) ?? []).length > 0) return;
		const budget = goalBudget(goal);
		if (budget.exhausted) {
			if (goal.waiting !== "budget") {
				goal.waiting = "budget";
				goal.revision += 1;
				goal.updatedAt = Date.now();
				await rt.save();
			}
			return;
		}
		if (goal.nudges >= GOAL_IDLE_NUDGES) {
			goal.idle = true;
			goal.revision += 1;
			goal.updatedAt = Date.now();
			await rt.save();
			return;
		}
		goal.nudges += 1;
		goal.spent = { checks: (goal.spent?.checks ?? 0) + 1 };
		goal.revision += 1;
		goal.updatedAt = Date.now();
		await rt.save();
		await queueGoalRelay(room, "[Goal check]", "Ocean Crew");
	}

	// Member work can outlive the round it grew out of; the round-end check then skips
	// the room, and nothing else would wake the admin when the last of it settles.
	const SETTLE_ROUND: RoundView = Object.freeze({
		roomId: "",
		stoppedOnly: false,
		slots: Object.freeze([{ id: "", worked: true }]),
		replies: [],
	}) as unknown as RoundView;

	async function goalSettled(room: Room | undefined): Promise<void> {
		if (room === undefined) return;
		const rounds = (rt.roomProgress?.values?.() ?? []) as Iterable<RoundView>;
		if ([...rounds].some((round) => round.roomId === room.id)) return;
		await goalDrive(room, { ...SETTLE_ROUND, roomId: room.id });
	}

	// The user pressed stop in the group: the goal waits for them instead of waking the
	// admin through the stop-notice round.
	const goalUserStopped = (roomId: string): void => {
		const goal = goalIn(roomOf(roomId));
		if (goal?.status !== "active") return;
		goal.idle = true;
		goal.revision += 1;
		goal.updatedAt = Date.now();
		void rt.save().catch(() => undefined);
	};

	// A user post in the room — its own message or a goal draft — brings the goal out of
	// its idle wait and resets the count of fruitless wakes.
	const goalUserMessage = (roomId: string): void => {
		const goal = goalIn(roomOf(roomId));
		if (goal === undefined || (goal.idle === undefined && goal.nudges === 0 && goal.waiting === undefined)) return;
		delete goal.idle;
		delete goal.waiting;
		goal.nudges = 0;
		goal.revision += 1;
		goal.updatedAt = Date.now();
		void rt.save().catch(() => undefined);
	};

	const mark = (roomId: string, botId: string, from: GoalTaskStatus, to: GoalTaskStatus, note?: string): void => {
		const room = roomOf(roomId);
		if (room !== undefined && markTasks(asGoalRoom(room), botId, from, to, note))
			void rt.save().catch(() => undefined);
	};

	const addTool = (definition: ReturnType<typeof defineTool>): void => {
		rt.teamTools.push(definition as unknown as TeamTool);
	};

	addTool(
		defineTool({
			name: "group_goal",
			description:
				"Set and run a group chat's goal: one outcome for the whole group, how to check it is done, and stages whose tasks go to members. Only the group's admin or a Main Bot changes it; any member can show it. Inside that group's own conversation the group is implied; elsewhere name it. A stage passes only when every required task has reported a result for the current version of the goal and the evidence checks out; optional tasks need an explicit waiver. Actions: show; draft (you are aligning the goal with the user before writing it); start (write it and begin stage 1); revise (change it when the user corrects the direction; reason required); task (set one member's task status, note or evidence); pass (the current stage meets its check; evidence required); rework (the current stage falls short; reason required); complete (every stage passed and the overall check is met; evidence and summary required); pause; resume; stop (reason required).",
			parameters: {
				group: { type: "string", description: "Exact group chat name from list_bots; leave out inside that group" },
				action: {
					type: "string",
					required: true,
					enum: [
						"show",
						"draft",
						"start",
						"revise",
						"task",
						"pass",
						"rework",
						"complete",
						"pause",
						"resume",
						"stop",
					],
					description: "What to do",
				},
				title: { type: "string", description: "Short title, up to 80 characters" },
				brief: { type: "string", description: "draft: what the user wants, in their words" },
				objective: { type: "string", description: "start, revise: the one outcome the group must reach" },
				acceptance: {
					type: "string",
					description:
						"start, revise: how to check the whole goal is done: commands or tests to run, files or results to look at, and the evidence to show",
				},
				constraints: {
					type: "array",
					items: { type: "string" },
					description:
						"start, revise: rules every member keeps, including the user's corrections. Replaces the list",
				},
				stages: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							title: { type: "string" },
							acceptance: { type: "string" },
							tasks: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										bot: { type: "string" },
										task: { type: "string" },
										required: {
											type: "boolean",
											description:
												"false for an optional task: it may be waived explicitly when the stage passes",
										},
										acceptance: {
											type: "string",
											description:
												"how this task's result is checked; its evidence is then required to pass",
										},
									},
								},
							},
						},
					},
					description:
						"start: every stage, in order. revise: replaces the current stage and every stage after it; passed stages stay. Each stage has a title, its own check (how to tell this stage is done) and its tasks, each for one member by exact name",
				},
				budget: {
					type: "object",
					additionalProperties: false,
					properties: {
						maxChecks: {
							type: "integer",
							description: "start: at most this many idle goal checks before it waits for the user",
						},
						deadline: {
							type: "integer",
							description: "start: epoch-millisecond time after which no check starts new work",
						},
					},
					description: "start: optional limits on the goal's own idle checks",
				},
				bot: {
					type: "string",
					description: "task: the member whose task changes. rework: only this member's task goes back",
				},
				stage: {
					type: "integer",
					description: "task: stage number, 1 for the first; the current stage when left out",
				},
				status: {
					type: "string",
					enum: ["pending", "working", "reported", "done", "failed", "unknown"],
					description: "task: the task's new status",
				},
				note: { type: "string", description: "task: where the task stands, in a few words" },
				evidence: {
					type: "string",
					description:
						"task: what shows this task's result; pass, complete: what shows it is done: test output, changed files, check results",
				},
				waiver: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							bot: { type: "string" },
							taskId: { type: "string" },
							reason: { type: "string" },
						},
					},
					description: "pass: explicit waivers for optional tasks that did not report, each with a reason",
				},
				reason: { type: "string", description: "revise, rework, stop: why" },
				summary: { type: "string", description: "complete: what the group delivered, for the user" },
			},
			output: toolOutput,
			async execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }) {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id) as string | undefined;
				const member = rt.botOf(self);
				if (member === undefined || self === undefined) return "Only Bots on the team can use group_goal.";
				const selfId = self;
				const action = String(args.action ?? "");
				let room = rt.roomOf(rt.groupOwners?.get(exec.agent?.id ?? "")?.roomId);
				if (room === undefined) {
					if (String(args.group ?? "").trim() === "") return required("group", action);
					const picked = rt.pickRoom(args.group, selfId) as { room?: Room; error?: string };
					if (picked.error !== undefined) return picked.error;
					room = picked.room;
				}
				if (room === undefined) return "Unknown group chat";
				const admin = room.members
					.map((id) => rt.botOf(id))
					.filter((bot): bot is NonNullable<typeof bot> => bot !== undefined)
					.find((bot) => rt.isAdminOf(room, bot.id));
				const change = action !== "show";
				if (change && !rt.isMain(selfId) && !rt.isAdminOf(room, selfId))
					return admin !== undefined
						? `Only ${admin.name}, the admin of "${room.name}", or a Main Bot changes its goal. Tell the admin in the group.`
						: `Only a Main Bot changes the goal of "${room.name}".`;
				if ((action === "draft" || action === "start") && admin === undefined)
					return `"${room.name}" has no admin, and a goal needs one to run it. Set an admin with update_group first.`;
				const of = memberOf(room);
				const names = memberNames(room);
				const target = asGoalRoom(room);
				let result: { goal?: Goal; reply?: Record<string, unknown>; error?: string };
				let next = "";
				let post: (() => Promise<void>) | undefined;
				switch (action) {
					case "show":
						return goalLedger(room, member);
					case "draft":
						result = draftGoal(target, { brief: args.brief, title: args.title, by: selfId });
						next = "Aligning. Ask the user only what is still open, then call group_goal start.";
						break;
					case "start":
						result = startGoal(target, args, selfId, of, names);
						next = "Started. Hand out the tasks of stage 1 now, with @Name in your reply.";
						break;
					case "revise":
						result = reviseGoal(target, args, selfId, of, names);
						next = "Changed. Tell the group what changed, and go on with the current stage.";
						break;
					case "task":
						result = taskGoal(target, args, selfId, of, names);
						break;
					case "pass": {
						result = passGoal(target, args, selfId, Date.now(), nameOf, of);
						const goal = result.goal;
						next =
							goal === undefined
								? ""
								: goal.stages[goal.current] !== undefined
									? `Stage ${goal.current} passed. Stage ${goal.current + 1} "${goal.stages[goal.current].title}" is current: hand out its tasks with @Name in this reply.`
									: 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.';
						break;
					}
					case "rework":
						result = reworkGoal(target, args, selfId, of, names);
						next = "Sent back. Call the members again with @Name and say what is missing.";
						break;
					case "complete":
						result = completeGoal(target, args, selfId);
						next = "Complete. Tell the user what was delivered.";
						break;
					case "pause":
						result = pauseGoal(target, selfId);
						next = "Paused. Hand out no stage work until the goal is resumed.";
						break;
					case "resume":
						result = resumeGoal(target, selfId);
						next = "Resumed. Take the next step now.";
						break;
					case "stop":
						result = stopGoal(target, args.reason, selfId);
						next = "Stopped.";
						// The caller keeps running; the other members' work stops.
						post = async () => {
							for (const id of room.members.filter((other) => other !== selfId))
								await rt.stopMemberWork?.(room.id, id);
						};
						break;
					default:
						return `Unknown action ${action}.`;
				}
				if (result.error !== undefined) return result.error;
				if (result.reply !== undefined) announce(room, result.reply);
				await rt.save();
				if (post !== undefined) await post();
				const ledger = goalLedger(room, member);
				return next === "" ? ledger : `${ledger}\n${next}`;
			},
		}),
	);

	Object.assign(rt, {
		goalBlock,
		goalLedger,
		goalDraft,
		goalControl,
		goalDrive,
		goalSettled,
		goalUserMessage,
		goalUserStopped,
		goalBudget,
		goalTaskWorking: (roomId: string, botId: string) => mark(roomId, botId, "pending", "working"),
		goalTaskReported: (roomId: string, botId: string) => mark(roomId, botId, "working", "reported"),
		goalTaskReset: (roomId: string, botId: string, note?: string) => mark(roomId, botId, "working", "pending", note),
	});
}

// The state helpers shared with other slices: a room's goal and its status, without
// reaching into the loose Room type everywhere.
export const goalOf = (room: Room | undefined): Goal | undefined =>
	room === undefined ? undefined : asGoalRoom(room).goal;
export const setGoal = (room: Room, goal: Goal | undefined): void => {
	if (goal === undefined) delete asGoalRoom(room).goal;
	else asGoalRoom(room).goal = goal;
};
export const pastGoalsOf = (room: Room | undefined): Goal[] =>
	room === undefined ? [] : (asGoalRoom(room).pastGoals ?? []);
