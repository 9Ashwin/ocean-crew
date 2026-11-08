// The group log: sequence numbers, the long lines kept in group-lines/<room>/<seq>.txt,
// how a member reads a line, the notices the group posts, and the "@" rule and idle
// guard the round shares.

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mentionSpans, speakerOf } from "../../shared/mentions.ts";
import { GROUP_LINE_READ, TEXT_KEPT } from "../core/constants.ts";
import { escapeRegExp, headOf } from "../core/text.ts";
import type {
	BotLike,
	CallGoal,
	GroupHost,
	GroupLine,
	GroupRoom,
	RoundReference,
	SavedLine,
	TurnFailure,
} from "./types.ts";
import { asRoom } from "./types.ts";

// Short ack/thanks/closing phrases with no new content, used by the 0-tool idle loop guard.
const IDLE_ACK_WORDS =
	"收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|完毕|完成|好嘞|行|ok|okay|got\\s+it|understood|noted|thanks|thank\\s+you|you\\s+are\\s+welcome|you're\\s+welcome|welcome|np|no\\s+problem|roger|ack|done|all\\s+good|sounds\\s+good";
// A status post: a member saying it has nothing to do right now. It carries no new
// content and calls nobody, and a group that keeps answering itself with these spins
// until the user writes (#853). The words are the ones members actually post.
// A noun needs its "nothing there" prefix: "任务", "变化" or "安排" alone is ordinary
// talk about work, and matching it would stop a group that is working.
const IDLE_STATUS_WORDS = [
	"(?:收口)?(?:当前|目前|今日|今天)*(?:暂无|没有|无)+(?:待办|任务|新进展|新内容|进展|动作|变化|安排)",
	"待命",
	"保持待命",
	"继续待命",
	"原地待命",
	"静候",
	"静候下一步",
	"静候指令",
	"等候指令",
	"等待指令",
	"等待指示",
	"等待下一步",
	"等待安排",
	"等待新任务",
	"无事可做",
	"空转",
	"standby",
	"standing\\s+by",
	"idle",
	"nothing\\s+(?:pending|to\\s+do|new)",
	"no\\s+pending\\s+(?:tasks?|work)",
	"no\\s+new\\s+(?:work|tasks?|progress|updates?)",
	"no\\s+changes?",
	"no\\s+updates?",
	"waiting\\s+for\\s+(?:instructions?|the\\s+next\\s+steps?)",
].join("|");
// A line may mix them: "收到，待命" is a status post too.
const IDLE_BODY = new RegExp(`^(?:(?:${IDLE_ACK_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, "i");
const IDLE_TEXT_MAX = 45;

// The message body without the names and punctuation, for the idle guard.
export const normalizeRelayBody = (text: unknown, everyone: BotLike[]): string => {
	let out = String(text ?? "");
	for (const bot of everyone) {
		out = out.replace(new RegExp(`@${escapeRegExp(bot.name)}\\b`, "gi"), "");
		out = out.replaceAll(`@${bot.name}`, "");
	}
	return out
		.replace(/@(?:all|everyone|所有人|全体)/gi, "")
		.replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, " ")
		.trim()
		.toLowerCase();
};

export const isIdleRelayText = (text: unknown, everyone: BotLike[], priorBodies: string[]): boolean => {
	const norm = normalizeRelayBody(text, everyone);
	if (norm === "" || (norm.length <= IDLE_TEXT_MAX && IDLE_BODY.test(norm))) return true;
	return priorBodies.some(
		(prev) =>
			prev !== "" &&
			(prev === norm || (prev.length >= 8 && norm.length >= 8 && (prev.includes(norm) || norm.includes(prev)))),
	);
};

// Logs written before rooms were versioned get sequence numbers in place.
export const ensureRoomLog = (room: GroupRoom): void => {
	if (typeof room.seq !== "number") {
		room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }));
		room.seq = room.log.length;
	}
	room.seen ??= {};
};

// A member's own lines are already in its Session, so only the others' are news.
export const unseenLines = (host: GroupHost, room: GroupRoom, memberId: string): SavedLine[] => {
	const since = room.seen[memberId];
	if (since === undefined) return room.log.slice(-host.timing.firstLook);
	return room.log.filter((line) => line.seq > since && line.botId !== memberId).slice(-host.timing.deltaMax);
};

// The goal snapshot a result was asked for under, spread onto a log line or a reply.
export const goalFields = (
	goal: CallGoal | undefined,
): { goalRevision?: number; goalId?: string; goalObjectiveRevision?: number } =>
	goal === undefined
		? {}
		: {
				...(goal.revision !== undefined ? { goalRevision: goal.revision } : {}),
				...(goal.id !== undefined ? { goalId: goal.id } : {}),
				...(goal.objectiveRevision !== undefined ? { goalObjectiveRevision: goal.objectiveRevision } : {}),
			};

// A notice keeps its fields, not a finished sentence: the line members read is written
// when it is read, so old entries still say what happened when the wording or the
// constants move on.
const goalNotice = (line: GroupLine): string => {
	switch (line.event) {
		case "draft":
			return "The user asked for a goal for this group; the admin is aligning it with them.";
		case "start":
			return `Goal "${line.title}" started with ${line.count} stages; stage 1 "${line.next ?? ""}" is current.`;
		case "pass":
			return line.next !== undefined
				? `Goal "${line.title}": stage ${line.stage} of ${line.count} passed; stage ${Number(line.stage) + 1} "${line.next}" is current.`
				: `Goal "${line.title}": stage ${line.stage} of ${line.count} passed; every stage passed.`;
		case "rework":
			return `Goal "${line.title}": stage ${line.stage} was sent back: ${line.text ?? ""}`;
		case "revise":
			return `Goal "${line.title}" was changed: ${line.text ?? ""}`;
		case "pause":
			return `Goal "${line.title}" is paused. Start no new stage work.`;
		case "resume":
			return `Goal "${line.title}" is resumed.`;
		case "complete":
			return `Goal "${line.title}" is complete.`;
		case "stop":
			return `Goal "${line.title}" was stopped: ${line.text ?? ""}`;
		default:
			return line.text ?? "";
	}
};

export const noticeText = (line: GroupLine): string => {
	if (line.reason === "missed")
		return `${(line.names ?? []).join(" and ")} did not answer within ${line.minutes} minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.`;
	if (line.reason === "paused" && line.idle && (line.names ?? []).length === 0)
		return `Paused: Bots here posted ${line.limit} status updates with no new work (no tool used, nobody called), the last from ${line.from ?? "a member"}. The group answers no more of them until the user writes here; do not post again to start a round.`;
	if (line.reason === "paused" && line.idle)
		return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(" and ")} went back and forth ${line.limit} times without progress (no tool used, only thanks or repeats). The calls to @${(line.names ?? []).join(" and @")} wait until the user writes here; do not call them again.`;
	if (line.reason === "paused")
		return `Paused: Bots have called each other ${line.limit} times since the user last wrote here. The calls to @${(line.names ?? []).join(" and @")} wait until the user continues or writes here; do not call them again.`;
	if (line.reason === "admin-passed")
		return `${(line.names ?? []).join(" and ") || "The admin"} did not answer or call anyone; call a member with @Name.`;
	if (line.reason === "folder")
		return `The group's folder ${line.path} is gone, so its members work in the team workspace; set the group's folder again in the group's settings.`;
	if (line.reason === "goal") return goalNotice(line);
	if (line.reason === "failed")
		return `${(line.names ?? []).join(" and ")} stopped: its model call failed (${line.detail}). What it was doing here is not finished; the user can switch its model in its settings or ask it to go on.`;
	return line.text ?? "";
};

// `text` is what to show of a message line, by default what the log keeps of it.
export const lineText = (line: GroupLine, text: string | undefined = line.text): string => {
	const who = String(speakerOf(line));
	if (line.kind === "lookup") return `[${who} looked up its own chat${line.text ? ` for "${line.text}"` : ""}]`;
	if (line.kind === "resumed")
		return `[${who}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`;
	if (line.kind === "cut")
		return `[${who}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`;
	if (line.kind === "stopped") return `[The user stopped ${who}'s work here]`;
	if (line.kind === "done") return `[${who} finished the work it was asked for]`;
	if (line.kind === "notice") return `[${noticeText(line)}]`;
	// A late result says which revision it answers; other lines stay plain.
	const asked =
		line.late !== true || line.goalRevision === undefined ? "" : ` (asked at goal revision ${line.goalRevision})`;
	return `${who}: ${text}${asked}`;
};

export const transcript = (
	lines: GroupLine[],
	textOfLine: (line: GroupLine) => string | undefined = (line) => line.text,
): string => lines.map((line) => lineText(line, textOfLine(line))).join("\n");

// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name: string, text: unknown): string =>
	String(text ?? "")
		.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), "")
		.trim();

export const isPass = (text: unknown): boolean =>
	String(text ?? "") === "" || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(String(text ?? ""));

// Who "@" calls, in order, by the same rule the bubbles draw. `references` are the
// round's referenced conversations: each one's "@label" is a reference, not a call.
// Pass every member, the speaker too, so "@新 Bot 2" said by 新 Bot 2 is never read as
// a call to 新 Bot; the caller drops the speaker.
export const mentionsIn = (
	text: unknown,
	members: BotLike[],
	references: RoundReference[] = [],
): { all: boolean; found: BotLike[] } => {
	const found: BotLike[] = [];
	let all = false;
	for (const span of mentionSpans(text, members, {
		references: references.flatMap((reference) => reference.labels ?? []),
	})) {
		if (span.all) all = true;
		else if (span.bot && !found.includes(span.bot as BotLike)) found.push(span.bot as BotLike);
	}
	return { all, found };
};

// post_to_group resolves "@" on the whole message and stores it on the post. A post
// past MESSAGE_INLINE_MAX keeps only its first LONG_HEAD characters in `text`, so
// reading "@" there would miss anyone named further on. Undefined for a user's
// message, a late reply, or a step line, which were not sent that way.
export function mentionsOf(
	opener: { mentions?: unknown } | undefined,
	everyone: BotLike[],
): { all: boolean; found: BotLike[] } | undefined {
	const saved = opener?.mentions as { ids?: unknown; all?: unknown } | undefined;
	if (saved === undefined || !Array.isArray(saved.ids)) return undefined;
	const byId = new Map(everyone.map((bot) => [bot.id, bot]));
	const found: BotLike[] = [];
	for (const id of saved.ids) {
		const bot = byId.get(String(id));
		if (bot !== undefined && !found.includes(bot)) found.push(bot);
	}
	return { all: saved.all === true, found };
}

// What the user referenced in this round, for a member that has not been shown it yet.
export const referenceNote = (references: RoundReference[] | undefined): string =>
	references?.length
		? `Conversations the user referenced in this round:\n\n${references.map((reference) => reference.text).join("\n\n")}`
		: "";

export const fileLine = (file: { name: string; bytes: number }): string =>
	`[File "${file.name}" (${file.bytes} bytes) attached]`;

// DSH cannot open the Session at all: it is gone, or its stored log is corrupt. DSH
// reports a corrupt log only in the message of a generic failure.
export const lostSession = (error: unknown): boolean => {
	const value = error as { code?: string; message?: string } | undefined;
	return (
		value?.code === "session/not-found" ||
		/\bis corrupt\b|\bcorrupt session log\b/i.test(String(value?.message ?? ""))
	);
};

// The one-line failure the group and the prompt show.
export const failureLine = (failure: TurnFailure): string =>
	`${failure.code}${failure.status ? ` ${failure.status}` : ""}${failure.message ? `: ${failure.message.slice(0, 200)}` : ""}`;

// Wires the log into the host and publishes its members on rt.
export function installLog(host: GroupHost): void {
	const { rt } = host;
	host.ensureRoomLog = ensureRoomLog;
	host.lineKey = (roomId, seq) => `${roomId}/${seq}`;
	host.lineFile = (roomId, seq) => join(host.linesDir, roomId, `${seq}.txt`);
	host.writes = () => rt.readOnly?.() === undefined;
	host.unseenLines = (room, memberId) => unseenLines(host, room, memberId);

	// A long line keeps its start in state.json, which is written whole on every save,
	// and what a member reads of it (GROUP_LINE_READ) in a file of its own: written once,
	// before the state that names it, and removed with the line. All of it stays in the
	// group's Session, where the group chat shows it.
	host.keepGroupLine = (roomId, line, text) => {
		const kept = headOf(text, TEXT_KEPT);
		if (kept.length === text.length) return line;
		const read = headOf(text, GROUP_LINE_READ);
		host.wholeLines.set(host.lineKey(roomId, line.seq), read);
		if (host.writes()) {
			try {
				mkdirSync(join(host.linesDir, roomId), { recursive: true });
				writeFileSync(host.lineFile(roomId, line.seq), read, "utf8");
			} catch (error) {
				rt.warn("ocean-crew: group line %s/%s not kept whole: %s", roomId, line.seq, error);
			}
		}
		return { ...line, text: kept, length: text.length };
	};

	host.dropGroupLine = (roomId, line) => {
		if (line.length === undefined) return;
		host.wholeLines.delete(host.lineKey(roomId, line.seq));
		if (host.writes()) void rm(host.lineFile(roomId, line.seq), { force: true }).catch(() => {});
	};

	host.dropGroupLines = (roomId) => {
		for (const key of host.wholeLines.keys()) if (key.startsWith(`${roomId}/`)) host.wholeLines.delete(key);
		if (host.writes()) void rm(join(host.linesDir, roomId), { recursive: true, force: true }).catch(() => {});
	};

	// After a restart the whole lines are read back before a member reads them.
	host.loadGroupLines = (room) =>
		Promise.all(
			room.log
				.filter((line) => line.length !== undefined && !host.wholeLines.has(host.lineKey(room.id, line.seq)))
				.map((line) =>
					readFile(host.lineFile(room.id, line.seq), "utf8").then(
						(text) => {
							host.wholeLines.set(host.lineKey(room.id, line.seq), text);
						},
						() => {},
					),
				),
		).then(() => {});

	// What a member reads of a line: all of it, up to GROUP_LINE_READ.
	host.memberText = (room) => (line) => {
		const seq = line.seq ?? 0;
		const read = line.length === undefined ? line.text : host.wholeLines.get(host.lineKey(room.id, seq));
		if (read === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`;
		const length = line.length ?? read.length;
		const shown = headOf(read, GROUP_LINE_READ);
		return length > shown.length ? `${shown}… (cut; ${length} characters in all)` : shown;
	};

	host.appendRoom = (room, line) => {
		room.seq += 1;
		const whole: SavedLine = { ...line, seq: room.seq };
		const log = [...room.log, host.keepGroupLine(room.id, whole, line.text ?? "")];
		for (const gone of log.slice(0, -host.timing.roomLogMax)) host.dropGroupLine(room.id, gone);
		room.log = log.slice(-host.timing.roomLogMax);
		// Listeners see the whole line, before keepGroupLine cut it for the log.
		for (const listener of host.roomLineListeners) {
			try {
				listener(room, whole);
			} catch (error) {
				rt.warn("ocean-crew: room line listener failed: %s", error);
			}
		}
	};

	Object.assign(rt, {
		keepGroupLine: host.keepGroupLine,
		dropGroupLines: host.dropGroupLines,
		logRoom: (room: GroupRoom, line: GroupLine) => {
			host.ensureRoomLog(room);
			host.appendRoom(room, line);
		},
		onRoomLine: (listener: (room: GroupRoom, line: SavedLine) => void) => {
			host.roomLineListeners.add(listener);
			return () => host.roomLineListeners.delete(listener);
		},
	});

	// The folder a group was set to work in is gone: its members' Sessions move on in
	// the team workspace (parts.js), and the group is told once per folder, so a later
	// round does not say it again. Changing the folder clears the mark (updateRoom).
	// A failed turn stays in the log, so the admin and the other members read on their
	// next turn that the work stopped there and why (#974); the round's row is gone once
	// the round is.
	host.noteFailure = (room, name, failure) => {
		ensureRoomLog(room);
		host.appendRoom(room, {
			who: "Ocean Crew",
			kind: "notice",
			reason: "failed",
			names: [name],
			detail: failureLine(failure),
		});
	};

	host.roomFolderNotice = async (roomId, folder) => {
		const saved = rt.roomOf(roomId);
		if (saved === undefined || folder === undefined) return;
		const room = asRoom(saved);
		if (room.workDir !== folder || room.folderNotice === folder) return;
		ensureRoomLog(room);
		room.folderNotice = folder;
		host.appendRoom(room, { who: "Ocean Crew", kind: "notice", reason: "folder", path: folder });
		const text = noticeText({ reason: "folder", path: folder } as GroupLine);
		for (const round of rt.roomProgress.values()) {
			if (round.roomId === room.id) round.replies.push({ kind: "folder", text, time: host.now() });
		}
		await rt.save();
	};
	rt.roomFolderNotice = host.roomFolderNotice;
}
