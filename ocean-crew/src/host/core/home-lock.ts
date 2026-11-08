// One writer per plugin home. dsh Web and dsh Desktop share ~/.dsh, and each host keeps
// the team in memory and writes state.json whole, so two hosts at once would undo each
// other's changes. The first host to load takes `state.lock`; a second one only reads.
//
// The lock is a small JSON file (pid, host, a random token) whose mtime the holder bumps
// on a timer. A live holder on the same host needs both: a process that still runs under
// that pid and a heartbeat fresher than `staleMs` — a crashed holder's pid may be reused
// by an unrelated process, and without the heartbeat check that process would hold the
// team read-only for as long as it runs. The token, not the pid, decides ownership: a
// holder that finds another token has lost the lock.

import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

// What `state.lock` says about the holder; this module writes the file.
export interface LockHolder {
	pid?: number;
	host?: string;
	token?: string;
	since?: number;
}

export interface HomeLockOptions {
	staleMs?: number;
	beatMs?: number;
	host?: string;
	pid?: number;
	isAlive?: (pid: number) => boolean;
	now?: () => number;
}

// The lock a caller keeps: claim it once, keep the heartbeat, release it on unload.
export interface HomeLock {
	claim(): LockHolder | undefined;
	owns(): boolean;
	release(): void;
	read(): LockHolder | null | undefined;
}

// The `code` an OS error carries; a thrown value is unknown to TypeScript.
const errorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
};

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return errorCode(error) === "EPERM";
	}
}

// One field of parsed lock content; non-object content carries no holder fields.
const fieldOf = (value: unknown, key: keyof LockHolder): unknown =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const holderOf = (value: unknown): LockHolder | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as LockHolder) : null;

export function homeLock(
	path: string,
	{
		staleMs = 60_000,
		beatMs = 15_000,
		host = hostname(),
		pid = process.pid,
		isAlive = pidAlive,
		now = Date.now,
	}: HomeLockOptions = {},
): HomeLock {
	const token = randomUUID();
	let timer: ReturnType<typeof setInterval> | undefined;

	// undefined: no lock file; null: a file that does not parse (being written right now).
	const readRaw = (): unknown => {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as unknown;
		} catch (error) {
			return errorCode(error) === "ENOENT" ? undefined : null;
		}
	};
	const read = (): LockHolder | null | undefined => {
		const value = readRaw();
		return value === undefined ? undefined : holderOf(value);
	};
	const age = (): number => {
		try {
			return now() - statSync(path).mtimeMs;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	};
	const live = (value: unknown): boolean => {
		if (value === undefined) return false;
		if (value === null) return age() < staleMs;
		if (fieldOf(value, "host") === host) {
			const holderPid = fieldOf(value, "pid");
			return typeof holderPid === "number" && holderPid !== pid && isAlive(holderPid) && age() < staleMs;
		}
		return age() < staleMs;
	};
	const owns = (): boolean => fieldOf(readRaw(), "token") === token;

	const beat = (): void => {
		if (!owns()) {
			stop();
			return;
		}
		const time = new Date(now());
		try {
			utimesSync(path, time, time);
		} catch {
			// A vanished lock file is not a beat failure; the next claim checks ownership.
		}
	};
	const stop = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};

	// Take the lock if it is free or its holder is gone. Returns undefined when this
	// process holds it, else what the lock file says about the holder.
	function claim(): LockHolder | undefined {
		if (owns()) return undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				writeFileSync(path, JSON.stringify({ pid, host, token, since: now() }), { flag: "wx" });
				stop();
				timer = setInterval(beat, beatMs);
				timer.unref?.();
				return undefined;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			const holder = readRaw();
			if (live(holder)) return holderOf(holder) ?? {};
			const current = readRaw();
			const unchanged =
				holder === null
					? current === null
					: fieldOf(holder, "token") !== undefined
						? fieldOf(current, "token") === fieldOf(holder, "token")
						: JSON.stringify(current) === JSON.stringify(holder);
			if (unchanged) {
				try {
					unlinkSync(path);
				} catch {
					// Another host may remove the stale file first; the next try handles it.
				}
			}
		}
		return holderOf(readRaw()) ?? {};
	}

	function release(): void {
		stop();
		if (owns()) {
			try {
				unlinkSync(path);
			} catch {
				// The file is already gone; nothing to release.
			}
		}
	}

	return { claim, owns, release, read };
}
