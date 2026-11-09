// The runtime every host module receives. A module registers its listeners, tools and
// effects in `install(rt)`, publishes the functions other modules call on `rt`, and
// calls other modules through `rt` only at run time.
//

// hooks;

import type { Companion } from "../../shared/companion.ts";
import type { PluginConfig } from "../../shared/config.ts";
import type { Bot, BotId, Room, RoomLogLine, TeamState } from "../../shared/state.ts";

/** The plugin's logger; other modules call it, diagnostics owns where lines go. */
export type Warn = (template: string, ...args: unknown[]) => void;

/** A tool a Bot Session gets; the tools module registers what each module pushes here. */
export interface TeamTool {
	name: string;
	description?: string;
	parameters?: unknown;
	execute?: (...args: any[]) => any;
	[key: string]: unknown;
}

export interface FetchRoute {
	path: string;
	methods: readonly string[];
	requestBody?: "buffered" | "stream";
	fetch(request: Request): Promise<Response>;
	[key: string]: unknown;
}

/** The DSH services the host modules read. Untyped members are filled in as modules are added. */
export interface DshContext {
	logger: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
	on(event: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void;
	effect(setup: () => unknown, label?: string): void;
	get(name: string): unknown;
	reflect?: { get(name: string): unknown };
	workspaceRegistry?: {
		archivedSessionIds?: readonly string[];
		archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>;
		unarchiveSession?(sessionId: string): Promise<unknown>;
		get?(workspaceId?: string): { path?: string } | undefined;
		[key: string]: unknown;
	};
	connection?: { fetch: { register(route: FetchRoute): () => void } };
	sessionController?: Record<string, unknown>;
	sessions?: Record<string, unknown>;
	sessionTitle?: Record<string, unknown>;
	systemPrompt?: Record<string, unknown>;
	tools?: Record<string, unknown>;
	llm?: Record<string, unknown>;
	attachments?: Record<string, unknown>;
	agents?: Record<string, unknown>;

	[key: string]: any;
}

/** What store.ts publishes: the saved team, its lock, and the Session indexes. */
export interface StoreApi {
	state: TeamState;
	load(): Promise<void>;
	save(options?: { required?: boolean }): Promise<void>;
	refresh(): Promise<void>;
	readOnly(): string | undefined;
	own<T>(table: Record<string, T> | null | undefined, key: string): T | undefined;
	onSaved(listener: () => void): () => void;
	closeCard(sessionId: string, card: { callId?: string } | undefined, outcome: string): void;
	botOf(id?: string): Bot | undefined;
	roomOf(id?: string): Room | undefined;
	isMain(id?: string): boolean;
	chatOf(botId: string): string;
	sessionOfRoom(room?: Room): string | undefined;
	selfOf(id?: string): string | undefined;
	isBotSession(id?: string): boolean;
	chatOwners: Map<string, string>;
	groupOwners: Map<string, { botId: string; roomId: string }>;
	roomOwners: Map<string, string>;
	pastOwners: Map<string, { botId?: string; roomId?: string }>;
	groupSessionsOf(botId: string): string[];
	dropGroupSession(room: Room, botId: string): void;
	retireGroupSession(room: Room, botId: string): void;
	findBot(ref?: unknown): Bot | undefined;
	findRooms(ref?: unknown): Room[];
	isAdminOf(room: Room, id?: string): boolean;
	/** What durable sends may assume about this host. */
	writerMode(): "owned" | "readonly" | "degraded";
}

/** The runtime assembled by `createRuntime` and filled in by each installed module. */
export interface Runtime extends StoreApi {
	ctx: DshContext;
	config: PluginConfig;
	dshHome: string;
	/** Team data directory: `$DSH_HOME/bot` by default. */
	home: string;
	statePath: string;
	/** Bot-only tools each host module contributes, scoped per Bot Session. */
	teamTools: TeamTool[];
	defaults: { mainName: string; mainRole: string };
	warn: Warn;
	/** Modules installed after store and not yet typed. */
	keepGroupLine?: (roomId: string, line: RoomLogLine, text: string) => RoomLogLine;
	autoRoomName?: (members: BotId[]) => string;
	retitleRoom?: (room: Room) => Promise<void>;
	capabilitiesStateSaved?: () => void;
	indexAgents?: () => void;
	syncScopedTools?: () => void;
	cancelApprovals?: (sessionId: string) => void;

	// companion mode
	companionOf?: (botId?: string) => Companion | undefined;
	companionMap?: () => Record<string, { name: string; mood: string; affection: number }>;
	companionView?: () => unknown;
	companionSet?: (botId: string, patch: unknown) => Promise<unknown>;
	companionTouch?: (sessionId: string, text: string) => Promise<void>;

	// handoffs, requests, delivery, roster, folders, privacy, prompt, tools, groups,
	// resume, feed, channel.
	[key: string]: any;
}

// A host module is one install function; it registers its listeners, tools and effects
// and publishes what other modules call on `rt`.
export type HostModule = (rt: Runtime) => void;
