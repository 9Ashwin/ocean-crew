// What the team is doing in the background, and what looks stuck. A Bot can spend a long time on
// work the user never sees: it is in another chat, or it handed work on and waits. This module
// keeps the evidence — which tools a Session called, in what order, when it last made progress —
// and turns it into one view the window can show. A run that repeats one call, or goes quiet for
// long enough, is marked once, not nagged about.
import type { Runtime } from "../core/runtime.ts";

/** How many calls back a repeat is looked for. */
export const REPEAT_WINDOW = 6;
/** How many identical calls in that window make a loop. */
export const REPEAT_LIMIT = 4;
/** No progress for this long while a turn runs reads as stuck. */
export const IDLE_MS = 10 * 60_000;

export interface BackgroundEntry {
	sessionId: string;
	/** The Bot or group the work belongs to. */
	owner: string;
	/** What it is doing, as the last tool it called. */
	doing?: string;
	/** When that call started. */
	since?: number;
	/** What it is working for: the work it was handed, or the one it handed on. */
	forWork?: string;
	/** The last thing it said about this work. */
	held?: string;
	stuck?: "repeating" | "quiet";
	/** What made it look stuck, for the panel's title. */
	stuckWhy?: string;
}

export interface BackgroundView {
	entries: BackgroundEntry[];
}

interface CallRecord {
	tool: string;
	key: string;
	at: number;
}

interface Observation {
	calls: CallRecord[];
	lastProgress: number;
	turnRunning: boolean;
}

export interface Background {
	/** One tool call, before it runs. */
	noteCall(sessionId: string, tool: string, args: unknown): void;
	/** A result came back: the run made progress. */
	noteProgress(sessionId: string): void;
	/** A turn opened or closed. */
	noteTurn(sessionId: string, running: boolean): void;
	view(): BackgroundView;
	/** Stuck entries the user has not been told about yet; each is reported once. */
	takeAnnouncements(): BackgroundEntry[];
	/** Forget a Session the team no longer has. */
	forget(sessionId: string): void;
}

const hashOf = (value: unknown): string => {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return String(value);
	}
};

export interface BackgroundOptions {
	/** The Bot or group a Session speaks for, in the words the user reads. */
	ownerOf: (sessionId: string) => string | undefined;
	/** Whether this Session is one the team's own work runs in. */
	isTeamSession: (sessionId: string) => boolean;
	/** What the Session is doing, from the turn tracker. */
	doingOf?: (sessionId: string) => { tool: string; since: number; note?: string } | undefined;
	/** The work a Session's turn is serving, when the host knows. */
	workOf?: (sessionId: string) => { id: string; held?: string } | undefined;
	now?: () => number;
}

export function backgroundOf({
	ownerOf,
	isTeamSession,
	doingOf,
	workOf,
	now = Date.now,
}: BackgroundOptions): Background {
	const held = new Map<string, Observation>();
	// Sessions the user has already been told about, by kind: a loop that persists is one message.
	const told = new Set<string>();

	const observation = (sessionId: string): Observation => {
		let seen = held.get(sessionId);
		if (seen === undefined) {
			seen = { calls: [], lastProgress: now(), turnRunning: false };
			held.set(sessionId, seen);
		}
		return seen;
	};

	const stuckOf = (
		sessionId: string,
		seen: Observation,
	): { stuck: "repeating" | "quiet"; why: string } | undefined => {
		const recent = seen.calls.slice(-REPEAT_WINDOW);
		const counts = new Map<string, number>();
		for (const call of recent) {
			const key = `${call.tool}:${call.key}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		for (const [key, count] of counts)
			if (count >= REPEAT_LIMIT)
				return {
					stuck: "repeating",
					why: `it called ${key.split(":")[0]} ${count} times with the same arguments`,
				};
		if (seen.turnRunning && now() - seen.lastProgress >= IDLE_MS)
			return {
				stuck: "quiet",
				why: `nothing has happened for ${Math.round((now() - seen.lastProgress) / 60_000)} minutes`,
			};
		return undefined;
	};

	const entryOf = (sessionId: string): BackgroundEntry | undefined => {
		const owner = ownerOf(sessionId);
		if (owner === undefined) return undefined;
		const seen = observation(sessionId);
		const doing = doingOf?.(sessionId);
		const work = workOf?.(sessionId);
		const stuck = stuckOf(sessionId, seen);
		const last = seen.calls.at(-1);
		const entry: BackgroundEntry = {
			sessionId,
			owner,
			...(doing === undefined ? {} : { doing: doing.tool, since: doing.since }),
			...(doing === undefined && last !== undefined ? { doing: last.tool, since: last.at } : {}),
			...(work === undefined ? {} : { forWork: work.id }),
			...(work?.held === undefined ? {} : { held: work.held.slice(0, 200) }),
			...(stuck === undefined ? {} : { stuck: stuck.stuck, stuckWhy: stuck.why }),
		};
		return entry;
	};

	return {
		noteCall(sessionId, tool, args) {
			if (!isTeamSession(sessionId)) return;
			const seen = observation(sessionId);
			seen.calls.push({ tool, key: hashOf(args), at: now() });
			// The window is small: a run's history is evidence of a loop, not a log.
			if (seen.calls.length > REPEAT_WINDOW * 4) seen.calls = seen.calls.slice(-REPEAT_WINDOW * 2);
		},
		noteProgress(sessionId) {
			const seen = held.get(sessionId);
			if (seen !== undefined) seen.lastProgress = now();
		},
		noteTurn(sessionId, running) {
			const seen = observation(sessionId);
			seen.turnRunning = running;
			if (running) {
				// A new turn starts its own evidence: the previous turn's calls are not its loop.
				seen.calls = [];
				seen.lastProgress = now();
			}
		},
		view() {
			const entries: BackgroundEntry[] = [];
			for (const sessionId of held.keys()) {
				const entry = entryOf(sessionId);
				if (entry !== undefined) entries.push(entry);
			}
			// Running work first, then by how long it has been going.
			return {
				entries: entries.sort((left, right) => (left.since ?? 0) - (right.since ?? 0)),
			};
		},
		takeAnnouncements() {
			const out: BackgroundEntry[] = [];
			for (const sessionId of held.keys()) {
				const entry = entryOf(sessionId);
				if (entry?.stuck === undefined) continue;
				const key = `${sessionId}:${entry.stuck}`;
				if (told.has(key)) continue;
				told.add(key);
				out.push(entry);
			}
			return out;
		},
		forget(sessionId) {
			held.delete(sessionId);
		},
	};
}
