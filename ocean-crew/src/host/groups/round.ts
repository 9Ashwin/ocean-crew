// The round engine: who answers, in what order, and what the group does while a member
// works. A call takes effect as soon as the message that makes it is posted; members
// called together start together, plain messages are answered one at a time (admin
// first), a member answers one call at a time, and work past the grace lets the round
// go on while the member's late reply still reaches the group.

import { randomUUID } from "node:crypto";
import { TEAM_TOOLS } from "../core/constants.ts";
import { splitRef } from "../core/text.ts";
import {
	goalFields,
	isIdleRelayText,
	isPass,
	lostSession,
	mentionsIn,
	mentionsOf,
	normalizeRelayBody,
	stripOwnName,
} from "./log.ts";
import type {
	BotLike,
	CallBatch,
	GroupHost,
	GroupRoom,
	RoomSource,
	RoomWaiter,
	Round,
	Slot,
	TurnFailure,
	TurnResult,
} from "./types.ts";
import { asRoom, savedRoom } from "./types.ts";

// The team's own tools are quick; any other tool is the start of work.
const QUICK_TOOLS = new Set(TEAM_TOOLS);

// Wires the round into the host and publishes its members on rt.
export function installRound(host: GroupHost): void {
	const { rt, ctx } = host;
	const timing = host.timing;

	// A member's group Session, created on its first turn there. A new one starts with
	// a fresh look at the log and a brief of the member's own chat; the brief is the
	// first message, so it stays fixed and the prefix stays cacheable.
	host.groupSessionFor = async (room, member) => {
		room.sessions ??= {};
		const known = room.sessions[member.id];
		if (known !== undefined) {
			await rt.ensureCapabilities?.(known);
			return { id: known, brief: undefined };
		}
		const id = await rt.createSession(`${member.name} · ${room.name}`, {
			dir: rt.workDirOf?.({ botId: member.id, roomId: room.id }),
		});
		// While the Session was made the member may have left or been deleted, the group
		// been deleted, or another turn made the member's Session first: the new one is
		// not kept. Undefined means the member is gone from the group.
		const gone =
			(rt.roomOf(room.id) as unknown) !== (room as unknown) ||
			!room.members.includes(member.id) ||
			rt.botOf(member.id) === undefined;
		if (gone || room.sessions?.[member.id] !== undefined) {
			void ctx.workspaceRegistry
				?.archiveSession?.(id, { stopActivity: true })
				?.catch((error: unknown) =>
					rt.warn("ocean-crew: unused group Session of %s in %s not archived: %s", member.name, room.name, error),
				);
			return gone ? undefined : host.groupSessionFor(room, member);
		}
		room.sessions[member.id] = id;
		rt.groupOwners.set(id, { botId: member.id, roomId: room.id });
		delete room.seen[member.id];
		const ref = await rt.desiredModel?.(member);
		if (ref !== undefined) {
			const effort = await rt.desiredEffort?.(member, ref);
			await rt
				.selectSessionModel?.(id, {
					...splitRef(ref),
					...(effort === undefined ? {} : { reasoningEffort: effort }),
				})
				?.catch((error: unknown) =>
					rt.warn("ocean-crew: model for %s in %s not applied: %s", member.name, room.name, error),
				);
		}
		await rt
			.applyPermission?.(member, id, room)
			?.catch((error: unknown) =>
				rt.warn("ocean-crew: permission for %s in %s not applied: %s", member.name, room.name, error),
			);
		await rt.save();
		// The Session was resolved before the group owned it, so its scoped tools land now.
		await rt
			.resolveAgent?.(id)
			?.catch((error: unknown) =>
				rt.warn("ocean-crew: scoped tools for %s in %s not applied: %s", member.name, room.name, error),
			);
		await rt.ensureCapabilities?.(id);
		return { id, brief: await rt.ownChatBrief?.(member) };
	};

	// Members whose turn or DSH subagent in this group is running, and since when.
	host.workingIn = (room) =>
		room.members.flatMap((id) => {
			const sessionId = room.sessions?.[id];
			const entry = rt.live.get(sessionId);
			const bot = rt.botOf(id);
			if (bot === undefined) return [];
			if (entry?.turn !== undefined) return [{ bot, since: entry.since ?? host.now() }];
			if (sessionId !== undefined && rt.hasSubagents?.(sessionId) === true) {
				const view = rt.roomWorkView?.() as Record<string, { botId: string; since: number }[]> | undefined;
				const subSince = view?.[room.id]?.find((item) => item.botId === id)?.since;
				return [{ bot, since: subSince ?? host.now() }];
			}
			return [];
		});
	// How many group lines a member has not been shown yet, counted the same way a
	// round counts the lines it carries over (unseenLines), so the number a speaker
	// reads is the number the member would get.
	host.unreadCount = (room, botId) => host.unseenLines(room, botId).length;
	host.minutesSince = (at) => Math.max(1, Math.round((host.now() - at) / 60000));

	// Active Bot-to-Bot call batches in groups: when Bot `by` calls one or more members
	// together (`@B @C`), the batch tracks which callees are still working so:
	// 1) a callee that finishes tool work within the round (< 15s) without writing `@by`
	//    still hands the result back to `by` (#619), and
	// 2) when multiple callees work in parallel, `by` is woken once when the last callee
	//    in the batch finishes rather than woken piecemeal on every early reply.
	const batchKeyOf = (roomId: string, botId: string): string => `${roomId}:${botId}`;
	host.pruneBatchPending = (room, batch) => {
		let changed = false;
		for (const otherId of batch.pending) {
			if (!room.members.includes(otherId) || !host.activeInRoom(room, otherId)) {
				batch.pending.delete(otherId);
				changed = true;
				if (host.memberBatch.get(batchKeyOf(room.id, otherId)) === batch)
					host.memberBatch.delete(batchKeyOf(room.id, otherId));
			}
		}
		if (changed) host.saveBatch(room, batch);
	};
	host.activeInRoom = (room, botId) => {
		const sessionId = room.sessions?.[botId];
		if (
			sessionId !== undefined &&
			(rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true)
		)
			return true;
		const rounds = [...rt.roomProgress.values()] as Round[];
		return rounds.some(
			(round) =>
				round.roomId === room.id &&
				round.slots.some((slot) => slot.id === botId && (slot.status === "waiting" || slot.status === "speaking")),
		);
	};
	host.registerBatch = (roomId, by, callees, callId) => {
		if (by === undefined || callees.length === 0) return undefined;
		const saved = rt.roomOf(roomId);
		if (saved === undefined) return undefined;
		const batch: CallBatch = {
			key: randomUUID(),
			roomId,
			by,
			callees: callees.map((peer) => peer.id),
			pending: new Set(callees.map((peer) => peer.id)),
			done: [],
			worked: false,
			answered: false,
			state: "open",
			...(callId !== undefined ? { callId } : {}),
			...(host.goalAt(roomId) !== undefined ? { goal: host.goalAt(roomId) } : {}),
		};
		host.roomBatches.set(batch.key, batch);
		host.saveBatch(asRoom(saved), batch);
		for (const peer of callees) {
			const mKey = batchKeyOf(roomId, peer.id);
			const prev = host.memberBatch.get(mKey);
			if (prev !== undefined) {
				prev.pending.delete(peer.id);
				if (prev.pending.size === 0) {
					host.roomBatches.delete(prev.key);
					host.settleBatch(asRoom(saved), prev);
				}
			}
			host.memberBatch.set(mKey, batch);
		}
		return batch.key;
	};
	host.markBatchWorked = (roomId, botId) => {
		const batch = host.memberBatch.get(batchKeyOf(roomId, botId));
		if (batch === undefined || batch.worked) return;
		batch.worked = true;
		const saved = rt.roomOf(roomId);
		if (saved !== undefined) host.saveBatch(asRoom(saved), batch);
	};
	host.dropMemberFromBatch = (room, botId) => {
		const mKey = batchKeyOf(room.id, botId);
		const batch = host.memberBatch.get(mKey);
		if (batch === undefined) return undefined;
		host.memberBatch.delete(mKey);
		batch.pending.delete(botId);
		host.pruneBatchPending(room, batch);
		if (batch.pending.size === 0) {
			host.roomBatches.delete(batch.key);
			host.settleBatch(room, batch);
			void rt
				.goalSettled?.(room, batch)
				?.catch?.((error: unknown) => rt.warn("ocean-crew: goal settle in %s failed: %s", room.name, error));
		}
		return batch;
	};

	// A member's message in the round: in the log, for the members after it, and in the
	// round's replies, for the user.
	host.postInRound = (room, round, member, text, duration) => {
		const batch = host.memberBatch.get(batchKeyOf(room.id, member.id));
		const goal = goalFields(batch?.goal);
		host.appendRoom(room, { who: member.name, botId: member.id, text, ...goal });
		round.replies.push({
			botId: member.id,
			name: member.name,
			color: member.color,
			text,
			time: host.now(),
			...(duration === undefined ? {} : { duration }),
			...goal,
		});
		// A line in the group is what the user reads: it is the delivery of any summary
		// this Bot still owed, and of any hand-off result this Bot owed the room.
		host.deliverSummary(room, member.id, text);
		void rt.save().catch(() => {});
	};

	// One member turn inside the room; resolves to its final text, `{ failure }` when its
	// model call failed, `{ missed }` when it went quiet for too long, `{ approval }` when
	// it waits for the user's approval, `{ working }` when it goes on working without the
	// round, or null when the round was stopped.
	host.roomTurn = async (
		room,
		member,
		sessionId,
		{ text, images = [], files = [] },
		note,
		signal,
		round,
		by,
		said = [],
		heard = () => {},
		onWork = () => {},
	) => {
		if (signal.aborted) return null;
		const startedAt = host.now();
		const exchangeId = randomUUID();
		const turn = { botId: member.id, sessionId, exchangeId };
		const { started } = round;
		started.push(turn);
		// The read position is the one of this turn's start, and moves only when the
		// delivery lands: a delivery that failed leaves the member where it was.
		const seenAt = room.seq;
		// Checked before the delivery, which may start the turn at once.
		const busy = rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true;
		const done = new Promise<TurnResult>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let grace: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: TurnResult): void => {
				clearTimeout(timer);
				clearTimeout(grace);
				rt.roomWaiters.delete(exchangeId);
				resolve(value);
			};
			const touch = (): void => {
				clearTimeout(timer);
				timer = setTimeout(() => finish({ missed: true }), timing.replyTimeoutMs);
			};
			const work = (): void => {
				onWork();
				grace ??= setTimeout(() => finish({ working: true }), timing.workGraceMs);
			};
			const say = (raw: string): void => {
				const step = stripOwnName(member.name, raw);
				if (isPass(step)) return;
				said.push(step);
				host.postInRound(room, round, member, step, host.now() - startedAt);
				heard(step);
			};
			touch();
			rt.roomWaiters.set(exchangeId, {
				sessionId,
				botId: member.id,
				roomId: room.id,
				resolve: finish,
				fail: (failure: TurnFailure) => finish({ failure }),
				touch,
				work,
				say,
				approval: () => finish({ approval: true }),
			});
			signal.addEventListener("abort", () => finish(null), { once: true });
		});
		try {
			await rt.deliver({
				fromId: undefined,
				toId: member.id,
				sessionId,
				role: "room",
				roomId: room.id,
				exchangeId,
				note,
				text,
				images,
				files,
				steer: busy,
				...(by ? { askedBy: by } : {}),
			});
			// The prompt reached the member: its read position moves on.
			room.seen[member.id] = seenAt;

			if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval();
			// the round goes on.
			else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true });
		} catch (error) {
			rt.warn("ocean-crew: group delivery to %s failed: %s", member.name, error);
			// A delivery that failed is not a pass: the round shows it. Nothing here can
			// repair a lost Session, so the member's next turn in the group starts a new one.
			const lost = lostSession(error);
			if (lost && room.sessions?.[member.id] === sessionId) {
				rt.retireGroupSession(room as unknown as Parameters<typeof rt.retireGroupSession>[0], member.id);
				void rt.save().catch(() => {});
			}
			rt.roomWaiters.get(exchangeId)?.fail({
				code: lost ? "SESSION_RESET" : "SESSION",
				message: String((error as Error)?.message ?? error).slice(0, 300),
			});
		}
		const reply = await done;
		// A turn that ended leaves nothing for a stop to cancel.
		if ((typeof reply === "string" || reply?.failure !== undefined) && !rt.hasSubagents?.(sessionId))
			started.splice(started.indexOf(turn), 1);
		if (reply === null || typeof reply === "object") return reply;
		return stripOwnName(member.name, String(reply ?? "").trim());
	};

	// A member that reaches its context limit mid-turn goes on in a fresh Session, so a
	// waiter is also found by the member and group that Session now speaks for.
	const waitersOf = (sessionId: string): RoomWaiter[] => {
		const owner = rt.groupOwners.get(sessionId);
		return [...rt.roomWaiters.values()].filter(
			(waiter) =>
				waiter.sessionId === sessionId ||
				(owner !== undefined && waiter.botId === owner.botId && waiter.roomId === owner.roomId),
		);
	};
	host.touchRoomTurn = (sessionId) => {
		for (const waiter of waitersOf(sessionId)) waiter.touch();
	};
	host.failRoomTurn = (sessionId, failure) => {
		const waiters = waitersOf(sessionId);
		for (const waiter of waiters) waiter.fail(failure);
		return waiters.length > 0;
	};
	host.yieldRoomTurn = (sessionId) => {
		for (const waiter of waitersOf(sessionId)) waiter.approval();
	};
	host.workRoomTurn = (sessionId, tool) => {
		if (QUICK_TOOLS.has(tool)) return;
		const owner = rt.groupOwners.get(sessionId);
		if (owner !== undefined) host.markBatchWorked(owner.roomId, owner.botId);
		for (const waiter of waitersOf(sessionId)) waiter.work();
	};
	// The group Session's inbox changed: a running round looks for the user's messages
	// once DSH has finished the change.
	host.nudgeRoom = (roomId) => {
		for (const round of rt.roomProgress.values()) {
			if (round.roomId === roomId && round.nudge !== undefined) setImmediate(() => round.nudge?.());
		}
	};

	// Calls members into a round; the members one call names share a batch. Ordered calls
	// (a plain message everyone answers in turn) go ahead of the ordered calls still
	// waiting, in their own order; the others start as soon as their member is free.
	host.callIn = (
		round,
		callees,
		note,
		by,
		{ ordered = false, summaryBatch }: { ordered?: boolean; summaryBatch?: string } = {},
	) => {
		if (callees.length === 0) return;
		round.batches = (round.batches ?? 0) + 1;
		const batchKey = host.registerBatch(round.roomId, by, callees, round.callId);
		const goal = host.goalAt(round.roomId);
		let last: Slot | undefined;
		for (const peer of callees) {
			const waiting = round.slots.findIndex((slot) => slot.id === peer.id && slot.status === "waiting");
			const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true);
			const slot: Slot =
				waiting === -1
					? { id: peer.id, name: peer.name, status: "waiting", batch: round.batches }
					: round.slots[waiting];
			if (moves && waiting !== -1) round.slots.splice(waiting, 1);
			slot.note = note;
			slot.batch = round.batches;
			if (batchKey !== undefined) slot.batchKey = batchKey;
			if (goal !== undefined) slot.goal = goal;
			if (summaryBatch !== undefined) slot.summaryBatch = summaryBatch;
			if (by === undefined) delete slot.by;
			else slot.by = by;
			if (!moves) slot.ordered = false;
			else if (!ordered) round.slots.push(slot);
			else {
				slot.ordered = true;
				const queue = round.slots.findIndex((other) => other.ordered && other.status === "waiting");
				round.slots.splice(
					last ? round.slots.indexOf(last) + 1 : queue === -1 ? round.slots.length : queue,
					0,
					slot,
				);
				last = slot;
			}
		}
		round.nudge?.();
	};

	// Whether a waiting call can start now: its member answers nothing else in this
	// round, and an ordered call waits for the ordered calls before it.
	host.startable = (round, slot) => {
		if (slot.status !== "waiting" || round.slots.some((other) => other.id === slot.id && other.status === "speaking"))
			return false;
		if (!slot.ordered) return true;
		const at = round.slots.indexOf(slot);
		return round.slots.every(
			(other, index) =>
				!other.ordered ||
				other === slot ||
				(other.status !== "speaking" && !(other.status === "waiting" && index < at)),
		);
	};

	// Calls the idle ping-pong guard parked (`idle`) run once the user writes: in the
	// round the user's message opens, or in the running round that takes it in.
	host.releaseParked = (room, round) => {
		const parked = room.paused ?? [];
		const due = parked.filter((entry) => entry.idle !== true || round.userMessage === true);
		if (due.length === 0) return;
		const left = parked.filter((entry) => !due.includes(entry));
		if (left.length > 0) room.paused = left;
		else delete room.paused;
		for (const entry of due) {
			if (round.slots.some((slot) => slot.id === entry.id && slot.status === "waiting")) continue;
			const peer = rt.botOf(entry.id);
			const batchKey =
				peer && entry.by !== undefined ? host.registerBatch(room.id, entry.by, [peer], round.callId) : undefined;
			const goal = host.goalAt(room.id);
			round.batches = (round.batches ?? 0) + 1;
			round.slots.push({
				id: entry.id,
				name: entry.name,
				status: "waiting",
				batch: round.batches,
				...(batchKey !== undefined ? { batchKey } : {}),
				...(goal !== undefined ? { goal } : {}),
				...(entry.note !== undefined ? { note: entry.note } : {}),
				...(entry.by !== undefined ? { by: entry.by } : {}),
			});
		}
	};

	// The user's messages waiting in the group Session's inbox while a round runs, from
	// the composer whether it queued or steered them. Images and chat references are
	// only read when the Session takes the message itself, so a message with either
	// stays for the next round, and so does everything after it in that list.
	host.waitingLines = (agent) => {
		const api = agent as
			| { inbox?: { nextStep?: unknown[]; nextTurn?: unknown[]; remove?: (id: string) => boolean } }
			| undefined;
		return ["nextStep", "nextTurn"].flatMap((list) => {
			const lines: { id: string; text: string; via?: string }[] = [];
			for (const raw of (api?.inbox?.[list as "nextStep" | "nextTurn"] ?? []) as unknown[]) {
				const message = raw as { id?: string; source?: { kind?: string; rpcId?: string }; content?: unknown };
				if (message.source?.kind !== "user") continue;
				const content = Array.isArray(message.content)
					? (message.content as { type?: string; text?: string }[])
					: [];
				const text = content
					.map((block) => (block?.type === "text" ? String(block.text ?? "") : ""))
					.join("")
					.trim();
				if (text === "" || content.some((block) => block?.type !== "text") || text.includes("dsh-session:")) break;
				const via =
					typeof message.source?.rpcId === "string" && message.source.rpcId.startsWith("im:")
						? message.source.rpcId.split(":")[1]
						: undefined;
				lines.push({ id: String(message.id), text, ...(via ? { via } : {}) });
			}
			return lines;
		});
	};

	// Messages the user sent while this round is running post into the log at once, so
	// every turn that starts from now on sees them.
	host.drainRoomInbox = (room, round, agent) => {
		// The greeting's prompt tells the admin the user has not written yet.
		if (round.kickoff) return;
		const api = agent as { inbox?: { remove?: (id: string) => boolean } } | undefined;
		const lines = host.waitingLines(agent).filter((line) => api?.inbox?.remove?.(line.id) === true);
		if (lines.length === 0) return;
		host.unpauseRoomIdle(room);
		round.userMessage = true;
		rt.goalUserMessage?.(room.id);
		const members = room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[];
		for (const line of lines) {
			host.appendRoom(room, { who: "User", text: line.text, ...(line.via ? { via: line.via } : {}) });
			round.replies.push({
				kind: "user",
				text: line.text,
				time: host.now(),
				...(line.via ? { via: line.via } : {}),
			});
			const { all, found } = mentionsIn(line.text, members);
			const note = all || found.length > 0 ? "the user mentioned you" : "new message from the user";
			const { speakers, ordered } = host.openingCall(room, { text: line.text });
			host.callIn(round, speakers, note, undefined, { ordered });
		}
		host.releaseParked(room, round);
		void rt.save().catch(() => {});
	};

	// Consecutive idle steps in this room since the user last wrote here or a member worked
	// (#853). A step is one Bot turn that used no tool: the post that opens a round is not
	// a step of its own, so a round and the answer it gets count once.
	host.countIdleStep = (room) => {
		if (room.idlePaused !== undefined) return;
		room.idleRelays = (room.idleRelays ?? 0) + 1;
	};
	// Work or new content clears the streak, so a group that is working is never paused.
	// It does not lift a pause already in place: that is the user's to lift (#853).
	host.clearIdleStreak = (room) => {
		if (room.idlePaused !== undefined) return;
		if (room.idleRelays !== undefined) delete room.idleRelays;
	};
	// The user's own message lifts a pause.
	host.unpauseRoomIdle = (room) => {
		if (room.idleRelays !== undefined) delete room.idleRelays;
		if (room.idlePaused !== undefined) delete room.idlePaused;
	};
	// Whether an idle step must wait for the user: the room is paused, or this step reaches
	// the limit. Every call it would have made waits in `room.paused`.
	host.holdIdleCalls = (room, round, member, callees, { named = [], all = false } = {}) => {
		if (room.idlePaused === undefined && (room.idleRelays ?? 0) < timing.idleRelayLimit) return false;
		if (room.idlePaused === undefined)
			room.idlePaused = { from: member.id, count: room.idleRelays ?? timing.idleRelayLimit, noticed: false };
		if (callees.length > 0) {
			const parked = room.paused ?? [];
			for (const peer of callees) {
				if (parked.some((entry) => entry.id === peer.id)) continue;
				const note = named.includes(peer)
					? `${member.name} mentioned you`
					: all
						? `${member.name} called everyone`
						: `${member.name} posted in the group`;
				parked.push({ id: peer.id, name: peer.name, note, by: member.id, idle: true });
			}
			room.paused = parked;
		}
		host.announceRoomIdlePaused(room, round, member, callees);
		return true;
	};
	host.announceRoomIdlePaused = (room, round, member, callees) => {
		if (room.idlePaused === undefined || room.idlePaused.noticed === true) return;
		room.idlePaused.noticed = true;
		const names = callees.map((peer) => peer.name);
		host.appendRoom(room, {
			who: "Ocean Crew",
			kind: "notice",
			reason: "paused",
			idle: true,
			from: member.name,
			limit: timing.idleRelayLimit,
			names,
		});
		round.replies.push({
			kind: "paused",
			idle: true,
			botId: member.id,
			name: member.name,
			color: member.color,
			count: room.idlePaused.count ?? timing.idleRelayLimit,
			limit: timing.idleRelayLimit,
			names,
			time: host.now(),
		});
		void rt.save().catch(() => {});
	};

	// The members a member's message calls: those it names with @, or everyone when the
	// admin writes "@all" (only the admin, so a member cannot set off a storm). A turn
	// calls each member once, however many of its lines name it.
	host.callFrom = (room, round, member, text, called, { worked = false, byBot = false } = {}) => {
		const everyone = room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[];
		const others = everyone.filter((other) => other.id !== member.id);
		const { all, found: named } = mentionsIn(text, everyone);
		const found = named.filter((other) => other.id !== member.id);
		const callees = (
			rt.isAdminOf(savedRoom(room), member.id) && all
				? [...found, ...others.filter((other) => !found.includes(other))]
				: found
		).filter((peer) => !called.has(peer.id));
		// Counted before the callers below, because a status post calls nobody at all.
		let idleStep = false;
		const roundBodies = (): Map<string, string[]> => {
			round.botBodies ??= new Map<string, string[]>();
			return round.botBodies;
		};
		if (worked) {
			host.clearIdleStreak(room);
		} else if (byBot) {
			const history = roundBodies().get(member.id) ?? [];
			const norm = normalizeRelayBody(text, everyone);
			if (norm !== "") roundBodies().set(member.id, [...history, norm]);
			idleStep = isIdleRelayText(text, everyone, history);
			if (idleStep) host.countIdleStep(room);
			else host.clearIdleStreak(room);
		} else {
			const norm = normalizeRelayBody(text, everyone);
			if (norm !== "") roundBodies().set(member.id, [...(roundBodies().get(member.id) ?? []), norm]);
		}
		for (const peer of callees) called.add(peer.id);
		if (byBot && idleStep && host.holdIdleCalls(room, round, member, callees, { named, all })) return;
		if (callees.length === 0) return;
		host.callIn(round, callees, `${member.name} mentioned you`, member.id);
		// An @Name from the admin hands the member its goal task.
		if (rt.isAdminOf(savedRoom(room), member.id)) for (const peer of callees) rt.goalTaskWorking?.(room.id, peer.id);
	};

	// A round runs every call that can start, and wakes when a turn ends, a call comes
	// in, the user writes or the round is stopped.
	host.runRound = async (room, round, signal, agent) => {
		const turns = new Set<Promise<unknown>>();
		let due = true;
		let wake = (): void => {};
		round.nudge = () => {
			due = true;
			wake();
		};
		signal.addEventListener("abort", () => round.nudge?.(), { once: true });
		while (!signal.aborted) {
			if (!due)
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			due = false;
			if (signal.aborted) break;
			host.drainRoomInbox(room, round, agent);
			for (const slot of round.slots) {
				if (!host.startable(round, slot)) continue;
				const turn: Promise<void> = host
					.memberTurn(room, round, slot, signal)
					.catch((error: unknown) =>
						rt.warn("ocean-crew: group turn of %s in %s failed: %s", slot.name, room.name, error),
					)
					.finally(() => {
						turns.delete(turn);
						round.nudge?.();
					});
				turns.add(turn);
			}
			// The greeting round leaves the user's messages for a round of their own.
			if (
				turns.size === 0 &&
				!round.slots.some((slot) => slot.status === "waiting") &&
				(round.kickoff || host.waitingLines(agent).length === 0)
			)
				break;
		}
		await Promise.allSettled([...turns]);
		delete round.nudge;
		// The admin was alone with the user's message and passed: the round ends with
		// nothing said. The group says so once, so the user knows to call a member.
		const alone =
			round.soleAdmin !== undefined &&
			round.slots.find((slot) => slot.id === round.soleAdmin?.id)?.status === "passed";
		// An answer that came, or is still coming, means the round is not left silent.
		const answered = round.slots.some((slot) => ["posted", "working", "waiting-approval"].includes(slot.status));
		if (alone && !answered) {
			host.appendRoom(room, {
				who: "Ocean Crew",
				kind: "notice",
				reason: "admin-passed",
				names: [round.soleAdmin!.name],
			});
			// The round the user watched shows the same notice as one line of its replies.
			round.replies.push({
				kind: "admin-passed",
				botId: round.soleAdmin!.id,
				name: round.soleAdmin!.name,
				color: round.soleAdmin!.color,
				time: host.now(),
			});
			await rt.save();
		}
	};

	// A budget that is used up stops the turn before it spends anything, and says so once
	// per scope. The idle guard is a different mechanism and never reaches here.
	const blockForBudget = (
		room: GroupRoom,
		round: Round,
		slot: Slot,
		member: BotLike,
		side: "members" | "summary",
	): void => {
		slot.status = "failed";
		round.failed.push(member.name);
		host.dropMemberFromBatch(room, member.id);
		if (room.budget?.noticed?.[side] !== true) {
			room.budget ??= {};
			room.budget.noticed = { ...(room.budget.noticed ?? {}), [side]: true };
			const inGoal = room.goal?.status === "active";
			const text =
				side === "members"
					? `The group's member work budget is used up, so its members take no new work${inGoal ? " in this goal" : " in this task"}. ${inGoal ? "Revise or stop the goal to change it." : "The user can write here to start a new one."}`
					: `The group's summary budget is used up, so the caller cannot summarize these results. ${inGoal ? "Revise or stop the goal to change it." : "The user can write here to start a new task."}`;
			host.appendRoom(room, { who: "Ocean Crew", kind: "notice", reason: "budget", text });
			round.replies.push({ kind: "budget", botId: member.id, name: member.name, text, time: host.now() });
		}
		void rt.save().catch(() => {});
	};

	// One call's turn in the round. Its status says how it ended; what it says calls
	// members as soon as each line is posted.
	host.memberTurn = async (room, round, slot, signal) => {
		const member = rt.botOf(slot.id);
		// Settings may change mid-round, for example when the admin removes someone.
		if (member === undefined || !room.members.includes(slot.id)) {
			slot.status = "left";
			host.dropMemberFromBatch(room, slot.id);
			return;
		}
		// A summary turn was already charged against the summary budget when it was asked
		// for; any other turn spends the member budget.
		if (slot.summaryBatch === undefined) {
			if (!host.allowMemberWork(room)) {
				blockForBudget(room, round, slot, member, "members");
				return;
			}
			host.chargeWork(room, "members");
		}
		slot.status = "speaking";
		let session: { id: string; brief?: string } | undefined;
		try {
			session = await host.groupSessionFor(room, member);
		} catch (error) {
			rt.warn("ocean-crew: group Session for %s in %s failed: %s", member.name, room.name, error);
			slot.status = "failed";
			host.dropMemberFromBatch(room, member.id);
			round.failed.push(member.name);
			const failure = { code: "SESSION", message: String((error as Error)?.message ?? error).slice(0, 300) };
			round.replies.push({
				kind: "failed",
				botId: member.id,
				name: member.name,
				color: member.color,
				code: failure.code,
				text: failure.message,
				time: host.now(),
			});
			host.noteFailure(room, member.name, failure);
			return;
		}
		if (session === undefined) {
			slot.status = "left";
			host.dropMemberFromBatch(room, member.id);
			return;
		}
		await host.loadGroupLines(room);
		const prompt = host.roomPrompt(room, member, round, slot);
		round.shown?.push(member.id);
		const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`;
		const said: string[] = [];
		const called = new Set<string>();
		const startedAt = host.now();
		let worked = false;
		// A step answers a Bot when a Bot called it: by name, or the round a Bot's own post
		// opened (#853).
		const answeredBot = slot.by !== undefined || slot.fromBot === true;
		const onWork = (): void => {
			worked = true;
			slot.worked = true;
			host.clearIdleStreak(room);
			host.markBatchWorked(room.id, member.id);
		};
		const tokensBefore = await host.sessionTokens(session.id);
		const reply = await host.roomTurn(
			room,
			member,
			session.id,
			{ text, images: prompt.images, files: prompt.files },
			slot.note ?? "your turn",
			signal,
			round,
			slot.by,
			said,
			(line: string) => host.callFrom(room, round, member, line, called, { worked, byBot: answeredBot }),
			onWork,
		);
		const tokensAfter = await host.sessionTokens(session.id);
		host.chargeTokens(
			room,
			slot.summaryBatch !== undefined,
			tokensBefore !== undefined && tokensAfter !== undefined ? Math.max(0, tokensAfter - tokensBefore) : undefined,
		);
		const final = typeof reply === "string" && !isPass(reply) ? reply : undefined;
		const subRunning = rt.hasSubagents?.(session.id) === true;
		if (typeof reply === "object" && reply !== null && reply.failure !== undefined) {
			// Not a pass: the user sees why the member is silent, and the round goes on.
			slot.status = "failed";
			round.failed.push(member.name);
			const { code, status, message } = reply.failure;
			round.replies.push({
				kind: "failed",
				botId: member.id,
				name: member.name,
				color: member.color,
				code,
				...(status ? { status } : {}),
				text: message,
				time: host.now(),
			});
			host.noteFailure(room, member.name, reply.failure);
		} else if (typeof reply === "object" && reply !== null && reply.approval) {
			// The member's turn goes on in the background and posts when it ends.
			slot.status = "waiting-approval";
			round.replies.push({
				kind: "approval",
				botId: member.id,
				name: member.name,
				color: member.color,
				time: host.now(),
			});
		} else if (typeof reply === "object" && reply !== null && reply.working) {
			slot.status = "working";
			host.markBatchWorked(room.id, member.id);
			round.replies.push({
				kind: "working",
				botId: member.id,
				name: member.name,
				color: member.color,
				time: host.now(),
			});
		} else if (subRunning) {
			if (final !== undefined) {
				host.postInRound(room, round, member, final, host.now() - startedAt);
				host.callFrom(room, round, member, final, called, { worked: true, byBot: answeredBot });
			}
			slot.status = "working";
			host.markBatchWorked(room.id, member.id);
			round.replies.push({
				kind: "working",
				botId: member.id,
				name: member.name,
				color: member.color,
				time: host.now(),
			});
		} else if (final !== undefined || (typeof reply === "string" && said.length > 0)) {
			slot.status = "posted";
			if (final !== undefined) {
				host.postInRound(room, round, member, final, host.now() - startedAt);
				host.callFrom(room, round, member, final, called, { worked, byBot: answeredBot });
			}
		} else {
			slot.status = typeof reply === "string" ? "passed" : "missed";
			round.passed.push(member.name);
			if (typeof reply === "object" && reply !== null && reply.missed) {
				round.replies.push({
					kind: "missed",
					botId: member.id,
					name: member.name,
					color: member.color,
					time: host.now(),
				});
				// The round moved on without this member: the log shows the call and then
				// silence, which reads as a lost message. The group is told the baton was
				// dropped, and what brings the member back.
				host.appendRoom(room, {
					who: "Ocean Crew",
					kind: "notice",
					reason: "missed",
					names: [member.name],
					minutes: Math.round(timing.replyTimeoutMs / 60000),
				});
			}
		}
		// A result the admin asked for reports its goal task; a failed model call puts it back.
		if (slot.status === "posted" && slot.by === (room.admin ?? undefined) && final !== undefined)
			rt.goalTaskReported?.(room.id, member.id);
		if (typeof reply === "object" && reply !== null && reply.failure !== undefined)
			rt.goalTaskReset?.(room.id, member.id, "Could not finish: its model call failed");
		// Settle the member's place in its call batch when its work did not continue in the background.
		if (slot.status !== "working") {
			const batch =
				(slot.batchKey ? host.roomBatches.get(slot.batchKey) : undefined) ??
				host.memberBatch.get(batchKeyOf(room.id, member.id));
			if (batch !== undefined) {
				if (slot.status === "posted") {
					batch.done.push(member.name);
					if (called.size > 0) batch.answered = true;
					if (worked) batch.worked = true;
					if (final !== undefined) host.noteBatchResult(room, batch, member.id, member.name, final);
				}
				host.dropMemberFromBatch(room, member.id);
				// The batch owns the final-summary duty now; ask it once per round, and only
				// when the round did not abort under it.
				if (!signal.aborted && batch.pending.size === 0)
					host.askSummary(room, round, batch, `${batch.done.join(" and ")} finished the work you asked for`);
			}
		}
	};

	// A Bot that posts never answers its own post. @mentions choose the speakers; else
	// the admin answers alone in admin mode, or first of everyone. What a member posts
	// after its round moved on is answered by the member that asked for it.
	host.openingCall = (room, opener) => {
		const everyone = room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[];
		const members = everyone.filter((bot) => bot.id !== opener.botId);
		const admin = members.find((bot) => rt.isAdminOf(savedRoom(room), bot.id));
		const at = (speakers: BotLike[]): { speakers: BotLike[]; ordered: boolean } => ({ speakers, ordered: false });
		if (opener.kickoff) return at(admin ? [admin] : []);
		if (opener.quiet) return at([]);
		if (opener.done) return at(members.filter((bot) => bot.id === opener.askedBy));
		// A goal post — the user's draft ask, an idle goal check, a resume — is the admin's alone.
		if (opener.goal !== undefined) return at(admin ? [admin] : []);
		const mentions = mentionsOf(opener, everyone) ?? mentionsIn(opener.text ?? "", everyone, opener.references ?? []);
		const found = mentions.found.filter((bot) => bot.id !== opener.botId);
		if (opener.progress) return at(found);
		if (opener.late) return at(found.length > 0 ? found : members.filter((bot) => bot.id === opener.askedBy));
		if (opener.member) return at(found);
		if (found.length > 0 && !mentions.all) return at(found);
		if (!mentions.all && room.mode === "admin" && admin) return at([admin]);
		const speakers = admin ? [admin, ...members.filter((bot) => bot !== admin)] : members;
		return { speakers, ordered: !mentions.all && speakers.length > 1 };
	};
	host.openingSpeakers = (room, opener) => host.openingCall(room, opener).speakers;

	const memberIn = (
		sessionId: string,
		info: RoomSource | undefined,
	): { room: GroupRoom; member: BotLike } | undefined => {
		const owner = rt.groupOwners.get(sessionId);
		const saved = rt.roomOf(owner?.roomId ?? info?.roomId);
		const member = rt.botOf(owner?.botId);
		if (saved === undefined || member === undefined) return undefined;
		const room = asRoom(saved);
		return room.members.includes(member.id) ? { room, member } : undefined;
	};
	host.memberIn = memberIn;
	host.callsIn = (room, member, text) =>
		mentionsIn(text, room.members.map((id) => rt.botOf(id)).filter(Boolean) as BotLike[]).found.some(
			(bot) => bot.id !== member.id,
		);

	// The user stops a member's work in this group from the group's details, including
	// any running DSH subagents it spawned (#701). Messages still waiting for that
	// member here go with it.
	host.stopMemberWork = async (roomId, botId) => {
		await rt.load();
		const saved = rt.roomOf(roomId);
		const member = rt.botOf(botId);
		const sessionId = rt.own(saved?.sessions, botId);
		const turnRunning = sessionId !== undefined && rt.live.get(sessionId)?.turn !== undefined;
		const subRunning = sessionId !== undefined && rt.hasSubagents?.(sessionId) === true;
		if (saved === undefined || member === undefined || sessionId === undefined || (!turnRunning && !subRunning))
			return false;
		const room = asRoom(saved);
		host.dropMemberFromBatch(room, botId);
		await rt.stopSubagents?.(sessionId);
		if (turnRunning) {
			const agent = await rt.resolveAgent(sessionId);
			agent.cancel({ kind: "user" });
		}
		rt.goalTaskReset?.(roomId, botId, "Stopped by the user");
		await host.postToRoom(room, member, "", { quiet: true, stopped: true });
		return true;
	};
	rt.stopMemberWork = host.stopMemberWork;

	// The user stops everything at work in this group at once: the round the group's own
	// Session runs, which takes the member turns it started with it, then each member's
	// turn here. Work the same Bots do in their own chats or other groups goes on.
	host.stopRoomWork = async (roomId) => {
		await rt.load();
		const saved = rt.roomOf(roomId);
		if (saved === undefined) return false;
		const room = asRoom(saved);
		const failures: unknown[] = [];
		const attempt = async (work: () => Promise<unknown>): Promise<boolean> => {
			try {
				return (await work()) as boolean;
			} catch (error) {
				rt.warn("ocean-crew: stopping work in %s failed: %s", room.name, error);
				failures.push(error);
				return false;
			}
		};
		const round = rt.roomBusy?.(room.id);
		if (round)
			await attempt(async () => {
				const agent = await rt.resolveAgent(rt.sessionOfRoom(savedRoom(room)));
				agent.cancel({ kind: "user" });
				return true;
			});
		let stopped = false;
		for (const botId of room.members) stopped = (await attempt(() => host.stopMemberWork(room.id, botId))) || stopped;
		if (failures.length > 0) throw failures[0];
		return round || stopped;
	};
	rt.stopRoomWork = host.stopRoomWork;

	// What the views ask about the round.
	host.workingInRoom = host.workingIn;
	host.roomBatchPending = (roomId) => {
		if ([...host.roomBatches.values()].some((batch) => batch.roomId === roomId && batch.pending.size > 0))
			return true;
		// A host that has just restarted has the saved record before the in-memory batch.
		const saved = rt.roomOf(roomId);
		return saved !== undefined && Object.values(asRoom(saved).calls ?? {}).some((call) => call.state === "open");
	};

	// Publishes the round's turn hooks on rt for turns.ts/approvals.ts to call.
	Object.assign(rt, {
		touchRoomTurn: host.touchRoomTurn,
		failRoomTurn: host.failRoomTurn,
		yieldRoomTurn: host.yieldRoomTurn,
		workRoomTurn: host.workRoomTurn,
		nudgeRoom: host.nudgeRoom,
		workingInRoom: host.workingInRoom,
		roomBatchPending: host.roomBatchPending,
		callsRoomMember: (sessionId: string, info: RoomSource, raw: string) => {
			const found = memberIn(sessionId, info);
			return (
				found !== undefined && host.callsIn(found.room, found.member, stripOwnName(found.member.name, raw ?? ""))
			);
		},
	});
}
