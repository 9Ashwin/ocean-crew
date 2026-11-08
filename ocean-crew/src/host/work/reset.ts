// Reset: start the team over. The user's API keys, DSH Sessions and the team's
// workspace stay; the Bots, group chats, memory, learning, schedules, IM bindings and
// indexes go, and the first Main Bot is created again. Everything removed is copied to
// a backup folder first, so a reset can be undone by hand.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../core/runtime.ts";

/** What a reset leaves behind, relative to the team home. */
export interface ResetResult {
	/** The backup folder, relative to the team home. */
	backup: string;
	/** The backup folder, from the machine's root. */
	path: string;
}

/** The plugin data a reset replaces, besides `state.json`. */
const DATA = ["memory", "learning", "im", "chat-index.sqlite", "inflight.json", "scheduler-state.json"];

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const busy = (rt: Runtime): boolean =>
	((rt.live as Map<string, unknown> | undefined)?.size ?? 0) > 0 ||
	((rt as unknown as { roomProgress?: Map<string, unknown> }).roomProgress?.size ?? 0) > 0;

export function install(rt: Runtime): void {
	const fail = (message: string, code: string): Error => Object.assign(new Error(message), { code });

	async function resetTeam(): Promise<ResetResult> {
		const readOnly = rt.readOnly?.();
		if (readOnly !== undefined) throw fail(readOnly, "bot/read-only");
		if (busy(rt))
			throw fail("A turn is still running. Stop it, or wait for it to finish, and reset again.", "bot/busy");
		const home = rt.home;
		const name = `backups/reset-${stamp()}`;
		const path = join(home, ...name.split("/"));
		mkdirSync(path, { recursive: true });
		const moved: string[] = [];
		const take = (entry: string): void => {
			const source = join(home, entry);
			if (!existsSync(source)) return;
			cpSync(source, join(path, entry), { recursive: true, verbatimSymlinks: true });
			moved.push(entry);
		};
		for (const entry of ["state.json", ...DATA]) take(entry);
		// The team is cleared in one save, then the same bootstrap that creates the first
		// Main Bot on a fresh install runs again.
		await rt.clearTeam();
		for (const entry of DATA) rmSync(join(home, entry), { recursive: true, force: true });
		await rt.bootstrap();
		return { backup: name, path };
	}

	Object.assign(rt, { resetTeam });
}
