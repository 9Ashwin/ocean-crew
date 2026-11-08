// App and foreground leases: one Bot per app, release on turn end, idle and release.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeases } from "../src/host/computer/leases.ts";

test("leases: one Bot per app, release on turn end, idle and release", async () => {
	const leases = createLeases({ idleMs: 50 });
	assert.equal(leases.takeApp("notes", "w1", "w1"), undefined);
	const held = leases.takeApp("notes", "m1", "m1");
	assert.equal(held?.botId, "w1");
	// The holder may retake its own lease; another Bot may not.
	assert.equal(leases.takeApp("notes", "w1", "w1"), undefined);
	// Turn end releases that Session's leases.
	leases.endSession("w1");
	assert.equal(leases.takeApp("notes", "m1", "m1"), undefined);
	// The foreground is its own single lease.
	assert.equal(leases.takeForeground("m1", "m1"), undefined);
	assert.equal(leases.takeForeground("w1", "w1")?.botId, "m1");
	// Stop releases everything a Bot holds.
	leases.releaseBot("m1");
	assert.equal(leases.holderOfApp("notes"), undefined);
	assert.equal(leases.holderOfForeground(), undefined);
	// Idle expiry frees a lease without a release call.
	leases.takeApp("mail", "w1", "w1");
	await new Promise((resolve) => setTimeout(resolve, 90));
	assert.equal(leases.takeApp("mail", "m1", "m1"), undefined);
	leases.dispose();
});

test("leases report holders for the indicator, app-scoped and foreground-scoped", () => {
	const leases = createLeases({ idleMs: 10_000, now: () => 1234 });
	assert.equal(leases.takeApp("notes", "w1", "w1"), undefined);
	assert.equal(leases.takeForeground("m1", "m1"), undefined);
	const entries = leases.entries();
	assert.deepEqual(
		entries.map((entry) => [entry.kind, entry.appKey, entry.botId]),
		[
			["app", "notes", "w1"],
			["foreground", null, "m1"],
		],
	);
	const holder = leases.holderOfApp("notes");
	assert.deepEqual([holder?.botId, holder?.sessionId, holder?.since], ["w1", "w1", 1234]);
	assert.deepEqual(
		leases.ofBot("w1").map(([key]) => key),
		["app:notes"],
	);
	assert.deepEqual(
		leases.ofBot("m1").map(([key]) => key),
		["foreground"],
	);
	leases.releaseAll();
	assert.deepEqual(leases.entries(), []);
	leases.dispose();
});
