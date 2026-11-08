// The three group tools: group_relay (the only model call a group Session makes — it
// drains the queued posts, runs the round and returns its replies), read_own_chat (a
// member's own chat with the user, logged in the group so the group sees the lookup),
// and read_group_chat (the latest lines of a group, or one long line whole).
// Own-chat reading itself is chat-index.ts's job

// they do not.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { TEXT_KEPT } from "../core/constants.ts";
import type { TeamTool } from "../core/runtime.ts";
import { headOf, unquote } from "../core/text.ts";
import { ensureRoomLog, fileLine, isIdleRelayText, lineText, mentionsIn, mentionsOf, transcript } from "./log.ts";
import type { BotLike, GroupHost, GroupLine, GroupRoom, InboxPost, Round, Slot } from "./types.ts";
import { asRoom, savedRoom } from "./types.ts";

// The group argument shared by the group tools;
const GROUP_REF = { type: "string", required: true, description: "Exact group chat name from list_bots" } as const;
const output = {
	schema: { type: "string" as const },
	render: (_args: unknown, value: unknown): { type: "text"; text: string }[] => [
		{ type: "text", text: String(value) },
	],
};

const OWN_CHAT_UNAVAILABLE =
	"Your own chat is not available in this build yet (it arrives with the chat index); read_group_chat and the group chat still work.";

// Wires the group tools into the host; install() calls it after the relay.
export function installTools(host: GroupHost): void {
	const { rt } = host;
	// defineTool returns the full DSH definition; runtime.ts's TeamTool bridge stays

	const addTool = (definition: ReturnType<typeof defineTool>): void => {
		rt.teamTools.push(definition as unknown as TeamTool);
	};

	// until then the same rule over the store.
	const pickRoom = (ref: unknown, self: string | undefined): { room?: GroupRoom; error?: string } => {
		if (typeof rt.pickRoom === "function") return rt.pickRoom(ref, self) as { room?: GroupRoom; error?: string };
		const visible = (Object.values(rt.state.rooms) as unknown as import("../../shared/state.ts").Room[])
			.filter((room) => rt.isMain(self) || (self !== undefined && room.members.includes(self)))
			.map(asRoom);
		const wanted = unquote(ref);
		const matches = visible.filter((room) => room.id === String(ref) || room.name === wanted);
		if (matches.length === 1) return { room: matches[0] };
		if (matches.length > 1) return { error: `Several group chats are called "${wanted}". Rename one first.` };
		const names = visible.map((room) => room.name).join(", ");
		return { error: `No group chat called "${wanted}" that you can see. Groups: ${names}.` };
	};

	addTool(
		defineTool({
			name: "group_relay",
			description:
				"Group chat relay only. Deliver the latest user message to the Bots it calls in this group chat, and collect their replies.",
			parameters: {},
			output,
			async execute(_args, exec) {
				await rt.load();
				const saved = rt.roomOf(exec.agent?.id);
				if (saved === undefined) return JSON.stringify({ error: "Not a group chat" });
				const room = asRoom(saved);
				ensureRoomLog(room);
				// Everything queued since the last relay is posted in order, so messages that the
				// Session folds into one turn are not lost; the newest one picks the speakers.
				const queued = (rt.roomInbox.get(room.id) ?? []) as InboxPost[];
				rt.roomInbox.delete(room.id);
				const posts: InboxPost[] = queued.length > 0 ? queued : [{ text: "" }];
				// A goal post queued for a goal that moved on is dropped: a check or resume
				// for a goal that is gone, idle or no longer active is stale, and a draft for
				// a goal that was written or stopped keeps only its user line.
				for (const post of [...posts]) {
					const goal = room.goal;
					if (post.goal === "nudge" || post.goal === "resume") {
						if (
							goal === undefined ||
							goal.id !== post.goalId ||
							goal.status !== "active" ||
							(post.goal === "nudge" && goal.idle === true)
						)
							posts.splice(posts.indexOf(post), 1);
					} else if (
						post.goal === "draft" &&
						(goal === undefined || goal.id !== post.goalId || goal.status !== "drafting")
					) {
						delete post.goal;
						delete post.goalId;
					}
				}
				// A post a running round already logged stays inside the round this relay opens.
				const loggedSeqs = posts.map((post) => post.logged).filter((seq): seq is number => typeof seq === "number");
				const startSeq = Math.min(room.seq + 1, ...loggedSeqs);
				// The opening greeting is a cue for the admin, not a line of the group; a member's
				// late failure, its work picked up after a restart, its work the user stopped, or
				// the end of work whose result it already posted is an event of the round.
				const event = (item: InboxPost): boolean =>
					Boolean(
						item.failed ||
							item.resumed ||
							item.stopped ||
							item.done ||
							item.goal === "nudge" ||
							item.goal === "resume",
					);
				// A user post has no botId and is no round event or kickoff; a goal draft counts
				// as the user's own line too.
				const userPost = (post: InboxPost): boolean =>
					post.botId === undefined && post.kickoff !== true && !event(post);
				const stoppedOnly = posts.length > 0 && posts.every((item) => event(item) && item.stopped === true);
				for (const post of posts.filter((item) => !item.kickoff && !event(item) && item.logged === undefined)) {
					// Image readings go into the log only; `@` names are picked from what the user typed.
					// Images and files stay with their line and reach each member the line is shown to.
					const readings =
						post.images === undefined
							? []
							: ((await rt.imagesForGroup?.(post.images, rt.sessionOfRoom(savedRoom(room)))) ?? []);
					const text = [
						post.text,
						...readings,
						...(post.files ?? []).map((file) => fileLine(file as { name: string; bytes: number })),
					]
						.filter(Boolean)
						.join("\n");
					host.appendRoom(room, {
						...(post.botId
							? { who: rt.botOf(post.botId)?.name ?? post.name ?? "Bot", botId: post.botId }
							: { who: "User" }),
						text,
						...(post.images === undefined ? {} : { images: post.images }),
						...(post.files === undefined ? {} : { files: post.files }),
						...(post.via === undefined ? {} : { via: post.via }),
					});
				}
				await rt.save();
				if (posts.some(userPost)) rt.goalUserMessage?.(room.id);
				// An event post, and a member post that calls nobody, never pick the speakers
				// over a message queued with them.
				// called (`called`) picks none.
				const callsNobody = (post: InboxPost): boolean =>
					post.member === true && host.openingSpeakers(room, post).length === 0;
				const open = posts.filter((post) => post.called !== true);
				const opener: InboxPost = open.findLast((post) => !event(post) && !callsNobody(post)) ??
					open.findLast((post) => !event(post)) ??
					open.at(-1) ?? { text: "", quiet: true };
				const references = posts.flatMap((post) => post.references ?? []);
				// A member a Bot's post calls by name works for that Bot. The saved list is the
				// whole message; the text may be only its opening.
				const everyone = room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[];
				// A Bot's status post is a round of its own: in a group where everyone answers, that
				// post is what starts the next round of status turns (#853). It counts once as an
				// idle round; a post with new work in it, or the user's own message, clears the
				// streak. Only the user's message lifts a pause already in place.
				const poster = opener.botId === undefined ? undefined : rt.botOf(opener.botId);
				const idlePost =
					poster !== undefined &&
					!event(opener) &&
					opener.quiet !== true &&
					isIdleRelayText(opener.text ?? "", everyone, []);
				if (posts.some(userPost)) host.unpauseRoomIdle(room);
				// The pause holds a status post back: it is not answered, and the members it named
				// wait for the user. A post with work in it goes ahead.
				const holdsPost = idlePost && room.idlePaused !== undefined;
				const openerMentions =
					mentionsOf(opener as { mentions?: unknown }, everyone) ?? mentionsIn(opener.text ?? "", everyone);
				const named = opener.botId === undefined ? [] : openerMentions.found;
				const opened = host.openingCall(room, opener);
				const speakers = holdsPost ? [] : opened.speakers;
				const ordered = holdsPost ? false : opened.ordered;
				const calledByOpener = speakers.filter((member) => named.includes(member));
				const openingBatchKey =
					opener.botId !== undefined && calledByOpener.length > 0
						? host.registerBatch(room.id, opener.botId, calledByOpener)
						: undefined;
				// The admin's own post that opens a round hands goal tasks the same way a call does.
				if (rt.isAdminOf(savedRoom(room), opener.botId))
					for (const member of calledByOpener) rt.goalTaskWorking?.(room.id, member.id);
				// The admin alone with the user's message: when it passes, the round ends with
				// nothing said, and the group says so once.
				const admin = everyone.find((bot) => rt.isAdminOf(savedRoom(room), bot.id));
				const soleAdmin =
					opener.botId === undefined &&
					!opener.kickoff &&
					opener.goal === undefined &&
					room.mode === "admin" &&
					admin !== undefined &&
					speakers.length === 1 &&
					speakers[0].id === admin.id;
				// A goal draft queued with another post still brings the admin in, on its note.
				const draftPost = posts.find((post) => post.goal === "draft" && post !== opener);
				if (draftPost !== undefined && admin !== undefined && !speakers.some((member) => member.id === admin.id))
					speakers.push(admin);
				const round: Round = {
					roomId: room.id,
					members: room.members,
					startSeq,
					goalRevision: room.goal?.revision,
					...(posts.some(userPost) ? { userMessage: true } : {}),
					...(opener.kickoff ? { kickoff: true } : {}),
					...(opener.goal === "nudge" ? { goalNudge: true } : {}),
					...(opener.goal === "resume" ? { goalResume: true } : {}),
					...(stoppedOnly ? { stoppedOnly: true } : {}),
					...(references.length > 0 ? { references, shown: [] } : {}),
					slots: speakers.map(
						(member): Slot => ({
							id: member.id,
							name: member.name,
							status: "waiting",
							batch: 1,
							...(ordered ? { ordered: true } : {}),
							// A round a Bot's post opened: what its members answer is Bot-to-Bot, counted
							// by the idle guard even though no one is named (#853).
							...(opener.botId !== undefined ? { fromBot: true } : {}),
							...(opener.kickoff ? { note: "the group was just created" } : {}),
							...(opener.goal === "draft" ||
							(draftPost !== undefined && admin !== undefined && member.id === admin.id)
								? { note: "the user wants to set a goal for this group" }
								: {}),
							...(opener.goal === "nudge" ? { note: "goal check" } : {}),
							...(opener.goal === "resume" ? { note: "the user resumed the goal" } : {}),
							...(named.includes(member)
								? { by: opener.botId, ...(openingBatchKey ? { batchKey: openingBatchKey } : {}) }
								: {}),
							...(opener.done ? { note: `${opener.name ?? "a member"} finished the work you asked for` } : {}),
						}),
					),
					batches: 1,
					...(soleAdmin ? { soleAdmin: { id: admin.id, name: admin.name, color: admin.color } } : {}),
					replies: [],
					passed: [],
					failed: [],
					started: [],
				};
				// A status post of its own is not an idle step: what its members answer is. A post
				// with work in it clears the streak, and a paused room holds the post back.
				if (!idlePost && poster !== undefined && !event(opener) && opener.quiet !== true)
					host.clearIdleStreak(room);
				if (holdsPost && poster !== undefined)
					host.holdIdleCalls(room, round, poster, opened.speakers, { named, all: openerMentions.all === true });
				// The group transcript hides the goal trigger, so the user sees their request as a reply.
				for (const post of posts.filter((item) => item.goal === "draft" && item.logged === undefined)) {
					round.replies.push({ kind: "user", text: post.text, time: host.now() });
				}
				for (const post of posts.filter((item) => item.failed && item.logged === undefined)) {
					const bot = rt.botOf(post.botId);
					const { code, status, message } = post.failed!;
					round.failed.push(bot?.name ?? post.name ?? "Bot");
					round.replies.push({
						kind: "failed",
						botId: post.botId,
						name: bot?.name ?? post.name,
						color: bot?.color,
						code,
						...(status ? { status } : {}),
						text: message,
						time: host.now(),
					});
				}
				// The log line tells the admin and the other members on their next turn.
				for (const post of posts.filter(
					(item) => (item.resumed || item.stopped || item.done) && item.logged === undefined,
				)) {
					const bot = rt.botOf(post.botId);
					const name = bot?.name ?? post.name ?? "Bot";
					const kind = post.done ? "done" : post.stopped ? "stopped" : post.again ? "cut" : "resumed";
					host.appendRoom(room, { who: name, botId: post.botId, kind, text: "" });
					round.replies.push({ kind, botId: post.botId, name, color: bot?.color, time: host.now() });
				}
				if (posts.some((post) => post.resumed || post.stopped || post.done)) await rt.save();
				host.releaseParked(room, round);
				rt.roomProgress.set(exec.callId as string, round);
				try {
					await host.runRound(room, round, exec.signal, exec.agent);
				} catch (error) {
					rt.warn("ocean-crew: group round in %s stopped: %s", room.name, error);
				} finally {
					rt.roomProgress.delete(exec.callId as string);
				}
				if (exec.signal?.aborted) {
					for (const turn of round.started) {
						void (
							rt.stopRoomTurn?.(room.sessions?.[turn.botId] ?? turn.sessionId, turn.exchangeId) as
								| Promise<unknown>
								| undefined
						)?.catch((error: unknown) =>
							rt.warn("ocean-crew: stopping a turn of the round in %s failed: %s", room.name, error),
						);
					}
				} else if (rt.goalDrive !== undefined) {
					// A round that ends with an active goal and nothing running may wake the admin.
					try {
						await rt.goalDrive(room, round);
					} catch (error) {
						rt.warn("ocean-crew: goal check in %s failed: %s", room.name, error);
					}
				}
				await rt.save();
				for (const post of open) {
					if (post.reportBack && rt.botOf(post.botId)) void host.reportRound(room, post, round);
				}
				// A post this round took in while it ran gets the replies of the members it called.
				for (const { post, ids, from } of round.reports ?? []) {
					if (!rt.botOf(post.botId)) continue;
					const names = ids.map((id) => rt.botOf(id)?.name).filter(Boolean) as string[];
					void host.reportRound(
						room,
						post as unknown as InboxPost,
						{
							replies: round.replies
								.slice(from)
								.filter((reply) => reply.botId !== undefined && ids.includes(reply.botId)),
							passed: round.passed.filter((name) => names.includes(name)),
							failed: round.failed.filter((name) => names.includes(name)),
						} as Round,
					);
				}
				exec.concludeTurn?.();
				return JSON.stringify({
					replies: round.replies,
					passed: round.passed,
					...(round.failed.length > 0 ? { failed: round.failed } : {}),
				});
			},
		}),
	);

	// Private context enters a group only through this tool, and the group sees each use.
	addTool(
		defineTool({
			name: "read_own_chat",
			description:
				"Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.",
			parameters: {
				query: {
					type: "string",
					description:
						"Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages",
				},
				around: {
					type: "string",
					description:
						'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it',
				},
				part: {
					type: "integer",
					description: "Number of an earlier part: shows the handoff note you wrote when it ended",
				},
			},
			output,
			async execute(args, exec) {
				await rt.load();
				const id = exec.agent?.id;
				const owner = rt.groupOwners.get(id as string);
				const botId = owner?.botId ?? rt.chatOwners.get(id as string);
				if (botId === undefined) return "Only Bots on the team can use read_own_chat.";
				const member = rt.botOf(botId);
				const saved = rt.roomOf(owner?.roomId);
				const query = String(args.query ?? "")
					.trim()
					.slice(0, 80);
				const around = String(args.around ?? "")
					.trim()
					.slice(0, 40);
				const parts = (rt.partsOf?.(botId) ?? []) as { number?: number; startedAt?: number; endedAt?: number }[];
				const number = Number.isInteger(args.part) ? (args.part as number) : undefined;
				if (saved !== undefined && member !== undefined) {
					const room = asRoom(saved);
					ensureRoomLog(room);
					const text =
						query !== ""
							? query
							: around !== ""
								? `around ${around}`
								: number !== undefined
									? `part ${number}`
									: "";
					host.appendRoom(room, { who: member.name, botId: member.id, kind: "lookup", text });
					for (const round of rt.roomProgress.values()) {
						if (round.roomId === room.id)
							round.replies.push({
								kind: "lookup",
								botId: member.id,
								name: member.name,
								color: member.color,
								text,
								time: host.now(),
							});
					}
					void rt.save().catch(() => {});
				}
				const partsNote =
					parts.length > 1 && rt.partIndex
						? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.`
						: "";
				if (query === "" && around !== "") {
					if (typeof rt.aroundOwnChat !== "function") return `${OWN_CHAT_UNAVAILABLE}${partsNote}`;
					const found = (await rt.aroundOwnChat(botId, around)) as {
						error?: string;
						lines: string[];
						exact?: boolean;
					};
					if (found.error) return `${found.error}${partsNote}`;
					if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`;
					const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`;
					return `Your own chat ${heading} (oldest first):\n${found.lines.join("\n")}${partsNote}`;
				}
				if (query === "" && number !== undefined) {
					const part = parts[number - 1];
					if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`;
					if (part.endedAt === undefined)
						return `Part ${number} is the current one; it is in your context.${partsNote}`;
					const started = rt.clock?.(part.startedAt) ?? "";
					const ended = rt.clock?.(part.endedAt) ?? "";
					return `Part ${number} of your own chat (${started} – ${ended}). The handoff note that closed it:\n${rt.noteText?.(part) ?? "(none: the part ended on a context overflow)"}${partsNote}`;
				}
				if (query === "") {
					if (typeof rt.latestOwnChat !== "function") return `${OWN_CHAT_UNAVAILABLE}${partsNote}`;
					const lines = (await rt.latestOwnChat(botId, { askingId: id })) as string[];
					return lines.length === 0
						? `Your own chat is empty.${partsNote}`
						: `Your own chat (oldest first):\n${lines.join("\n")}${partsNote}`;
				}
				if (typeof rt.searchOwnChat !== "function") return `${OWN_CHAT_UNAVAILABLE}${partsNote}`;
				const { lines, every } = (await rt.searchOwnChat(botId, query, { askingId: id })) as {
					lines: string[];
					every: boolean;
				};
				if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`;
				const heading = every
					? `messages mentioning "${query}"`
					: `no message has all of "${query}"; messages with the most of these words`;
				return `Your own chat, ${heading} (oldest first):\n${lines.join("\n")}${partsNote}`;
			},
		}),
	);

	addTool(
		defineTool({
			name: "read_group_chat",
			description:
				"Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.",
			parameters: {
				group: GROUP_REF,
				seq: { type: "integer", description: "Read one message whole: the seq that a cut message names" },
			},
			output,
			async execute(args, exec) {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				if (rt.botOf(self) === undefined) return "Only Bots on the team can read group chats.";
				const picked = pickRoom(args.group, self);
				if (picked.error !== undefined) return picked.error;
				const room = picked.room!;
				ensureRoomLog(room);
				await host.loadGroupLines(room);
				if (args.seq !== undefined) {
					const line = room.log.find((entry) => entry.seq === Number(args.seq));
					return line === undefined
						? `"${room.name}" no longer keeps message ${args.seq}; it keeps its latest ${host.timing.roomLogMax}.`
						: lineText(line, host.memberText(room)(line));
				}
				// Thirty whole lines could fill the context, so a long one shows its start.
				const short = (line: GroupLine): string => {
					if (line.text === undefined) return "";
					const length = line.length ?? line.text.length;
					return length <= TEXT_KEPT
						? line.text
						: `${headOf(line.text, TEXT_KEPT)}… (cut; ${length} characters in all; read_group_chat with seq ${line.seq} reads it whole)`;
				};
				const lines = room.log.slice(-host.timing.readMax);
				return lines.length === 0
					? `"${room.name}" has no messages yet.`
					: `Latest in "${room.name}" (oldest first):\n${transcript(lines, short)}`;
			},
		}),
	);
}
