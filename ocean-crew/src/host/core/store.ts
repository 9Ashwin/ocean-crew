// Store: the saved team (state.json), the lock that keeps a second DSH host on the same
// data from writing it, the migrations that bring an older team forward, and the
// indexes that map a Session to the Bot or group chat it belongs to.
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot, BotId, Exchange, Room, RoomLogLine, TeamState } from "../../shared/state.ts";
import { emptyTeam } from "../../shared/state.ts";
import { MAX_EXCHANGES, ROOM_MODES, TEXT_KEPT } from "./constants.ts";
import { replaceFile } from "./files.ts";
import { homeLock } from "./home-lock.ts";
import type { Runtime } from "./runtime.ts";
import { headOf, isColor, normalize, unquote } from "./text.ts";

/** The other DSH host that holds state.lock while this one only reads. */
interface LockHolder {
	pid?: number;
	host?: string;
	token?: string;
	since?: number;
}

// A table read that sees only the keys the table holds itself. Ids that come from
// outside (a request body, a tool argument, a name a model gives) go through this, so
// "__proto__" and other inherited names read as "not there" instead of returning
// Object.prototype.
export function own<T>(table: Record<string, T> | null | undefined, key: string): T | undefined {
	return table !== null && table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export function install(rt: Runtime): void {
	const { ctx, home, statePath } = rt;
	const state: TeamState = emptyTeam();
	let loaded: Promise<void> | undefined;
	let writing: Promise<void> = Promise.resolve();
	const { warn } = rt;
	let holder: LockHolder | null | undefined;
	let lockBroken = false;
	let stuck: string | undefined;
	let warnedReadOnly = false;
	let stopped = false;
	// mtime and size of the state.json this host last read or wrote.
	let seen = "";
	// Bumped each time the in-memory state is replaced from the file, so a queued save
	// cannot write a snapshot taken of the state it replaced.
	let lockEpoch = 0;
	const stamp = (): string => {
		try {
			const { mtimeMs, size } = statSync(statePath);
			return `${mtimeMs}:${size}`;
		} catch {
			return "";
		}
	};
	const lock = homeLock(join(home, "state.lock"));
	const claimLock = (): void => {
		if (lockBroken) return;
		try {
			mkdirSync(home, { recursive: true });
			holder = lock.claim();
		} catch (error) {
			// An unusable lock (a read-only or odd file system) must not stop the team; a
			// save that then cannot write still rejects.
			lockBroken = true;
			holder = undefined;
			warn("ocean-crew: cannot lock %s, so another dsh on the same data could undo changes: %s", home, error);
		}
	};
	const readOnly = (): string | undefined => {
		if (stuck !== undefined)
			return `The Bot team file ${statePath} could not be read (${stuck}). Ocean Crew does not change it; fix or move the file and reload.`;
		if (holder === undefined) return undefined;
		const where = holder?.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ""}` : "unknown process";
		return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`;
	};

	// Synchronous on purpose: the saved team and the session indexes built from it
	// exist before the first tool or shell env call can resolve a Session.
	const readFileState = (): TeamState | undefined => {
		let contents: string;
		try {
			contents = readFileSync(statePath, "utf8");
		} catch (error) {
			seen = stamp();
			if ((error as { code?: string })?.code === "ENOENT") {
				stuck = undefined;
				return undefined;
			}
			stuck = (error as { code?: string })?.code ?? (error as Error)?.message ?? String(error);
			warn("ocean-crew: unreadable state %s: %s", statePath, error);
			return undefined;
		}
		seen = stamp();
		let parsed: unknown;
		try {
			parsed = JSON.parse(contents);
		} catch (error) {
			const backup = `${statePath}.broken-${Date.now()}`;
			try {
				copyFileSync(statePath, backup);
				stuck = undefined;
				warn("ocean-crew: unreadable state %s: %s; backed up as %s", statePath, error, backup);
			} catch (copyError) {
				stuck =
					(copyError as { code?: string })?.code ??
					(copyError as Error)?.message ??
					(error as Error)?.message ??
					String(error);
				warn("ocean-crew: unreadable state %s: %s; backup failed: %s", statePath, error, copyError);
			}
			return undefined;
		}
		if ((parsed as { version?: unknown } | null)?.version === 1) {
			stuck = undefined;
			return parsed as TeamState;
		}
		stuck = "saved by a newer Ocean Crew; update Ocean Crew";
		return undefined;
	};

	// Fill `state` from the saved file and bring an older team up to date. Returns the
	// groups whose Session titles still need the new name.
	const adopt = (parsed: TeamState | undefined): { migrated: boolean; stale: Room[] } => {
		lockEpoch += 1;
		const hadCapabilities = parsed !== null && parsed !== undefined && Object.hasOwn(parsed, "capabilities");
		for (const key of Object.keys(state)) delete state[key];
		Object.assign(state, emptyTeam(), parsed ?? {});
		state.prefs ??= {};
		// Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
		if (state.agents === null || typeof state.agents !== "object" || Array.isArray(state.agents)) state.agents = {};
		let migrated = !hadCapabilities;
		if (state.capabilities === null || typeof state.capabilities !== "object" || Array.isArray(state.capabilities)) {
			state.capabilities = { items: {} };
			migrated = true;
		} else if (
			state.capabilities.items === null ||
			typeof state.capabilities.items !== "object" ||
			Array.isArray(state.capabilities.items)
		) {
			state.capabilities.items = {};
			migrated = true;
		}
		for (const bot of Object.values(state.bots) as Bot[]) {
			if (!Array.isArray(bot.capabilities)) {
				bot.capabilities = [];
				migrated = true;
			}
			if (bot.color !== undefined && !isColor(bot.color)) {
				delete bot.color;
				migrated = true;
			}
			// the model they
			// last ran on becomes their own, so dropping the lab changes nothing for them.
			if ("lab" in bot) {
				if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel;
				delete bot.lab;
				migrated = true;
			}
		}
		// A team from before several Main Bots were allowed names a single one.
		if (!Array.isArray(state.mainBotIds)) state.mainBotIds = [];
		if ("mainBotId" in state) {
			const single = state.mainBotId as BotId | undefined;
			if (single && !state.mainBotIds.includes(single)) state.mainBotIds.unshift(single);
			delete state.mainBotId;
			migrated = true;
		}
		state.mainBotIds = state.mainBotIds.filter((id) => state.bots[id]);
		if (!Array.isArray(state.privateArchives)) state.privateArchives = [];
		// Teams from before the whale was stored at setup: their first Bot, while still a
		// Main Bot, gets it once wherever it has no look of its own. After that the whale is
		// an ordinary look the user can change, and it never passes to another Bot.
		if (state.whaleStored !== true) {
			const first = Object.values(state.bots).reduce<Bot | undefined>(
				(best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best),
				undefined,
			);
			if (first !== undefined && state.mainBotIds.includes(first.id) && !first.color) first.color = "deepseek";
			state.whaleStored = true;
			if (first !== undefined) migrated = true;
		}
		if (state.works === null || typeof state.works !== "object" || Array.isArray(state.works)) state.works = {};
		if (state.requests === null || typeof state.requests !== "object" || Array.isArray(state.requests))
			state.requests = {};
		if (state.views === null || typeof state.views !== "object" || Array.isArray(state.views)) state.views = {};
		if (state.closedCards === null || typeof state.closedCards !== "object" || Array.isArray(state.closedCards))
			state.closedCards = {};

		// they are kept under btw/ per part now. A saved copy is dropped, not moved.
		if ("btwCards" in state) {
			delete state.btwCards;
			migrated = true;
		}
		const writer = holder === undefined && stuck === undefined;

		for (const room of Object.values(state.rooms) as Room[]) {
			if (!("botRounds" in room)) continue;
			delete room.botRounds;
			migrated = true;
		}

		// followed it went too. Calls it parked stay until the group's next round runs them.
		for (const room of Object.values(state.rooms) as Room[]) {
			if (
				["lateRounds", "quietNoticed", "quietShown", "relays", "relayLimit"].every((key) => room[key] === undefined)
			)
				continue;
			delete room.lateRounds;
			delete room.quietNoticed;
			delete room.quietShown;
			delete room.relays;
			delete room.relayLimit;
			migrated = true;
		}
		// Groups from before group settings existed reply in turn, led by a Main Bot member.
		for (const room of Object.values(state.rooms) as Room[]) {
			if (room.admin !== undefined && (ROOM_MODES as readonly string[]).includes(String(room.mode))) continue;
			if (room.admin === undefined) room.admin = room.members.find((id) => state.mainBotIds.includes(id)) ?? null;
			if (!(ROOM_MODES as readonly string[]).includes(String(room.mode))) room.mode = "everyone";
			room.notice ??= "";
			migrated = true;
		}
		// A Bot deleted while a group was made or changed could stay listed in it, even as its
		// admin; it leaves the group now.
		for (const room of Object.values(state.rooms) as Room[]) {
			const members = room.members.filter((id) => state.bots[id]);
			const admin = members.includes(room.admin as BotId) ? room.admin : null;
			if (members.length === room.members.length && admin === room.admin) continue;
			room.members = members;
			room.admin = admin;
			migrated = true;
		}
		// Teams from before #206 kept every long message whole in this file, written whole on
		// every save. A message between Bots is whole in its recipient's Session; a group
		// line's whole text moves to a file of its own, which only the writing host makes.
		for (const entry of state.exchanges as Exchange[]) {
			if (typeof entry.text !== "string" || entry.text.length <= TEXT_KEPT || entry.length !== undefined) continue;
			entry.length = entry.text.length;
			entry.text = headOf(entry.text, TEXT_KEPT);
			migrated = true;
		}
		for (const room of writer ? (Object.values(state.rooms) as Room[]) : []) {
			if (!Array.isArray(room.log)) continue;
			const keep = rt.keepGroupLine;
			if (keep === undefined) continue;
			const log = room.log.map((line) =>
				typeof line.text === "string" && line.length === undefined && typeof line.seq === "number"
					? keep(room.id, line, line.text)
					: line,
			);
			if (log.some((line, index) => line !== room.log?.[index])) {
				room.log = log;
				migrated = true;
			}
		}
		// Unnamed groups from before names followed their members may still list old names.
		const autoName = rt.autoRoomName;
		const stale =
			autoName === undefined
				? []
				: (Object.values(state.rooms) as Room[]).filter(
						(room) => !room.named && room.name !== autoName(room.members),
					);
		for (const room of stale) room.name = autoName?.(room.members) ?? room.name;
		indexSessions();
		return { migrated: migrated || stale.length > 0, stale };
	};

	const load = (): Promise<void> => {
		loaded ??= (async () => {
			claimLock();
			if (holder !== undefined) warn("ocean-crew: %s", readOnly());
			const { migrated, stale } = adopt(readFileState());
			if (holder !== undefined) return;
			if (migrated && stuck === undefined) {
				// A failed write must not poison `loaded`: the migrated state stays in
				// memory and the next save() writes it.
				try {
					await save();
				} catch (error) {
					warn("ocean-crew: saving the migrated Bot team failed: %s", error);
				}
			}
			// Not awaited: renaming a session must not hold up the first roster read.
			for (const room of stale) void rt.retitleRoom?.(room);
		})();
		return loaded;
	};

	// An outside edit of state.json while this host held the lock, found at a
	// reclaim or by a queued write that saw the file change: this host's in-memory
	// state goes aside first, then the file on disk is adopted. Queued behind
	// `writing` — and behind any adopt already queued — so no save or second
	// refresh slips between finding the change and the adopt.
	let adopting: Promise<void> | undefined;
	const adoptAfterReclaim = (): Promise<void> => {
		const run = (adopting ?? writing).then(async () => {
			if (stamp() !== seen) {
				const aside = `${statePath}.replaced-${Date.now()}`;
				try {
					await writeFile(aside, JSON.stringify(state));
					warn(
						"ocean-crew: %s changed while no host held the team; it is adopted and this host's state is kept as %s",
						statePath,
						aside,
					);
				} catch (error) {
					warn(
						"ocean-crew: %s changed while no host held the team; it is adopted, and this host's state is lost because it could not be kept aside: %s",
						statePath,
						error,
					);
				}
			}
			adopt(readFileState());
		});
		writing = run.catch(() => undefined);
		const tracked = run.finally(() => {
			if (adopting === tracked) adopting = undefined;
		});
		adopting = tracked;
		return tracked;
	};

	// The lock was this host's and is its own again. An adopt still queued is
	// awaited; otherwise the file is compared with what this host last saw:
	// unchanged means nothing external happened and the in-memory state stays,
	// changed means an outside edit is adopted the usual way.
	const reclaimHeld = (): Promise<void> | undefined => {
		warnedReadOnly = false;
		if (adopting !== undefined) return adopting;
		return stamp() === seen ? undefined : adoptAfterReclaim();
	};

	// A reading host follows the file and takes over once the other host has gone.
	const refresh = async (): Promise<void> => {
		await load();
		const hadHolder = holder !== undefined;
		if (hadHolder) {
			claimLock();
			if (holder === undefined) {
				warn("ocean-crew: the other dsh has closed; this one now saves the Bot team");
				warnedReadOnly = false;
				adopt(readFileState());
				return;
			}
		} else if (!lockBroken && !lock.owns()) {
			// A cached "writer" is stale once the lock file no longer names this host:
			// another dsh may have taken it over, or the file may just be gone. Re-claim
			// and re-check instead of trusting the flag.
			claimLock();
			if (lockBroken) return;
			if (holder === undefined) {
				await reclaimHeld();
				return;
			}
			warn("ocean-crew: %s", readOnly());
		}
		if (adopting !== undefined) return adopting;
		if ((stuck !== undefined || holder !== undefined) && stamp() !== seen) adopt(readFileState());
	};

	const warnReadOnly = (): false => {
		if (!warnedReadOnly) {
			warnedReadOnly = true;
			warn("ocean-crew: not saving the Bot team: %s", readOnly());
		}
		return false;
	};
	const writable = (): boolean => {
		if (stuck !== undefined) return warnReadOnly();
		if (lockBroken) return true;
		if (holder === undefined && lock.owns()) return true;
		// Lost the lock: retake it when nobody else holds it (its file was deleted), else
		// another host took it over and this one stops writing.
		if (holder === undefined) {
			claimLock();
			if (holder === undefined) {
				// A changed file is adopted first; the save queues behind that adopt.
				const pending = reclaimHeld();
				if (pending !== undefined) void pending.catch(() => undefined);
				return true;
			}
		}
		return warnReadOnly();
	};

	// Replace the whole team with the empty state and save it. The reset module calls
	// this before creating the first Main Bot again.
	const clearTeam = async (): Promise<void> => {
		if (!writable())
			throw Object.assign(new Error(`This host cannot clear the Bot team: ${readOnly()}`), {
				code: "bot/read-only",
			});
		adopt(undefined);
		await save({ required: true });
	};

	const save = (options: { required?: boolean } = {}): Promise<void> => {
		const { required = false } = options;
		if (stopped)
			return required ? Promise.reject(new Error("The Bot team cannot be saved after this host stopped.")) : writing;
		indexSessions();
		// A reading host keeps the file's revision, so its window does not skip the next change.
		if (!writable())
			return required ? Promise.reject(new Error(`This host cannot save the Bot team: ${readOnly()}`)) : writing;
		const run = writing.then(async () => {
			// Re-check writability once the queued write runs: an adopt queued before
			// it may have made this host read-only (e.g. a file a newer Ocean Crew wrote).
			if (stuck !== undefined || holder !== undefined) {
				if (required) throw new Error(`This host cannot save the Bot team: ${readOnly()}`);
				warnReadOnly();
				return;
			}
			// The snapshot is taken here, so a save made while an adopt was pending
			// writes the adopted state, not the stale one it had.
			const epoch = lockEpoch;
			state.revision += 1;
			state.exchanges = state.exchanges.slice(-MAX_EXCHANGES);
			const snapshot = JSON.stringify(state);
			const temp = `${statePath}.${process.pid}.tmp`;
			try {
				await mkdir(home, { recursive: true });
				const ensureLock = (): void => {
					if (lockBroken) return;
					const owned = lock.owns();
					// An outside edit under this host's lock goes through the adopt step
					// instead of being written over; a removed file is just written again.
					const changed = owned && stamp() !== "" && stamp() !== seen;
					if (changed) void adoptAfterReclaim().catch(() => undefined);
					// A different epoch means an adopt replaced the state this snapshot was
					// taken from — another host's writes, or an outside edit it adopted.
					if (!owned || changed || lockEpoch !== epoch) {
						const error = new Error(
							changed
								? "ocean-crew: the Bot team file changed under this host's lock"
								: "ocean-crew lost the state lock to another dsh",
						) as Error & { code?: string };
						error.code = "ELOCKLOST";
						throw error;
					}
				};
				ensureLock();
				await writeFile(temp, snapshot, "utf8");
				ensureLock();
				await replaceFile(temp, statePath, ensureLock);
				seen = stamp();
				rt.capabilitiesStateSaved?.();
				for (const listener of savedListeners) {
					try {
						listener();
					} catch (error) {
						warn("ocean-crew: saved listener failed: %s", error);
					}
				}
			} catch (error) {
				await unlink(temp).catch(() => undefined);
				throw error;
			}
		});
		writing = run.catch(() => undefined);
		return run.catch((error) => {
			warn("ocean-crew: state write failed: %s", error);
			throw error;
		});
	};

	ctx.effect(
		() => () => {
			stopped = true;
			return writing.finally(() => lock.release());
		},
		"ocean-crew: state lock",
	);

	const botOf = (id?: string): Bot | undefined => (id === undefined ? undefined : own(state.bots, id));
	// A group's own Session moves on to a fresh part when the group's folder no longer
	// matches the one it was made in (parts.js), like a Bot's own chat: `room.id` stays
	// the first Session's id and `room.sessionId` the current one, so the group keeps
	// one identity while its Session moves. `roomOwners` maps the current Session.
	const roomOf = (id?: string): Room | undefined =>
		id === undefined ? undefined : (own(state.rooms, id) ?? own(state.rooms, roomOwners.get(id) ?? ""));
	const isMain = (id?: string): boolean => id !== undefined && state.mainBotIds.includes(id);

	// Group Sessions. A member speaks in each group from a hidden Session of its own,
	// `room.sessions[botId]`, that renders the same system prompt and tools as its own
	// chat: the provider's prefix cache is shared, and a group turn never re-reads the
	// member's private context. Created on the member's first turn in the group.
	//
	// Segments. A long conversation moves to a fresh Session at a context line (see
	// parts.js), and a group's own Session to a fresh part when the group's folder
	// changes. A Bot's id is the Session id of its first own-chat segment and never
	// changes; `bot.sessionId` is the current one, and `room.sessionId` the group's.

	// (`room.segments[botId]`) and of the group's own Session (`room.parts`), are
	// archived and stay readable.
	const chatOwners = new Map<string, string>();
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	const roomOwners = new Map<string, string>();
	const pastOwners = new Map<string, { botId?: string; roomId?: string }>();
	const chatOf = (botId: string): string => botOf(botId)?.sessionId ?? botId;
	const sessionOfRoom = (room?: Room): string | undefined =>
		room === undefined ? undefined : (room.sessionId ?? room.id);
	// DSH turns away every step of an archived Session and every task aimed at it, so a

	// could leave one there, and DSH's own Session list can archive one.
	// stay archived.
	let restoring: Promise<void> | undefined;
	const restoreCurrent = (): void => {
		const registry = ctx.workspaceRegistry;
		if (restoring !== undefined || readOnly() !== undefined || typeof registry?.unarchiveSession !== "function")
			return;
		let archived: Set<string>;
		try {
			archived = new Set(registry.archivedSessionIds ?? []);
		} catch {
			return;
		}
		const held = [...chatOwners.keys(), ...groupOwners.keys(), ...roomOwners.keys()].filter((id) => archived.has(id));
		if (held.length === 0) return;
		restoring = (async () => {
			for (const sessionId of held) {
				await registry
					.unarchiveSession?.(sessionId)
					.then(() => warn("ocean-crew: current Session %s was archived in DSH; taken back out", sessionId))
					.catch((error) =>
						warn(
							"ocean-crew: current Session %s is archived in DSH and could not be taken out: %s",
							sessionId,
							error,
						),
					);
			}
		})().finally(() => {
			restoring = undefined;
		});
	};
	const indexSessions = (): void => {
		chatOwners.clear();
		groupOwners.clear();
		roomOwners.clear();
		pastOwners.clear();
		for (const bot of Object.values(state.bots) as Bot[]) {
			for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id });
			chatOwners.set(chatOf(bot.id), bot.id);
		}
		for (const room of Object.values(state.rooms) as Room[]) {
			const sessionId = sessionOfRoom(room);
			if (sessionId !== undefined) roomOwners.set(sessionId, room.id);
			for (const segment of room.parts ?? []) pastOwners.set(segment.sessionId, { roomId: room.id });
			for (const [botId, segments] of Object.entries(room.segments ?? {})) {
				for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id });
			}
			for (const [botId, memberSession] of Object.entries(room.sessions ?? {}))
				groupOwners.set(memberSession, { botId, roomId: room.id });
		}
		// The agents module owns the DSH Agent session index, and tools.js re-syncs
		// the scoped tools with this ownership (drops Sessions that left, scopes
		// live Agents that joined); both install after this, and are optional until

		rt.indexAgents?.();
		rt.syncScopedTools?.();
		restoreCurrent();
	};
	// The Bot a Session speaks for: its own chat, one of its group Sessions, or an

	const selfOf = (id?: string): string | undefined =>
		id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId);
	// A Session where the Bot speaks now, as opposed to an archived segment.
	const isBotSession = (id?: string): boolean => id !== undefined && (chatOwners.has(id) || groupOwners.has(id));
	const groupSessionsOf = (botId: string): string[] =>
		(Object.values(state.rooms) as Room[])
			.map((room) => room.sessions?.[botId])
			.filter((value): value is string => typeof value === "string");
	const dropGroupSession = (room: Room, botId: string): void => {
		if (room.memberDirs !== undefined) delete room.memberDirs[botId];
		const sessionId = room.sessions?.[botId];
		if (sessionId === undefined) return;
		delete room.sessions?.[botId];
		for (const segment of room.segments?.[botId] ?? []) delete state.switching[segment.sessionId];
		if (room.segments !== undefined) delete room.segments[botId];
		delete state.switching[sessionId];
		groupOwners.delete(sessionId);
		rt.cancelApprovals?.(sessionId);
		// A plain archive refuses a running Session, which would go on working for a group
		// that no longer has it.
		void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch(() => undefined);
	};
	// A group Session DSH can no longer open is set aside;
	// the group stay, and its next turn there starts a new Session.
	const retireGroupSession = (room: Room, botId: string): void => {
		const sessionId = room.sessions?.[botId];
		if (sessionId === undefined) return;
		delete room.sessions?.[botId];
		groupOwners.delete(sessionId);
		rt.cancelApprovals?.(sessionId);
		void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch(() => undefined);
	};
	const findBot = (ref?: unknown): Bot | undefined => {
		if (ref === undefined) return undefined;
		const byId = own(state.bots, String(ref));
		if (byId) return byId;
		const wanted = normalize(unquote(ref)).replace(/^@/, "");
		return (Object.values(state.bots) as Bot[]).find((bot) => normalize(bot.name) === wanted);
	};
	// Every group chat whose id or name matches; callers refuse an ambiguous name.
	const findRooms = (ref?: unknown): Room[] => {
		if (ref === undefined || ref === null) return [];
		const byId = own(state.rooms, String(ref));
		if (byId) return [byId];
		const wanted = normalize(unquote(ref));
		return (Object.values(state.rooms) as Room[]).filter((room) => normalize(room.name) === wanted);
	};
	const isAdminOf = (room: Room, id?: string): boolean => id !== undefined && room.admin === id;

	// What later durable sends may assume about this host.
	// lockBroken tolerance: the team still saves, but a reliable dispatch must not

	const writerMode = (): "owned" | "readonly" | "degraded" => {
		if (lockBroken) return "degraded";
		if (stuck !== undefined || holder !== undefined) return "readonly";
		return "owned";
	};

	const savedListeners = new Set<() => void>();
	const onSaved = (listener: () => void): (() => void) => {
		savedListeners.add(listener);
		return () => savedListeners.delete(listener);
	};

	// A question or view card closed without an answer on the card (dismissed, or
	// answered by a message) stays in the chat, read-only: by Session, its call id
	// and how it closed. A card answered on the card shows on its reply message.
	const closeCard = (sessionId: string, card: { callId?: string } | undefined, outcome: string): void => {
		if (typeof card?.callId !== "string") return;
		state.closedCards[sessionId] = { ...own(state.closedCards, sessionId), [card.callId]: outcome };
	};

	Object.assign(rt, {
		state,
		load,
		save,
		refresh,
		readOnly,
		own,
		onSaved,
		closeCard,
		clearTeam,
		botOf,
		roomOf,
		isMain,
		chatOf,
		sessionOfRoom,
		selfOf,
		isBotSession,
		chatOwners,
		groupOwners,
		roomOwners,
		pastOwners,
		groupSessionsOf,
		dropGroupSession,
		retireGroupSession,
		findBot,
		findRooms,
		isAdminOf,
		writerMode,
	});
}

// The Session indexes a caller may rebuild after changing bots or rooms without saving
// through `install`; kept here so tests and later modules can share the exact types.
export type { Bot, BotId, Exchange, Room, RoomLogLine, TeamState };
