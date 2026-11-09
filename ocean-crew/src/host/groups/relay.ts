// Posting into a group: a Bot's post lands in the running round at once (or opens one
// through the group's own Session), late replies and failures find the member that
// asked, step lines are batched, and the group Session's llm/stream is synthesized into
// a group_relay call so a group never consults the model for itself.

import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { failureLine } from "../chat/turns.ts";
import { SOURCE_KIND } from "../core/constants.ts";
import { listenGlobal } from "../core/events.ts";
import { fileLine, goalFields, isIdleRelayText, isPass, mentionsIn, mentionsOf, stripOwnName } from "./log.ts";
import type { BotLike, CallGoal, GroupHost, InboxPost, Round, TurnFailure } from "./types.ts";
import { asRoom, savedRoom } from "./types.ts";

// Wires the relay into the host and publishes its members on rt.
export function installRelay(host: GroupHost): void {
	const { rt, ctx } = host;
	const timing = host.timing;
	const now = () => host.now();
	// sessions.flush lives on the DSH sessions service, which runtime.ts keeps loosely typed.
	const flushSession = async (session: unknown): Promise<void> => {
		const sessions = ctx.sessions as { flush?: (session: unknown) => Promise<unknown> } | undefined;
		await sessions?.flush?.(session);
	};
	// A round is running in the room right now: a late post lands in its log directly,
	// so the goal snapshot travels on the post instead of the saved late-goal list.
	const roundRunning = (room: { id: string }): boolean =>
		[...rt.roomProgress.values()].some((round: Round) => round.roomId === room.id && round.nudge !== undefined);

	// A Bot's post that lands while a round runs calls its members in that round at
	// once, as the relay it opens would. A post that wants the replies (`reportBack`)
	// gets those of the members it called when the round ends.
	host.callPost = (room, round, sender, text, extra) => {
		if (extra.failed !== undefined && !extra.askedBy) return false;
		if (extra.resumed || extra.stopped) return false;
		const post: InboxPost = { ...(extra as Partial<InboxPost>), botId: sender.id, name: sender.name, text };
		const everyone = room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[];
		const mentions = mentionsOf(post as { mentions?: unknown }, everyone) ?? mentionsIn(text, everyone);
		const named = mentions.found;
		// A post that lands in a running round counts the same way: new work in it clears the
		// streak, a status post is one idle round, and what the pause holds back is parked so
		// it runs after the user writes instead of being dropped (#853).
		const idlePost =
			!extra.done && extra.progress !== true && extra.late !== true && isIdleRelayText(text, everyone, []);
		if (!idlePost) host.clearIdleStreak(room);
		const opened = host.openingCall(room, post);
		if (
			idlePost &&
			room.idlePaused !== undefined &&
			host.holdIdleCalls(room, round, sender, opened.speakers, { named, all: mentions.all === true })
		)
			return true;
		const { speakers, ordered } = opened;
		if (speakers.length === 0) return false;
		const by = speakers.filter((peer) => named.includes(peer));
		const rest = speakers.filter((peer) => !named.includes(peer));
		const note = extra.done ? `${sender.name} finished the work you asked for` : undefined;
		// A barrier completing inside a running round still owes the caller its summary:
		// asking here records the duty on the batch, so the next round does not ask again.
		if (extra.done && extra.askedBy !== undefined && note !== undefined) {
			let asked = false;
			for (const batch of host.summaryBatches(room, String(extra.askedBy)))
				asked = host.askSummary(room, round, batch, note) || asked;
			if (asked) return true;
		}
		host.callIn(round, by, note ?? `${sender.name} mentioned you`, sender.id, { ordered });
		host.callIn(round, rest, note, undefined, { ordered });
		if (rt.isAdminOf(savedRoom(room), sender.id)) for (const peer of speakers) rt.goalTaskWorking?.(room.id, peer.id);
		if (extra.reportBack) {
			round.reports ??= [];
			round.reports.push({
				post: {
					botId: sender.id,
					name: sender.name,
					reportBack: true,
					...(extra.sub ? { sub: String(extra.sub) } : {}),
					...(extra.fromRoomId ? { fromRoomId: String(extra.fromRoomId) } : {}),
				},
				ids: speakers.map((peer) => peer.id),
				from: round.replies.length,
				...(host.goalAt(room.id) !== undefined ? { goal: host.goalAt(room.id) } : {}),
			});
		}
		return true;
	};

	// A Bot's message into the group's own Session, which relays it as a new round.
	// While a round runs, the post goes into the group's log and that round's replies at
	// once, and the members it calls start in that round, so it is not held back until
	// the round ends and never sits in the group Session's QueueDock (#663).
	host.postToRoom = async (room, sender, text, extra = {}, files = []) => {
		const running = [...rt.roomProgress.values()].find(
			(round: Round) => round.roomId === room.id && round.nudge !== undefined,
		) as Round | undefined;
		if (running !== undefined) {
			host.ensureRoomLog(room);
			const failed = extra.failed as TurnFailure | undefined;
			if (failed !== undefined) {
				// A failed model call is an event of the round only: no log line, as the relay does it.
				running.failed.push(sender.name);
				running.replies.push({
					kind: "failed",
					botId: sender.id,
					name: sender.name,
					color: sender.color,
					code: failed.code,
					...(failed.status ? { status: failed.status } : {}),
					text: failed.message,
					time: now(),
				});
			} else if (extra.resumed === true || extra.stopped === true || extra.done === true) {
				const kind =
					extra.done === true
						? "done"
						: extra.stopped === true
							? "stopped"
							: extra.again === true
								? "cut"
								: "resumed";
				host.appendRoom(room, { who: sender.name, botId: sender.id, kind, text: "" });
				running.replies.push({ kind, botId: sender.id, name: sender.name, color: sender.color, time: now() });
			} else {
				const line = [text, ...files.map((file) => fileLine(file as { name: string; bytes: number }))]
					.filter(Boolean)
					.join("\n");
				// A late result carries the goal revision it was asked for under, not the one
				// the goal happens to be at now.
				const goal = goalFields(extra.dispatchGoal as CallGoal | undefined);
				host.appendRoom(room, {
					who: sender.name,
					botId: sender.id,
					text: line,
					...(files.length > 0 ? { files } : {}),
					...(extra.late === true ? { late: true } : {}),
					...goal,
				});
				running.replies.push({
					botId: sender.id,
					name: sender.name,
					color: sender.color,
					text: line,
					time: now(),
					...goal,
				});
				// The group log is what the user reads: this line delivers what the Bot owed.
				host.deliverSummary(room, sender.id, line);
			}
			host.callPost(room, running, sender, text, extra);
			await rt.save();
			return;
		}
		const agent = await rt.resolveAgent(rt.sessionOfRoom(savedRoom(room)));
		agent.followup(
			createUserMessage({
				content: [
					{ type: "text", text: `[Group post from ${sender.name}]\n${text}` },
					...files.map((attachment) => ({ type: "file", attachment })),
				] as never,
				source: {
					kind: SOURCE_KIND,
					form: "relay",
					role: "post",
					exchangeId: randomUUID(),
					senderName: sender.name,
					senderSessionId: sender.id,
					roomId: room.id,
					...extra,
				} as never,
			}),
		);
		await flushSession(agent.session);
	};
	rt.postToRoom = host.postToRoom;

	// A member the round moved on from (it went on working, went quiet or waited for an
	// approval) posts what its turn ended with. The member that asked for it and anyone
	// it names answer. When multiple members were called in one batch, each result posts
	// as soon as it is ready, and the caller is woken once when the last member in the
	// batch finishes.
	host.lateRoomReply = async (sessionId, info, reply, { shown = false } = {}) => {
		const owner = rt.groupOwners.get(sessionId);
		const saved = rt.roomOf(owner?.roomId ?? info.roomId);
		const member = rt.botOf(owner?.botId);
		if (saved === undefined || member === undefined) return;
		const room = asRoom(saved);
		if (!room.members.includes(member.id)) return;
		const text = stripOwnName(member.name, reply);
		// While a DSH subagent of this member is still running, the member's work is not
		// finished yet: post any non-empty text as a progress line and keep its batch open.
		if (rt.hasSubagents?.(sessionId) === true) {
			if (!isPass(text)) {
				const calls = host.callsIn(room, member, text);
				await host
					.postToRoom(room, member, text, { progress: true, ...(!calls ? { quiet: true } : {}) })
					.catch((error: unknown) =>
						rt.warn("ocean-crew: subagent progress from %s failed: %s", member.name, error),
					);
			}
			return;
		}
		const batchKey = host.batchKeyOf(room.id, member.id);
		const currentBatch = host.memberBatch.get(batchKey);
		const batch =
			currentBatch !== undefined && (info.role !== "room" || info.askedBy === currentBatch.by)
				? currentBatch
				: undefined;
		const askedBy = info.role === "room" ? info.askedBy : (info.askedBy ?? batch?.by);
		// The batch remembers where the goal stood when it called this member; the late
		// result keeps that revision even if the goal moved on meanwhile.
		const dispatchGoal = batch?.goal;
		// The admin asked for this result: its goal task is reported at once, even
		// while the other members of the batch still work.
		if (askedBy === room.admin && (!isPass(text) || shown)) rt.goalTaskReported?.(room.id, member.id);
		const named = mentionsIn(text, room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[]).found.filter(
			(bot) => bot.id !== member.id,
		);
		let waitingPeers = false;
		let batchDoneBefore = false;
		if (batch !== undefined) {
			if (named.length > 0) batch.answered = true;
			if (!isPass(text) || shown) batch.done.push(member.name);
			if (!isPass(text)) host.noteBatchResult(room, batch, member.id, member.name, text);
			host.dropMemberFromBatch(room, member.id);
			waitingPeers = batch.pending.size > 0;
			batchDoneBefore = !waitingPeers && batch.done.length > 0 && !batch.answered;
		}
		if (waitingPeers && named.length === 0) {
			if (!isPass(text)) {
				if (!roundRunning(room)) host.noteLateGoal(room, member.id, dispatchGoal);
				await host
					.postToRoom(room, member, text, {
						late: true,
						quiet: true,
						...(dispatchGoal !== undefined ? { dispatchGoal } : {}),
					})
					.catch((error: unknown) =>
						rt.warn("ocean-crew: late group reply from %s failed: %s", member.name, error),
					);
			}
			return;
		}
		const done = isPass(text) && (shown || batchDoneBefore) && askedBy !== undefined;
		if (isPass(text) && !done) return;
		if (!isPass(text) && !roundRunning(room)) host.noteLateGoal(room, member.id, dispatchGoal);
		await host
			.postToRoom(room, member, done ? "" : text, {
				late: true,
				...(done ? { done: true } : {}),
				...(askedBy ? { askedBy } : {}),
				...(dispatchGoal !== undefined ? { dispatchGoal } : {}),
			})
			.catch((error: unknown) => rt.warn("ocean-crew: late group reply from %s failed: %s", member.name, error));
	};
	rt.lateRoomReply = host.lateRoomReply;

	// What a member says while it works, into the group. While the member holds its place
	// in a round, it joins that round. Later, it joins whatever round runs in the group, or
	// posts on its own. Only the members it calls with @ answer it; the member that asked
	// for the work answers the result.
	host.postStep = async (sessionId, info, text) => {
		const waiter =
			info?.role === "room" && info.exchangeId !== undefined ? rt.roomWaiters.get(info.exchangeId) : undefined;
		if (waiter !== undefined) return waiter.say(text);
		const found = host.memberIn(sessionId, info);
		if (found === undefined) return;
		const { room, member } = found;
		host.ensureRoomLog(room);
		const calls = host.callsIn(room, member, text);
		const running = [...rt.roomProgress.values()].find((round: Round) => round.roomId === room.id) as
			| Round
			| undefined;
		if (!calls && running !== undefined) {
			host.postInRound(room, running, member, text);
			return;
		}
		const quiet = !calls;
		await rt.save();
		await host.postToRoom(room, member, text, { progress: true, ...(quiet ? { quiet: true } : {}) });
	};

	// Lines a member writes close together reach the group as one message, so a burst of
	// steps does not come out as a string of messages. Its first line on work it was asked
	// for and a line that calls a member go at once; lines still held when the turn ends
	// open its result. Per group Session.
	ctx.effect(
		() => () => {
			for (const entry of host.held.values()) clearTimeout(entry.timer);
		},
		"ocean-crew: group step lines",
	);
	const flushSteps = (sessionId: string): Promise<void> | undefined => {
		const entry = host.held.get(sessionId);
		if (entry === undefined) return undefined;
		clearTimeout(entry.timer);
		entry.timer = undefined;
		if (entry.lines.length === 0) return undefined;
		entry.last = now();
		return host.postStep(sessionId, entry.info, entry.lines.splice(0).join("\n\n"));
	};
	host.flushSteps = flushSteps;
	host.roomStepText = async (sessionId, info, raw, first) => {
		const found = host.memberIn(sessionId, info);
		if (found === undefined) return;
		const { room, member } = found;
		const text = stripOwnName(member.name, raw);
		if (isPass(text)) return;
		const entry = host.held.get(sessionId) ?? { last: 0, lines: [] };
		host.held.set(sessionId, entry);
		entry.info = info;
		entry.lines.push(text);
		if (
			(first && info?.role === "room") ||
			host.callsIn(room, member, text) ||
			now() - entry.last >= timing.stepGapMs
		)
			return flushSteps(sessionId);
		entry.timer ??= setTimeout(
			() =>
				void flushSteps(sessionId)?.catch((error: unknown) =>
					rt.warn("ocean-crew: step lines from %s not posted: %s", member.name, error),
				),
			entry.last + timing.stepGapMs - now(),
		);
	};
	rt.roomStepText = host.roomStepText;
	host.takeRoomSteps = (sessionId) => {
		const entry = host.held.get(sessionId);
		if (entry === undefined) return "";
		clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.last = now();
		return entry.lines.splice(0).join("\n\n");
	};
	rt.takeRoomSteps = host.takeRoomSteps;
	host.withRoomSteps = (lines, reply) => (lines === "" ? reply : isPass(reply) ? lines : `${lines}\n\n${reply}`);
	rt.withRoomSteps = host.withRoomSteps;

	// The round said such a member posts when done; a failed model call is how it ended.
	// Nobody answers it unless other members of its batch already finished and waited on
	// the barrier for this member.
	host.lateRoomFailure = async (sessionId, info, failure) => {
		const owner = rt.groupOwners.get(sessionId);
		const saved = rt.roomOf(owner?.roomId ?? info.roomId);
		const member = rt.botOf(owner?.botId);
		if (saved === undefined || member === undefined) return;
		const room = asRoom(saved);
		if (!room.members.includes(member.id)) return;
		const dispatchGoal = host.memberBatch.get(host.batchKeyOf(room.id, member.id))?.goal;
		const batch = host.dropMemberFromBatch(room, member.id);
		const wakeCaller =
			batch !== undefined && batch.pending.size === 0 && batch.done.length > 0 && !batch.answered
				? batch.by
				: undefined;
		const { code, status, message } = failure;
		rt.goalTaskReset?.(room.id, member.id, "Could not finish: its model call failed");
		host.noteFailure(room, member.name, failure);
		await host
			.postToRoom(room, member, `Could not finish: its model call failed (${failureLine(failure)}).`, {
				late: true,
				...(wakeCaller ? { askedBy: wakeCaller } : { quiet: true }),
				failed: { code, ...(status ? { status } : {}), message },
				...(dispatchGoal !== undefined ? { dispatchGoal } : {}),
			})
			.catch((error: unknown) => rt.warn("ocean-crew: late group failure from %s failed: %s", member.name, error));
	};
	rt.lateRoomFailure = host.lateRoomFailure;

	// A group the user just made opens with its admin asking what the group is for.
	host.greetRoom = async (roomId) => {
		const saved = rt.roomOf(roomId);
		if (!saved?.admin) return;
		const room = asRoom(saved);
		const agent = await rt.resolveAgent(rt.sessionOfRoom(savedRoom(room)));
		agent.followup(
			createUserMessage({
				content: [{ type: "text", text: "[Group chat created]" }] as never,
				source: {
					kind: SOURCE_KIND,
					form: "relay",
					role: "kickoff",
					exchangeId: randomUUID(),
					senderName: "You",
					roomId: room.id,
				} as never,
			}),
		);
		await flushSession(agent.session);
	};
	rt.greetRoom = host.greetRoom;

	host.reportRound = async (room, post, round) => {
		const reportGoal = round.reports?.find(
			(entry) => entry.post.botId === post.botId && (post.sub === undefined || entry.post.sub === post.sub),
		)?.goal;
		const revisionNote =
			reportGoal?.revision !== undefined &&
			room.goal?.revision !== undefined &&
			room.goal.revision !== reportGoal.revision
				? `These results were asked for at goal revision ${reportGoal.revision}; the goal is now at revision ${room.goal.revision}, so check them against its current objective.`
				: "";
		const lines = round.replies
			.filter((reply) => reply.kind === undefined)
			.map((reply) => `${reply.name}: ${reply.text}`);
		const waiting = round.replies.filter((reply) => reply.kind === "approval").map((reply) => reply.name);
		const working = round.replies.filter((reply) => reply.kind === "working").map((reply) => reply.name);
		const text = [
			lines.length > 0
				? `Replies to your post (oldest first):\n${lines.join("\n")}`
				: "Nobody replied to your post.",
			working.length > 0
				? `Still working on it: ${working.join(", ")}. Each posts its result in the group when done, not to you; read_group_chat shows it.`
				: "",
			waiting.length > 0
				? `Waiting for the user's approval: ${waiting.join(", ")}. What they say afterwards is posted in the group, not sent to you; read_group_chat shows it.`
				: "",
			round.passed.length > 0 ? `Stayed silent: ${round.passed.join(", ")}.` : "",
			round.failed.length > 0
				? `Could not answer because their model call failed: ${round.replies
						.filter((reply) => reply.kind === "failed")
						.map(
							(reply) =>
								`${reply.name} (${failureLine({ code: String(reply.code), status: reply.status, message: String(reply.text) })})`,
						)
						.join(", ")}.`
				: "",
			revisionNote,
		]
			.filter(Boolean)
			.join("\n\n");
		// Replies the poster waited for go on with the work it posted for.
		const work = post.sub === undefined ? undefined : rt.closeWork?.(post.sub, `Group "${room.name}"`, text);
		// The report goes back to the conversation the post was written from: its
		// Session in that group when the post came from one, else the own chat.
		const back = rt.roomOf(post.fromRoomId as string | undefined)?.sessions?.[post.botId as string];
		await rt
			.deliver({
				toId: post.botId,
				...(back ? { sessionId: back } : {}),
				role: "report",
				roomId: room.id,
				text,
				...(work ? { work, replyTo: post.sub } : {}),
			})
			.catch((error: unknown) => rt.warn("ocean-crew: group report to %s failed: %s", post.name, error));
	};

	// A group chat's own Session never consults the model: models drift from "only call
	// group_relay" (they message one member directly when the user names it), so the
	// relay step is synthesized here. Auxiliary calls such as titles, and Ocean Crew's own
	// calls for the room such as image readings, still reach the model.
	listenGlobal(ctx, "llm/stream", (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => {
		if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest?.(options) === true)
			return next();
		return (async function* relayOrPass(): AsyncGenerator<unknown> {
			await rt.load();
			const room = rt.roomOf(options.sessionId as string);
			if (room === undefined) {
				yield* next();
				return;
			}
			// Plugins append context as user-role messages (time, attachments), so only a
			// message from the user, a scheduled task, or a Bot's post after the last model or
			// tool step starts a relay.
			const messages = (options.messages ?? []) as { role?: string; source?: { kind?: string; role?: string } }[];
			const opens = (message: { role?: string; source?: { kind?: string; role?: string } }): boolean =>
				message.role === "user" &&
				(message.source?.kind === "user" ||
					message.source?.kind === "schedule" ||
					(message.source?.kind === SOURCE_KIND &&
						(message.source.role === "post" ||
							message.source.role === "kickoff" ||
							message.source.role === "goal")));
			const latest = [...messages]
				.reverse()
				.find((message) => message.role === "assistant" || message.role === "tool" || opens(message));
			if (latest?.role !== "user") {
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			const declared = new Set(((options.tools ?? []) as { name: string }[]).map((tool) => tool.name));
			// Neither relay path is declared, so a synthesized call could only fail
			// unseen. The assemble scope keeps this unreachable; if it is reached the
			// step ends with a line the user can read instead.
			if (!declared.has("group_relay") && !declared.has("run_code")) {
				rt.warn("ocean-crew: group %s cannot relay: group_relay is not available in its Session", room.name);
				const text =
					"This group could not pass the message on: its relay tool is not available. Restart Ocean Crew; if it keeps happening, report it.";
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "text-delta", index: 0, text };
				yield { type: "block-end", index: 0, block: { type: "text", text } };
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			const id = `toolu_relay_${randomUUID().replace(/-/g, "")}`;
			// Only for a group made under the PTC preset, which can call nothing but run_code;
			// new group Sessions get the standard preset.
			const [name, args] =
				declared.has("run_code") && !declared.has("group_relay")
					? [
							"run_code",
							JSON.stringify({
								description: "Relay the group chat to its Bots",
								code: "return await tools.group_relay({})",
								timeoutMs: 600_000,
							}),
						]
					: ["group_relay", "{}"];
			yield { type: "block-start", index: 0, blockType: "tool-call" };
			yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: args };
			yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: args } };
			yield { type: "finish", reason: { kind: "tool-calls" } };
		})();
	});
}
