// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
// install() wires the module onto the runtime; the parts live in log.ts (log and long
// lines), calls.ts (recoverable call batches, summaries, replays and budgets),
// prompt.ts (what a member reads), round.ts (who answers, in what order), relay.ts
// (posts, late replies and the relay step a group Session is given) and tools.ts (the
// three tools).

import { join } from "node:path";
import {
	GROUP_LINE_READ,
	ROOM_IDLE_RELAY_LIMIT,
	ROOM_REPLY_TIMEOUT_MS,
	ROOM_STEP_GAP_MS,
	ROOM_WORK_GRACE_MS,
} from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";
import { installCalls } from "./calls.ts";
import { installLog } from "./log.ts";
import { installPrompt } from "./prompt.ts";
import { installRelay } from "./relay.ts";
import { installRound } from "./round.ts";
import { installTasksView } from "./tasks.ts";
import { installTools } from "./tools.ts";
import type { GroupHost, GroupTiming } from "./types.ts";

// the timing constants
// come from constants.ts. Tests inject smaller values through rt.groupTiming so a round
// can be driven with a fake clock.
const ROOM_LOG_MAX = 60;
const ROOM_FIRST_LOOK = 12;
const ROOM_DELTA_MAX = 24;
const ROOM_EARLIER_MAX = 8;
const ROOM_READ_MAX = 30;

const defaultTiming = (): GroupTiming => ({
	replyTimeoutMs: ROOM_REPLY_TIMEOUT_MS,
	workGraceMs: ROOM_WORK_GRACE_MS,
	stepGapMs: ROOM_STEP_GAP_MS,
	idleRelayLimit: ROOM_IDLE_RELAY_LIMIT,
	roomLogMax: ROOM_LOG_MAX,
	firstLook: ROOM_FIRST_LOOK,
	deltaMax: ROOM_DELTA_MAX,
	earlierMax: ROOM_EARLIER_MAX,
	readMax: ROOM_READ_MAX,
});

// The read a member gets of one group line; exported for the tests and later modules.
export { GROUP_LINE_READ };

export function install(rt: Runtime): void {
	// install only the store and this module), so they are created here if absent.
	rt.live ??= new Map();
	rt.roomWaiters ??= new Map();
	rt.roomProgress ??= new Map();
	rt.roomInbox ??= new Map();
	// until the goals
	// module installs, they do nothing (goalDrive stays absent so the relay skips it).
	rt.goalSettled ??= () => Promise.resolve();
	rt.goalTaskWorking ??= () => {};
	rt.goalTaskReported ??= () => {};
	rt.goalTaskReset ??= () => {};
	rt.goalUserMessage ??= () => {};
	rt.goalBlock ??= () => "";
	// until then the line names the file.
	rt.imagesForGroup ??= async () => [];

	const host = {} as GroupHost;
	Object.assign(host, {
		rt,
		ctx: rt.ctx,
		timing: { ...defaultTiming(), ...((rt.groupTiming as Partial<GroupTiming> | undefined) ?? {}) },
		now: typeof rt.groupNow === "function" ? (rt.groupNow as () => number) : () => Date.now(),
		linesDir: join(rt.home, "group-lines"),
		wholeLines: new Map<string, string>(),
		roomLineListeners: new Set<(room: never, line: never) => void>(),
		roomBatches: new Map(),
		memberBatch: new Map(),
		held: new Map(),
	});

	installLog(host);
	installCalls(host);
	installPrompt(host);
	installRound(host);
	installRelay(host);
	installTools(host);
	// The read-only task view the chat shows: goal, status, results and delivery.
	installTasksView(rt);
}

export { mentionSpans, nameProblem, referenceSpans, speakerOf } from "../../shared/mentions.ts";
// The pure helpers other modules and tests read: the "@" rule, the reply/notice text,
// and the log helpers parts.ts and tools.ts share.
export {
	ensureRoomLog,
	isIdleRelayText,
	isPass,
	lineText,
	mentionsIn,
	mentionsOf,
	noticeText,
	referenceNote,
	stripOwnName,
	transcript,
} from "./log.ts";
export type {
	CallBatch,
	CallGoal,
	GroupBudget,
	GroupBudgetView,
	GroupHost,
	GroupRoom,
	GroupTiming,
	RelayResult,
	Round,
	SavedCallBatch,
	Slot,
} from "./types.ts";
