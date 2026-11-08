// The IM support modules: outbound formatting, the status-reaction lifecycle, and the
// pure connection supervisor. All three are host-side helpers the IM adapters and the
// IM host core share, so their behavior is checked here without a network or timers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMarkdown, chunkTelegram, toPlain, toTelegramHtml } from "../src/host/im/format.ts";
import { STATUS_REACTIONS, type StatusReactionOptions, startStatusReaction } from "../src/host/im/reaction.ts";
import { failClass, nextAction, RETRY_DELAYS_MS, retryDelay } from "../src/host/im/supervisor.ts";

// ---------------------------------------------------------------------------
// format.ts: Markdown to platform text.

test("Markdown becomes Telegram HTML", () => {
	assert.equal(toTelegramHtml("**bold** and _ital_"), "<b>bold</b> and <i>ital</i>");
	assert.equal(toTelegramHtml("run `rm -rf` now"), "run <code>rm -rf</code> now");
	assert.equal(toTelegramHtml("see [the docs](https://a.b/c)"), 'see <a href="https://a.b/c">the docs</a>');
	assert.equal(toTelegramHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
	const fenced = toTelegramHtml("before\n```js\nlet x = 1 < 2\n```\nafter");
	assert.equal(fenced, 'before\n<pre><code class="language-js">let x = 1 &lt; 2</code></pre>\nafter');
	assert.equal(toTelegramHtml("done ~~deal~~"), "done <s>deal</s>");
	// Markers inside a code span stay literal.
	assert.equal(toTelegramHtml("`**not bold**`"), "<code>**not bold**</code>");
});

test("Markdown becomes plain text", () => {
	assert.equal(toPlain("**bold** `code` [site](https://a.b)"), "bold code site (https://a.b)");
	assert.equal(toPlain("```\nlet x = 1\n```"), "let x = 1");
	// A link whose label is its URL is written once.
	assert.equal(toPlain("[https://a.b](https://a.b)"), "https://a.b");
});

test("chunks stay under the limit and keep whole fences", () => {
	const fence = `\`\`\`\n${"x".repeat(200)}\n\`\`\``;
	const chunks = chunkTelegram(`start\n\n${fence}\n\nend`, 100);
	assert.ok(chunks.length > 1);
	const whole = chunks.find((chunk) => chunk.html.includes("<pre><code>"));
	assert.ok(whole !== undefined);
	assert.ok(whole.html.length <= 100);
	// The 200-char fence cannot fit, so it is split into several fenced blocks.
	for (const chunk of chunks) assert.ok(chunk.html.length <= 100, String(chunk.html.length));
	// A fence that fits is not cut.
	const fits = chunkTelegram(`a\n\n${fence}`, 300);
	assert.equal(fits.length, 1);
	assert.ok(fits[0].html.includes("<pre><code>"));
});

test("an oversized line is hard cut and stays under the limit", () => {
	const chunks = chunkTelegram("y".repeat(9000), 4096);
	assert.equal(chunks.length, 3);
	for (const chunk of chunks) assert.ok(chunk.html.length <= 4096);
});

test("plain markdown chunks at paragraphs and lines, then hard cuts", () => {
	assert.deepEqual(chunkMarkdown("short text", 4000), ["short text"]);
	const paragraphs = chunkMarkdown("first paragraph\n\nsecond paragraph", 20);
	// The cut point is the blank-line break; the trailing newline stays on the chunk.
	assert.deepEqual(paragraphs, ["first paragraph\n", "second paragraph"]);
	for (const chunk of paragraphs) assert.ok(chunk.length <= 20);
	// A line longer than the limit is cut, with no whitespace carried into the next chunk.
	const cut = chunkMarkdown("aaaa bbbb cccc", 8);
	assert.deepEqual(cut, ["aaaa bbb", "b cccc"]);
	const hard = chunkMarkdown("x".repeat(25), 10);
	assert.deepEqual(hard, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	assert.deepEqual(chunkMarkdown("", 10), []);
	assert.deepEqual(chunkMarkdown(null, 10), []);
});

// ---------------------------------------------------------------------------
// reaction.ts: the best-effort status lifecycle.

interface ReactionRecorder {
	calls: string[];
	warns: string[];
	add(emoji: string): Promise<string>;
	remove(id: string): Promise<void>;
}

const recorder = ({
	failAdd = false,
	failRemove = false,
}: {
	failAdd?: boolean;
	failRemove?: boolean;
} = {}): ReactionRecorder => {
	const calls: string[] = [];
	const warns: string[] = [];
	return {
		calls,
		warns,
		add: async (emoji: string) => {
			calls.push(`add:${emoji}`);
			if (failAdd) throw new Error("the app has no reaction scope");
			return `r${calls.length}`;
		},
		remove: async (id: string) => {
			calls.push(`remove:${id}`);
			if (failRemove) throw new Error("the reaction is gone");
		},
	};
};

const start = (r: ReactionRecorder, extra: StatusReactionOptions = {}) =>
	startStatusReaction({
		add: r.add,
		remove: r.remove,
		warn: (error) => r.warns.push((error as Error).message),
		...extra,
	});

test("the processing mark goes on at once and success replaces it", async () => {
	const r = recorder();
	const reaction = start(r);
	assert.ok(reaction !== undefined);
	await reaction.settled();
	assert.deepEqual(r.calls, [`add:${STATUS_REACTIONS.processing}`]);
	await reaction.success();
	assert.deepEqual(r.calls, [`add:${STATUS_REACTIONS.processing}`, "remove:r1", `add:${STATUS_REACTIONS.success}`]);
});

test("error replaces the processing mark instead of success", async () => {
	const r = recorder();
	const reaction = start(r);
	assert.ok(reaction !== undefined);
	await reaction.settled();
	await reaction.error();
	assert.deepEqual(r.calls, [`add:${STATUS_REACTIONS.processing}`, "remove:r1", `add:${STATUS_REACTIONS.error}`]);
});

test("clear removes the mark and leaves no verdict", async () => {
	const r = recorder();
	const reaction = start(r);
	assert.ok(reaction !== undefined);
	await reaction.settled();
	await reaction.clear();
	assert.deepEqual(r.calls, [`add:${STATUS_REACTIONS.processing}`, "remove:r1"]);
});

test("the first verdict wins and later ones are ignored", async () => {
	const r = recorder();
	const reaction = start(r);
	assert.ok(reaction !== undefined);
	await reaction.settled();
	const first = reaction.success();
	void reaction.error();
	void reaction.clear();
	await first;
	assert.deepEqual(r.calls, [`add:${STATUS_REACTIONS.processing}`, "remove:r1", `add:${STATUS_REACTIONS.success}`]);
});

test("a failing add or remove is warned about, not thrown", async () => {
	const failedAdd = recorder({ failAdd: true });
	const first = start(failedAdd);
	assert.ok(first !== undefined);
	await first.settled();
	assert.deepEqual(failedAdd.calls, [`add:${STATUS_REACTIONS.processing}`]);
	assert.deepEqual(failedAdd.warns, ["the app has no reaction scope"]);

	const failedRemove = recorder({ failRemove: true });
	const second = start(failedRemove);
	assert.ok(second !== undefined);
	await second.settled();
	await second.success();
	assert.deepEqual(failedRemove.calls, [`add:${STATUS_REACTIONS.processing}`, "remove:r1"]);
	assert.deepEqual(failedRemove.warns, ["the reaction is gone"]);
});

test("an adapter without both operations gets no reaction at all", () => {
	// Only one of the two operations is present: the adapter gets no reaction.
	assert.equal(startStatusReaction({ add: async () => "r1" }), undefined);
	assert.equal(startStatusReaction({}), undefined);
	assert.equal(startStatusReaction(), undefined);
});

test("transitions wait for the previous provider call", async () => {
	const order: string[] = [];
	let release: (() => void) | undefined;
	const reaction = startStatusReaction({
		add: async (emoji: string) => {
			order.push(`add start:${emoji}`);
			if (emoji === STATUS_REACTIONS.processing)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			order.push(`add end:${emoji}`);
			return `r-${emoji}`;
		},
		remove: async (id: string) => {
			order.push(`remove:${id}`);
		},
	});
	assert.ok(reaction !== undefined);
	await Promise.resolve();
	assert.deepEqual(order, [`add start:${STATUS_REACTIONS.processing}`], "the processing add is still in flight");
	const settled = reaction.success();
	await Promise.resolve();
	assert.deepEqual(order, [`add start:${STATUS_REACTIONS.processing}`], "the verdict waits for the add");
	release?.();
	await settled;
	assert.deepEqual(order, [
		`add start:${STATUS_REACTIONS.processing}`,
		`add end:${STATUS_REACTIONS.processing}`,
		`remove:r-${STATUS_REACTIONS.processing}`,
		`add start:${STATUS_REACTIONS.success}`,
		`add end:${STATUS_REACTIONS.success}`,
	]);
});

// ---------------------------------------------------------------------------
// supervisor.ts: one decision per health check.

test("the retry ladder climbs from 250ms to a 30s cap", () => {
	assert.deepEqual([...RETRY_DELAYS_MS], [250, 1_000, 3_000, 5_000, 10_000, 30_000]);
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 7, 42].map(retryDelay),
		[250, 1_000, 3_000, 5_000, 10_000, 30_000, 30_000, 30_000],
	);
	assert.equal(retryDelay(0), 250, "a missing attempt counts as the first one");
});

test("an error connection restarts along the ladder until the cap", () => {
	let now = 10_000;
	let entry = { desired: true, running: true, state: "error", attempts: 0, nextRetryAt: 0 };
	const waits: number[] = [];
	for (let attempt = 1; attempt <= 7; attempt += 1) {
		const decision = nextAction(now, entry);
		assert.equal(decision.action, "restart");
		assert.equal(decision.attempts, attempt);
		waits.push(decision.nextRetryAt - now);
		entry = { ...entry, attempts: decision.attempts, nextRetryAt: decision.nextRetryAt };
		now = decision.nextRetryAt;
	}
	assert.deepEqual(waits, [250, 1_000, 3_000, 5_000, 10_000, 30_000, 30_000]);
});

test("a retry waits for its due time and a restart keeps counting from there", () => {
	const waits = nextAction(2_000, { desired: true, running: true, state: "error", attempts: 2, nextRetryAt: 2_250 });
	assert.deepEqual(waits, { action: "none", attempts: 2, nextRetryAt: 2_250 });
	const restart = nextAction(2_250, { desired: true, running: true, state: "error", attempts: 2, nextRetryAt: 2_250 });
	assert.deepEqual(restart, { action: "restart", attempts: 3, nextRetryAt: 5_250 });
});

test("a ready connection ends the ladder", () => {
	const decision = nextAction(9_000, {
		desired: true,
		running: true,
		state: "ready",
		attempts: 5,
		nextRetryAt: 20_000,
	});
	assert.deepEqual(decision, { action: "none", attempts: 0, nextRetryAt: 0 });
});

test("a connection that is no longer desired stops and keeps no retry", () => {
	assert.deepEqual(
		nextAction(5_000, { desired: false, running: true, state: "error", attempts: 3, nextRetryAt: 9_000 }),
		{
			action: "stop",
			attempts: 0,
			nextRetryAt: 0,
		},
	);
	assert.deepEqual(nextAction(5_000, { desired: false, running: false, state: "off", attempts: 0, nextRetryAt: 0 }), {
		action: "none",
		attempts: 0,
		nextRetryAt: 0,
	});
});

test("a desired connection without a runner starts, and a lost runner retries with the ladder", () => {
	assert.deepEqual(nextAction(1_000, { desired: true, running: false, state: "off" }), {
		action: "start",
		attempts: 0,
		nextRetryAt: 0,
	});
	assert.deepEqual(nextAction(1_000, { desired: true, running: false, state: "error", attempts: 0, nextRetryAt: 0 }), {
		action: "start",
		attempts: 1,
		nextRetryAt: 1_250,
	});
	assert.deepEqual(
		nextAction(1_100, { desired: true, running: false, state: "error", attempts: 1, nextRetryAt: 1_250 }),
		{
			action: "none",
			attempts: 1,
			nextRetryAt: 1_250,
		},
	);
});

test("a connecting connection is left alone", () => {
	const decision = nextAction(7_000, {
		desired: true,
		running: true,
		state: "connecting",
		attempts: 2,
		nextRetryAt: 8_000,
	});
	assert.deepEqual(decision, { action: "none", attempts: 2, nextRetryAt: 8_000 });
});

test("a refused message does not restart a healthy connection", () => {
	const decision = nextAction(9_000, {
		desired: true,
		running: true,
		state: "error",
		messageError: true,
		attempts: 3,
		nextRetryAt: 20_000,
	});
	assert.deepEqual(decision, { action: "none", attempts: 3, nextRetryAt: 0 });
	// No runner means the link is really gone: one refused message must not mask that.
	assert.equal(
		nextAction(9_000, {
			desired: true,
			running: false,
			state: "error",
			messageError: true,
			attempts: 0,
			nextRetryAt: 0,
		}).action,
		"start",
	);
});

test("failures are classified three ways and only retry is resent", () => {
	assert.equal(failClass(Object.assign(new Error("refused"), { status: 401 })), "permanent");
	assert.equal(failClass(Object.assign(new Error("refused"), { permanent: true })), "permanent");
	assert.equal(failClass(Object.assign(new Error("rate limited"), { status: 429 })), "retry", "429 is a retry");
	assert.equal(failClass(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), "retry");
	assert.equal(failClass(Object.assign(new Error("adapter closed"), { stopped: true })), "unknown");
	assert.equal(failClass(Object.assign(new Error("send timed out"), { unknown: true })), "unknown");
	assert.equal(failClass(undefined), "retry");
	for (const error of [
		Object.assign(new Error("x"), { permanent: true }),
		Object.assign(new Error("x"), { unknown: true }),
	]) {
		assert.notEqual(failClass(error), "retry", "permanent and unknown failures are dropped, not retried");
	}
});
