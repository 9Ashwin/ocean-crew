// aside cards sit among the rows, the `/side` command parsing, and the learning-card
// diff. Components that render React wait for the client test harness (a `react` stub
// and the `deep-view` declarations); they are checked by tsc and the client build.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	dockCards,
	owningTurn,
	partIndexOf,
	seqNum,
	sessionCards,
	tailCards,
	withBtwRows,
} from "../src/client/chat/btw-model.ts";
import { editLines, fileLines, lineDiff, proposalPlacement } from "../src/client/chat/learning-card-model.ts";
import {
	matchSideClaim,
	matchSideEnter,
	matchSideSpace,
	parseSideLine,
	sideChatsOf,
	sideQueryMatches,
	sideSurface,
} from "../src/client/chat/side-model.ts";
import type { ReasoningStep } from "../src/client/chat/turn-reasoning.ts";
import { opensReply, stepActivity, thinkingStep, turnReasoning } from "../src/client/chat/turn-reasoning.ts";

const step = (
	stepNumber: number,
	blocks: ReasoningStep["blocks"],
	extra: Partial<ReasoningStep> = {},
): ReasoningStep => ({ step: stepNumber, blocks, ...extra });
const reasoning = (text: string) => ({ kind: "reasoning", text });
const text = (value: string) => ({ kind: "text", text: value });

test("turnReasoning shows every loaded step's reasoning once, on the last reasoner", () => {
	const first = step(1, [reasoning("thinking one")]);
	const second = step(2, [reasoning("thinking two"), text("the answer")]);
	const third = step(3, [text("more")]);
	assert.equal(turnReasoning([first, second, third], second), "thinking one\n\nthinking two");
	// A step after the last reasoner shows none of the Turn's reasoning.
	assert.equal(turnReasoning([first, second], third), "");
	// With no loaded steps the current step is the only member.
	assert.equal(turnReasoning([], first), "thinking one");
});

test("step reasoning hides a signature block and keeps the rest", () => {
	const signed = step(1, [reasoning("<signature>private</signature>\nvisible thought")]);
	assert.equal(turnReasoning([], signed), "visible thought");
	// A partial opening tag is hidden; an unrelated angle-bracket text is not.
	assert.equal(turnReasoning([], step(1, [reasoning("<signat")])), "");
	assert.equal(turnReasoning([], step(1, [reasoning("<not a signature")])), "<not a signature");
});

test("stepActivity lifts the local agent's own tool lines out of the thought", () => {
	const mixed = step(1, [reasoning("a thought\n▸ read the file\nanother thought\n▸  grep  ")]);
	assert.equal(turnReasoning([], mixed), "a thought\nanother thought");
	assert.deepEqual(stepActivity(mixed), ["read the file", "grep"]);
});

test("opensReply names the first step with reply text, or the reasoner while reasoning shows", () => {
	const first = step(1, [reasoning("thought")]);
	const second = step(2, [text("reply")]);
	assert.equal(opensReply([first, second], first), true);
	assert.equal(opensReply([first, second], second), false);
	// With reasoning drawn, a step that only thought opens nothing.
	assert.equal(opensReply([first], first, true), true);
	const answerOnly = step(2, [text("reply only")]);
	assert.equal(opensReply([first, answerOnly], first, false), false);
});

test("thinkingStep finds a running step that streams reasoning and no text", () => {
	const running = step(1, [reasoning("thinking")], { status: "running" });
	assert.equal(thinkingStep([running])?.step, 1);
	assert.equal(thinkingStep([step(2, [reasoning("thinking")], { status: "done" })]), undefined);
	assert.equal(thinkingStep([step(3, [reasoning("thinking"), text("reply")], { status: "running" })]), undefined);
	assert.equal(thinkingStep([step(4, [text("reply")], { status: "running" })]), undefined);
});

test("seqNum reads a number, a bigint, or an object's seq", () => {
	assert.equal(seqNum(7), 7);
	assert.equal(seqNum(7n), 7);
	assert.equal(seqNum({ seq: 3 }), 3);
	assert.equal(seqNum({ seq: 3n }), 3);
	assert.equal(seqNum(undefined), undefined);
	assert.equal(seqNum(null), undefined);
	assert.equal(seqNum("3"), undefined);
	assert.equal(seqNum(Number.NaN), undefined);
});

test("owningTurn matches a closed turn first and an open turn second", () => {
	const closed = { turn: 1, start: 10, end: 20 };
	const open = { turn: 2, start: 30 };
	const turns = new Map([
		[1, closed],
		[2, open],
	]);
	assert.equal(owningTurn({ anchorSeq: 10 }, turns), closed);
	assert.equal(owningTurn({ anchorSeq: 20 }, turns), closed);
	assert.equal(owningTurn({ anchorSeq: 30 }, turns), open);
	assert.equal(owningTurn({ anchorSeq: 25 }, turns), undefined);
	// No anchorSeq: the latest turn that started by atSeq, including a log-only tail.
	assert.equal(owningTurn({ atSeq: 22 }, turns), closed);
	assert.equal(owningTurn({ atSeq: 31 }, turns), open);
	assert.equal(owningTurn({ atSeq: 5 }, turns), undefined);
	assert.equal(owningTurn({ anchorSeq: 10 }, undefined), undefined);
});

test("dockCards keeps open turns and unowned cards; tailCards names one closed turn", () => {
	const closed = { turn: 1, start: 10, end: 20 };
	const open = { turn: 2, start: 30 };
	const turns = new Map([
		[1, closed],
		[2, open],
	]);
	const docked = { id: "a", anchorSeq: 30 };
	const tailed = { id: "b", anchorSeq: 15 };
	const stray = { id: "c", anchorSeq: 99 };
	const facts = { turns };
	assert.deepEqual(
		dockCards([docked, tailed, stray], facts).map((card: any) => card.id),
		["a", "c"],
	);
	assert.deepEqual(tailCards([docked, tailed, stray], closed, turns), [tailed]);
	// An open turn has no tail yet.
	assert.deepEqual(tailCards([docked], open, turns), []);
	assert.deepEqual(tailCards([tailed], closed, undefined), []);
	assert.deepEqual(
		dockCards([tailed], undefined).map((card: any) => card.id),
		["b"],
	);
});

test("sessionCards reads a ready Bot chat's cards for this part only", () => {
	const roster = {
		ready: true,
		byId: { b1: { id: "b1" } },
		roomsById: {},
		btwCards: {
			b1: [
				{ id: "c1", partId: "b1" },
				{ id: "c2", partId: "older" },
			],
		},
	};
	assert.deepEqual(
		sessionCards(roster, "b1").map((card: any) => card.id),
		["c1"],
	);
	assert.deepEqual(sessionCards(roster, "no-one"), []);
	// A group's own chat has no aside cards.
	assert.deepEqual(sessionCards({ ...roster, roomsById: { r1: {} } }, "r1"), []);
	// A roster still loading has nothing yet.
	assert.deepEqual(sessionCards({ ...roster, ready: false }, "b1"), []);
});

test("partIndexOf uses an explicit cursor part, else the part before this one", () => {
	const bot = { parts: ["p1", "p2"], sessionId: "p3" };
	assert.equal(partIndexOf(bot, "p2", { part: 1 }), 1);
	assert.equal(partIndexOf(bot, "p2", undefined), 0);
	assert.equal(partIndexOf(bot, "p3", undefined), 1);
});

test("withBtwRows inserts a card once, after the turn it belongs to", () => {
	const items = [
		{ turn: 1, seq: 10, kind: "assistant-step" },
		{ turn: 1, seq: 11, kind: "assistant-step" },
		{ turn: 2, seq: 20, kind: "assistant-step" },
	];
	const card = { id: "c1", turn: 1 };
	const out = withBtwRows(items, [card]);
	assert.deepEqual(
		out.map((row: any) => (row.kind === "btw" ? `btw:${row.card.id}` : row.seq)),
		[10, 11, "btw:c1", 20],
	);
	// No cards means the rows are untouched.
	assert.equal(withBtwRows(items, []), items);
	// A card whose turn is not on this page waits in the trailing block.
	const trailing = withBtwRows(items, [{ id: "c2", turn: 9 }]);
	assert.equal(trailing.at(-1).kind, "btw");
	assert.equal(trailing.at(-1).card.id, "c2");
	// A divider can split a run; the card follows the later one.
	const split = [
		{ turn: 1, seq: 10, kind: "assistant-step" },
		{ seq: 11, kind: "divider" },
		{ turn: 1, seq: 12, kind: "assistant-step" },
	];
	const splitOut = withBtwRows(split, [{ id: "c3", turn: 1 }]);
	assert.equal(splitOut.at(-1).kind, "btw");
});

test("withBtwRows places an old card by anchorSeq, and drops one below the loaded page", () => {
	const items = [
		{ turn: 1, seq: 10, kind: "assistant-step" },
		{ turn: 1, seq: 11, kind: "assistant-step" },
	];
	// anchorSeq 10 is the turn/start, not a row: the card lands after that turn's rows.
	const anchored = withBtwRows(items, [{ id: "old", anchorSeq: 10, atSeq: 9 }]);
	assert.equal(anchored.length, 3);
	assert.equal(anchored.at(-1).kind, "btw");
	// atSeq below the first loaded seq belongs to an older page and is not drawn here.
	const below = withBtwRows(items, [{ id: "older", atSeq: 1 }]);
	assert.equal(below.length, 2);
});

test("parseSideLine reads only a leading `/side` token", () => {
	assert.deepEqual(parseSideLine("/side why?"), { args: "why?", bare: false });
	assert.deepEqual(parseSideLine("  /side   "), { args: "", bare: true });
	assert.deepEqual(parseSideLine("/side"), { args: "", bare: true });
	assert.equal(parseSideLine("/sidechat hi"), null);
	assert.equal(parseSideLine("/Side hi"), null);
	assert.equal(parseSideLine("hello /side"), null);
	assert.equal(parseSideLine(undefined), null);
});

test("sideSurface tells a Bot chat from a group and from an unready roster", () => {
	assert.equal(sideSurface({ ready: true, byId: { b: {} }, roomsById: {} }, "b"), "bot");
	assert.equal(sideSurface({ ready: true, byId: {}, roomsById: { r: {} } }, "r"), "group");
	assert.equal(sideSurface({ ready: true, byId: {}, roomsById: {} }, "x"), "other");
	assert.equal(sideSurface({ ready: false }, "b"), "unknown");
	assert.equal(sideSurface(undefined, "b"), "unknown");
});

test("the /side query matches its own prefix only", () => {
	assert.equal(sideQueryMatches(""), true);
	assert.equal(sideQueryMatches("s"), true);
	assert.equal(sideQueryMatches("side"), true);
	assert.equal(sideQueryMatches("SID"), true);
	assert.equal(sideQueryMatches("x"), false);
	assert.equal(sideChatsOf({ sideChats: { b: [{ id: "s1" }] } }, "b").length, 1);
	assert.deepEqual(sideChatsOf({ sideChats: { b: "junk" } }, "b"), []);
});

test("matchSideSpace and matchSideClaim claim only in a Bot's chat", () => {
	const roster = { ready: true, byId: { b: {} }, roomsById: { r: {} } };
	assert.deepEqual(matchSideSpace(roster, "b", "/side"), { claim: true });
	assert.equal(matchSideSpace(roster, "r", "/side"), undefined);
	assert.equal(matchSideSpace(roster, "b", "/sidechat"), undefined);
	assert.equal(matchSideClaim(roster, "b", "/side"), true);
	assert.equal(matchSideClaim(roster, "r", "/side"), undefined);
});

test("matchSideEnter throws for a group, an attachment, and an empty question", async () => {
	const roster = { ready: true, byId: { b: {} }, roomsById: { r: {} } };
	assert.deepEqual(await matchSideEnter(roster, "b", "/side why", undefined, undefined), { claim: true });
	await assert.rejects(matchSideEnter(roster, "r", "/side why", undefined, undefined), /private chat/);
	await assert.rejects(
		matchSideEnter(roster, "b", "/side why", { attachments: 1 }, undefined),
		/does not take attachments/,
	);
	await assert.rejects(matchSideEnter(roster, "b", "/side", undefined, undefined), /Write a question/);
	// A positively non-Bot session sends the line as an ordinary message.
	assert.equal(await matchSideEnter(roster, "nobody", "/side why", undefined, undefined), undefined);
	assert.equal(await matchSideEnter(roster, "b", "plain text", undefined, undefined), undefined);
});

test("a line diff marks same, added and removed lines", () => {
	const diff = lineDiff("one\ntwo\nthree", "one\nTWO\nthree");
	assert.deepEqual(
		diff.map((row: any) => [row.kind, row.line]),
		[
			["same", "one"],
			["removed", "two"],
			["added", "TWO"],
			["same", "three"],
		],
	);
	// Identical text is all the same lines.
	assert.equal(
		lineDiff("a\nb", "a\nb").every((row: any) => row.kind === "same"),
		true,
	);
});

test("edit lines split a card's text, and a file drops its trailing blank lines", () => {
	assert.deepEqual(editLines("a\nb\nc"), ["a", "b", "c"]);
	assert.deepEqual(editLines(undefined), []);
	assert.deepEqual(fileLines("a\nb\n\n"), ["a", "b"]);
	assert.deepEqual(fileLines(""), []);
});

test("a proposal is placed after the last turn that ended before it", () => {
	const turns = new Map([
		[1, { turn: 1, status: "closed", end: { time: 100 } }],
		[2, { turn: 2, status: "closed", end: { time: 200 } }],
	]);
	assert.deepEqual(proposalPlacement({ at: 150 }, turns), { kind: "turn", turn: 1 });
	assert.deepEqual(proposalPlacement({ at: 250 }, turns), { kind: "turn", turn: 2 });
	// A turn still open has no end, so it cannot own the card.
	assert.deepEqual(proposalPlacement({ at: 150 }, new Map([[3, { turn: 3, status: "open", start: { time: 120 } }]])), {
		kind: "dock",
	});
	// An answered card stays where it was answered; with no such turn it goes nowhere.
	assert.deepEqual(proposalPlacement({ at: 50, settledAt: 250, outcome: "accepted" }, turns), {
		kind: "turn",
		turn: 2,
	});
	// With no turn ended before either time, it goes nowhere, not to the dock.
	assert.deepEqual(proposalPlacement({ at: 50, outcome: "accepted" }, turns), { kind: "none" });
	assert.deepEqual(proposalPlacement({ at: Number.NaN }, turns), { kind: "dock" });
	assert.deepEqual(proposalPlacement({ at: Number.NaN, outcome: "accepted" }, turns), { kind: "none" });
});
