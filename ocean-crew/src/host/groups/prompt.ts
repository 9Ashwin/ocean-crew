// The prompt one member's turn in a group round reads: who is in the group, the notice,
// the transcript since it last looked, where its turn stands in the round, and the
// reply rules.

import { referenceNote, transcript } from "./log.ts";
import type { BotLike, GroupHost, GroupRoom, RoomPrompt, Round, Slot } from "./types.ts";
import { savedRoom } from "./types.ts";

const ROOM_REPLY =
	"Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, call your first tool in the same step as your opening note — if you stop without a tool call, your turn ends and no work runs. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.";
const ROOM_CALLS =
	'Writing "@Name" calls that member at once, to answer or to do what you ask, as soon as your message is posted: call members before you start on your own part. Members called in one message start together and do not see each other\'s replies until they post, so when one needs another\'s result, call the first and ask it to call the next. When a member finishes work you gave it, you answer its result. To only mention a member, write its name without "@".';

const slotLabel = (slot: Slot, self: Slot): string => {
	if (slot.status === "speaking") return slot === self ? `${slot.name} (you, now)` : `${slot.name} (answering now)`;
	if (slot.status === "posted") return `${slot.name} (posted)`;
	if (slot.status === "passed") return `${slot.name} (passed)`;
	if (slot.status === "missed") return `${slot.name} (no answer)`;
	if (slot.status === "working") return `${slot.name} (working on it; posts when done)`;
	if (slot.status === "waiting-approval") return `${slot.name} (waiting for the user's approval; posts when done)`;
	if (slot.status === "failed") return `${slot.name} (could not answer: error)`;
	if (slot.status === "left") return `${slot.name} (left the group)`;
	return slot.name;
};

const adminNote = (room: GroupRoom): string =>
	[
		"You are this group's admin.",
		room.mode === "admin"
			? "Plain messages come to you first: answer them, or call the members who should answer with @Name."
			: "",
		'"@all" calls every member. When the user asks, change the group with update_group.',
		"When the user wants this group to reach a goal, set it with group_goal: align with the user first (goal-grill skill), then start it.",
	]
		.filter(Boolean)
		.join(" ");

// The opening turn of a group the user just made without a first message.
const roomKickoff = (language?: string): string =>
	`The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? "the user's language if known; otherwise Chinese"}.`;

// Where a turn stands in its round: its place in the order when members take turns,
// or who was called with it and answers at the same time; then the others' latest
// calls in this round.
const placeLines = (round: Round, slot: Slot): string[] => {
	const lines: string[] = [];
	if (slot.ordered) {
		const order = round.slots.filter((other) => other.ordered);
		const index = order.indexOf(slot);
		const after = order.length - index - 1;
		lines.push(
			`Members answer this message one at a time: ${order.map((other) => slotLabel(other, slot)).join(" → ")}.`,
			`You are number ${index + 1} of ${order.length}. ${index === 0 ? "Nobody spoke before you" : `${index} went before you`}${after === 0 ? ", and you are the last." : `; ${after} after you will see your message.`}`,
		);
	} else {
		const together = round.slots.filter(
			(other) => other !== slot && other.batch === slot.batch && other.id !== slot.id,
		);
		if (together.length > 0)
			lines.push(
				`Called together with you: ${together.map((other) => other.name).join(", ")}. You answer at the same time and do not see each other's replies until they post.`,
			);
	}
	const latest = new Map<string, Slot>();
	for (const other of round.slots)
		if (other.id !== slot.id && !(slot.ordered && other.ordered)) latest.set(other.id, other);
	if (latest.size > 0)
		lines.push(`Also in this round: ${[...latest.values()].map((other) => slotLabel(other, slot)).join(", ")}.`);
	return lines;
};

// Wires the prompt builder into the host.
export function installPrompt(host: GroupHost): void {
	const { rt } = host;
	host.roomPrompt = (room, member, round, slot) => {
		const peers = room.members
			.filter((id) => id !== member.id)
			.map((id) => rt.botOf(id))
			.filter(Boolean)
			.map(
				(bot) => `${(bot as BotLike).name}${rt.isAdminOf(savedRoom(room), (bot as BotLike).id) ? " (admin)" : ""}`,
			);
		const leads = rt.isAdminOf(savedRoom(room), member.id);
		const lines = host.unseenLines(room, member.id);
		const earlier = lines.filter((line) => line.seq < round.startSeq).slice(-host.timing.earlierMax);
		const current = lines.filter((line) => line.seq >= round.startSeq);
		const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq;
		const members = `Members: the user${peers.length ? `, ${peers.join(", ")}` : ""} and you${leads ? " (admin)" : ""}. ${ROOM_CALLS}`;
		const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : "";
		if (round.kickoff)
			return {
				text: [members, notice, leads ? adminNote(room) : "", roomKickoff(rt.uiLanguage?.())]
					.filter(Boolean)
					.join("\n\n"),
				images: [],
				files: [],
			};
		const goal =
			rt.goalBlock?.(room, member, { nudge: round.goalNudge === true, resume: round.goalResume === true }) ?? "";
		// Members answering in this round are named with the round below.
		const answering = new Set(round.slots.filter((other) => other.status === "speaking").map((other) => other.id));
		const working = host
			.workingIn(room)
			.filter((item) => item.bot.id !== member.id && !answering.has(item.bot.id))
			.map((item) => ({ ...item, unread: host.unreadCount(room, item.bot.id) }));
		const text = [
			members,
			notice,
			goal,
			leads ? adminNote(room) : "",
			earlier.length
				? `Earlier in the group, before this round (context only):\n${transcript(earlier, host.memberText(room))}`
				: "",
			current.length
				? `This round so far${spokeThisRound ? ", since your last message" : ", starting with the new message"} (oldest first):\n${transcript(current, host.memberText(room))}`
				: "Nothing new in this round since your last message.",
			round.shown?.includes(member.id) ? "" : referenceNote(round.references),
			working.length > 0
				? `Still at work on what they were asked; each posts here when done: ${working
						.map(
							(item) =>
								`${item.bot.name} (${host.minutesSince(item.since)} min${item.unread > 0 ? `, with ${item.unread} group message(s) it has not read yet` : ""})`,
						)
						.join(", ")}.`
				: "",
			...placeLines(round, slot),
			ROOM_REPLY,
		]
			.filter(Boolean)
			.join("\n\n");
		const shown = [...earlier, ...current];
		const prompt: RoomPrompt = {
			text,
			images: shown.flatMap((line) => line.images ?? []),
			files: shown.flatMap((line) => line.files ?? []),
		};
		return prompt;
	};
}
