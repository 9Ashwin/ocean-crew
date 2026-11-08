// App and foreground leases: in-memory, process-local. A lease says "this Bot is
// operating that app" (or the foreground) so another Bot's call is refused instead
// of two Bots typing into the same window. Leases end with the holder's turn, after
// a short idle, on stop and on takeover; observe calls never need one.

const IDLE_MS = 60_000;

/** What a lease reports to the view. */
export interface LeaseEntry {
	kind: "app" | "foreground";
	appKey: string | null;
	botId: string;
	since: number;
	last: number;
}

interface Lease {
	botId: string;
	sessionId: string;
	since: number;
	last: number;
	timer: ReturnType<typeof setTimeout>;
}

/** A readable lease, as the holder checks answer with. */
export interface LeaseHolder {
	botId: string;
	sessionId: string;
	since: number;
	last: number;
}

export interface LeasesOptions {
	idleMs?: number;
	now?: () => number;
	onChange?: () => void;
}

export interface Leases {
	/** Returns the other Bot's lease that blocks this take, else undefined. */
	takeApp(appKey: string, botId: string, sessionId: string): LeaseHolder | undefined;
	takeForeground(botId: string, sessionId: string): LeaseHolder | undefined;
	holderOfApp(appKey: string): LeaseHolder | undefined;
	holderOfForeground(): LeaseHolder | undefined;
	/** Everything this Bot holds (for release and for the indicator). */
	ofBot(botId: string): [string, LeaseHolder][];
	/** Every held app plus the foreground holder, for the indicator. */
	entries(): LeaseEntry[];
	/** The holder's turn ended: leases taken by that session go free. */
	endSession(sessionId: string): void;
	/** Stop or takeover: everything this Bot holds goes free. */
	releaseBot(botId: string): void;
	releaseAll(): void;
	dispose(): void;
}

export function createLeases({ idleMs = IDLE_MS, now = Date.now, onChange = () => {} }: LeasesOptions = {}): Leases {
	const leases = new Map<string, Lease>();

	const drop = (key: string): void => {
		const lease = leases.get(key);
		if (lease === undefined) return;
		clearTimeout(lease.timer);
		leases.delete(key);
		onChange();
	};
	const arm = (key: string, lease: Lease): void => {
		clearTimeout(lease.timer);
		lease.timer = setTimeout(() => drop(key), idleMs);
		lease.timer.unref?.();
	};
	const take = (key: string, botId: string, sessionId: string): LeaseHolder | undefined => {
		const held = leases.get(key);
		if (held !== undefined && held.botId !== botId) return held;
		if (held !== undefined) {
			held.sessionId = sessionId;
			held.last = now();
			arm(key, held);
			return undefined;
		}
		const lease: Lease = { botId, sessionId, since: now(), last: now(), timer: setTimeout(() => {}, 0) };
		leases.set(key, lease);
		arm(key, lease);
		onChange();
		return undefined;
	};

	return {
		takeApp: (appKey, botId, sessionId) => take(`app:${appKey}`, botId, sessionId),
		takeForeground: (botId, sessionId) => take("foreground", botId, sessionId),
		holderOfApp: (appKey) => leases.get(`app:${appKey}`),
		holderOfForeground: () => leases.get("foreground"),
		ofBot: (botId) => [...leases.entries()].filter(([, lease]) => lease.botId === botId),
		entries: () =>
			[...leases.entries()].map(([key, lease]) => ({
				kind: key === "foreground" ? "foreground" : "app",
				appKey: key === "foreground" ? null : key.slice(4),
				botId: lease.botId,
				since: lease.since,
				last: lease.last,
			})),
		endSession: (sessionId) => {
			for (const [key, lease] of [...leases]) if (lease.sessionId === sessionId) drop(key);
		},
		releaseBot: (botId) => {
			for (const [key, lease] of [...leases]) if (lease.botId === botId) drop(key);
		},
		releaseAll: () => {
			for (const key of [...leases.keys()]) drop(key);
		},
		dispose: () => {
			for (const lease of leases.values()) clearTimeout(lease.timer);
			leases.clear();
		},
	};
}
