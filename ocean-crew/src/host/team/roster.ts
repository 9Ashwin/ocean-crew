// Roster: creating, changing, and deleting Bots and group chats, the Main Bot role, and
// the first Main Bot of a new team.
//

// names. The slices it calls (models, permissions, privacy, folders, delivery, parts,
// memory) may be installed after it, or absent from a minimal runtime: each one has a
// documented fallback below, never a second implementation of the slice.
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { nameProblem } from "../../shared/mentions.ts";
import type { Bot, BotAvatar, BotId, BotKickoff, Room, RoomId, RoomMode, TeamAgent } from "../../shared/state.ts";
import { MAX_AVATAR_IMAGE, ROOM_MAX_MEMBERS, ROOM_MODES, ROOM_NAME_MAX, ROOM_NOTICE_MAX } from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";
import { currentColor, isColor, normalize, unquote } from "../core/text.ts";

const HOSTNAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const AVATAR_IMAGE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

const OWN_RULES = "Where your instructions say otherwise, follow them.";
const writeIn = (language?: string): string =>
	`Write in ${language ?? "the user's language if known; otherwise Chinese"}.`;
// The first Main Bot's greeting when the user wrote before it had a model that works.
const AFTER_USER =
	"You were just set up as the user's Main Bot. The user wrote to you before your model could answer; their message above has no answer yet. Answer it now, and say in one short sentence that you run their Bot team.";

// The name a create asks for; anything the client or a Bot tool sends is untrusted.
interface CreateBotOptions {
	name?: unknown;
	role?: string;
	instructions?: string;
	color?: unknown;
	brief?: string;
	createdBy?: string;
	main?: boolean;
	avatar?: unknown;
	model?: unknown;
	effort?: unknown;
	workDir?: unknown;
	copyOf?: string;
	pickModel?: boolean;
}

// One change to a Bot, as `update-bot` or the `update_bot` tool carries it.
interface BotPatch {
	name?: unknown;
	role?: unknown;
	instructions?: unknown;
	color?: unknown;
	avatar?: unknown;
	model?: unknown;
	effort?: unknown;
	private?: unknown;
	workDir?: unknown;
	permission?: unknown;
	changeEngine?: unknown;
}

// One change to a group chat, as `update-room` or the `update_group` tool carries it.
interface RoomPatch {
	members?: unknown;
	add?: unknown;
	remove?: unknown;
	admin?: unknown;
	mode?: unknown;
	notice?: unknown;
	workDir?: unknown;
	permission?: unknown;
	name?: unknown;
}

interface CreateRoomOptions {
	members?: BotId[];
	name?: unknown;
	notice?: unknown;
	mode?: unknown;
	admin?: BotId | null;
	createdBy?: BotId;
}

// A greeting: held on the Bot until a model is available, or on its way to the chat.
interface Greeting extends BotKickoff {
	text?: string;
	from?: BotId | null;
	main?: boolean;
	afterUser?: boolean;
}

// A private Bot kept closed after deletion: its folder, memory and Sessions.
interface PrivateArchive {
	id: BotId;
	name: string;
	workDir?: string;
	sessionIds: string[];
	archiving?: boolean;
	archivePath?: string;
}

// The folder/privacy facts of one Bot change, checked before anything is written.
interface PrivacyChange {
	flag?: boolean;
	moving: boolean;
	workDir?: string;
}

// The DSH services this file reads; they are injected, so they exist by the time the
// plugin applies. The shapes stay local instead of widening host/runtime.ts for every
// slice that eventually needs them.
interface WorkspaceHandle {
	id?: string;
	path?: string;
}
interface Workspaces {
	get?(workspaceId?: string): WorkspaceHandle | undefined;
	resolveByPath?(path: string): Promise<WorkspaceHandle | undefined>;
	create?(path: string, name?: string): Promise<WorkspaceHandle>;
	archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>;
}
interface SessionController {
	create(request: Record<string, unknown>): Promise<{ sessionId: string }>;
	resolveAgent?(sessionId: string): Promise<unknown>;
}
interface SessionTitle {
	rename(session: unknown, title: string): Promise<unknown>;
}
interface AgentPresets {
	list?(): Promise<Array<{ id?: string; broken?: unknown }>>;
}

/** Installs the roster and publishes its members on `rt`. */
export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state = rt.state;
	const { warn } = rt;

	const workspaces = (ctx.workspaceRegistry ?? {}) as unknown as Workspaces;
	const sessions = (ctx.sessionController ?? {}) as unknown as SessionController;
	const sessionTitle = ctx.sessionTitle as unknown as SessionTitle | undefined;

	let bootstrapping: Promise<Bot> | null = null;

	// A function another slice publishes on `rt`, or the fallback used while that slice
	// is absent.
	// several slices (folders, privacy, resume, groups) install after roster, and their
	// functions must be picked up once they exist. The fallbacks are the smallest
	// behaviour that leaves the roster's own promises intact; they never reimplement them.
	const dependency = <T extends (...args: never[]) => unknown>(name: string, fallback: T): T =>
		((...args: Parameters<T>) => {
			const live = rt[name];
			return typeof live === "function" ? live(...args) : (fallback as (...rest: Parameters<T>) => unknown)(...args);
		}) as unknown as T;

	// `deliver` is the one fallback that must not be silent: a greeting with nowhere to
	// go is a host installed without the delivery slice, which is a configuration fault.
	let deliveryMissing = false;
	const deliver = dependency<(...args: unknown[]) => Promise<unknown>>("deliver", async () => {
		if (deliveryMissing) return;
		deliveryMissing = true;
		warn("ocean-crew: delivery is not installed, so a greeting was not sent");
	});

	const teamFolder = dependency<() => string | undefined>(
		"teamFolder",
		() => workspaces.get?.(state.workspaceId)?.path,
	);
	const defaultTeamFolder = dependency<() => string>(
		"defaultTeamFolder",
		() => rt.config.workspace ?? join(rt.home, "workspace"),
	);
	const isFolder = dependency<(path: string) => Promise<boolean>>("isFolder", async (path) => {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	});
	const resolveModel = dependency<(text: unknown) => Promise<string>>("resolveModel", async (text) =>
		String(text ?? "").trim(),
	);
	const defaultBotModel = dependency<() => Promise<string | undefined>>("defaultBotModel", async () => undefined);
	const resolveEffort = dependency<(ref: string, text: unknown) => Promise<string | undefined>>(
		"resolveEffort",
		async (_ref, text) => {
			const wanted = String(text ?? "").trim();
			return wanted === "" ? undefined : wanted;
		},
	);
	const defaultEffort = dependency<(ref: string) => Promise<string | undefined>>(
		"defaultEffort",
		async () => undefined,
	);
	const cleanWorkDir = dependency<(input: unknown) => Promise<string | undefined>>("cleanWorkDir", async (input) => {
		const text = String(input ?? "").trim();
		return text === "" ? undefined : text;
	});
	const privateClash = dependency<(dir: string) => Promise<{ name?: string } | undefined>>(
		"privateClash",
		async () => undefined,
	);
	const applyModel = dependency<(bot: Bot, options?: { force?: boolean }) => Promise<unknown>>(
		"applyModel",
		async () => undefined,
	);
	const waitForModel = dependency<(bot: Bot) => Promise<unknown>>("waitForModel", async (bot) => bot.model);
	const catalog = dependency<() => Promise<Array<{ ref?: string }>>>("catalog", async () => []);
	const isUsable = dependency<(ref?: string) => boolean>("isUsable", (ref) => ref !== undefined);
	const unreadOf = dependency<(sessionId: string) => unknown[]>("unreadOf", () => []);
	const archiveBotMemory = dependency<(botId: string) => Promise<string | undefined>>(
		"archiveBotMemory",
		async () => undefined,
	);
	const archiveGroupMemory = dependency<(room: Room) => Promise<string | undefined>>(
		"archiveGroupMemory",
		async () => undefined,
	);
	const releaseBot = dependency<(botId: string, sessionIds: string[]) => Promise<unknown>>(
		"releaseBot",
		async () => undefined,
	);
	const forgetBotSecrets = dependency<(botId: string) => Promise<unknown>>("forgetBotSecrets", async () => undefined);
	const dropGroupLines = dependency<(roomId: string) => void>("dropGroupLines", () => undefined);
	const setPermission = dependency<(bot: Bot, name: unknown) => Promise<unknown>>("setPermission", async () => {
		throw new Error("Permissions are not available in this DeepSeek Harness");
	});
	// `null` means each member uses its own preset; a name is a group-wide one.
	const cleanRoomPermission = dependency<(name: unknown) => string | null>("cleanRoomPermission", (name) =>
		name === null || name === "" ? null : String(name ?? "").trim() || null,
	);
	const setRoomPermission = dependency<(room: Room, name: string | null | undefined) => Promise<boolean>>(
		"setRoomPermission",
		async (room, name) => {
			const wanted = name ?? undefined;
			if (wanted === room.permission) return false;
			if (wanted === undefined) delete room.permission;
			else room.permission = wanted;
			return true;
		},
	);
	const checkNoPrivate = dependency<(ids: BotId[]) => void>("checkNoPrivate", (ids) => {
		const found = ids.map((id) => rt.botOf(id)).find((bot) => bot?.private === true);
		if (found !== undefined)
			throw new Error(
				`${found.name} is a private Bot and cannot be in a group chat: what is said in a group is read by every member`,
			);
	});
	const checkPrivacyChange = dependency<(bot: Bot, change: PrivacyChange) => Promise<void>>(
		"checkPrivacyChange",
		async (bot, change) => {
			const makes = change.flag === undefined ? bot.private === true : change.flag;
			const dir = change.moving ? change.workDir : bot.workDir;
			if (!makes) {
				const clash = change.moving && dir !== undefined ? await privateClash(dir) : undefined;
				if (clash)
					throw new Error(
						`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`,
					);
				return;
			}
			if (rt.isMain(bot.id)) throw new Error(`${bot.name} is a Main Bot, so it cannot be private`);
			if (dir === undefined) throw new Error(`${bot.name} needs a folder of its own to be private`);
			if (Object.values(state.rooms).some((room) => room.members.includes(bot.id)))
				throw new Error(
					`${bot.name} is in a group chat, where every member reads what is said. Remove it from its groups first`,
				);
			const clash = await privateClash(dir);
			if (clash)
				throw new Error(
					`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`,
				);
		},
	);

	// The Session a Bot or group speaks from, resolved through delivery.ts or, before
	// that slice lands, through the DSH controller itself.
	const resolveAgent = async (sessionId: string): Promise<{ session?: unknown }> => {
		if (typeof rt.resolveAgent === "function") return rt.resolveAgent(sessionId);
		const resolved = (await sessions.resolveAgent?.(sessionId)) as
			| { agent?: { session?: unknown }; error?: { code?: string; message?: string } }
			| undefined;
		if (resolved !== undefined && resolved !== null && resolved.error !== undefined)
			throw Object.assign(new Error(resolved.error.message ?? "Session unavailable"), { code: resolved.error.code });
		return (resolved?.agent ?? {}) as { session?: unknown };
	};
	const archive = (sessionId: string | undefined, options?: { stopActivity?: boolean }): Promise<unknown> =>
		sessionId === undefined ? Promise.resolve() : Promise.resolve(workspaces.archiveSession?.(sessionId, options));

	const kickoffOf = (bot: Bot | undefined): Greeting | undefined => bot?.kickoff as Greeting | undefined;

	function cleanAvatar(input: unknown): BotAvatar | undefined {
		if (input === null || typeof input !== "object") return undefined;
		const source = input as { shape?: unknown; image?: unknown };
		const avatar: BotAvatar = {};
		if (typeof source.shape === "string" && /^[a-z][\w-]{0,31}$/.test(source.shape)) avatar.shape = source.shape;
		if (typeof source.image === "string") {
			if (!AVATAR_IMAGE.test(source.image)) throw new Error("Avatar images must be PNG, JPEG, WebP, GIF, or SVG");
			if (source.image.length > MAX_AVATAR_IMAGE) throw new Error("Avatar image is too large");
			avatar.image = source.image;
		}
		return Object.keys(avatar).length > 0 ? avatar : undefined;
	}

	// The team folder is Ocean Crew's own: deleted, it is made again before a Session needs it.
	async function keepTeamFolder(): Promise<string | undefined> {
		const team = teamFolder();
		if (team !== undefined)
			await mkdir(team, { recursive: true }).catch((error) =>
				warn("ocean-crew: team folder %s not made again: %s", team, error),
			);
		return team;
	}

	async function ensureWorkspace(): Promise<string> {
		if (state.workspaceId !== undefined && workspaces.get?.(state.workspaceId) !== undefined) {
			await keepTeamFolder();
			return state.workspaceId;
		}
		const path = defaultTeamFolder();
		await mkdir(path, { recursive: true });
		const workspace = (await workspaces.resolveByPath?.(path)) ?? (await workspaces.create?.(path, "Ocean Crew"));
		if (workspace === undefined || workspace.id === undefined)
			throw new Error("DeepSeek Harness could not register the team folder as a workspace");
		state.workspaceId = workspace.id;
		await rt.save();
		return workspace.id;
	}

	// Under the PTC preset (DSH Desktop's default) a model may call only run_code, which
	// turns down the group_relay call that a group chat's Session is given. A Session
	// keeps the preset it is made with.
	async function botPreset(): Promise<{ agentPreset?: string }> {
		const presets = ctx.get("agentPresets") as AgentPresets | undefined;
		if (presets === undefined) return {};
		const standard = ((await presets.list?.()) ?? []).some(
			(preset) => preset.id === "standard" && preset.broken === undefined,
		);
		return standard ? { agentPreset: "standard" } : {};
	}

	// `dir` is a working folder outside the team workspace. Such a Session is made by cwd
	// alone, so it joins no DSH workspace and the user's own project lists stay as they are —
	// unless the folder is already registered as a workspace, which it then joins (#710).
	async function createSession(title: string, { dir }: { dir?: string } = {}): Promise<string> {
		// A Bot's tools run here too; while another dsh holds the team, a new Session would
		// belong to no saved Bot.
		const readOnly = rt.readOnly();
		if (readOnly !== undefined) throw new Error(readOnly);
		const usable = dir !== undefined && (await isFolder(dir));
		if (dir !== undefined && !usable)
			warn("ocean-crew: the working folder %s is gone; %s starts in the team workspace", dir, title);
		const known = usable ? await workspaces.resolveByPath?.(dir as string) : undefined;
		let place: Record<string, unknown>;
		if (known !== undefined) place = { workspaceId: known.id };
		else if (dir !== undefined && usable) place = { cwd: dir };
		else place = { workspaceId: await ensureWorkspace() };
		if (typeof sessions.create !== "function")
			throw new Error("DeepSeek Harness did not provide a session controller");
		const { sessionId } = await sessions.create({ ...place, ...(await botPreset()) });
		const agent = await resolveAgent(sessionId);
		await sessionTitle?.rename?.(agent.session, title);
		return sessionId;
	}

	// A new Bot or group is written only after its Session is made, several awaits after
	// its name was checked. The name is held from the check until the create ends, so a
	// create or rename that runs meanwhile cannot take it too.
	const held = { bot: new Set<string>(), room: new Set<string>() };
	const isHeld = (kind: "bot" | "room", name: unknown): boolean => held[kind].has(normalize(name));
	async function holdName<T>(kind: "bot" | "room", name: unknown, work: () => Promise<T>): Promise<T> {
		const key = normalize(name);
		if (key === "") return work();
		held[kind].add(key);
		try {
			return await work();
		} finally {
			held[kind].delete(key);
		}
	}
	const botNameTaken = (name: string): boolean => rt.findBot(name) !== undefined || isHeld("bot", name);

	const freshName = (base: string): string => {
		const stem = base.slice(0, 34);
		if (!botNameTaken(stem)) return stem;
		let index = 2;
		while (botNameTaken(`${stem} ${index}`)) index += 1;
		return `${stem} ${index}`;
	};

	// `pickModel` leaves the model to the user: the chat opens on a model card, and the
	// greeting waits until a model is chosen. So does a Bot made when no model it can
	// run on is served.
	async function createBot(options: CreateBotOptions): Promise<Bot> {
		const cleanName = String(options.name ?? "")
			.trim()
			.slice(0, 40);
		const problem = nameProblem(cleanName);
		if (problem !== undefined) throw new Error(problem);
		if (botNameTaken(cleanName)) throw new Error(`A Bot named ${cleanName} already exists`);
		return holdName("bot", cleanName, () => buildBot(cleanName, options));
	}

	async function buildBot(cleanName: string, options: CreateBotOptions): Promise<Bot> {
		const {
			role = "",
			instructions = "",
			color,
			brief = "",
			createdBy,
			main = false,
			avatar,
			model,
			effort,
			workDir,
			copyOf,
			pickModel = false,
		} = options;
		const cleanAvatarValue = cleanAvatar(avatar);
		// The model is fixed at creation, so a later change of the DSH default leaves it alone.
		const modelRef = model ? await resolveModel(model) : pickModel ? undefined : await defaultBotModel();
		// A thinking level needs a model to resolve against; with none it would be dropped
		// silently, so the create fails before a Session is made.
		if (effort && modelRef === undefined) throw new Error("Pick a model before choosing a thinking level");
		// An explicit level wins; an explicit Default (null) picks the model's own level; an
		// untouched pick inherits the profile default's level.
		const effortId =
			modelRef === undefined
				? undefined
				: effort === null || effort === ""
					? undefined
					: ((await resolveEffort(modelRef, effort)) ?? (await defaultEffort(modelRef)));
		const dir = workDir === undefined || workDir === null ? undefined : await cleanWorkDir(workDir);
		const clash = dir === undefined ? undefined : await privateClash(dir);
		if (clash)
			throw new Error(
				`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${cleanName} cannot work there`,
			);
		const id = await createSession(cleanName, dir === undefined ? {} : { dir });
		try {
			const picked = currentColor(typeof color === "string" ? color : undefined);
			state.bots[id] = {
				id,
				name: cleanName,
				role: String(role).trim().slice(0, 24),
				// A color is only stored when the user picks one; otherwise the id picks it.
				...(isColor(picked) ? { color: picked } : {}),
				...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
				...(modelRef ? { model: modelRef } : {}),
				...(effortId ? { effort: effortId } : {}),
				...(dir ? { workDir: dir } : {}),
				instructions: String(instructions).trim(),
				createdAt: Date.now(),
				createdBy: createdBy ?? null,
				capabilities: [],
			};
			if (main) state.mainBotIds.push(id);
			const creator = rt.botOf(createdBy);
			const original = rt.botOf(copyOf);
			const language = rt.uiLanguage?.() as string | undefined;
			// The kickoff arrives as a user message, so it outranks the Bot's instructions
			// unless it gives way to them, and it names no tool those instructions may rule out.
			const kickoff = main
				? `You were just set up as the user's Main Bot. Greet the user in one or two short messages: say you will run their Bot team and that they can come to you for anything that needs a decision. Then ask in one short question what they want the team to help with first. ${writeIn(language)}`
				: original
					? `The user just made you as a copy of ${original.name}: same job, fresh memory. Greet the user in one short message, then ask in one short question what this copy should focus on.`
					: creator
						? `${creator.name} just created you for the user.${brief ? ` Why you exist: ${brief}` : ""}\nGreet the user in one short message, then ask in one short question where to start. Keep it brief.`
						: brief
							? `The user just created you and sent this first message:\n\n${brief}\n\nIntroduce yourself in one short line, then help with it.`
							: "The user just created you. Greet the user in one short message, then ask in one short question what you should focus on.";
			const opener = `${kickoff}\n${OWN_RULES}`;
			const text = !main && language ? `${opener}\nWrite in ${language}.` : opener;
			const bot = state.bots[id];
			const greeting: Greeting = { text, from: createdBy ?? null, ...(main ? { main: true } : {}) };
			// The Bot is saved by now; a failure here must not archive it in the catch below.
			const scopeTools = (): Promise<unknown> =>
				resolveAgent(id).catch((error) =>
					warn("ocean-crew: scoped tools for %s not applied: %s", cleanName, error),
				);
			if (modelRef === undefined) {
				bot.kickoff = greeting;
				await rt.save();
				// The Session was resolved before the Bot existed, so its scoped tools land now.
				await scopeTools();
				return bot;
			}
			await rt.save();
			await scopeTools();
			// The greeting runs on the Bot's own model, once its provider is registered.
			void waitForModel(bot)
				.then(() =>
					applyModel(bot).catch((error) => warn("ocean-crew: model for %s not applied: %s", cleanName, error)),
				)
				.then(() => sendKickoff(bot, greeting));
			return bot;
		} catch (error) {
			// The Bot's Session was already made: archive it instead of leaving an orphan.
			delete state.bots[id];
			state.mainBotIds = state.mainBotIds.filter((other) => other !== id);
			rt.chatOwners.delete(id);
			// A save that another change queued meanwhile still carries this Bot; a later one
			// writes the team without it.
			void rt.save().catch(() => undefined);
			await archive(id).catch((archiveError) =>
				warn("ocean-crew: archiving the Session for %s failed: %s", cleanName, archiveError),
			);
			throw error;
		}
	}

	// Greetings sent, by Bot: one whose turn a key, a sign-in or a balance stops is held
	// again (turns.ts), to go out once the user has fixed that.
	const sentKickoffs = new Map<BotId, Greeting>();
	function sendKickoff(bot: Bot, greeting: Greeting): void {
		sentKickoffs.set(bot.id, greeting);
		const text = greeting.afterUser
			? `${AFTER_USER} ${writeIn(rt.uiLanguage?.() as string | undefined)}\n${OWN_RULES}`
			: greeting.text;
		void deliver({ fromId: greeting.from ?? undefined, toId: bot.id, text, role: "kickoff" }).catch((error) =>
			warn("ocean-crew: kickoff failed: %s", error),
		);
	}

	// A held greeting goes out once its Bot has a model, on that model once its provider
	// is registered. False while the Bot has none.
	const releasing = new Set<BotId>();
	async function releaseKickoff(bot: Bot): Promise<boolean> {
		const greeting = kickoffOf(bot);
		if (greeting === undefined || !bot.model) return false;
		delete bot.kickoff;
		releasing.add(bot.id);
		await rt.save().catch((error) => {
			releasing.delete(bot.id);
			throw error;
		});
		const send = (): void => {
			releasing.delete(bot.id);
			sendKickoff(bot, greeting);
		};
		void waitForModel(bot).then(send, send);
		return true;
	}

	// A greeting on its way to a Bot: released and waiting for its model, or sent to its
	// chat and not yet taken up by a turn there (resume.ts notes what no turn took up).
	function greetingOut(botId: BotId): boolean {
		if (releasing.has(botId)) return true;
		return unreadOf(rt.chatOf(botId)).some((args) => (args as { role?: string } | undefined)?.role === "kickoff");
	}

	function holdKickoffAgain(botId: BotId): void {
		const bot = rt.botOf(botId);
		const greeting = sentKickoffs.get(botId);
		sentKickoffs.delete(botId);
		if (bot === undefined || greeting === undefined || bot.kickoff !== undefined) return;
		// "You are the Main Bot" must not go out after a demotion.
		if (greeting.main && !rt.isMain(botId)) return;
		bot.kickoff = greeting;
		void rt.save().catch(() => undefined);
	}

	// The user wrote in a Bot's own chat, so a held greeting would only interrupt. The
	// first Main Bot's stays while that Bot has no model it can run on, and a Bot that a
	// key, a sign-in or a balance blocks has none: once it has one, it answers the message
	// first, unless a turn answered it meanwhile (userAnswered). Read from the catalog as
	// last listed, so it is marked before that turn can end.
	function userWrote(botId: BotId): void {
		const bot = rt.botOf(botId);
		const greeting = kickoffOf(bot);
		if (bot === undefined || greeting === undefined || greeting.afterUser) return;
		if (greeting.main && (bot.blocked !== undefined || !isUsable(bot.model))) greeting.afterUser = true;
		else delete bot.kickoff;
		void rt.save().catch(() => undefined);
	}

	// A turn that answered the user in a Bot's own chat leaves nothing for a greeting held
	// for that message to answer.
	function userAnswered(botId: BotId): void {
		const bot = rt.botOf(botId);
		if ((bot?.kickoff as Greeting | undefined)?.afterUser !== true) return;
		delete bot?.kickoff;
		void rt.save().catch(() => undefined);
	}

	async function duplicateBot(id: BotId): Promise<Bot> {
		const bot = rt.botOf(id);
		if (bot === undefined) throw new Error("Unknown Bot");
		if (bot.private === true) throw new Error(`${bot.name} is private, so it cannot be copied`);
		const served = (await catalog()).some((entry) => entry.ref === bot.model);
		// A folder that went away since leaves the copy in the team workspace.
		const workDir = bot.workDir !== undefined && (await isFolder(bot.workDir)) ? bot.workDir : undefined;
		// No await from here to createBot's check, so two copies at once get different names.
		return createBot({
			name: freshName(`${bot.name} copy`),
			role: bot.role,
			instructions: bot.instructions,
			color: bot.color,
			avatar: bot.avatar,
			model: served ? bot.model : undefined,
			// A copy of a Bot on the model's own default stays on it (null marks the
			// explicit Default pick); else the create would inherit the profile level.
			effort: served ? (bot.effort ?? null) : undefined,
			workDir,
			copyOf: bot.id,
		});
	}

	async function updateBot(id: BotId, patch: BotPatch, actorId?: BotId, fromSessionId?: string): Promise<Bot> {
		const bot = rt.botOf(id);
		if (bot === undefined) throw new Error("Unknown Bot");
		if (patch.private !== undefined && actorId !== undefined)
			throw new Error(`Only the user can make ${bot.name} private or open`);
		// Checked first, so a folder, model or level that does not pass leaves the rest
		// unchanged too.
		const moving = patch.workDir !== undefined;
		const workDir = moving ? await cleanWorkDir(patch.workDir ?? "") : undefined;
		const flag = patch.private === undefined ? undefined : patch.private === true;
		await checkPrivacyChange(bot, { flag, moving, workDir });
		const modelRef =
			patch.model === undefined
				? undefined
				: patch.model === null || patch.model === ""
					? null
					: await resolveModel(patch.model);
		// What a Bot runs on changes only from its settings, after the user confirmed: every
		// conversation of the Bot starts a new part for it. A Bot without a model runs on the
		// one it last ran on, and one that never ran runs on Ocean Crew's models.
		const engineBefore = rt.engineOf === undefined ? undefined : (rt.engineOfBot?.(bot) ?? "model");
		if (modelRef === null && engineBefore !== undefined && engineBefore !== "model")
			throw new Error(`${bot.name} runs on a local agent and keeps a model of it`);
		const engineChanged = !!modelRef && engineBefore !== undefined && rt.engineOf?.(modelRef) !== engineBefore;
		if (engineChanged && actorId !== undefined)
			throw new Error(`Only the user can change what ${bot.name} runs on, in the Bot's settings`);
		if (engineChanged && patch.changeEngine !== true)
			throw new Error(`Changing what ${bot.name} runs on needs a confirmation in the Bot's settings`);
		// A new level resolves against the model the Bot will run on: the new one, the
		// model it keeps, or — the model cleared — the one it last ran on.
		const effortRef = modelRef === undefined ? (bot.model ?? bot.appliedModel) : (modelRef ?? bot.appliedModel);
		let effortId: string | null | undefined;
		if (patch.effort !== undefined) {
			if (patch.effort === null || patch.effort === "") effortId = null;
			else {
				if (effortRef === undefined) throw new Error("Pick a model before choosing a thinking level");
				effortId = await resolveEffort(effortRef, patch.effort);
			}
		}
		if (patch.name !== undefined) {
			const next = String(patch.name).trim().slice(0, 40);
			const clash = rt.findBot(next);
			const pending = isHeld("bot", next) && normalize(next) !== normalize(bot.name);
			if (next === "" || (clash !== undefined && clash.id !== id) || pending)
				throw new Error(`Name ${next} is not available`);
			// A name saved before the rule stays usable until it changes.
			const problem = next === bot.name ? undefined : nameProblem(next);
			if (problem !== undefined) throw new Error(problem);
			bot.name = next;
			const agent = await resolveAgent(rt.chatOf(id));
			await sessionTitle?.rename?.(agent.session, next);
			await followMemberNames(Object.values(state.rooms).filter((room) => room.members.includes(id)));
		}
		const roleBefore = bot.role;
		const instructionsBefore = bot.instructions;
		if (patch.role !== undefined) bot.role = String(patch.role).trim().slice(0, 24);
		if (patch.instructions !== undefined) bot.instructions = String(patch.instructions).trim();
		let modelChanged = false;
		if (patch.color !== undefined) {
			if (patch.color === null) delete bot.color;
			else {
				const picked = currentColor(String(patch.color));
				if (isColor(picked)) bot.color = picked;
			}
		}
		if (patch.avatar !== undefined) {
			const avatar = cleanAvatar(patch.avatar);
			if (avatar) bot.avatar = avatar;
			else delete bot.avatar;
		}
		if (patch.model !== undefined) {
			// A failure that blocked the Bot was its old model's (turns.js).
			if ((modelRef ?? undefined) !== bot.model) delete bot.blocked;
			if (modelRef === null) delete bot.model;
			else bot.model = modelRef;
			modelChanged = true;
		}
		if (patch.effort !== undefined) {
			if (effortId === null) delete bot.effort;
			else bot.effort = effortId;
			modelChanged = true;
		}
		if (patch.permission !== undefined) await setPermission(bot, patch.permission);
		if (flag === true) bot.private = true;
		else if (flag === false) delete bot.private;
		const moved = moving && workDir !== bot.workDir;
		if (moving) {
			if (workDir === undefined) delete bot.workDir;
			else bot.workDir = workDir;
		}
		await rt.save();
		// The system prompt reads the live profile every turn, but a Session with several
		// rounds behind it follows the old kickoff's pull until a message lands; notify the
		// Bot's chat so the next turn honors the new profile.
		const notes: string[] = [];
		if (bot.role !== roleBefore) notes.push(`Your role is now "${bot.role || "(none)"}"`);
		if (bot.instructions !== instructionsBefore)
			notes.push(`Your instructions now read:\n${bot.instructions || "(none)"}`);
		// A held greeting means the model pick is still open: the kickoff it later sends
		// already reads the new profile, and a notice would start a turn before that.
		// A Bot editing itself in its own chat just got the tool result in the turn that
		// made the edit; a notice there would only buy it a second, unsolicited reply.
		const selfEditInChat = actorId === bot.id && fromSessionId === rt.chatOf(bot.id);
		if (notes.length > 0 && bot.kickoff === undefined && !selfEditInChat) {
			void deliver({ toId: bot.id, text: notes.join("\n"), role: "update" }).catch((error) =>
				warn(
					"ocean-crew: profile update for %s not delivered: %s",
					bot.name,
					(error as { message?: string })?.message ?? error,
				),
			);
		}
		if (modelChanged) await applyModel(bot, { force: true });
		if (engineChanged) void rt.followEngine?.(bot.id);
		if (moved) void rt.followFolder?.({ botId: bot.id });
		// A new model lifted what blocked the Bot; a new thinking level alone fixes nothing.
		// releaseKickoff itself leaves when the Bot still lacks a model or holds no greeting.
		if (modelChanged && bot.blocked === undefined) await releaseKickoff(bot);
		return bot;
	}

	async function setFlags(id: string, flags: { pinned?: unknown; hidden?: unknown }): Promise<Bot | Room | TeamAgent> {
		const found = (rt.botOf(id) ?? rt.roomOf(id) ?? rt.own(state.agents, id)) as Bot | Room | TeamAgent | undefined;
		if (found === undefined) throw new Error("Unknown conversation");
		const entry = found as unknown as Record<string, unknown>;
		if (typeof flags.pinned === "boolean") entry.pinned = flags.pinned;
		if (typeof flags.hidden === "boolean") entry.hidden = flags.hidden;
		await rt.save();
		return found;
	}

	// ---------------------------------------------------------------------------
	// Group chat settings. The user and every Main Bot may change any group; a group's
	// admin may change its own group but not delete it. Only a member can be admin.

	const roomBusy = (id: RoomId): boolean => {
		const rounds = (rt.roomProgress?.values?.() ?? []) as Iterable<{ roomId?: string }>;
		return [...rounds].some((round) => round.roomId === id);
	};
	const autoRoomName = (members: BotId[]): string =>
		["You", ...members.map((id) => rt.botOf(id)?.name).filter((name): name is string => name !== undefined)].join(
			", ",
		);
	// A notice past the limit is refused rather than silently cut (#710).
	const cleanNotice = (text: unknown): string => {
		const notice = String(text ?? "").trim();
		if (notice.length > ROOM_NOTICE_MAX)
			throw new Error(
				`A group's notice can hold at most ${ROOM_NOTICE_MAX} characters; this one has ${notice.length}`,
			);
		return notice;
	};

	function cleanRoomName(text: unknown, selfId?: RoomId): string {
		const next = unquote(text).replace(/\s+/g, " ").slice(0, ROOM_NAME_MAX);
		if (next !== "" && (rt.findRooms(next).some((room) => room.id !== selfId) || isHeld("room", next)))
			throw new Error(`Another group chat is already called "${next}"`);
		return next;
	}

	async function retitleRoom(room: Room): Promise<void> {
		try {
			const agent = await resolveAgent(rt.sessionOfRoom(room) as string);
			await sessionTitle?.rename?.(agent.session, room.name);
		} catch (error) {
			warn("ocean-crew: group title for %s not updated: %s", room.name, error);
		}
	}

	// Groups without a chosen name are named after their members, so they follow renames.
	async function followMemberNames(rooms: Room[] = Object.values(state.rooms)): Promise<void> {
		for (const room of rooms) {
			if (room.named) continue;
			const next = autoRoomName(room.members);
			if (next === room.name) continue;
			room.name = next;
			await retitleRoom(room);
		}
	}

	function checkMembers(members: BotId[]): void {
		if (members.length < 2) throw new Error("A group chat needs at least two Bots");
		if (members.length > ROOM_MAX_MEMBERS) throw new Error(`A group chat holds at most ${ROOM_MAX_MEMBERS} Bots`);
		checkNoPrivate(members);
	}

	// A Main Bot leads the groups it makes; a group the user makes is led by a Main Bot
	// member when it has one.
	const defaultAdmin = (members: BotId[], createdBy?: BotId): BotId | null =>
		createdBy !== undefined && members.includes(createdBy)
			? createdBy
			: (members.find((id) => rt.isMain(id)) ?? null);

	async function createRoom(options: CreateRoomOptions = {}): Promise<Room> {
		const memberIds = Array.isArray(options.members) ? options.members : [];
		const members = [...new Set(memberIds)].filter((id) => rt.botOf(id) !== undefined);
		checkMembers(members);
		const custom = cleanRoomName(options.name ?? "", undefined);
		const adminId = options.admin !== undefined ? options.admin : defaultAdmin(members, options.createdBy);
		if (adminId !== null && !members.includes(adminId)) throw new Error("The admin must be a member of the group");
		if (options.mode !== undefined && !ROOM_MODES.includes(String(options.mode)))
			throw new Error(`Reply mode must be one of ${ROOM_MODES.join(", ")}`);
		return holdName("room", custom, () =>
			buildRoom({
				members,
				custom,
				notice: options.notice,
				mode: options.mode,
				adminId,
				createdBy: options.createdBy,
			}),
		);
	}

	async function buildRoom({
		members,
		custom,
		notice,
		mode,
		adminId,
		createdBy,
	}: {
		members: BotId[];
		custom: string;
		notice: unknown;
		mode: unknown;
		adminId: BotId | null;
		createdBy?: BotId;
	}): Promise<Room> {
		const title = custom || autoRoomName(members);
		// The group's own Session only relays; like a member's it moves to a fresh part
		// in the group's folder once the group has one (parts.js).
		const id = await createSession(title);
		try {
			// A member deleted while the Session was made stays out, and the group is checked
			// again as it is written.
			const live = members.filter((member) => rt.botOf(member) !== undefined);
			checkMembers(live);
			const lead = adminId === null || live.includes(adminId) ? adminId : defaultAdmin(live, createdBy);
			const name = custom || autoRoomName(live);
			const room: Room = {
				id,
				name,
				...(custom ? { named: true } : {}),
				members: live,
				admin: lead,
				mode: (mode ?? "admin") as RoomMode,
				notice: cleanNotice(notice),
				createdAt: Date.now(),
				createdBy: createdBy ?? null,
			};
			state.rooms[id] = room;
			await rt.save();
			// The Session was resolved before the group owned it, so its relay tool lands now.
			await resolveAgent(id);
			if (name !== title) await retitleRoom(room);
			return room;
		} catch (error) {
			// The group's Session was already made: archive it instead of leaving an orphan.
			delete state.rooms[id];
			void rt.save().catch(() => undefined);
			await archive(id).catch((archiveError) =>
				warn("ocean-crew: archiving the Session for %s failed: %s", title, archiveError),
			);
			throw error;
		}
	}

	// What a change would write to the group as it is now, or why it cannot be made. It
	// reads only the team, so updateRoom runs it to fail fast and again after its last
	// await: another change or a deleted Bot may have come in meanwhile, and `add` and
	// `remove` apply to the members the group has then.
	function planRoomChange(
		room: Room,
		patch: RoomPatch,
		actorId?: BotId,
	): {
		members: BotId[];
		admin: BotId | null;
		name: string | undefined;
		notice: string | undefined;
		permission: string | null | undefined;
	} {
		const byMain = actorId === undefined || rt.isMain(actorId);
		const byAdmin = !byMain && rt.isAdminOf(room, actorId);
		if (!byMain && !byAdmin)
			throw new Error(`Only the user, a Main Bot, or the admin of "${room.name}" can change it`);
		let members: BotId[] = Array.isArray(patch.members) ? [...new Set(patch.members as BotId[])] : [...room.members];
		for (const member of Array.isArray(patch.add) ? (patch.add as BotId[]) : [])
			if (!members.includes(member)) members.push(member);
		const removed = Array.isArray(patch.remove) ? (patch.remove as BotId[]) : [];
		members = members.filter((member) => !removed.includes(member) && rt.botOf(member) !== undefined);
		// A group left with one Bot by a deletion can still change its other settings.
		const current = room.members.filter((member) => rt.botOf(member) !== undefined);
		if (members.length !== current.length || members.some((member) => !current.includes(member)))
			checkMembers(members);
		let admin: BotId | null = room.admin ?? null;
		if (patch.admin !== undefined) {
			admin = patch.admin === null || patch.admin === "" ? null : (patch.admin as BotId);
			if (admin === null && byAdmin)
				throw new Error("Hand the admin role to another member instead of leaving the group without one");
			if (admin !== null && !members.includes(admin))
				throw new Error(`${rt.botOf(admin)?.name ?? "That Bot"} must be a member to be the admin`);
		}
		if (admin !== null && !members.includes(admin)) {
			if (byAdmin && admin === actorId)
				throw new Error("Hand the admin role to another member before leaving the group");
			admin = null;
		}
		if (patch.mode !== undefined && !ROOM_MODES.includes(String(patch.mode)))
			throw new Error(`Reply mode must be one of ${ROOM_MODES.join(", ")}`);
		const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice);
		if (patch.workDir !== undefined && byAdmin)
			throw new Error(`Only the user or a Main Bot can set the folder of "${room.name}"`);
		// A Bot's own permissions are the user's to set, so a group's are too.
		if (patch.permission !== undefined && actorId !== undefined)
			throw new Error(`Only the user can set the permissions of "${room.name}"`);
		const permission = patch.permission === undefined ? undefined : cleanRoomPermission(patch.permission);
		// The second run is the last check before the change is written, so no other change
		// can take the name in between.
		const name = patch.name === undefined ? undefined : cleanRoomName(patch.name, room.id);
		return { members, admin, name, notice, permission };
	}

	// `actorId` is the Bot asking, or undefined for the user. Returns what changed, in words.
	async function updateRoom(
		id: RoomId,
		patch: RoomPatch,
		actorId?: BotId,
	): Promise<{ room: Room; changes: string[] }> {
		const asked = rt.roomOf(id);
		if (asked === undefined) throw new Error("Unknown group chat");
		planRoomChange(asked, patch, actorId);
		const moving = patch.workDir !== undefined;
		const workDir = moving ? await cleanWorkDir(patch.workDir ?? "") : undefined;
		const clash = workDir === undefined ? undefined : await privateClash(workDir);
		if (clash)
			throw new Error(
				`${workDir} is in or around the folder of ${clash.name}, a private Bot, so a group cannot work there`,
			);
		// No await from here until every change is written.
		const room = rt.roomOf(id);
		if (room === undefined) throw new Error("Unknown group chat");
		const { members, admin, name, notice, permission } = planRoomChange(room, patch, actorId);

		const changes: string[] = [];
		const names = (ids: BotId[]): string =>
			ids
				.map((member) => rt.botOf(member)?.name)
				.filter(Boolean)
				.join(", ");
		const added = members.filter((member) => !room.members.includes(member));
		const removed = room.members.filter((member) => !members.includes(member));
		if (added.length > 0) changes.push(`added ${names(added)}`);
		// A deleted Bot still listed goes without a word.
		if (names(removed) !== "") changes.push(`removed ${names(removed)}`);
		// A member who leaves and comes back starts from a fresh look at the log.
		for (const member of removed) {
			if (room.seen !== undefined) delete room.seen[member];
			rt.dropGroupSession(room, member);
		}
		room.members = members;
		if (admin !== (room.admin ?? null))
			changes.push(admin ? `made ${rt.botOf(admin)?.name} the admin` : "removed the admin");
		room.admin = admin;
		if (patch.mode !== undefined && String(patch.mode) !== room.mode) {
			room.mode = patch.mode as RoomMode;
			changes.push(
				patch.mode === "admin" ? "plain messages now go to the admin first" : "every member now replies in turn",
			);
		}
		if (notice !== undefined && notice !== (room.notice ?? "")) {
			room.notice = notice;
			changes.push(notice ? "updated the notice" : "cleared the notice");
		}
		// Members' group conversations move on to the folder at their next turn there;
		// the group's own Session moves the same way, now when it is idle.
		if (moving && workDir !== room.workDir) {
			delete room.folderNotice;
			if (workDir === undefined) delete room.workDir;
			else room.workDir = workDir;
			// A member's own pick for this group gives way to the group's folder, and a
			// cleared one does not bring it back.
			delete room.memberDirs;
			changes.push(
				workDir ? `every member now works in ${workDir} here` : "every member works in its own folder again",
			);
			void rt.followFolder?.({ roomId: room.id });
		}
		const before = room.name;
		if (name !== undefined) {
			if (name !== "") {
				room.named = true;
				room.name = name;
			} else {
				delete room.named;
			}
		}
		if (!room.named) room.name = autoRoomName(room.members);
		// The preset is written before its first await; the members' Sessions follow it.
		if (permission !== undefined && (await setRoomPermission(room, permission))) {
			changes.push(
				permission
					? `every member now works with the ${permission} permissions here`
					: "every member uses its own permissions again",
			);
		}
		if (room.name !== before) {
			changes.push(`renamed it "${room.name}"`);
			await retitleRoom(room);
		}
		await rt.save();
		return { room, changes };
	}

	async function deleteRoom(id: RoomId): Promise<void> {
		const room = rt.roomOf(id);
		if (room === undefined) throw new Error("Unknown group chat");
		// Before the group's Sessions leave the state, which the archive reads.
		const archived = archiveGroupMemory(room);
		for (const botId of Object.keys(room.sessions ?? {})) rt.dropGroupSession(room, botId);
		for (const segment of room.parts ?? []) delete state.switching[segment.sessionId];
		delete state.switching[rt.sessionOfRoom(room) as string];
		delete state.rooms[id];
		rt.roomInbox?.delete(id);
		dropGroupLines(id);
		await archived;
		const failed = await saveForDelete();
		// Armed scheduled tasks refuse a plain archive and would keep delivering into
		// the deleted group; the session-stop that stopActivity runs removes them.
		await archive(rt.sessionOfRoom(room), { stopActivity: true }).catch((error) =>
			warn("ocean-crew: group chat %s not archived: %s", room.name, error),
		);
		if (failed !== undefined) throw failed;
	}

	// The first Main Bot is the sidebar tile. `replace` gives a Main Bot's place to
	// another Bot in one step, so the team never has none; `primary` moves a Bot to the
	// front and keeps the others.
	async function setMain(
		id: BotId,
		main: boolean,
		{ primary = false, replace }: { primary?: boolean; replace?: BotId } = {},
	): Promise<void> {
		const bot = rt.botOf(id);
		if (bot === undefined) throw new Error("Unknown Bot");
		if (main && bot.private === true) throw new Error(`${bot.name} is private, so it cannot be a Main Bot`);
		const others = state.mainBotIds.filter((other) => other !== id);
		let next: BotId[];
		if (!main) {
			if (!rt.isMain(id)) return;
			if (others.length === 0) throw new Error("The team needs at least one Main Bot");
			next = others;
		} else if (replace !== undefined && replace !== id) {
			const at = others.indexOf(replace);
			if (at === -1) throw new Error("Only a Main Bot can be replaced");
			next = others.with(at, id);
		} else if (primary) {
			next = [id, ...others];
		} else {
			next = rt.isMain(id) ? state.mainBotIds : [...others, id];
		}
		// The sidebar shows every Main Bot, so a hidden Bot would vanish again once demoted.
		if (main) delete bot.hidden;
		// A held setup greeting says "you are the Main Bot"; it must not go out after demotion.
		for (const other of state.mainBotIds.filter((other) => !next.includes(other))) {
			const demoted = rt.botOf(other);
			if ((demoted?.kickoff as Greeting | undefined)?.main) delete demoted?.kickoff;
		}
		state.mainBotIds = next;
		await rt.save();
	}

	async function deleteBot(id: BotId): Promise<void> {
		const bot = rt.botOf(id);
		if (bot === undefined) throw new Error("Unknown Bot");
		if (rt.isMain(id)) throw new Error("A Main Bot cannot be deleted; remove its Main Bot role first");
		// Before the Bot and its group Sessions leave the state, which the archive reads.
		const archived = archiveBotMemory(id);
		const current = rt.chatOf(id);
		// Questions and exchange turns are kept per Session, so every part of the chat is cleared.
		const parts = new Set([id, current, ...(bot.segments ?? []).map((segment) => segment.sessionId)]);
		// `archiving` stands until the archive's path is known: the memory may already be
		// there, and no region of its own closes it yet.
		const closedArchive: PrivateArchive | undefined =
			bot.private === true
				? {
						id: bot.id,
						name: bot.name,
						...(bot.workDir === undefined ? {} : { workDir: bot.workDir }),
						sessionIds: [...parts, ...rt.groupSessionsOf(id)],
						archiving: true,
					}
				: undefined;
		await releaseBot(id, [...parts, ...rt.groupSessionsOf(id)]);
		if (closedArchive !== undefined)
			state.privateArchives = [
				...(state.privateArchives ?? []).filter((entry) => (entry as { id?: string }).id !== id),
				closedArchive,
			];
		delete state.bots[id];
		// The shared capability list is the user's and keeps its items; only a
		// still-unapproved local MCP this Bot alone asked for leaves with it.
		rt.dropOrphanCapabilities?.(bot);
		for (const part of parts) {
			delete state.questions[part];
			if (state.views !== undefined) delete state.views[part];
			if (state.closedCards !== undefined) delete state.closedCards[part];
			delete state.exchangeTurns[part];
			delete state.switching[part];
		}
		const touched: Room[] = [];
		for (const room of Object.values(state.rooms)) {
			if (!room.members.includes(id)) continue;
			room.members = room.members.filter((member) => member !== id);
			if (room.admin === id) room.admin = null;
			rt.dropGroupSession(room, id);
			touched.push(room);
		}
		await followMemberNames(touched);
		await forgetBotSecrets(id);
		const archivePath = await archived;
		if (closedArchive !== undefined) {
			// No path means nothing was moved: a memory that stayed in place is a region already.
			if (archivePath !== undefined) closedArchive.archivePath = archivePath;
			delete closedArchive.archiving;
		}
		const failed = await saveForDelete();
		// Same as deleteRoom: stopActivity removes the Session's armed scheduled tasks.
		// Past parts are archived too: a part move can leave tasks on the old Session,
		// which otherwise stays armed and invisible. Already-archived ids are a no-op.
		for (const part of parts)
			await archive(part, { stopActivity: true }).catch((error) =>
				warn("ocean-crew: Bot %s not archived: %s", bot.name, error),
			);
		if (failed !== undefined) throw failed;
	}

	// A deletion whose save fails stays in memory, and the next save writes it, so its
	// Sessions are stopped anyway: left armed, their scheduled tasks would keep running
	// with nothing in the team to show or delete them. Only a host that lost the team
	// to another dsh keeps them, since the other host's copy still has them.
	async function saveForDelete(): Promise<unknown> {
		try {
			await rt.save();
			return undefined;
		} catch (error) {
			if ((error as { code?: string })?.code === "ELOCKLOST" || rt.readOnly() !== undefined) throw error;
			return error;
		}
	}

	async function bootstrap(): Promise<void> {
		await rt.load();
		void rt.syncModels?.();
		if (state.mainBotIds.some((id) => rt.botOf(id) !== undefined)) return;
		// Only the team's first Main Bot is stored as the DeepSeek whale; other Bots get a
		// look from their id, and a Bot made Main Bot later keeps its own.
		bootstrapping ??= createBot({
			name: rt.defaults.mainName,
			role: rt.defaults.mainRole,
			main: true,
			color: "deepseek",
			avatar: { shape: "marine-whale" },
			pickModel: true,
		}).finally(() => {
			bootstrapping = null;
		});
		await bootstrapping;
	}

	Object.assign(rt, {
		ensureWorkspace,
		keepTeamFolder,
		createSession,
		createBot,
		duplicateBot,
		updateBot,
		setFlags,
		roomBusy,
		autoRoomName,
		retitleRoom,
		createRoom,
		updateRoom,
		deleteRoom,
		setMain,
		deleteBot,
		bootstrap,
		releaseKickoff,
		greetingOut,
		holdKickoffAgain,
		userWrote,
		userAnswered,
	});
}
