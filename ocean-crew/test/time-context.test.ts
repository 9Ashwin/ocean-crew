// Time context: a Bot step gets one dated, zoned snapshot appended for its model; a
// reading younger than the refresh interval suppresses a second one, a loaded DSH clock
// means no second clock, and a cancelled or rejected step changes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/core/time-context.ts";
import { fakeContext } from "./fake-ctx.ts";

const NOW = Date.UTC(2026, 9, 12, 4, 30);
const reading = (time: number, kind = "ocean-crew-time-context") => ({
	type: "user/message",
	time,
	data: { source: { kind } },
});

interface SetupOptions {
	events?: any[];
	config?: Record<string, unknown>;
	owned?: boolean;
}

function setup(t: any, { events = [], config = {}, owned = true }: SetupOptions = {}) {
	t.mock.method(Date, "now", () => NOW);
	const ctx = fakeContext() as any;
	let reads = 0;
	const rt = {
		ctx,
		config: { timeZone: "Asia/Shanghai", ...config },
		load: async () => {},
		isBotSession: () => owned,
		async *eventsBackwards() {
			reads += 1;
			yield* [...events].reverse();
		},
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	const hook = (ctx.listeners.get("agent/pre-step") ?? [])[0];
	const message = { role: "user", content: [{ type: "text", text: "Hello" }], source: { kind: "user" } };
	const step = (decision: any = { kind: "enter", messages: [message] }, payload: Record<string, unknown> = {}) =>
		hook(
			{
				agent: { id: "bot", session: { id: "bot" } },
				turn: 1,
				step: 1,
				signal: new AbortController().signal,
				...payload,
			},
			async () => decision,
		);
	return { step, message, reads: () => reads, rt };
}

test("a first Bot step appends a dated, zoned snapshot without changing the user message", async (t) => {
	const { step, message } = setup(t);
	const result = await step();
	assert.equal(result.messages[0], message);
	const clock = result.messages[1];
	assert.match(clock.content[0].text, /2026-10-12.*12:30:00.*GMT\+08:00.*Asia\/Shanghai/);
	assert.deepEqual(clock.source, {
		kind: "ocean-crew-time-context",
		form: "snapshot",
		sections: [{ name: "ocean-crew-time-context", text: clock.content[0].text }],
	});
});

test("a resumed session suppresses readings before ten minutes and refreshes at the boundary", async (t) => {
	const { step } = setup(t, { events: [reading(NOW - 599_999)] });
	const decision = { kind: "enter", messages: [] as any[] };
	assert.equal(await step(decision), decision);
	(Date.now as any).mock.mockImplementation(() => NOW + 1);
	assert.equal((await step(decision)).messages.length, 1);
});

test("a long running turn refreshes on a later step", async (t) => {
	const { step } = setup(t, { events: [reading(NOW - 600_000)] });
	assert.equal((await step(undefined, { step: 3 })).messages.length, 2);
});

test("native DSH readings, pending or persisted, do not get a second clock", async (t) => {
	// A pending native reading in the decision's messages: no history read at all.
	const pending = setup(t, { events: [reading(NOW - 1, "time-context")] });
	const decision = { kind: "enter", messages: [{ source: { kind: "time-context" } }] };
	assert.equal(await pending.step(decision), decision);
	assert.equal(pending.reads(), 0);
	// A persisted native reading in the log: suppressed too.
	const persisted = setup(t, { events: [reading(NOW - 1, "time-context")] });
	const empty = { kind: "enter", messages: [] as any[] };
	assert.equal(await persisted.step(empty), empty);
});

test("an expired native DSH clock is refreshed when the preset no longer supplies one", async (t) => {
	const { step } = setup(t, { events: [reading(NOW - 600_000, "time-context")] });
	assert.equal((await step()).messages.length, 2);
});

test("a rejection or cancellation does not add a reading or read history", async (t) => {
	const { step, reads } = setup(t);
	const reject = { kind: "reject" };
	assert.equal(await step(reject), reject);
	const abort = new AbortController();
	abort.abort();
	const decision = { kind: "enter", messages: [] as any[] };
	assert.equal(await step(decision, { signal: abort.signal }), decision);
	assert.equal(reads(), 0);
});

test("ordinary DSH sessions are unchanged", async (t) => {
	const { step, reads } = setup(t, { owned: false });
	const decision = { kind: "enter", messages: [] as any[] };
	assert.equal(await step(decision), decision);
	assert.equal(reads(), 0);
});

test("group member sessions and fresh parts get their own clock", async (t) => {
	const { step } = setup(t);
	for (const id of ["group-member", "fresh-part"])
		assert.equal((await step(undefined, { agent: { id } })).messages.length, 2);
});

test("a backward wall-clock change refreshes the stale future reading", async (t) => {
	const { step } = setup(t, { events: [reading(NOW + 1)] });
	assert.equal((await step()).messages.length, 2);
});

test("a zero interval refreshes every eligible step", async (t) => {
	const { step } = setup(t, { config: { timeRefreshIntervalMs: 0 }, events: [reading(NOW)] });
	assert.equal((await step()).messages.length, 2);
});

test("invalid intervals and zones fail at plugin installation", () => {
	for (const interval of [-1, 0.5, Infinity, NaN, "10"]) {
		assert.throws(
			() => install({ ctx: fakeContext() as any, config: { timeRefreshIntervalMs: interval as any } } as any),
			/timeRefreshIntervalMs/,
		);
	}
	assert.throws(() => install({ ctx: fakeContext() as any, config: { timeZone: "invalid-zone" } } as any), RangeError);
});
