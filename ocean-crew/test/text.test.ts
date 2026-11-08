import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clockLabel,
	commRunOf,
	contentText,
	dayLabel,
	elapsedLabel,
	isHiddenTurn,
	isRelayContext,
	latestMemoryChange,
	linkMentions,
	MENTION_ORIGIN,
	messageClock,
	previewOf,
	relativeShort,
	relayPart,
	relaysBefore,
	reminderPrompts,
	runStatsOf,
	stripHeader,
	summaryBlocks,
	toolArgs,
	toolName,
	usageOf,
} from "../src/client/core/text.ts";
import {
	clip,
	createClock,
	currentColor,
	escapeRegExp,
	estimateTokens,
	excerpt,
	headOf,
	isColor,
	normalize,
	splitRef,
	textOf,
	unquote,
} from "../src/host/core/text.ts";

test("textOf joins the text blocks only", () => {
	assert.equal(
		textOf([
			{ type: "text", text: " a " },
			{ type: "image" },
			{ type: "text", text: "b" },
			{ type: "text", text: 3 },
		]),
		"a \nb",
	);
	assert.equal(textOf(undefined), "");
	assert.equal(textOf("plain"), "");
});

test("normalize and unquote", () => {
	assert.equal(normalize("  MiXed "), "mixed");
	assert.equal(normalize(null), "");
	assert.equal(normalize(undefined), "");
	assert.equal(unquote(" 「项目组」 "), "项目组");
	assert.equal(unquote('"Team"'), "Team");
	assert.equal(unquote("  'quoted'  "), "quoted");
	assert.equal(unquote(undefined), "");
});

test("splitRef splits at the first slash", () => {
	assert.deepEqual(splitRef("ollama/deepseek-v4-pro:0813"), { provider: "ollama", model: "deepseek-v4-pro:0813" });
	assert.deepEqual(splitRef("a/b/c"), { provider: "a", model: "b/c" });
	assert.equal(splitRef("/model"), undefined);
	assert.equal(splitRef("model"), undefined);
	assert.equal(splitRef(undefined), undefined);
});

test("currentColor keeps a palette id or hex and drops anything else", () => {
	assert.equal(currentColor("kimi"), undefined);
	assert.equal(currentColor("qwen"), undefined);
	assert.equal(currentColor("aurora"), "aurora");
	assert.equal(currentColor("#a0b1c2"), "#a0b1c2");
	assert.equal(currentColor(undefined), undefined);
});

test("isColor takes avatar inks, extra inks, and #rrggbb", () => {
	assert.equal(isColor("aurora"), true);
	assert.equal(isColor("charcoal"), true);
	assert.equal(isColor("#A0b1C2"), true);
	assert.equal(isColor("#abc"), false);
	assert.equal(isColor("pink"), false);
	assert.equal(isColor(undefined), false);
	assert.equal(isColor("#gggggg"), false);
});

test("escapeRegExp makes a literal pattern", () => {
	const name = "A.b*(c)?[d]";
	assert.equal(new RegExp(`^${escapeRegExp(name)}$`).test(name), true);
	assert.equal(new RegExp(`^${escapeRegExp(name)}$`).test("Axb*(c)?[d]"), false);
});

test("excerpt keeps the match in view", () => {
	assert.equal(excerpt("short", "x"), "short");
	const long = `${"a".repeat(500)}needle${"b".repeat(500)}`;
	const cut = excerpt(long, "needle", 200);
	assert.ok(cut.startsWith("…"));
	assert.ok(cut.endsWith("…"));
	assert.ok(cut.includes("needle"));
	assert.equal(excerpt(long, "", 10), `${"a".repeat(10)}…`);
	assert.equal(excerpt(long, "missing", 10), `${"a".repeat(10)}…`);
});

test("estimateTokens counts CJK as one token and other text as a third", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("你好"), 2);
	assert.equal(estimateTokens("abc"), 2);
	// Summing 0.34 per character runs a hair over, so ceil may add one; it stays an upper bound.
	const tokens = estimateTokens("a".repeat(100));
	assert.ok(tokens >= 34 && tokens <= 35, String(tokens));
});

test("clip cuts long text and says where the rest is", () => {
	assert.equal(clip("abc", 5, "x"), "abc");
	assert.equal(clip("abcdef", 3, "see part 2"), "abc… (cut; see part 2)");
});

test("headOf never cuts a character in half", () => {
	assert.equal(headOf("abc", 5), "abc");
	assert.equal(headOf("abc", 2), "ab");
	assert.equal(headOf("a😀b", 2), "a");
	assert.equal(headOf("a😀b", 3), "a😀");
});

test("createClock formats month, day, and 24-hour time", () => {
	const clock = createClock("UTC");
	assert.equal(clock(Date.UTC(2025, 9, 8, 14, 22)), "10-08 14:22");
	assert.equal(clock(Date.UTC(2025, 0, 2, 0, 5)), "01-02 00:05");
	assert.equal(clock(undefined), "?");
	assert.equal(clock(Number.NaN), "?");
});

// --- the browser half's text helpers -----------------------------------------------

const clockOf = (ms: number): string =>
	new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
// A time in the machine's own zone, some days back, so the test does not depend on the zone.
const at = (daysAgo: number, hour: number, minute: number): number => {
	const today = new Date();
	return new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hour, minute).getTime();
};

test("a message shows the clock today, and the day it came in before that", () => {
	const today = at(0, 14, 5);
	assert.equal(messageClock(today), clockOf(today));
	const yesterday = at(1, 9, 3);
	assert.equal(messageClock(yesterday), `Yesterday ${clockOf(yesterday)}`);
	const older = at(5, 9, 3);
	const date = new Date(older);
	const sameYear = date.getFullYear() === new Date().getFullYear();
	const day = date.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	});
	assert.equal(messageClock(older), `${day} ${clockOf(older)}`);
	// The hover title always names the day.
	assert.equal(clockLabel(today), `Today ${clockOf(today)}`);
	assert.equal(clockLabel(yesterday), `Yesterday ${clockOf(yesterday)}`);
	assert.equal(clockLabel(older), messageClock(older));
	// The group separator's day stamp names the day of an older message.
	assert.match(dayLabel(older), /\w{3}, \w{3} \d+ /);
});

test("the work clock counts seconds, then minutes and seconds, then hours, minutes and seconds", () => {
	assert.equal(elapsedLabel(-5_000), "0s");
	assert.equal(elapsedLabel(1_000), "1s");
	assert.equal(elapsedLabel(59_999), "59s");
	assert.equal(elapsedLabel(60_000), "1m 0s");
	assert.equal(elapsedLabel(68_400), "1m 8s");
	assert.equal(elapsedLabel(3_599_000), "59m 59s");
	assert.equal(elapsedLabel(3_600_000), "1h 0m 0s");
	assert.equal(elapsedLabel(3_723_000), "1h 2m 3s");
});

test("relative stamps read short and fall back to a date", () => {
	const now = Date.now();
	assert.equal(relativeShort(now - 1_000), "just now");
	assert.equal(relativeShort(now - 5 * 60_000), "5 min");
	assert.equal(relativeShort(now - 3 * 3_600_000), "3 h");
	assert.equal(relativeShort(now - 2 * 86_400_000), "2 d");
	assert.match(relativeShort(now - 40 * 86_400_000), /^[A-Z][a-z]{2} \d+$/);
});

test("contentText joins the text blocks only", () => {
	assert.equal(contentText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(contentText(undefined), "");
	assert.equal(contentText([]), "");
});

test("a bare name is ordinary text, even when a Bot has that name", () => {
	const bots = [
		{ id: "a", name: "新 Bot" },
		{ id: "b", name: "新 Bot 2" },
		{ id: "c", name: "Chief" },
		{ id: "t", name: "测试" },
	];
	assert.equal(linkMentions("76 项测试通过，问问 Chief", bots, "a"), "76 项测试通过，问问 Chief");
	// A Bot naming itself is not taken for a Bot whose name is a prefix of its own.
	assert.equal(linkMentions("你好！我是 @新 Bot 2，很高兴加入", bots, "b"), "你好！我是 @新 Bot 2，很高兴加入");
	// The longest name wins, and other Bots are still linked.
	assert.equal(
		linkMentions("@新 Bot 2 和 @chief", bots, "a"),
		`[新 Bot 2](${MENTION_ORIGIN}b) 和 [chief](${MENTION_ORIGIN}c)`,
	);
	assert.equal(linkMentions("问问@新 Bot。", bots, "b"), `问问[新 Bot](${MENTION_ORIGIN}a)。`);
	assert.equal(linkMentions("@测试你看下", bots, "a"), `[测试](${MENTION_ORIGIN}t)你看下`);
	// Addresses, longer words and code are left alone.
	assert.equal(linkMentions("mail me@Chief.dev", bots, "a"), "mail me@Chief.dev");
	assert.equal(linkMentions("@Chiefs 来了", bots, "a"), "@Chiefs 来了");
	assert.equal(linkMentions("run `@Chief` now", bots, "a"), "run `@Chief` now");
	// A "@all" mentions everyone, so it is not a link.
	assert.equal(linkMentions("@all 开会", bots, "a"), "@all 开会");
});

test("relay headers with brackets in a Bot or group name leave the body intact", () => {
	const body = "Hello [team]\n[notes](https://example.test)\n[Keep this line]";
	for (const name of ["Writer", "R]2", "A]B]C", "A[B]C", "[Ops]", "普通[助理]"]) {
		for (const header of [
			`[Message from ${name}]`,
			`[Reply from ${name}]`,
			`[Group post from ${name}]`,
			`[Group chat "${name}" · replies to your post]`,
			`[Reply from Writer · for the work ${name} asked you for; your answer goes to ${name} once everything you handed on is back]`,
		]) {
			assert.equal(stripHeader(`${header}\n${body}`), body, header);
			assert.equal(stripHeader(`${header}\r\n${body}`), body, header);
		}
	}
});

test("a single-line relay keeps its inline body, including later brackets", () => {
	for (const header of ["[Message from Writer]", "[Group post from Writer]", "[Bot team setup]"]) {
		assert.equal(stripHeader(`${header} Hello [team]`), " Hello [team]");
		assert.equal(stripHeader(header), "");
	}
});

test("a header strip never reaches into a later body line or unrelated bracketed text", () => {
	for (const text of [
		"[Message from Writer\n[Keep this line]",
		"[Someone else]\nHello",
		"Hello\n[Message from Writer]",
	]) {
		assert.equal(stripHeader(text), text);
	}
});

test("a due scheduled task's framing becomes its prompts", () => {
	assert.deepEqual(reminderPrompts('reminder_prompt_json: "Where are we?"'), ["Where are we?"]);
	assert.deepEqual(
		reminderPrompts(
			`reminders_json: ${JSON.stringify([{ reminder_prompt: "One" }, { reminder_prompt: " " }, { reminder_prompt: "Two" }])}`,
		),
		["One", "Two"],
	);
	assert.deepEqual(reminderPrompts("reminders_json: not json"), []);
	assert.deepEqual(reminderPrompts("[SCHEDULE REMINDER] nothing here"), []);
});

const argsRaw = JSON.stringify({ name: "GITHUB_TOKEN", purpose: "GitHub", questions: [{ question: "Which?" }] });

test("a finished call that carries its name and arguments only under `call` is still read", () => {
	const root = { kind: "tool-result", callId: "c1", call: { name: "request_secret", argsRaw }, content: [] };
	const args = toolArgs(root);
	assert.equal(toolName(root), "request_secret");
	assert.equal(args.text("name"), "GITHUB_TOKEN");
	assert.deepEqual(args.value("questions"), [{ question: "Which?" }]);
	assert.equal(args.text("questions"), undefined);
	assert.equal(args.text("missing"), undefined);
});

test("a running call is read from its own name and raw arguments", () => {
	const root = { phase: "start", callId: "c1", name: "request_secret", argsRaw };
	assert.equal(toolName(root), "request_secret");
	assert.equal(toolArgs(root).text("name"), "GITHUB_TOKEN");
});

test("a node with an argument reader uses the reader", () => {
	const reader = {
		text: (key: string) => (key === "to" ? "Coder" : undefined),
		value: (key: string) => (key === "to" ? "Coder" : undefined),
	};
	const root = {
		kind: "tool-result",
		name: "message_bot",
		args: reader,
		call: { name: "message_bot", argsRaw: '{"to":"Other"}' },
	};
	assert.equal(toolName(root), "message_bot");
	assert.equal(toolArgs(root).text("to"), "Coder");
	assert.equal(toolArgs(root).value("to"), "Coder");
});

test("an empty name falls back to the call, and unreadable arguments read as absent", () => {
	const root = { kind: "tool-result", name: "", call: { name: "ask_user", argsRaw: '{"question":' } };
	assert.equal(toolName(root), "ask_user");
	assert.equal(toolArgs(root).text("question"), undefined);
	assert.equal(toolArgs({ kind: "tool-result", call: null }).value("x"), undefined);
	assert.equal(toolArgs({ argsRaw: "[1]" }).value("0"), undefined);
});

const relay = (time: number, role = "request", over: Record<string, unknown> = {}) => ({
	time,
	source: { kind: "bot", role, senderSessionId: "session-sender", ...over },
});
const stepAt = (step: number, time: number, text: string | null = "some text") => ({
	step,
	time,
	blocks: text === null ? [{ kind: "tool-call" }] : [{ kind: "text", text }],
});

test("a relay between steps attaches to the step that follows it only", () => {
	const steps = [stepAt(1, 10), stepAt(2, 20), stepAt(3, 30)];
	const contexts = [relay(15), relay(25)];
	assert.equal(relaysBefore(contexts, steps, steps[0]).length, 0);
	assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[0]]);
	assert.deepEqual(relaysBefore(contexts, steps, steps[2]), [contexts[1]]);
});

test("a relay before a tool-only step attaches to the next step that renders", () => {
	const steps = [stepAt(1, 10), stepAt(2, 20, null), stepAt(3, 30, null), stepAt(4, 40)];
	const contexts = [relay(15)];
	assert.deepEqual(relaysBefore(contexts, steps, steps[3]), [contexts[0]]);
});

test("a relay before the first step attaches to it", () => {
	const steps = [stepAt(1, 10), stepAt(2, 20)];
	const contexts = [relay(5)];
	assert.deepEqual(relaysBefore(contexts, steps, steps[0]), [contexts[0]]);
	assert.equal(relaysBefore(contexts, steps, steps[1]).length, 0);
});

test("the step is found by its number when the cell holds a different copy", () => {
	const steps = [stepAt(1, 10), stepAt(2, 20), stepAt(3, 30)];
	const contexts = [relay(15)];
	assert.deepEqual(relaysBefore(contexts, steps, { ...steps[1] }), [contexts[0]]);
});

test("a relay sharing the previous step's time attaches to the next step", () => {
	const steps = [stepAt(1, 10), stepAt(2, 20)];
	const contexts = [relay(10)];
	assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[0]]);
});

test("relayPart puts the line in the step's first cell", () => {
	const thinking = {
		step: 1,
		time: 10,
		blocks: [
			{ kind: "reasoning", text: "thought" },
			{ kind: "text", text: "reply" },
		],
	};
	const plain = { step: 2, time: 20, blocks: [{ kind: "text", text: "reply" }] };
	const blank = { step: 3, time: 30, blocks: [{ kind: "reasoning", text: "  " }] };
	assert.equal(relayPart(thinking, "reasoning"), true);
	assert.equal(relayPart(thinking, "response"), false);
	assert.equal(relayPart(plain, "response"), true);
	assert.equal(relayPart(plain, "reasoning"), false);
	assert.equal(relayPart(blank, "response"), true);
	assert.equal(relayPart(thinking, undefined), true);
	assert.equal(relayPart(plain, undefined), true);
});

test("two relays before one step both return, in order", () => {
	const steps = [stepAt(1, 10), stepAt(2, 30)];
	const contexts = [relay(12, "request"), relay(18, "reply")];
	assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[0], contexts[1]]);
});

test("non-relay context and ocean-crew package sources are ignored", () => {
	const steps = [stepAt(1, 10), stepAt(2, 30)];
	const contexts = [
		relay(12, "request", { handoff: true }),
		relay(14, "kickoff"),
		relay(16, "room"),
		relay(18, "secret"),
		relay(22, "request", { senderSessionId: undefined }),
		{ time: 24, source: { kind: "agent-instructions" } },
		{ time: 26, source: null },
		relay(27, "request", { deferred: true }),
		relay(27, "request", { resumed: true }),
		relay(27, "stopped", { retried: true }),
		relay(28, "request"),
	];
	assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[10]]);
});

test("a message that is a relay is told from package sources and handed-back requests", () => {
	assert.equal(isRelayContext(relay(1)), true);
	for (const role of ["kickoff", "room", "secret", "handoff", "update"])
		assert.equal(isRelayContext(relay(1, role)), false);
	assert.equal(isRelayContext(relay(1, "request", { handoff: true })), false);
	for (const flag of ["deferred", "resumed", "retried"])
		assert.equal(isRelayContext(relay(1, "request", { [flag]: true })), false);
	assert.equal(isRelayContext(relay(1, "request", { senderSessionId: undefined })), false);
	assert.equal(isRelayContext({ source: null }), false);
	assert.equal(isRelayContext(undefined), false);
});

test("back-to-back Bot-to-Bot messages fold into one line", () => {
	const order = [1, 2, 3];
	const peers: Record<string, string> = { 1: "a", 2: "b", 3: "a" };
	assert.deepEqual(commRunOf(order, peers, 1, [1, 2]), { count: 5, peerIds: ["a", "b"] });
	assert.equal(commRunOf(order, peers, 2, [1, 2]), "folded");
	assert.equal(commRunOf(order, peers, 3, [2]), "folded");
	// A turn that relayed nothing has no run, and a hidden turn outside the run is skipped.
	assert.equal(commRunOf(order, { 2: "b" }, 1), null);
	assert.equal(commRunOf([9], {}, 9, [9]), null);
	// The run goes on through the hidden turns that follow its first one.
	assert.deepEqual(commRunOf(order, peers, 1, [1]), { count: 3, peerIds: ["a", "b"] });
});

test("the sidebar preview is the latest visible line, without its relay header", () => {
	const list = {
		projectionsBySession: {
			s: {
				values: {
					turnOutline: [
						{ turn: 1, prompt: "hi" },
						{ turn: 2, response: "[Reply from Chief]\nall done" },
						{ turn: 3, response: "hidden line" },
					],
				},
			},
		},
	};
	assert.equal(previewOf(list, "s", [3]), "all done");
	assert.equal(previewOf(list, "missing"), "");
	assert.equal(previewOf({}, "s"), "");
});

test("a Session's token use counts every prompt-side bucket plus output", () => {
	const list = {
		projectionsBySession: {
			s: {
				values: {
					tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
				},
			},
		},
	};
	assert.equal(usageOf(list, ["s"]), "1.4K tok · Cache hit 90%");
	assert.equal(usageOf({}, ["s"]), "");
});

test("a hidden exchange turn stays out of the chat", () => {
	assert.equal(isHiddenTurn({ exchangeTurns: { s: [1, 3] } }, "s", 3), true);
	assert.equal(isHiddenTurn({ exchangeTurns: { s: [1] } }, "s", 2), false);
	assert.equal(isHiddenTurn({ exchangeTurns: {} }, "s", 1), false);
	assert.equal(isHiddenTurn({ exchangeTurns: { s: [1] } }, undefined, 1), false);
});

test("the figures read as DSH counts them", () => {
	const values = {
		sessionStats: { turns: 12, decodeMs: 4000, decodeTokens: 150 },
		tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
		contextPressure: { pressureTokens: 41_000, contextWindow: 100_000 },
	};
	const texts = (found: any) => runStatsOf(found).map((entry) => entry.text);
	assert.deepEqual(texts(values), ["12 turns", "38 tok/s", "Cache hit 90%", "Context 41%"]);
	assert.equal(runStatsOf(values).at(-1)?.title, "41.0K of 100.0K tokens of context in use");
});

test("a slow speed keeps a decimal, and a projected count wins over the last measure", () => {
	const values = {
		sessionStats: { turns: 1, decodeMs: 2000, decodeTokens: 9 },
		contextPressure: { pressureTokens: 10, projectedTokens: 30, contextWindow: 100 },
	};
	assert.deepEqual(
		runStatsOf(values).map((entry) => entry.text),
		["1 turn", "4.5 tok/s", "Context 30%"],
	);
});

test("a cache hit short of whole never reads 100%", () => {
	const hit = (cacheReadTokens: number) =>
		runStatsOf({ tokenUsage: { uncachedInputTokens: 1000 - cacheReadTokens, cacheReadTokens } }).map(
			(entry) => entry.text,
		);
	assert.deepEqual(hit(996), ["Cache hit 99.6%"]);
	assert.deepEqual(hit(1000), ["Cache hit 100%"]);
	assert.deepEqual(hit(0), ["Cache hit 0%"]);
});

test("nothing to count leaves the line empty", () => {
	assert.deepEqual(runStatsOf(null), []);
	assert.deepEqual(
		runStatsOf({
			sessionStats: { turns: 0, decodeMs: 0, decodeTokens: 0 },
			tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		}),
		[],
	);
	assert.deepEqual(
		runStatsOf({ contextPressure: { contextWindow: 100 } }).map((entry) => entry.text),
		[],
	);
});

test("a memory summary reads as headings over paragraphs", () => {
	assert.deepEqual(
		summaryBlocks("## Overview\nYou like **tea**.\nYou live in Hangzhou.\n\n## Team\n- Ship on Friday\n"),
		[
			{ kind: "h", text: "Overview" },
			{ kind: "p", text: "You like tea. You live in Hangzhou." },
			{ kind: "h", text: "Team" },
			{ kind: "p", text: "Ship on Friday" },
		],
	);
	assert.deepEqual(summaryBlocks(""), []);
});

test("the memory that changed last on the host opens when one poll brings two", () => {
	const news = { b2: { at: 2_000, seen: 5_000 }, b3: { at: 3_000, seen: 5_000 }, b4: { at: 9_000, seen: 0 } };
	assert.equal(latestMemoryChange(news, ["b2", "b3"]), "b3");
	assert.equal(latestMemoryChange(news, ["b4", "b2"]), "b2");
	assert.equal(latestMemoryChange({}, ["b2"]), "b2");
	assert.equal(latestMemoryChange({}, []), null);
	assert.equal(latestMemoryChange(undefined, ["b2"]), "b2");
});
