// The saved team. The host owns `state.json`, writes it as a whole, atomically, and
// bumps `revision` on every save.

// typed exactly.

import type { Companion } from "./companion.ts";

export type BotId = string;
export type RoomId = string;
export type ConnectionId = string;
export type QuestionId = string;
export type WorkId = string;

// How a Bot looks: a built-in marine shape and a palette color, or a stored image.
export interface BotAvatar {
	shape?: string;
	color?: string;
	image?: string;
}

// One archived segment of a Bot's own chat; `sessionId` is what DSH archived.
export interface BotSegment {
	sessionId: string;
	startedAt?: number;
	readAt?: number;
	[key: string]: unknown;
}

// The greeting a Bot holds until a model is available.
export interface BotKickoff {
	/** The greeting text; every writer sets it, optional for tolerated older data. */
	text?: string;
	from?: string | null;
	main?: boolean;
	[key: string]: unknown;
}

// A terminal failure of a Bot's last turn, shown as a repair card until it clears.
export interface BotBlocked {
	code: string;
	message: string;
	status?: number;
	requestId?: string;
	[key: string]: unknown;
}

export interface Bot {
	id: BotId;
	name: string;
	role?: string;
	brief?: string;
	instructions?: string;
	model?: string;
	appliedModel?: string;
	effort?: string;
	appliedEffort?: string;
	color?: string;
	avatar?: BotAvatar;
	private?: boolean;
	hidden?: boolean;
	mainBot?: boolean;
	capabilities?: string[];
	workDir?: string;
	/** The current own-chat Session; absent means `id` is the current one. */
	sessionId?: string;
	sessionIds?: string[];
	segments?: BotSegment[];
	createdAt?: number;
	kickoff?: BotKickoff;
	blocked?: BotBlocked;
	permission?: string;
	archivePath?: string;
	archiving?: boolean;
	[key: string]: unknown;
}

export interface RoomLogLine {
	seq: number;
	/** Set when the whole line lives in `group-lines/<room>/<seq>.txt`; the log keeps the head. */
	length?: number;
	text?: string;
	from?: BotId;
	at?: number;
	kind?: string;
	[key: string]: unknown;
}

export type RoomMode = "everyone" | "admin";

export interface Room {
	id: RoomId;
	name: string;
	members: BotId[];
	mode: RoomMode;
	admin?: BotId | null;
	named?: boolean;
	notice?: string;
	goal?: string;
	createdAt?: number;
	/** The group's own Session; absent means `id` is the current one. */
	sessionId?: string;
	/** Member group Sessions, keyed by Bot. */
	sessions?: Record<BotId, string>;
	segments?: Record<BotId, BotSegment[]>;
	parts?: BotSegment[];
	log?: RoomLogLine[];
	seq?: number;
	seen?: Record<BotId, number>;
	paused?: boolean;
	idlePaused?: boolean;
	idleRelays?: number;
	workDir?: string;
	memberDirs?: Record<BotId, string | null>;
	folderNotice?: string;
	permission?: string;
	pastGoals?: unknown[];
	[key: string]: unknown;
}

export interface Exchange {
	id: string;
	from: BotId;
	to: BotId;
	/** What the message was: request, reply, room, report, kickoff, ... */
	role?: string;
	text: string;
	/** Original character count when the saved text was cut to `TEXT_KEPT`. */
	length?: number;
	time?: number;
	at?: number;
	roomId?: RoomId;
	replyTo?: string;
	audience?: string;
	sessionId?: string;
	files?: unknown[];
	[key: string]: unknown;
}

export interface TeamQuestionOption {
	label: string;
	value: string;
	description?: string;
}

// A pending ask_user card. The table key is the Session that asked; the id names the
// card in the transcript, `callId` ties it to the tool call when the card is in a turn.
export interface TeamQuestion {
	id: string;
	callId?: string;
	question: string;
	detail?: string;
	options?: string[];
	multiSelect?: boolean;
	allowCustom?: boolean;
	askedAt: number;
	[key: string]: unknown;
}

// A pending show_view card, keyed by the Session that showed it.
export interface TeamView {
	id: string;
	callId?: string;
	title: string;
	view: unknown;
	askedAt: number;
	[key: string]: unknown;
}

// One result handed back for a work item; a long one lives in `handoff-results/`.
export interface WorkResult {
	id: string;
	name: string;
	text: string;
	/** Original length when `text` was cut to the stored head. */
	length?: number;
	file?: string;
	child?: string;
	at: number;
	failed?: boolean;
	[key: string]: unknown;
}

// A Bot-to-Bot work item: the identity tree, its open children and the results it holds.
// The shape is the one the saved team uses; ids are the table keys.
export interface TeamWork {
	from?: BotId;
	to?: BotId;
	room?: RoomId;
	parent?: WorkId;
	fromRoom?: RoomId;
	name?: string;
	child?: string;
	late?: boolean;
	/** The start of a long result while the answer is not folded in yet. */
	held?: string;
	open: WorkId[];
	results: WorkResult[];
	at?: number;
	[key: string]: unknown;
}

// One idempotent Bot-to-Bot request receipt: the fingerprint of what was asked and how
// far the delivery got. The request name is the table key.
export interface TeamRequest {
	fingerprint: string;
	outcome: "pending" | "delivered" | "uncertain";
	receipt?: unknown;
	at?: number;
	run?: string;
	[key: string]: unknown;
}

// The team's one DSH Agent, as saved in `agents` (the table key is its id).
export interface TeamAgent {
	id: string;
	name?: string;
	sessions?: string[];
	createdAt?: number;
	[key: string]: unknown;
}

// One capability the user keeps, keyed by `name`. The fields differ by kind; this is
// the shape every kind shares.
export interface Capability {
	name: string;
	kind: "mcp" | "skill" | "pack";
	id?: string;
	description?: string;
	[key: string]: unknown;
}

export interface CapabilitiesState {
	items: Record<string, Capability>;
}

export interface Prefs {
	defaultBotModel?: string;
	enterToSend?: boolean;
	theme?: string;
	messageLayout?: string;
	accent?: string;
	animation?: string;
	width?: number;
	[key: string]: unknown;
}

// The two private-chat connectors the product keeps; external group chats are out of
// scope.
export type ImPlatformId = "feishu" | "weixin";

export interface ImConnection {
	id: ConnectionId;
	platform: ImPlatformId;
	botId: BotId;
	enabled: boolean;
	settings: Record<string, string | undefined>;
	pairees: { id: string; name: string; at: number }[];
	secrets: Record<string, string>;
	// Where a Bot's reply may go. "source" (the default) answers only the chat the
	// message came from; "all" mirrors every chat of this connection that listens to the
	// Bot. A conversation that started in the window sends nothing to IM at all.
	mirror?: "source" | "all";
	[key: string]: unknown;
}

export interface ImState {
	connections: Record<ConnectionId, ImConnection>;
	[key: string]: unknown;
}

export interface TeamState {
	version: 1;
	workspaceId?: string;
	mainBotIds: BotId[];
	bots: Record<BotId, Bot>;
	privateArchives: unknown[];
	rooms: Record<RoomId, Room>;
	agents: Record<string, TeamAgent>;
	capabilities: CapabilitiesState;
	exchanges: Exchange[];
	exchangeTurns: Record<string, number[]>;
	works: Record<WorkId, TeamWork>;
	requests: Record<string, TeamRequest>;
	questions: Record<string, TeamQuestion>;
	views: Record<string, TeamView>;
	closedCards: Record<string, Record<string, string>>;
	prefs: Prefs;
	switching: Record<string, unknown>;
	revision: number;
	whaleStored?: boolean;
	/** Companion mode records, by Bot id (see shared/companion.ts). */
	companions?: Record<string, Companion>;
	im?: ImState;
	secrets?: Record<string, unknown>;
	connectors?: Record<string, unknown>;
	secretRequests?: Record<string, unknown>;
	connectorRequests?: Record<string, unknown>;
	mailRequests?: Record<string, unknown>;
	[key: string]: unknown;
}

// The state a fresh team starts from. A function rather than a constant so no module
// can mutate another module's empty team through a shared object.
export function emptyTeam(): TeamState {
	return {
		version: 1,
		mainBotIds: [],
		bots: {},
		privateArchives: [],
		rooms: {},
		agents: {},
		capabilities: { items: {} },
		exchanges: [],
		exchangeTurns: {},
		works: {},
		requests: {},
		questions: {},
		views: {},
		closedCards: {},
		prefs: {},
		switching: {},
		revision: 0,
	};
}
