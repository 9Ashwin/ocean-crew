// Types the group-chat module shares across its files: the room log line, the room
// fields this module owns, a round and its replies, and the host object each installer
// fills in.
// module was one closure: the parts call each other through it at run time.

import type { BotId, BotSegment, Room, RoomId, RoomMode } from "../../shared/state.ts";
import type { Runtime } from "../core/runtime.ts";

// What one line of a group's log may carry. The saved line keeps the whole message's
// head in `text` and its length in `length`; the rest lives in group-lines/<room>/<seq>.
// `seq` is assigned by appendRoom, so a line a module creates does not carry it.
export interface GroupLine {
	seq?: number;
	length?: number;
	text?: string;
	who?: string;
	botId?: BotId;
	kind?: string;
	reason?: string;
	names?: string[];
	detail?: string;
	minutes?: number;
	limit?: number;
	path?: string;
	idle?: boolean;
	via?: string;
	images?: unknown[];
	files?: unknown[];
	event?: string;
	title?: string;
	count?: number;
	next?: string;
	stage?: number;
	again?: boolean;
	/** A late result posted after the round moved on. */
	late?: boolean;
	/** The goal revision the line's result was asked for under. */
	goalRevision?: number;
	goalId?: string;
	goalObjectiveRevision?: number;
	[key: string]: unknown;
}

// A line already appended to the log: appendRoom gives it its sequence number.
export type SavedLine = GroupLine & { seq: number };

export type SlotStatus =
	| "waiting"
	| "speaking"
	| "posted"
	| "passed"
	| "missed"
	| "working"
	| "waiting-approval"
	| "failed"
	| "left";

// One member's place in a round.
export interface Slot {
	id: string;
	name: string;
	status: SlotStatus;
	batch: number;
	order?: number;
	batchKey?: string;
	by?: string;
	note?: string;
	ordered?: boolean;
	worked?: boolean;
	fromBot?: boolean;
	/** Where the goal stood when this member was called. */
	goal?: CallGoal;
	/** The batch whose final summary this turn owes, when it was woken for one. */
	summaryBatch?: string;
}

// A reply that answer holds for the user; `kind` is absent for a member's message.
export interface RoundReply {
	kind?: string;
	botId?: string;
	name?: string;
	color?: string;
	text?: string;
	time?: number;
	duration?: number;
	code?: string;
	status?: number;
	idle?: boolean;
	count?: number;
	limit?: number;
	names?: string[];
	via?: string;
	[key: string]: unknown;
}

// A member turn the round started; a stop cancels the ones still in this list.
export interface RoundTurn {
	botId: string;
	sessionId: string;
	exchangeId: string;
}

// A Bot's post that asked for replies; the report goes back when the round ends.
export interface RoundReport {
	post: { botId: string; name: string; reportBack: boolean; sub?: string; fromRoomId?: string };
	ids: string[];
	from: number;
	/** Where the goal stood when the post called its members. */
	goal?: CallGoal;
}

// A conversation the user referenced in this round.
export interface RoundReference {
	labels?: string[];
	text: string;
}

// The rolling state of one group_relay call: its slots, replies and batch counter.
export interface Round {
	roomId: string;
	members: string[];
	startSeq: number;
	/** The group_relay call that runs this round, for replay dedupe and summary asks. */
	callId?: string;
	goalRevision?: number;
	/** Where the goal stood when the round opened. */
	goal?: CallGoal;
	userMessage?: boolean;
	kickoff?: boolean;
	goalNudge?: boolean;
	goalResume?: boolean;
	stoppedOnly?: boolean;
	references?: RoundReference[];
	shown?: string[];
	slots: Slot[];
	batches: number;
	soleAdmin?: { id: string; name: string; color?: string };
	replies: RoundReply[];
	passed: string[];
	failed: string[];
	started: RoundTurn[];
	reports?: RoundReport[];
	nudge?: () => void;
	// Normalized bodies of the Bot lines in this round, by Bot id (idle guard).
	botBodies?: Map<string, string[]>;
}

// A call the round or the idle guard holds back until the user writes.
export interface ParkedCall {
	id: string;
	name: string;
	note?: string;
	by?: string;
	idle?: boolean;
}

export interface IdlePaused {
	from: string;
	count: number;
	noticed: boolean;
}

// the group module only reads it, the goal module owns it.
export interface GoalState {
	id?: string;
	title?: string;
	status?: string;
	revision?: number;
	objectiveRevision?: number;
	stages?: unknown[];
	idle?: boolean;
	[key: string]: unknown;
}

// The room as this module uses it. shared/state.ts still types `paused`/`idlePaused`

// shapes; Omit over an interface with an index signature would drop the declared
// fields, so the room fields this module reads are written out here.
export interface GroupRoom {
	id: RoomId;
	name: string;
	members: BotId[];
	mode: RoomMode;
	admin?: BotId | null;
	named?: boolean;
	notice?: string;
	createdAt?: number;
	sessionId?: string;
	sessions?: Record<string, string>;
	segments?: Record<string, BotSegment[]>;
	parts?: BotSegment[];
	log: SavedLine[];
	seq: number;
	seen: Record<string, number>;
	paused?: ParkedCall[];
	idlePaused?: IdlePaused;
	idleRelays?: number;
	workDir?: string;
	memberDirs?: Record<string, string | null>;
	folderNotice?: string;
	permission?: string;
	pastGoals?: unknown[];
	goal?: GoalState;
	/** Call batches this room's rounds opened, by batch key, for restart recovery. */
	calls?: Record<string, SavedCallBatch>;
	/** The group_relay calls this room ran, by callId, so a replay does not run again. */
	callRuns?: Record<string, SavedRelayCall>;
	/** Goal snapshots of late results waiting to be written into the log. */
	lateGoals?: Record<string, CallGoal[]>;
	/** The room's work budget for its current scope. */
	budget?: GroupBudget;
	[key: string]: unknown;
}

// The one conversion from the saved room to this module's view of it.
export const asRoom = (room: Room): GroupRoom => room as unknown as GroupRoom;
// the fields

export const savedRoom = (room: GroupRoom): Room => room as unknown as Room;

// A model failure as it is shown in the group and the prompt.
export interface TurnFailure {
	code: string;
	message: string;
	status?: number;
	requestId?: string;
	[key: string]: unknown;
}

// What a member turn resolved to: text, a packet, or null when the round was stopped.
export type TurnResult =
	| string
	| null
	| { failure?: TurnFailure; missed?: boolean; approval?: boolean; working?: boolean };

// The waiter a member turn leaves in `rt.roomWaiters` while its Session runs.
export interface RoomWaiter {
	sessionId: string;
	botId: string;
	roomId: string;
	resolve(value: TurnResult): void;
	fail(failure: TurnFailure): void;
	touch(): void;
	work(): void;
	say(raw: string): void;
	approval(): void;
}

// A Bot-to-Bot call batch: which callees are still working for the same caller.
export interface CallBatch {
	key: string;
	roomId: string;
	by: string;
	/** Every callee the batch was opened with. */
	callees: string[];
	pending: Set<string>;
	done: string[];
	worked: boolean;
	answered: boolean;
	/** The group_relay call that opened the batch, for a replay of the same call. */
	callId?: string;
	/** Where the group's goal stood when the callees were called. */
	goal?: CallGoal;
	/** The last state saved for this batch; `open` until every callee settled. */
	state?: CallBatchState;
	/** What still has to happen after the batch: the caller's final summary. */
	summary?: CallSummary;
	/** Set when the batch ended without a usable result. */
	error?: string;
}

// Where a group's goal stood when a member was called: a later result answers the goal
// as it was at the call, not as it stands when the result is reported.
export interface CallGoal {
	id?: string;
	/** The goal card's own revision (the counter every change bumps). */
	revision?: number;
	/** The objective revision; a revise makes results of an older one stale. */
	objectiveRevision?: number;
}

// One result a batch received, kept with the batch so a restart can summarize results
// whose group line died with the process.
export interface CallResult {
	botId: string;
	name: string;
	text: string;
	at: number;
}

// A call batch as state.json keeps it, so a restart can go on or fail it clearly.
export type CallBatchState = "open" | "awaiting-summary" | "delivered" | "failed";

// The final-summary duty of a completed batch. `requested` means the caller was asked;
// `posted` means its answer reached the group, which is what the user reads.
export type SummaryState = "pending" | "requested" | "posted" | "failed";

export interface CallSummary {
	state: SummaryState;
	at?: number;
	/** The caller that owes the summary. */
	by?: string;
	/** How many times the caller was asked; a restarted host asks again. */
	attempts: number;
	/** The group_relay call that asked, so one round asks only once. */
	requestedIn?: string;
	/** The start of the summary the caller posted. */
	text?: string;
	/** Why the summary was never delivered. */
	error?: string;
}

// A call batch as state.json keeps it: the durable association between a call, its
// results, the summary it still owes and the user delivery that closes it.
export interface SavedCallBatch {
	key: string;
	roomId: string;
	callId?: string;
	by: string;
	callees: string[];
	/** Callees still working at the last save. */
	pending: string[];
	done: string[];
	worked: boolean;
	answered: boolean;
	goal?: CallGoal;
	state: CallBatchState;
	/** When the last callee settled; the batch's completion time. */
	completedAt?: number;
	createdAt: number;
	updatedAt: number;
	/** The process incarnation that last wrote the record; a different one is a restart. */
	writer?: string;
	error?: string;
	lost?: string[];
	/** What the callees handed back, latest per callee. */
	results?: CallResult[];
	/** A restart already told the group which results it recovered. */
	resultsNoted?: boolean;
	summary?: CallSummary;
}

// A result a group_relay call returned, as the saved team keeps it for a replay.
export interface RelayResult {
	replies: RoundReply[];
	passed: string[];
	failed?: string[];
	/** The call was answered from the saved record instead of run again. */
	replayed?: boolean;
	/** A restart cut the call before it returned; it is not run again. */
	interrupted?: boolean;
	/** Why the saved call failed. */
	error?: string;
}

// A group_relay call as state.json keeps it: its replay identity is the callId, never
// the text of the messages, so the same words sent as a new call stay a new task.
export interface SavedRelayCall {
	callId: string;
	at: number;
	state: "running" | "done" | "failed";
	error?: string;
	result?: RelayResult;
}

// One side of a group's work budget: member work and the admin's summaries are counted
// apart, because an idle ping-pong guard says nothing about what the team spends.
export interface BudgetSide {
	/** Work units allowed before calls are refused; absent means no limit. */
	limit?: number;
	/** Tokens allowed, enforced from DSH's token-meter when it is readable. */
	tokenLimit?: number;
	/** Member turns or summary turns charged. */
	spent: number;
	/** Tokens DSH's token-meter reported for those turns. */
	tokens?: number;
}

// The room's spent budget for one scope (a goal revision, or the user's current ask).
export interface GroupBudget {
	/** `goal:<id>:<objectiveRevision>` or `ask:<seq>`; a new scope starts at zero. */
	scope?: string;
	members?: BudgetSide;
	summary?: BudgetSide;
	/** The budget notices already posted in this scope, so each is said once. */
	noticed?: Partial<Record<"members" | "summary", boolean>>;
}

// What the budget views read.
export interface GroupBudgetView {
	/** Whether DSH's token meter could be read when this view was taken. */
	available: boolean;
	scope?: string;
	members: BudgetSide & { remaining?: number };
	summary: BudgetSide & { remaining?: number };
	/** The idle guard's own counter: a separate mechanism, not a cost budget. */
	idle: { streak: number; paused: boolean };
}

// The prompt a member's turn reads.
export interface RoomPrompt {
	text: string;
	images: unknown[];
	files: unknown[];
}

// Lines a member writes after the round moved on, held until they can go together.
export interface HeldSteps {
	last: number;
	lines: string[];
	info?: RoomSource;
	timer?: ReturnType<typeof setTimeout>;
}

// The `source` of a message delivered to a group Session or a member's group Session.
export interface RoomSource {
	role?: string;
	roomId?: string;
	exchangeId?: string;
	askedBy?: string;
	note?: string;
	text?: string;
	late?: boolean;
	quiet?: boolean;
	progress?: boolean;
	failed?: TurnFailure;
	askedByMember?: unknown;
	[key: string]: unknown;
}

// A user/member message queued for the group's own Session, drained by group_relay.
export interface InboxPost {
	text: string;
	botId?: string;
	name?: string;
	images?: unknown[];
	files?: unknown[];
	via?: string;
	kickoff?: boolean;
	quiet?: boolean;
	logged?: number;
	called?: boolean;
	member?: boolean;
	reportBack?: boolean;
	goal?: string;
	goalId?: string;
	failed?: TurnFailure;
	resumed?: boolean;
	stopped?: boolean;
	done?: boolean;
	again?: boolean;
	late?: boolean;
	progress?: boolean;
	askedBy?: string;
	fromRoomId?: string;
	mentions?: { ids: string[]; all: boolean };
	sub?: string;
	references?: RoundReference[];
	[key: string]: unknown;
}

// The timing knobs the tests freeze: every duration the round uses comes from here.
export interface GroupTiming {
	replyTimeoutMs: number;
	workGraceMs: number;
	stepGapMs: number;
	idleRelayLimit: number;
	roomLogMax: number;
	firstLook: number;
	deltaMax: number;
	earlierMax: number;
	readMax: number;
}

// The mutable host every install function fills in; install() creates it empty and the
// installers set their members before the module returns.
export interface GroupHost {
	rt: Runtime;
	ctx: Runtime["ctx"];
	timing: GroupTiming;
	now(): number;
	linesDir: string;
	wholeLines: Map<string, string>;
	roomLineListeners: Set<(room: GroupRoom, line: SavedLine) => void>;
	roomBatches: Map<string, CallBatch>;
	memberBatch: Map<string, CallBatch>;
	held: Map<string, HeldSteps>;

	// calls.ts
	goalAt(roomId: string): CallGoal | undefined;
	batchKeyOf(roomId: string, botId: string): string;
	saveBatch(room: GroupRoom, batch: CallBatch): void;
	settleBatch(room: GroupRoom, batch: CallBatch): void;
	noteBatchResult(room: GroupRoom, batch: CallBatch, botId: string, name: string, text: string): void;
	askSummary(room: GroupRoom, round: Round, batch: CallBatch, note: string): boolean;
	deliverSummary(room: GroupRoom, botId: string, text: string): void;
	restoreSummaries(room: GroupRoom, round: Round): void;
	summaryBatches(room: GroupRoom, by: string): CallBatch[];
	recoverCalls(room: GroupRoom): void;
	noteLateGoal(room: GroupRoom, botId: string, goal: CallGoal | undefined): void;
	takeLateGoal(room: GroupRoom, botId: string): CallGoal | undefined;
	beginRelay(room: GroupRoom, callId: string): RelayResult | undefined;
	finishRelay(room: GroupRoom, callId: string, result: RelayResult): void;
	failRelay(room: GroupRoom, callId: string, error: unknown): void;
	beginBudget(room: GroupRoom, round: Round): void;
	allowMemberWork(room: GroupRoom): boolean;
	allowSummary(room: GroupRoom): boolean;
	chargeWork(room: GroupRoom, side: "members" | "summary"): void;
	chargeTokens(room: GroupRoom, summary: boolean, tokens: number | undefined): void;
	sessionTokens(sessionId: string): Promise<number | undefined>;
	budgetOf(room: GroupRoom): Promise<GroupBudgetView>;

	// log.ts
	lineKey(roomId: string, seq: number): string;
	lineFile(roomId: string, seq: number): string;
	writes(): boolean;
	ensureRoomLog(room: GroupRoom): void;
	unseenLines(room: GroupRoom, memberId: string): SavedLine[];
	appendRoom(room: GroupRoom, line: GroupLine): void;
	keepGroupLine(roomId: string, line: SavedLine, text: string): SavedLine;
	dropGroupLine(roomId: string, line: SavedLine): void;
	dropGroupLines(roomId: string): void;
	loadGroupLines(room: GroupRoom): Promise<void>;
	memberText(room: GroupRoom): (line: GroupLine) => string;
	logRoom(room: GroupRoom, line: GroupLine): void;
	onRoomLine(listener: (room: GroupRoom, line: SavedLine) => void): () => boolean;
	roomFolderNotice(roomId: string, folder: string | undefined): Promise<void>;

	// prompt.ts
	roomPrompt(room: GroupRoom, member: BotLike, round: Round, slot: Slot): RoomPrompt;

	// round.ts
	postInRound(room: GroupRoom, round: Round, member: BotLike, text: string, duration?: number): void;
	groupSessionFor(room: GroupRoom, member: BotLike): Promise<{ id: string; brief?: string } | undefined>;
	roomTurn(
		room: GroupRoom,
		member: BotLike,
		sessionId: string,
		message: { text: string; images?: unknown[]; files?: unknown[] },
		note: string,
		signal: AbortSignal,
		round: Round,
		by: string | undefined,
		said?: string[],
		heard?: (line: string) => void,
		onWork?: () => void,
	): Promise<TurnResult>;
	touchRoomTurn(sessionId: string): void;
	failRoomTurn(sessionId: string, failure: TurnFailure): boolean;
	yieldRoomTurn(sessionId: string): void;
	workRoomTurn(sessionId: string, tool: string): void;
	nudgeRoom(roomId: string): void;
	nudgeRoomSoon(roomId: string): void;
	callIn(
		round: Round,
		callees: BotLike[],
		note: string | undefined,
		by: string | undefined,
		opts?: { ordered?: boolean },
	): void;
	callFrom(
		room: GroupRoom,
		round: Round,
		member: BotLike,
		text: string,
		called: Set<string>,
		opts?: { worked?: boolean; byBot?: boolean },
	): void;
	startable(round: Round, slot: Slot): boolean;
	registerBatch(roomId: string, by: string | undefined, callees: BotLike[], callId?: string): string | undefined;
	markBatchWorked(roomId: string, botId: string): void;
	pruneBatchPending(room: GroupRoom, batch: CallBatch): void;
	dropMemberFromBatch(room: GroupRoom, botId: string): CallBatch | undefined;
	activeInRoom(room: GroupRoom, botId: string): boolean;
	workingIn(room: GroupRoom): { bot: BotLike; since: number }[];
	workingInRoom(room: GroupRoom): { bot: BotLike; since: number }[];
	unreadCount(room: GroupRoom, botId: string): number;
	minutesSince(at: number): number;
	roomBatchPending(roomId: string): boolean;
	countIdleStep(room: GroupRoom): void;
	clearIdleStreak(room: GroupRoom): void;
	unpauseRoomIdle(room: GroupRoom): void;
	holdIdleCalls(
		room: GroupRoom,
		round: Round,
		member: BotLike,
		callees: BotLike[],
		opts?: { named?: BotLike[]; all?: boolean },
	): boolean;
	announceRoomIdlePaused(room: GroupRoom, round: Round, member: BotLike, callees: BotLike[]): void;
	waitingLines(agent: unknown): { id: string; text: string; via?: string }[];
	drainRoomInbox(room: GroupRoom, round: Round, agent: unknown): void;
	releaseParked(room: GroupRoom, round: Round): void;
	runRound(room: GroupRoom, round: Round, signal: AbortSignal, agent: unknown): Promise<void>;
	memberTurn(room: GroupRoom, round: Round, slot: Slot, signal: AbortSignal): Promise<void>;
	openingCall(room: GroupRoom, opener: InboxPost): { speakers: BotLike[]; ordered: boolean };
	openingSpeakers(room: GroupRoom, opener: InboxPost): BotLike[];
	callsIn(room: GroupRoom, member: BotLike, text: string): boolean;
	memberIn(sessionId: string, info: RoomSource | undefined): { room: GroupRoom; member: BotLike } | undefined;
	noteFailure(room: GroupRoom, name: string, failure: TurnFailure): void;
	stopMemberWork(roomId: string, botId: string): Promise<boolean>;
	stopRoomWork(roomId: string): Promise<boolean>;

	// relay.ts
	postToRoom(
		room: GroupRoom,
		sender: BotLike,
		text: string,
		extra?: Record<string, unknown>,
		files?: unknown[],
	): Promise<void>;
	callPost(room: GroupRoom, round: Round, sender: BotLike, text: string, extra: Record<string, unknown>): boolean;
	lateRoomReply(sessionId: string, info: RoomSource, reply: string, opts?: { shown?: boolean }): Promise<void>;
	lateRoomFailure(sessionId: string, info: RoomSource, failure: TurnFailure): Promise<void>;
	postStep(sessionId: string, info: RoomSource | undefined, text: string): Promise<void>;
	roomStepText(sessionId: string, info: RoomSource | undefined, raw: string, first: boolean): Promise<void>;
	takeRoomSteps(sessionId: string): string;
	withRoomSteps(lines: string, reply: string): string;
	flushSteps(sessionId: string): Promise<void> | undefined;
	greetRoom(roomId: string): Promise<void>;
	reportRound(room: GroupRoom, post: InboxPost, round: Round): Promise<void>;

	// tools.ts
	installTools(): void;
}

// The part of a Bot the group module reads.
export interface BotLike {
	id: string;
	name: string;
	color?: string;
	role?: string;
	[key: string]: unknown;
}
