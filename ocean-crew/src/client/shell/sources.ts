// Small observable sources for the client's inject `hooks` compartment, and the roster
// shape those sources hold. Everything here is pure: a source is a get/subscribe/set cell,
// the roster indexes only what the host sent, and the card counters are plain maps.

/** A tiny external store; `useSyncExternalStore` reads it through getSnapshot/subscribe. */
export interface Source<T> {
	getSnapshot(): T;
	subscribe(listener: () => void): () => void;
	set(next: T | ((prev: T) => T)): void;
}

export function createSource<T>(initial: T): Source<T> {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => value,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set(next) {
			const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
			if (resolved === value) return;
			value = resolved;
			for (const listener of [...listeners]) listener();
		},
	};
}

/** One Bot as the roster view carries it. Session ids are its parts, `parts` the older ones. */
export interface RosterBot {
	id: string;
	name: string;
	role?: string | null;
	sessionId?: string;
	parts?: string[];
	hidden?: boolean;
	private?: boolean;
	[key: string]: unknown;
}

/** One internal group chat; `id` is its first Session part and `sessionId` the current one. */
export interface RosterRoom {
	id: string;
	name: string;
	members: string[];
	sessionId?: string;
	ownParts?: string[];
	parts?: string[];
	goal?: unknown;
	[key: string]: unknown;
}

/** The team's one DSH Agent: a plain Session owner, not a Bot. */
export interface RosterAgent {
	id: string;
	name?: string;
	sessions?: string[];
	[key: string]: unknown;
}

/** The roster answer, before and after indexing. */
export interface RosterView {
	revision: number;
	mainBotId: string | null;
	mainBotIds: string[];
	bots: RosterBot[];
	rooms: RosterRoom[];
	agents: RosterAgent[];
	exchangeTurns: Record<string, number[] | undefined>;
	questions: Record<string, unknown>;
	btwCards: Record<string, unknown[]>;
	sideChats: Record<string, unknown[]>;
	learning: Record<string, unknown>;
	secrets: unknown[];
	capabilities: unknown[];
	capabilityStatuses: Record<string, unknown>;
	secretRequests: Record<string, unknown>;
	models: unknown[];
	defaultModel: string | null;
	modelsKey: string | null;
	prefs: Record<string, unknown>;
	byId: Record<string, RosterBot>;
	roomsById: Record<string, RosterRoom>;
	agentsById: Record<string, RosterAgent>;
	agentOf: Record<string, string>;
	ready: boolean;
	[key: string]: unknown;
}

export const EMPTY_ROSTER: RosterView = {
	revision: -1,
	mainBotId: null,
	mainBotIds: [],
	bots: [],
	rooms: [],
	agents: [],
	exchangeTurns: {},
	questions: {},
	btwCards: {},
	sideChats: {},
	learning: {},
	secrets: [],
	capabilities: [],
	capabilityStatuses: {},
	secretRequests: {},
	models: [],
	defaultModel: null,
	modelsKey: null,
	prefs: {},
	byId: {},
	roomsById: {},
	agentsById: {},
	agentOf: {},
	ready: false,
};

// Any Main Bot holds the Main Bot powers; `mainBotId`, the first one, is the sidebar tile.
export const isMainOf = (roster: Pick<RosterView, "mainBotIds">, id?: string): boolean =>
	id !== undefined && (roster.mainBotIds ?? []).includes(id);

// A Bot's chat is a chain of Sessions ("parts"): the Bot id is its first part's id and
// `sessionId` its current one. Every part id finds the Bot; Session state (running,
// unread, turns) is read from the current part, team state from the Bot id.
export function indexRoster(
	value: Omit<RosterView, "byId" | "roomsById" | "agentsById" | "agentOf" | "ready">,
): RosterView {
	const source = value as RosterView;
	const byId: Record<string, RosterBot> = {};
	for (const bot of source.bots) {
		for (const id of [...(bot.parts ?? []), bot.sessionId ?? bot.id, bot.id]) byId[id] = bot;
	}
	const roomsById: Record<string, RosterRoom> = {};
	// A group's own Session is a chain of parts like a Bot's chat: `room.id` is its first
	// part's id and `sessionId` its current one; every part id finds the room.
	for (const room of source.rooms) {
		for (const id of [room.id, room.sessionId, ...(room.ownParts ?? [])]) {
			if (id !== undefined) roomsById[id] = room;
		}
	}
	// The DSH Agent is not a Bot: it indexes by its own id and by each Session it owns.
	const agentsById: Record<string, RosterAgent> = {};
	const agentOf: Record<string, string> = {};
	for (const agent of source.agents ?? []) {
		agentsById[agent.id] = agent;
		for (const sessionId of agent.sessions ?? []) agentOf[sessionId] = agent.id;
	}
	return { ...source, agents: source.agents ?? [], byId, roomsById, agentsById, agentOf, ready: true };
}

// Whether a main-view Session id belongs to the team's DSH Agent: the conversation group
// then stays withdrawn while the shell keeps the sidebar. Before the roster arrives, the
// ids cached from the last pull answer.
export function isAgentSession(
	roster: Pick<RosterView, "ready" | "agentOf">,
	cache: ReadonlySet<string>,
	sessionId?: string | null,
): boolean {
	if (sessionId === undefined || sessionId === null || sessionId === "") return false;
	if (roster.ready) return roster.agentOf[sessionId] !== undefined;
	return cache.has(sessionId);
}

// A request can reuse a call id; question and secret ids belong to separate kinds.
export const heldCardKey = (kind: string, requestId: string): string => JSON.stringify([kind, requestId]);

/** Per Session, how many mounted cells draw or hold each card. */
export type CardCounts = Record<string, Record<string, number>>;

// Per Session, how many mounted cells draw or hold each card; 0 drops the entry.
export function countCards(
	state: CardCounts,
	sessionId: string,
	callIds: readonly string[],
	delta: number,
): CardCounts {
	const own = { ...state[sessionId] };
	for (const callId of callIds) {
		const count = (own[callId] ?? 0) + delta;
		if (count > 0) own[callId] = count;
		else delete own[callId];
	}
	return { ...state, [sessionId]: own };
}
