// Whole-file replacement: rename a finished temp file over its target, retrying for a
// moment while Windows reports the target busy.

import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// On Windows a file cannot be replaced while another program has it open: another DSH
// reading the team's state, the search indexer, a virus scanner, a sync client. Those
// readers let go within moments.
const BUSY: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const TRIES = 6;
const WAIT_MS = 40;

// The `code` a filesystem error carries; a thrown value is unknown to TypeScript.
const errorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
};

/**
 * Moves `temp` over `path`, trying again for a moment while Windows reports `path` busy.
 * `check` runs before each new try and throws to stop, as when the lock that allows the
 * write was lost in the meantime.
 */
export async function replaceFile(temp: string, path: string, check: () => void = () => {}): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await rename(temp, path);
		} catch (error) {
			const code = errorCode(error);
			if (process.platform !== "win32" || attempt >= TRIES || code === undefined || !BUSY.has(code)) throw error;
			// Real filesystem contention must clear even while tests freeze application timers.
			await delay(WAIT_MS * attempt);
			check();
		}
	}
}
