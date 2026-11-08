// A JSON object in browser storage that every open window of DSH edits, one entry at a
// time. Each change applies to what is stored at that moment, never to the window's own
// copy, so a window does not undo what another window saved after it loaded. Other windows
// learn of a change from the `storage` event and read the object again.

/** The slice of `localStorage` these maps use. */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

const defaultStorage = (): StorageLike | undefined =>
	(globalThis as unknown as { localStorage?: StorageLike }).localStorage;

export interface SharedMap<T> {
	key: string;
	read(fallback?: T): T;
	update(change: (base: T) => T, fallback?: T): T;
}

export function sharedMap<T extends Record<string, unknown> = Record<string, unknown>>(
	key: string,
	storage?: StorageLike,
): SharedMap<T> {
	const store = (): StorageLike | undefined => storage ?? defaultStorage();
	// `fallback` stands in when storage cannot be read, so the window keeps its own copy.
	const read = (fallback = {} as T): T => {
		const target = store();
		if (!target) return fallback;
		try {
			const value = JSON.parse(target.getItem(key) ?? "{}") as unknown;
			return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
		} catch {
			return fallback;
		}
	};
	// A change that returns what it was given changes nothing, and nothing is written.
	const update = (change: (base: T) => T, fallback = {} as T): T => {
		const base = read(fallback);
		const next = change(base);
		if (next === base) return next;
		try {
			store()?.setItem(key, JSON.stringify(next));
		} catch {
			/* storage unavailable */
		}
		return next;
	};
	return { key, read, update };
}

// Sets one entry, or drops it for `undefined`; an entry already so leaves the map as it is.
export function setEntry<T>(map: Record<string, T>, id: string, value: T | undefined): Record<string, T> {
	if (value === undefined) {
		if (!Object.hasOwn(map, id)) return map;
		const { [id]: _, ...rest } = map;
		return rest;
	}
	return { ...map, [id]: value };
}

/** reactions: { [message key]: { [bubble index]: [emoji…] } } */
export type Reactions = Record<string, Record<string, string[]>>;

export function toggleReaction(reactions: Reactions, key: string, index: number, emoji: string): Reactions {
	const entry: Record<string, string[]> = { ...reactions[key] };
	const list = entry[index] ?? [];
	entry[index] = list.includes(emoji) ? list.filter((item) => item !== emoji) : [...list, emoji];
	if (entry[index].length === 0) delete entry[index];
	const next: Reactions = { ...reactions };
	if (Object.keys(entry).length) next[key] = entry;
	else delete next[key];
	return next;
}

/** unread: { [Bot or group id]: true } */
export type Unread = Record<string, true>;

export function setUnread(unread: Unread, id: string, value: boolean): Unread {
	if (Boolean(unread[id]) === value) return unread;
	const next: Unread = { ...unread };
	if (value) next[id] = true;
	else delete next[id];
	return next;
}

/** seen: { [Bot or group id]: when it was last left } */
export type Seen = Record<string, number>;

// seen: { [Bot or group id]: when it was last left }. A time never goes back, so a window
// that closes late with an old copy cannot make seen messages new again.
export function noteLeft(seen: Seen, ids: readonly string[], now: number): Seen {
	const next: Seen = { ...seen };
	for (const id of ids) next[id] = Math.max(Number(next[id]) || 0, now);
	return next;
}
