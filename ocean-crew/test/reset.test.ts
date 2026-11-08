// Reset: the whole team is copied to a backup folder, the plugin's team data is removed,
// the state is cleared and the first Main Bot is created again.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/work/reset.ts";

const home = (): { home: string; seed: () => void; cleanup: () => void } => {
	const dir = mkdtempSync(join(tmpdir(), "ocean-crew-reset-"));
	const seed = (): void => {
		writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, revision: 3, bots: {}, rooms: {} }));
		for (const entry of ["memory", "learning", "im"]) {
			mkdirSync(join(dir, entry), { recursive: true });
			writeFileSync(join(dir, entry, "kept.json"), "{}");
		}
		for (const entry of ["chat-index.sqlite", "inflight.json", "scheduler-state.json"])
			writeFileSync(join(dir, entry), "x");
	};
	return {
		home: dir,
		seed,
		cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }),
	};
};

const host = (dir: string, options: { busy?: boolean; readOnly?: () => string | undefined } = {}) => {
	const order: string[] = [];
	const rt = {
		home: dir,
		live: new Map(options.busy ? [["session-1", {}]] : []),
		readOnly: options.readOnly ?? (() => undefined),
		clearTeam: async () => {
			order.push("clear");
		},
		bootstrap: async () => {
			order.push("bootstrap");
		},
	} as unknown as Runtime;
	install(rt);
	return { rt, order };
};

test("a reset backs up the team data, removes it and creates the first Bot again", async () => {
	const fixture = home();
	fixture.seed();
	try {
		const { rt, order } = host(fixture.home);
		const result = await rt.resetTeam();
		assert.deepEqual(order, ["clear", "bootstrap"]);
		assert.match(result.backup, /^backups\/reset-/);
		for (const entry of [
			"state.json",
			"memory",
			"learning",
			"im",
			"chat-index.sqlite",
			"inflight.json",
			"scheduler-state.json",
		])
			assert.ok(existsSync(join(result.path, entry)), entry);
		assert.equal(readFileSync(join(result.path, "memory", "kept.json"), "utf8"), "{}");
		for (const entry of ["memory", "learning", "im", "chat-index.sqlite", "inflight.json", "scheduler-state.json"])
			assert.equal(existsSync(join(fixture.home, entry)), false, entry);
	} finally {
		fixture.cleanup();
	}
});

test("a reset refuses while a turn runs, and on a read-only host", async () => {
	const fixture = home();
	fixture.seed();
	try {
		const busy = host(fixture.home, { busy: true });
		await assert.rejects(busy.rt.resetTeam(), (error: any) => {
			assert.equal(error.code, "bot/busy");
			assert.match(error.message, /still running/);
			return true;
		});
		const readOnly = host(fixture.home, { readOnly: () => "Another dsh has this team." });
		await assert.rejects(readOnly.rt.resetTeam(), (error: any) => {
			assert.equal(error.code, "bot/read-only");
			return true;
		});
		assert.ok(existsSync(join(fixture.home, "state.json")));
	} finally {
		fixture.cleanup();
	}
});

test("a backup keeps the files it copied, even when the reset later fails", async () => {
	const fixture = home();
	fixture.seed();
	try {
		const rt = {
			home: fixture.home,
			live: new Map(),
			readOnly: () => undefined,
			clearTeam: async () => {
				throw new Error("save failed");
			},
			bootstrap: async () => {},
		} as unknown as Runtime;
		install(rt);
		await assert.rejects(rt.resetTeam(), /save failed/);
		const backups = join(fixture.home, "backups");
		assert.ok(existsSync(backups));
	} finally {
		fixture.cleanup();
	}
});
