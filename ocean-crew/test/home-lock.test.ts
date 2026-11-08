// The one-writer lock: claim, heartbeat, stale takeover across hosts, and the token that
// decides ownership.

import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { homeLock, pidAlive } from "../src/host/core/home-lock.ts";

const tempHome = (t: TestContext): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-lock-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};

test("pidAlive tells a running process from a lost one", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(2_147_483_647), false);
});

test("the first host takes the lock and a second live host only reads", (t) => {
	const path = join(tempHome(t), "state.lock");
	const first = homeLock(path, { pid: 101, isAlive: () => true });
	const second = homeLock(path, { pid: 202, isAlive: () => true });
	t.after(() => {
		first.release();
		second.release();
	});
	assert.equal(first.claim(), undefined);
	assert.equal(first.owns(), true);
	assert.equal(second.claim()?.pid, 101);
	assert.equal(second.owns(), false);
	first.release();
	assert.equal(existsSync(path), false);
	assert.equal(second.claim(), undefined);
	assert.equal(second.owns(), true);
});

test("a lock whose same-host process has exited is taken over", (t) => {
	const path = join(tempHome(t), "state.lock");
	writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: "gone" }));
	const dead = homeLock(path, { pid: 202, isAlive: () => false });
	t.after(() => dead.release());
	assert.equal(dead.claim(), undefined);
	assert.equal(dead.owns(), true);
	dead.release();
});

test("a same-host lock without a fresh heartbeat is taken over even while its pid lives", (t) => {
	const path = join(tempHome(t), "state.lock");
	writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: "old" }));
	const old = new Date(Date.now() - 120_000);
	utimesSync(path, old, old);
	// A crashed holder's pid may be reused by an unrelated process; the stopped heartbeat,
	// not the pid, says the holder is gone.
	const late = homeLock(path, { pid: 202, isAlive: () => true });
	t.after(() => late.release());
	assert.equal(late.claim(), undefined);
	assert.equal(late.owns(), true);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 202);
});

test("a fresh same-host lock stays live while its process is alive", (t) => {
	const path = join(tempHome(t), "state.lock");
	writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: "live" }));
	const late = homeLock(path, { pid: 202, isAlive: () => true });
	t.after(() => late.release());
	assert.equal(late.claim()?.token, "live");
	assert.equal(late.owns(), false);
});

test("an old lock from another host is taken over", (t) => {
	const path = join(tempHome(t), "state.lock");
	writeFileSync(path, JSON.stringify({ pid: 101, host: "elsewhere", token: "far" }));
	const old = new Date(Date.now() - 120_000);
	utimesSync(path, old, old);
	const near = homeLock(path, { pid: 202, isAlive: () => false });
	t.after(() => near.release());
	assert.equal(near.claim(), undefined);
	assert.equal(near.owns(), true);
});

test("a stale-lock recheck does not delete a new owner token", (t) => {
	const path = join(tempHome(t), "state.lock");
	writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: "stale" }));
	const old = new Date(Date.now() - 120_000);
	utimesSync(path, old, old);
	const originalRead = fs.readFileSync;
	let reads = 0;
	// The lock reads through the ESM binding of `fs.readFileSync`; patch the CommonJS
	// function and re-sync so the third read sees another host claim between our two reads.
	const patchedFs = fs as { readFileSync: (file: string, encoding: "utf8") => string };
	patchedFs.readFileSync = (file, encoding) => {
		const contents = originalRead(file, encoding);
		if (file === path && ++reads === 3) {
			writeFileSync(path, JSON.stringify({ pid: 303, host: hostname(), token: "new-owner" }));
			return originalRead(file, encoding);
		}
		return contents;
	};
	syncBuiltinESMExports();
	const late = homeLock(path, { pid: 202, isAlive: (pid) => pid === 303 });
	t.after(() => {
		late.release();
		patchedFs.readFileSync = originalRead;
		syncBuiltinESMExports();
	});
	assert.equal(late.claim()?.token, "new-owner");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "new-owner");
});

test("a holder that finds another token in the file knows it lost the lock", (t) => {
	const path = join(tempHome(t), "state.lock");
	const lock = homeLock(path, { pid: 101 });
	t.after(() => lock.release());
	assert.equal(lock.claim(), undefined);
	writeFileSync(path, JSON.stringify({ pid: 303, host: hostname(), token: "other" }));
	assert.equal(lock.owns(), false);
	lock.release();
	assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "other");
});

test("a lock file caught mid-write reads as live while fresh and is taken over when stale", (t) => {
	const path = join(tempHome(t), "state.lock");
	writeFileSync(path, "{not json");
	const early = homeLock(path, { pid: 202, isAlive: () => false });
	t.after(() => early.release());
	assert.deepEqual(early.claim(), {});
	assert.equal(early.owns(), false);
	const old = new Date(Date.now() - 120_000);
	utimesSync(path, old, old);
	assert.equal(early.claim(), undefined);
	assert.equal(early.owns(), true);
});

test("the holder's heartbeat keeps the lock fresh", (t) => {
	const path = join(tempHome(t), "state.lock");
	t.mock.timers.enable({ apis: ["setInterval"] });
	let clock = 1_000_000;
	const lock = homeLock(path, { pid: 101, now: () => clock, beatMs: 100 });
	t.after(() => lock.release());
	assert.equal(lock.claim(), undefined);
	assert.ok(Math.abs(statSync(path).mtimeMs - Date.now()) < 60_000, "the claim stamps the file");
	clock = 2_000_000;
	t.mock.timers.tick(100);
	assert.ok(Math.abs(statSync(path).mtimeMs - 2_000_000) < 1, "the heartbeat bumps the mtime");
	clock = 3_000_000;
	t.mock.timers.tick(100);
	assert.ok(Math.abs(statSync(path).mtimeMs - 3_000_000) < 1, "the heartbeat keeps bumping it");
});

test("the heartbeat stops when the lock file carries another token", (t) => {
	const path = join(tempHome(t), "state.lock");
	t.mock.timers.enable({ apis: ["setInterval"] });
	let clock = 1_000_000;
	const lock = homeLock(path, { pid: 101, now: () => clock, beatMs: 100 });
	t.after(() => lock.release());
	assert.equal(lock.claim(), undefined);
	writeFileSync(path, JSON.stringify({ pid: 303, host: hostname(), token: "other" }));
	const stamped = statSync(path).mtimeMs;
	clock = 5_000_000;
	t.mock.timers.tick(100);
	t.mock.timers.tick(100);
	assert.equal(lock.owns(), false);
	assert.equal(statSync(path).mtimeMs, stamped, "no heartbeat may run after losing the token");
	lock.release();
	assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "other");
});
