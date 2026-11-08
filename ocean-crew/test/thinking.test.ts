// Thinking time: a Turn's thinking is the sum of its steps' reasoning spans, read from
// the timed model stream DSH keeps in each assistant/message event; attempts that were
// dropped never count, and an unrecorded step makes the time unknown rather than 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install, thinkingMs } from "../src/host/core/thinking.ts";

const reasoningRun = (time0: number, gaps: number[], texts: string[]) => ({
	type: "reasoning-chunks",
	time0,
	index: 0,
	dt: gaps,
	texts,
});
const textRun = (time0: number, gaps: number[], texts: string[]) => ({
	type: "text-chunks",
	time0,
	index: 0,
	dt: gaps,
	texts,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const message = (turn: number, step: number, stream: any, extra: Record<string, unknown> = {}) => ({
	seq: turn * 10 + step,
	type: "assistant/message",
	data: { turn, step, message: { content: [] }, stream, ...extra },
});

test("a Turn's thinking time sums its steps' reasoning spans", () => {
	const events = [
		message(1, 1, [reasoningRun(1000, [500, 200], ["a", "b", "c"]), textRun(1800, [100], ["reply"])]),
		message(1, 2, [reasoningRun(3000, [900], ["x", "y"]), textRun(4000, [], ["done"])]),
	];
	// Step 1: 1000+500+200−1000 = 700; step 2: 3000+900−3000 = 900.
	assert.equal(thinkingMs(events, 1), 1600);
});

test("a step without reasoning records contributes 0, other turn events are ignored", () => {
	const events = [
		message(1, 1, [textRun(1000, [50], ["straight to text"])]),
		{ type: "tool/call", data: { turn: 1, step: 1 } },
		message(1, 2, [reasoningRun(3000, [500], ["a", "b"])]),
		message(2, 1, [reasoningRun(5000, [1000], ["other", "turn"])]),
	];
	assert.equal(thinkingMs(events, 1), 500);
});

test("an interrupted message still counts its streamed reasoning", () => {
	assert.equal(
		thinkingMs([message(1, 1, [reasoningRun(1000, [400, 300], ["a", "b", "c"])], { interrupted: true })], 1),
		700,
	);
});

test("assistant/attempt streams are skipped", () => {
	const events = [
		{
			type: "assistant/attempt",
			data: { turn: 1, step: 1, stream: [reasoningRun(1000, [9000], ["failed", "try"])] },
		},
		message(1, 1, [reasoningRun(2000, [100], ["ok", "now"])]),
	];
	assert.equal(thinkingMs(events, 1), 100);
});

test("a turn with reasoning text but no stream records is unknown, not 0", () => {
	assert.equal(thinkingMs([message(1, 1, undefined)], 1), undefined);
	assert.equal(
		thinkingMs(
			[
				{
					type: "assistant/message",
					data: { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: "old" }] } },
				},
			],
			1,
		),
		undefined,
	);
});

test("several reasoning runs in one step span first to last", () => {
	assert.equal(
		thinkingMs(
			[
				message(1, 1, [
					reasoningRun(1000, [100], ["a", "b"]),
					textRun(2000, [50], ["tool intro"]),
					reasoningRun(5000, [200], ["c", "d"]),
				]),
			],
			1,
		),
		4200,
	);
});

// The reader `thinkingOf` uses; a host without the chat index has none.
function host(events: any[]) {
	let pages = 0;
	const rt = {
		eventsBackwards: async function* () {
			pages += 1;
			for (const event of [...events].reverse()) yield event;
		},
	} as unknown as Runtime;
	install(rt);
	return { rt, pages: () => pages, events };
}

test("thinkingOf reads a turn once it closed, and recomputes an open one", async () => {
	const boot = [message(1, 1, [reasoningRun(1000, [400, 600], ["a", "b", "c"])])];
	const { rt, pages, events } = host(boot);
	// Open turn: computed each call.
	assert.equal(await rt.thinkingOf("s", 1), 1000);
	assert.equal(await rt.thinkingOf("s", 1), 1000);
	assert.equal(pages(), 2);
	events.push({ type: "turn/end", data: { turn: 1 } });
	assert.equal(await rt.thinkingOf("s", 1), 1000);
	assert.equal(await rt.thinkingOf("s", 1), 1000);
	assert.equal(pages(), 3);
});

test("reading an older turn also answers the closed turns read on the way", async () => {
	const events = [
		message(1, 1, [reasoningRun(1000, [1000], ["a", "b"])]),
		{ type: "turn/end", data: { turn: 1 } },
		message(2, 1, [reasoningRun(5000, [2000], ["a", "b"])]),
		{ type: "turn/end", data: { turn: 2 } },
		message(3, 1, [reasoningRun(9000, [3000], ["a", "b"])]),
	];
	const { rt, pages } = host(events);
	assert.equal(await rt.thinkingOf("s", 1), 1000);
	assert.equal(await rt.thinkingOf("s", 2), 2000);
	assert.equal(pages(), 1);
	assert.equal(await rt.thinkingOf("s", 3), 3000);
	assert.equal(pages(), 2);
});
