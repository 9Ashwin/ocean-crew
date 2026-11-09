// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes a
// turn it never finished as interrupted when the Session next opens, and a clean shutdown
// also cancels the messages still waiting in a Session's inbox; nothing would ever run
// either again, and whoever waited for them was not told. Ocean Crew notes each running
// Bot turn and each message it delivers until a turn takes it up, in inflight.json; what
// is still noted at the next start is picked up once.
//
// Settling a turn that ended while Ocean Crew was not

// or answered here.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_KIND } from "../core/constants.ts";
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000;

/** The trigger fields a picked-up turn needs to answer the same sender. */
interface ResumeTrigger {
	role?: string;
	exchangeId?: string;
	senderSessionId?: string;
	roomId?: string;
	work?: string;
	audience?: string;
	askedBy?: string;
	senderRoomId?: string;
}

/** One turn a shutdown cut off: who ran it where, and what it was answering. */
interface ResumeTurnRecord {
	botId: string;
	roomId?: string;
	since: number;
	trigger?: ResumeTrigger;
	approval?: { tool?: string; reason?: string };
	resumed?: boolean;
}

/** One delivery noted before it was sent; the args are kept whole. */
interface QueuedDelivery {
	at: number;
	args: any;
}

/** What the last run left behind: running turns and deliveries no turn took up. */
interface InflightNotes {
	turns: Record<string, ResumeTurnRecord>;
	queued: Record<string, QueuedDelivery[]>;
}

export const resumeText = (record: ResumeTurnRecord): string =>
	[
		"DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.",
		record.approval
			? `You were waiting for the user's approval to run ${record.approval.tool || "a tool"}${record.approval.reason ? ` (${record.approval.reason})` : ""}; that request is gone, so ask again if you still need it.`
			: "",
		"Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.",
	]
		.filter(Boolean)
		.join(" ");

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = (info: any): ResumeTrigger => ({
	role: info.role,
	...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
	...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
	...(info.roomId ? { roomId: info.roomId } : {}),
	...(info.work ? { work: info.work } : {}),
	...(info.audience ? { audience: info.audience } : {}),
	...(info.askedBy ? { askedBy: info.askedBy } : {}),
	...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
});

const readNotes = (file: string): InflightNotes => {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		const object = (value: unknown): Record<string, any> =>
			value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
		return { turns: object(parsed?.turns), queued: object(parsed?.queued) };
	} catch {
		return { turns: {}, queued: {} };
	}
};

export function install(rt: Runtime): void {
	const { ctx, home } = rt;
	const file = join(home, "inflight.json");
	// A test shortens the wait; the team starts its pickup once DSH has opened its workspaces.
	const delayMs = typeof rt.resumeDelayMs === "number" ? rt.resumeDelayMs : RESUME_DELAY_MS;

	// What the last run left; read before this run notes anything.
	let interrupted: InflightNotes = readNotes(file);

	let turns: Record<string, ResumeTurnRecord> = {};
	// A new delivery can persist before recovery runs; it must keep the old queue.
	let queued: Record<string, QueuedDelivery[]> = interrupted.queued;
	let writing: Promise<void> = Promise.resolve();
	let stopped = false;
	let latest: string | undefined;
	let due = false;
	const persist = (): void => {
		// Only the host that saves the team runs its work again.
		if (stopped || rt.readOnly() !== undefined) return;
		latest = JSON.stringify({ turns, queued });
		// One write waits at a time and takes the latest notes, so a busy round does not
		// write the file once per change.
		if (due) return;
		due = true;
		// Written in place: a rename over the file fails on Windows while anything reads
		// it, and a torn write only loses what one restart would pick up.
		writing = writing
			.then(async () => {
				due = false;
				const snapshot = latest;
				await mkdir(home, { recursive: true });
				await writeFile(file, snapshot ?? "", "utf8");
			})
			.catch((error: unknown) => rt.warn("ocean-crew: noting running turns failed: %s", error));
	};
	const update = (
		id: string,
		change: (record: ResumeTurnRecord | undefined) => ResumeTurnRecord | undefined,
	): void => {
		const next = change(turns[id]);
		if (next === turns[id]) return;
		turns = { ...turns };
		if (next === undefined) delete turns[id];
		else turns[id] = next;
		persist();
	};
	const forgetQueued = (exchangeId: string | undefined): void => {
		if (exchangeId === undefined) return;
		for (const [sessionId, list] of Object.entries(queued)) {
			const at = list.findIndex((item) => item.args.exchangeId === exchangeId);
			if (at === -1) continue;
			const rest = list.toSpliced(at, 1);
			queued = { ...queued };
			if (rest.length === 0) delete queued[sessionId];
			else queued[sessionId] = rest;
			persist();
			return;
		}
	};

	const deliverOriginal = rt.deliver as (args: any) => Promise<any>;
	rt.deliver = async (args: any): Promise<any> => {
		const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() };
		const sessionId = noted.sessionId ?? rt.chatOf(noted.toId);
		// Noted before it is sent: a turn may take it up before the send returns. Notes are
		// kept whole; nothing waits out a delivery silently.
		queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: noted }] };
		persist();
		try {
			return await deliverOriginal(noted);
		} catch (error) {
			// A delivery that never reached the inbox stays noted: the next start sends it
			// again. One whose Bot is gone is dropped, since it can never be sent.
			if (rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId);
			throw error;
		}
	};

	// What a Session was sent and no turn has read yet.
	rt.unreadOf = (sessionId: string): any[] => (queued[sessionId] ?? []).map((item) => item.args);
	rt.forgetDelivery = forgetQueued;

	// A message is done with once a turn takes it up, or once it leaves the inbox untaken
	// while Ocean Crew runs: the user stopped the Bot, or Ocean Crew moved or withdrew it.
	listenGlobal(ctx, "agent/inbox/discarded", ({ message }: any = {}) => {
		if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId);
	});
	// Exchanges a turn took up since this start, until the resends are done, so a resend
	// never repeats one.
	let taken: Set<string> | undefined = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined;
	// The first turn event of each Session since this start, until the noted turns are
	// picked up. A turn that ends, or still runs, before one starts here outlived the
	// last run: only Ocean Crew restarted (the plugin reloaded) and DSH went on.
	let firstTurn: Map<string, { type: string; turn?: number; reason?: any }> | undefined =
		Object.keys(interrupted.turns).length > 0 ? new Map() : undefined;
	listenGlobal(ctx, "session/event", (session: any, event: any) => {
		const id = session?.id;
		if (id === undefined) return;
		if ((event.type === "turn/start" || event.type === "turn/end") && firstTurn?.has(id) === false) {
			firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason });
		}
		if (event.type === "user/message" && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
			taken?.add(event.data.source.exchangeId);
			forgetQueued(event.data.source.exchangeId);
		}
		if (!rt.isBotSession(id)) return;
		switch (event.type) {
			case "turn/start": {
				const owner = rt.groupOwners.get(id);
				const botId = owner?.botId ?? rt.chatOwners.get(id);
				// turns.js runs first and has already claimed or restored the trigger.
				const info = rt.live?.get(id)?.info;
				update(id, () => ({
					botId: botId as string,
					...(owner ? { roomId: owner.roomId } : {}),
					since: event.time ?? Date.now(),
					...(info !== undefined ? { trigger: triggerOf(info) } : {}),
				}));
				break;
			}
			case "user/message": {
				if (event.data?.source?.kind !== SOURCE_KIND) break;

				const info = rt.live?.get(id)?.info;
				update(id, (record) =>
					record === undefined || record.trigger !== undefined || info === undefined
						? record
						: { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) },
				);
				break;
			}
			case "turn/end": {
				// DSH stops every turn as it shuts down; that one is picked up at the next start.
				const reason = event.data?.reason;
				if (reason?.kind === "aborted" && reason.reason?.kind === "disposed") break;
				update(id, () => undefined);
				break;
			}
		}
	});

	// An approval the restart drops is named when the turn is picked up.
	rt.noteApproval = (sessionId: string, approval: { tool?: string; reason?: string } | undefined): void =>
		update(sessionId, (record) => {
			if (record === undefined) return record;
			if (approval === undefined) {
				const { approval: _gone, ...rest } = record;
				return rest;
			}
			return { ...record, approval };
		});

	async function resumeTurn(sessionId: string, record: ResumeTurnRecord): Promise<void> {
		const bot = rt.botOf(record.botId);
		if (bot === undefined) return;
		const text = resumeText(record);
		if (record.roomId !== undefined) {
			const room = rt.roomOf(record.roomId);
			if (room === undefined || !room.members.includes(bot.id)) return;
			await rt.postToRoom?.(room, bot, "", {
				resumed: true,
				quiet: true,
				...(record.resumed ? { again: true } : {}),
			});
			// A turn already picked up once and cut off again stays stopped: a restart loop
			// must not run it forever.
			if (record.resumed) return;
			await rt.deliver({
				toId: bot.id,
				sessionId: room.sessions?.[bot.id] ?? sessionId,
				role: "room",
				roomId: room.id,
				note: "picking up after a restart",
				resumed: true,
				text,
				...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}),
			});
			return;
		}
		if (record.resumed) return;
		const trigger = record.trigger;
		if (
			(trigger?.role === "request" || trigger?.role === "stopped") &&
			trigger.senderSessionId &&
			trigger.audience !== "user" &&
			rt.botOf(trigger.senderSessionId)
		) {
			// The sender still waits for this turn's answer, so it goes on under the same exchange.
			await rt.deliver({
				fromId: trigger.senderSessionId,
				toId: bot.id,
				role: trigger.role,
				...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}),
				...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}),
				resumed: true,
				text,
			});
			return;
		}
		// A turn that went on with work another Bot asked for still owes that Bot its answer.
		await rt.deliver({
			toId: bot.id,
			role: "resume",
			resumed: true,
			text,
			...(trigger?.work ? { work: trigger.work } : {}),
		});
	}

	// Where a queued note goes now: its Session if it still is one, else the current
	// Session of its Bot, or of its group when the message went to one.
	const sessionFor = (sessionId: string, args: any): string | undefined =>
		rt.isBotSession(sessionId)
			? sessionId
			: args?.roomId === undefined
				? rt.chatOf(args?.toId)
				: rt.roomOf(args.roomId)?.sessions?.[args.toId];

	const resolveAgentOf = async (sessionId: string): Promise<any> => {
		try {
			return await rt.resolveAgent?.(sessionId);
		} catch {
			return undefined;
		}
	};

	// A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
	// cancelled is sent again. The notes stay queued until a turn takes the messages up,
	// so a send that fails here, or a Session that cannot be opened, leaves them for the
	// next start instead of losing them.
	async function resendQueued(sessionId: string, list: QueuedDelivery[]): Promise<void> {
		const fresh = list.filter(
			(item) =>
				rt.botOf(item.args?.toId) !== undefined &&
				sessionFor(sessionId, item.args) !== undefined &&
				taken?.has(item.args.exchangeId) !== true,
		);
		if (fresh.length === 0) return;
		const target = sessionFor(sessionId, fresh[0].args) as string;
		const agent = await rt.resolveAgent(target);
		const waiting = new Set<string | undefined>(
			[...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(
				(message: any) => message.source?.exchangeId,
			),
		);
		for (const { args } of fresh) {
			if (waiting.has(args.exchangeId)) continue;
			if (taken?.has(args.exchangeId) === true) {
				forgetQueued(args.exchangeId);
				continue;
			}
			// A request that waited through a restart reaches its target late: the work it is
			// for is marked, so the answer that comes back says so.
			if (args.role === "request" || args.role === "stopped") rt.lateWork?.(args.exchangeId);
			await deliverOriginal({ ...args, sessionId: sessionFor(sessionId, args), steer: false, resent: true }).catch(
				(error: unknown) => rt.warn("ocean-crew: sending again what %s was sent failed: %s", sessionId, error),
			);
		}
	}

	async function resumeAll(): Promise<void> {
		await rt.load();
		if (rt.readOnly() !== undefined) return;
		const { turns: noted, queued: dropped } = interrupted;
		interrupted = { turns: {}, queued: {} };
		// What the last run still had on the way is noted again first, under the Session it
		// would go to now: nothing is cleared before it is handed over. A Bot that is gone
		// takes its notes with it; what a turn already read here is done with.
		const pending = queued;
		queued = {};
		for (const [oldId, list] of Object.entries(pending)) {
			if (!Array.isArray(list)) continue;
			for (const item of list) {
				if (
					item?.args?.exchangeId === undefined ||
					taken?.has(item.args.exchangeId) === true ||
					rt.botOf(item.args.toId) === undefined
				)
					continue;
				const key = sessionFor(oldId, item.args) ?? oldId;
				queued = { ...queued, [key]: [...(queued[key] ?? []), item] };
			}
		}
		persist();
		// Agents and inboxes are read before anything wakes their Sessions.
		const cut: Array<[string, ResumeTurnRecord]> = [];
		for (const [sessionId, record] of Object.entries(noted)) {
			const first = firstTurn?.get(sessionId);
			if (first?.type === "turn/end") {
				rt.warn(
					"ocean-crew: the turn of %s ended while Ocean Crew was not watching it, so its result could not be reconciled",
					sessionId,
				);
				continue;
			}
			// Still running: noted again, as if it had started here.
			if (first === undefined && (await resolveAgentOf(sessionId))?.status === "running")
				update(sessionId, () => record);
			else cut.push([sessionId, record]);
		}
		firstTurn = undefined;
		for (const [sessionId, list] of Object.entries(dropped)) {
			if (!Array.isArray(list)) continue;
			await resendQueued(sessionId, list).catch((error: unknown) =>
				rt.warn("ocean-crew: sending again what %s was sent failed: %s", sessionId, error),
			);
		}
		taken = undefined;
		for (const [sessionId, record] of cut) {
			await resumeTurn(sessionId, record).catch((error: unknown) =>
				rt.warn("ocean-crew: picking up the turn of %s failed: %s", sessionId, error),
			);
		}
	}

	ctx.effect(() => {
		const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0;
		const timer = pending
			? setTimeout(
					() =>
						void resumeAll().catch((error: unknown) =>
							rt.warn("ocean-crew: picking up interrupted work failed: %s", error),
						),
					delayMs,
				)
			: undefined;
		timer?.unref?.();
		// What the turns stopped by this shutdown left stays as last noted.
		return () => {
			stopped = true;
			clearTimeout(timer);
			return writing;
		};
	}, "ocean-crew: resume interrupted turns");
}
