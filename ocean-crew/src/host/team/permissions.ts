// Permissions. A Bot's permission preset is its own: kept on the Bot and set on every
// Session it speaks from, so a fresh part or a new group Session keeps it. A group may
// set one preset for all its members there, in place of each member's own, as it may
// set one working folder.
// DSH offers Auto review for the current Session only, so neither a Bot nor a group keeps it.
//

// its apply revision, the last error, and which preset every Session currently really has
// (and where it came from). A change whose Sessions did not all take it is `partial`; a
// tightening that failed is visible as such, and approvals asked under the old revision
// are invalidated (`rt.invalidateApprovals`), so nothing runs under an unverified grant.
// The revision this module reports is also what an approval card's ApprovalRef binds to.

import type { Bot, Room } from "../../shared/state.ts";
import type { Runtime } from "../core/runtime.ts";

const SESSION_ONLY = "auto";

interface PermissionOption {
	value: string;
	name?: string;
	[key: string]: unknown;
}

interface PresetServiceCatalog {
	options: PermissionOption[];
	defaultPreset?: string;
	[key: string]: unknown;
}

// DSH's permission presets service (`ctx.get('permissionPresets')`).
interface PermissionPresetsService {
	catalog(): PresetServiceCatalog;
	resolve(name: string): unknown;
	set(session: unknown, name: string): void;
}

interface AgentHandle {
	session: unknown;
}

interface PermissionRequest {
	seq: number;
	applied: string | undefined;
}

export function install(rt: Runtime): void {
	const presets = (): PermissionPresetsService | undefined =>
		rt.ctx.get?.("permissionPresets") as PermissionPresetsService | undefined;

	// The presets DSH offers, or undefined when the profile has none.
	function permissionCatalog(): { options: PermissionOption[]; defaultPreset?: string } | undefined {
		const service = presets();
		if (service === undefined) return undefined;
		const { options, defaultPreset } = service.catalog();
		return { options: options.filter((option) => option.value !== SESSION_ONLY), defaultPreset };
	}

	const roomOfSession = (sessionId: string): Room | undefined => rt.roomOf(rt.groupOwners.get(sessionId)?.roomId);

	// `name` may be a function: it is read once the agent resolves, so a change asked
	// for while the resolve ran wins over the one still being applied.
	async function setPreset(
		sessionId: string,
		name: string | (() => string | undefined),
		context?: { bot?: Bot; room?: Room; source?: "bot" | "room" | "default" },
	): Promise<string | undefined> {
		const agent = (await rt.resolveAgent(sessionId)) as AgentHandle;
		const wanted = typeof name === "function" ? name() : name;
		if (wanted === undefined) return undefined;
		bumpSession(sessionId);
		const source = context?.source ?? (context?.bot === undefined ? "default" : sourceOf(context.room, context.bot));
		try {
			presets()?.set(agent.session, wanted);
		} catch (error) {
			record(sessionId, {
				preset: wanted,
				source,
				applied: false,
				...(context?.bot !== undefined ? { botId: context.bot.id } : {}),
				...(context?.room !== undefined ? { roomId: context.room.id } : {}),
				error: (error as Error)?.message ?? String(error),
			});
			throw error;
		}
		record(sessionId, {
			preset: wanted,
			source,
			applied: true,
			...(context?.bot !== undefined ? { botId: context.bot.id } : {}),
			...(context?.room !== undefined ? { roomId: context.room.id } : {}),
		});
		return wanted;
	}

	// Sets the preset on one of the Bot's Sessions: its group's there, else its own; a Bot
	// without one keeps DSH's default. `room` is for a group Session not indexed yet.
	// Returns the preset it set, or undefined when it set none.
	async function applyPermission(
		bot: Bot,
		sessionId: string,
		room: Room | undefined = roomOfSession(sessionId),
	): Promise<string | undefined> {
		const name = (): string | undefined => room?.permission ?? bot.permission;
		if (presets() === undefined || !name()) return undefined;
		return setPreset(sessionId, name, { bot, room });
	}

	function checkPreset(name: unknown, whose: string): string {
		const service = presets();
		if (service === undefined) throw new Error("Permissions are not available in this DeepSeek Harness");
		const wanted = String(name ?? "").trim();
		if (wanted === SESSION_ONLY)
			throw new Error(`Auto review applies to one Session only and cannot be ${whose} permission`);
		service.resolve(wanted);
		return wanted;
	}

	// Per Bot, requests are numbered and the last preset an apply actually set is
	// tracked: only the newest request may roll the field back, and then to that
	// applied value, never to a value a request had only asked for.
	const requests = new Map<string, PermissionRequest>();

	// The audit: what each Session really has, where that came from, and why a change
	// did not reach it. `permissionRevision` is what approvals bind to.
	interface EffectivePreset {
		preset: string;
		source: "bot" | "room" | "default";
		applied: boolean;
		botId?: string;
		roomId?: string;
		at: number;
		error?: string;
	}
	interface BotPermissionState {
		desired?: string;
		applyRevision: number;
		lastError?: string;
		partial: boolean;
	}
	const effective = new Map<string, EffectivePreset>();
	const botsState = new Map<string, BotPermissionState>();
	const roomsState = new Map<
		string,
		{ permission?: string; applyRevision: number; lastError?: string; partial: boolean }
	>();
	const sessionRevisions = new Map<string, number>();
	const botRevisions = new Map<string, number>();
	const roomRevisions = new Map<string, number>();
	let revision = 0;
	const bump = (): number => ++revision;
	const roomKey = (room: Room): string => room.id;
	const bumpSession = (sessionId: string): void => {
		sessionRevisions.set(sessionId, (sessionRevisions.get(sessionId) ?? 0) + 1);
		bump();
	};
	const record = (sessionId: string, entry: Omit<EffectivePreset, "at"> & { at?: number }): void => {
		effective.set(sessionId, { ...entry, at: entry.at ?? Date.now() });
	};
	const stateOf = (botId: string): BotPermissionState => {
		const found = botsState.get(botId);
		if (found !== undefined) return found;
		const created: BotPermissionState = { applyRevision: 0, partial: false };
		botsState.set(botId, created);
		return created;
	};
	const sessionsOf = (bot: Bot): string[] => {
		const sessions = [rt.chatOf(bot.id), ...rt.groupSessionsOf(bot.id)];
		return [...new Set(sessions)];
	};
	const sourceOf = (room: Room | undefined, bot: Bot): "bot" | "room" | "default" => {
		if (room?.permission !== undefined) return "room";
		return bot.permission !== undefined ? "bot" : "default";
	};
	const audit = (bot: Bot): boolean => {
		// A Session the group governs is the group's to apply; this audit only judges the
		// Sessions the Bot's own change reached, and only a real failed apply is partial.
		const rows = sessionsOf(bot)
			.map((sessionId) => effective.get(sessionId))
			.filter((row): row is EffectivePreset => row !== undefined);
		const state = stateOf(bot.id);
		state.partial = rows.some((row) => row.applied === false);
		return state.partial;
	};

	async function setPermission(bot: Bot, name: unknown): Promise<void> {
		const wanted = checkPreset(name, "a Bot's");
		const request: PermissionRequest = requests.get(bot.id) ?? { seq: 0, applied: bot.permission };
		const mine = ++request.seq;
		requests.set(bot.id, request);
		// The change is known before its first await: the audit names the desired preset,
		// its revision moves, and any approval asked under the old authority is withdrawn
		// before a Session could still execute it.
		const state = stateOf(bot.id);
		state.desired = wanted;
		state.applyRevision = mine;
		state.lastError = undefined;
		state.partial = false;
		botRevisions.set(bot.id, (botRevisions.get(bot.id) ?? 0) + 1);
		bump();
		rt.invalidateApprovals?.(sessionsOf(bot));
		// The preset is written before its first await: a request still being applied
		// then reads the one asked for last.
		bot.permission = wanted;
		// The preset for one Session is read once its agent resolves: undefined once a
		// newer request exists, so a superseded request writes no more Sessions — every
		// Session the Bot has ends at the value the newest request actually applied.
		const applyTo = (
			sessionId: string,
			room: Room | undefined = roomOfSession(sessionId),
		): Promise<string | undefined> =>
			setPreset(sessionId, () => (request.seq === mine ? (room?.permission ?? bot.permission) : undefined), {
				bot,
				room,
			});
		const groups = async (warnFail: (error: unknown) => void): Promise<void> => {
			for (const sessionId of rt.groupSessionsOf(bot.id)) {
				if (request.seq !== mine) break;
				if (roomOfSession(sessionId)?.permission) continue;
				await applyTo(sessionId).catch(warnFail);
			}
		};
		try {
			const applied = await applyTo(rt.chatOf(bot.id));
			if (applied !== undefined) request.applied = applied;
		} catch (error) {
			if (request.seq === mine) {
				state.lastError = (error as Error)?.message ?? String(error);
				if (request.applied === undefined) delete bot.permission;
				else {
					bot.permission = request.applied;
					// The restored preset goes back on every Session the change left behind.
					const warnFail = (failure: unknown): void =>
						rt.warn("ocean-crew: permission for %s not restored: %s", bot.name, failure);
					await applyTo(rt.chatOf(bot.id)).catch(warnFail);
					await groups(warnFail);
				}
			}
			// A change that failed is partial by definition: the audit names what the
			// Sessions still hold after the rollback.
			audit(bot);
			throw error;
		}
		await groups((error) => rt.warn("ocean-crew: permission for %s in a group not applied: %s", bot.name, error));
		audit(bot);
	}

	// The audit for a Bot, or for every Bot the host has seen: what was asked for, which
	// revision applied it, the last error, and the preset each Session really holds.
	function permissionState(botId?: string): {
		revision: number;
		bots: Record<
			string,
			BotPermissionState & { id: string; sessions: Array<{ sessionId: string } & EffectivePreset> }
		>;
		rooms: Record<string, { permission?: string; applyRevision: number; lastError?: string; partial: boolean }>;
	} {
		const ids =
			botId === undefined
				? [
						...new Set(
							[...botsState.keys(), ...effective.values()].flatMap((entry) =>
								typeof entry === "string" ? [] : entry.botId === undefined ? [] : [entry.botId],
							),
						),
					]
				: [botId];
		const bots: Record<
			string,
			BotPermissionState & { id: string; sessions: Array<{ sessionId: string } & EffectivePreset> }
		> = {};
		for (const id of ids) {
			const state = stateOf(id);
			const sessions = [...effective.entries()]
				.filter(([, entry]) => entry.botId === id)
				.map(([sessionId, entry]) => ({ sessionId, ...entry }));
			bots[id] = { id, ...state, sessions };
		}
		return { revision, bots, rooms: Object.fromEntries(roomsState) };
	}

	// The revision an approval binds to: the Bot's, its group's, and the Session's own
	// last apply, as one comparable string.
	function permissionRevision(sessionId: string): string {
		const owner = rt.groupOwners.get(sessionId);
		const botId = owner?.botId ?? rt.chatOwners.get(sessionId);
		const roomId = owner?.roomId;
		const botRev = botId === undefined ? 0 : (botRevisions.get(botId) ?? 0);
		const roomRev = roomId === undefined ? 0 : (roomRevisions.get(roomId) ?? 0);
		return `b${botRev}:r${roomRev}:s${sessionRevisions.get(sessionId) ?? 0}`;
	}

	const effectivePermission = (sessionId: string): EffectivePreset | undefined => effective.get(sessionId);

	// A group's preset, or null when each member uses its own.
	const cleanRoomPermission = (name: unknown): string | null =>
		name === null || name === "" ? null : checkPreset(name, "a group's");

	// Members' Sessions in the group change now; a member that has none there yet gets the
	// group's preset when its first turn there makes one. Returns whether it changed.
	async function setRoomPermission(room: Room, name: unknown): Promise<boolean> {
		const wanted = cleanRoomPermission(name) ?? undefined;
		if (wanted === room.permission) return false;
		const key = roomKey(room);
		const state = roomsState.get(key) ?? { applyRevision: 0, partial: false };
		roomsState.set(key, state);
		if (wanted === undefined) delete room.permission;
		else room.permission = wanted;
		state.permission = wanted;
		state.applyRevision += 1;
		state.lastError = undefined;
		state.partial = false;
		roomRevisions.set(key, (roomRevisions.get(key) ?? 0) + 1);
		bump();
		rt.invalidateApprovals?.(Object.values(room.sessions ?? {}));
		const service = presets();
		if (service === undefined) return true;
		const failed: string[] = [];
		for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
			const bot = rt.botOf(botId);
			if (bot === undefined) continue;
			// A member without a preset of its own goes back to the default its Session started on.
			await setPreset(sessionId, () => room.permission ?? bot.permission ?? service.catalog().defaultPreset, {
				bot,
				room,
				source: room.permission !== undefined ? "room" : bot.permission !== undefined ? "bot" : "default",
			}).catch((error) => {
				failed.push(sessionId);
				rt.warn("ocean-crew: permission for %s in %s not applied: %s", bot.name, room.name, error);
			});
		}
		if (failed.length > 0) {
			state.partial = true;
			state.lastError = `not applied to ${failed.length} Session${failed.length === 1 ? "" : "s"}`;
		}
		return true;
	}

	Object.assign(rt, {
		permissionCatalog,
		applyPermission,
		setPermission,
		cleanRoomPermission,
		setRoomPermission,
		permissionState,
		permissionRevision,
		effectivePermission,
	});
}
