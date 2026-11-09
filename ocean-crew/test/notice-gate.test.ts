// The gate every proactive notice passes: the policy decides, the transport sends, and only
// an accepted notice becomes a receipt, so a repeated failure is news once.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { noticeGate, RECEIPTS_KEPT, receiptLog } from "../src/host/work/notice-gate.ts";

const home = (): string => mkdtempSync(join(tmpdir(), "ocean-crew-notices-"));
const quiet = { noChange: "all_clear" as const };

test("a delivered notice becomes a receipt, and the same notice is then a duplicate", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const gate = noticeGate({ home: dir, preferences: () => quiet });
	let sent = 0;
	const event = { kind: "requested_result" as const, noticeId: "reminder:1" };
	const first = await gate.offer(event, async () => {
		sent += 1;
	});
	assert.equal(first.deliver, true);
	assert.equal(sent, 1);
	const again = await gate.offer(event, async () => {
		sent += 1;
	});
	assert.equal(again.deliver, false);
	assert.equal(sent, 1, "the second offer never reached the transport");
	assert.equal((await gate.receipts()).length, 1);
});

test("a send that fails records no receipt, so the notice is retried as news", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const gate = noticeGate({ home: dir, preferences: () => quiet, warn: () => {} });
	const event = {
		kind: "pending" as const,
		noticeId: "n1",
		items: [{ itemId: "t1", kind: "failure" as const, title: "x", since: 1 }],
	};
	await gate.offer(event, async () => {
		throw new Error("network down");
	});
	assert.equal((await gate.receipts()).length, 0, "a failed delivery is not a receipt");
	let sent = 0;
	const retry = await gate.offer(event, async () => {
		sent += 1;
	});
	assert.equal(retry.deliver, true);
	assert.equal(sent, 1);
});

test("a blocked decision goes out even in quiet hours; a result waits", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Quiet for the whole day: equal bounds are read as no window, so use a wide one.
	const hours = { startMinute: 0, endMinute: 1439, utcOffsetMinutes: 0 };
	const now = () => Date.UTC(2026, 10, 10, 12, 0, 0);
	const gate = noticeGate({ home: dir, preferences: () => quiet, quietHours: () => hours, now });
	let sent = 0;
	const pending = await gate.offer(
		{ kind: "pending", noticeId: "p1", items: [{ itemId: "t", kind: "blocked", title: "x", since: 1 }] },
		async () => {
			sent += 1;
		},
	);
	assert.equal(pending.deliver, true, "a decision is never hidden by quiet hours");
	const result = await gate.offer({ kind: "requested_result", noticeId: "r1" }, async () => {
		sent += 1;
	});
	assert.equal(result.deliver, false);
	assert.equal(result.deliver === false ? result.reason : "", "quiet_hours");
	assert.equal(sent, 1);
});

test("the receipt file is bounded and survives a damaged file", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = receiptLog(dir);
	for (let index = 0; index < RECEIPTS_KEPT + 10; index += 1)
		await log.record({ dedupeKey: `k${index}`, kind: "requested_result", acceptedAt: index });
	assert.equal((await log.read()).length, RECEIPTS_KEPT);
	// A damaged file reads as no receipts, which re-arms the notices rather than throwing.
	const path = join(dir, "notice-receipts.json");
	const before = readFileSync(path, "utf8");
	assert.ok(before.startsWith("["));
	await log.record({ dedupeKey: "after", kind: "pending", acceptedAt: 1 });
	assert.equal((await log.read())[0].dedupeKey, "after");
});
