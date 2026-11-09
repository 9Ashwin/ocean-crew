// Scheduled run records: every firing leaves one line saying what it did, so a task that ran
// and failed never looks like one that never fired.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUNS_KEPT, runLog } from "../src/host/work/schedule-runs.ts";

const home = (): string => mkdtempSync(join(tmpdir(), "ocean-crew-runs-"));

test("a run is appended and read back newest first", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = runLog(dir);
	await log.append({ taskId: "t1", sessionId: "s1", startedAt: 1, outcome: "answered" });
	await log.append({
		taskId: "t2",
		sessionId: "s1",
		startedAt: 2,
		outcome: "failed",
		reason: "no credit",
		code: "402",
	});
	const all = await log.all();
	assert.equal(all.length, 2);
	assert.equal(all[0].taskId, "t2", "newest first");
	assert.equal(all[0].code, "402");
	const latest = await log.latest();
	assert.equal(latest.t1.outcome, "answered");
	assert.equal(latest.t2.outcome, "failed");
});

test("the newest run of a task wins, including a later success", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = runLog(dir);
	await log.append({ taskId: "t1", sessionId: "s1", startedAt: 1, outcome: "failed", reason: "no credit" });
	assert.equal((await log.latest()).t1.outcome, "failed");
	await log.append({ taskId: "t1", sessionId: "s1", startedAt: 5, outcome: "answered" });
	assert.equal((await log.latest()).t1.outcome, "answered", "a recovered task reads as answered");
});

test("a damaged line is skipped instead of hiding the rest", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = runLog(dir);
	await log.append({ taskId: "t1", sessionId: "s1", startedAt: 1, outcome: "silent" });
	const path = join(dir, "schedule-runs.jsonl");
	writeFileSync(
		path,
		`${readFileSync(path, "utf8")}{ not json\n{"taskId":"t9","sessionId":"s9","startedAt":3,"outcome":"skipped"}\n`,
	);
	const all = await log.all();
	assert.deepEqual(
		all.map((run) => run.taskId),
		["t9", "t1"],
	);
});

test("an unknown outcome is not a run, and the file stays bounded", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "schedule-runs.jsonl");
	writeFileSync(path, `${JSON.stringify({ taskId: "t1", sessionId: "s1", startedAt: 1, outcome: "nonsense" })}\n`);
	const log = runLog(dir);
	assert.deepEqual(await log.all(), []);
	for (let index = 0; index < RUNS_KEPT + 20; index += 1)
		await log.append({ taskId: `t${index}`, sessionId: "s1", startedAt: index, outcome: "answered" });
	assert.equal((await log.all()).length, RUNS_KEPT);
});
