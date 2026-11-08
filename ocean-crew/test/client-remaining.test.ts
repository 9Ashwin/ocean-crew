// The client's pure decision models: the Enter/steer judgment (#839), the `/side`
// command's refusals and menu keys, and the learning card's placement and file diff.

// same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editLines, fileLines, lineDiff, proposalPlacement } from "../src/client/chat/learning-card-model.ts";
import {
	drawerMenuKeys,
	matchSideClaim,
	matchSideEnter,
	matchSideSpace,
	panelHasStrip,
	parseSideLine,
	SIDE_SOURCE,
	SIDE_TOKEN,
	sideChatsOf,
	sideQueryMatches,
	sideSurface,
	stripMenuKeys,
	submitSide,
} from "../src/client/chat/side-model.ts";
import {
	type ComposerInput,
	type EnterEvent,
	enterSteers,
	type QueueItem,
	steerable,
	steerQueued,
} from "../src/client/shell/enter-steer.ts";
import { createSource } from "../src/client/shell/sources.ts";

// --- enter-steer -----------------------------------------------------------

const input = (over: Partial<ComposerInput> = {}): ComposerInput => ({
	phase: "plain",
	draft: "",
	attachmentIds: [],
	queue: [{ id: "m1", source: { kind: "user" } }],
	...over,
});
const event = (over: Partial<EnterEvent> = {}): EnterEvent => ({ key: "Enter", ...over });

test("plain Enter on an empty composer with the user's queue steers", () => {
	assert.equal(enterSteers(event(), input()), true);
	assert.equal(enterSteers(event(), input({ draft: "   \n\t  " })), true);
	assert.equal(steerable(input()), true);
});

test("modifiers, IME and key repeat pass Enter through", () => {
	for (const over of [
		{ key: "a" },
		{ shiftKey: true },
		{ ctrlKey: true },
		{ metaKey: true },
		{ altKey: true },
		{ getModifierState: (key: string) => key === "AltGraph" },
		{ isComposing: true },
		{ keyCode: 229 },
		{ repeat: true },
	]) {
		assert.equal(enterSteers(event(over), input()), false, JSON.stringify(over));
	}
});

test("a non-empty draft, attachments, a busy phase or no user queue stay put", () => {
	for (const over of [
		{ draft: "hello" },
		{ attachmentIds: ["a1"] },
		{ phase: "submitting" },
		{ phase: "adjudicating" },
		{ phase: "claimed" },
		{ queue: [] },
		{
			queue: [
				{ id: "m1", source: { kind: "bot" } },
				{ id: "m2", source: { kind: "user-question-reply" } },
			],
		},
		{ queue: [{ id: "m1" }] },
	]) {
		assert.equal(enterSteers(event(), input(over)), false, JSON.stringify(over));
		assert.equal(steerable(input(over)), false, JSON.stringify(over));
	}
	assert.equal(steerable(undefined), false);
});

interface SteerResult {
	ok: boolean;
	error?: { code?: string };
}
const steerSession = (queued: QueueItem[], results: Array<SteerResult | Error> = []) => {
	const calls: Array<[string, { kind: string }]> = [];
	return {
		calls,
		projections: { faceOf: () => ({ getSnapshot: () => ({ "next-turn": queued }) }) },
		updateQueue: async (id: string, action: { kind: "steer" }) => {
			calls.push([id, action]);
			const next = results.length === 0 ? { ok: true } : results.shift();
			if (next instanceof Error) throw next;
			return next as SteerResult;
		},
	};
};

test("steerQueued steers only the user's own rows in FIFO order", async () => {
	const queued = [
		{ id: "u1", source: { kind: "user" } },
		{ id: "b1", source: { kind: "bot" } },
		{ id: "u2", source: { kind: "user" } },
		{ id: "r1", source: { kind: "user-question-reply" } },
		{ id: "u3", source: { kind: "user" } },
	];
	const s = steerSession(queued);
	assert.equal(await steerQueued(s as any), "done");
	assert.deepEqual(s.calls, [
		["u1", { kind: "steer" }],
		["u2", { kind: "steer" }],
		["u3", { kind: "steer" }],
	]);
});

test("steerQueued converges silently on a stale queue or a stopped Agent", async () => {
	for (const code of ["session/steer-unavailable", "session/queue-item-not-found"]) {
		const s = steerSession(
			[
				{ id: "u1", source: { kind: "user" } },
				{ id: "u2", source: { kind: "user" } },
			],
			[{ ok: true }, { ok: false, error: { code } }],
		);
		assert.equal(await steerQueued(s as any), "done", code);
		assert.deepEqual(s.calls, [
			["u1", { kind: "steer" }],
			["u2", { kind: "steer" }],
		]);
	}
});

test("steerQueued reports other failures", async () => {
	const s = steerSession(
		[
			{ id: "u1", source: { kind: "user" } },
			{ id: "u2", source: { kind: "user" } },
		],
		[{ ok: false, error: { code: "session/gone" } }],
	);
	assert.equal(await steerQueued(s as any), "failed");
	assert.deepEqual(s.calls, [["u1", { kind: "steer" }]]);
	const rejecting = steerSession([{ id: "u1", source: { kind: "user" } }], [new Error("offline")]);
	assert.equal(await steerQueued(rejecting as any), "failed");
});

test("steerQueued on an empty or other-source queue calls nothing", async () => {
	for (const queued of [[], [{ id: "b1", source: { kind: "bot" } }]]) {
		const s = steerSession(queued);
		assert.equal(await steerQueued(s as any), "done");
		assert.deepEqual(s.calls, []);
	}
	const empty = {
		projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
		updateQueue: () => assert.fail(),
	};
	assert.equal(await steerQueued(empty as any), "done");
});

// --- side-model ------------------------------------------------------------

test("the /side command and its query match", () => {
	assert.equal(SIDE_SOURCE, "ocean-crew-side");
	assert.equal(SIDE_TOKEN, "/side ");
	assert.deepEqual(parseSideLine("/side what happened"), { args: "what happened", bare: false });
	assert.deepEqual(parseSideLine("  /side\tquestion  "), { args: "question", bare: false });
	assert.deepEqual(parseSideLine("/side"), { args: "", bare: true });
	assert.deepEqual(parseSideLine("/side   "), { args: "", bare: true });
	assert.equal(parseSideLine("/sidechat"), null);
	assert.equal(parseSideLine("/Side hi"), null);
	assert.equal(parseSideLine("hello /side"), null);
	assert.equal(parseSideLine(undefined), null);
	for (const query of ["", "s", "SI", "side ", "side question"])
		assert.equal(sideQueryMatches(query), true, String(query));
	for (const query of ["x", "sidecar"]) assert.equal(sideQueryMatches(query), false, String(query));
});

test("a surface is a Bot, a group, another session, or unknown until the roster loads", () => {
	assert.equal(sideSurface(undefined, "s"), "unknown");
	assert.equal(sideSurface({ ready: false }, "s"), "unknown");
	assert.equal(sideSurface({ ready: true, byId: { s: {} }, roomsById: {} }, "s"), "bot");
	assert.equal(sideSurface({ ready: true, byId: {}, roomsById: { g: {} } }, "g"), "group");
	assert.equal(sideSurface({ ready: true, byId: {}, roomsById: {} }, "x"), "other");
	assert.deepEqual(sideChatsOf({ sideChats: { b1: [{ id: "c1" }] } }, "b1"), [{ id: "c1" }]);
	assert.deepEqual(sideChatsOf({}, "b1"), []);
	assert.deepEqual(sideChatsOf({ sideChats: { b1: "nope" } }, "b1"), []);
});

test("Space claims /side only in a Bot's own chat; Enter adds the refusals", async () => {
	const botRoster = { ready: true, byId: { s: { id: "bot" } }, roomsById: {} };
	const groupRoster = { ready: true, byId: {}, roomsById: { g: { id: "group" } } };
	const otherRoster = { ready: true, byId: {}, roomsById: {} };
	assert.deepEqual(matchSideSpace(botRoster, "s", "/side"), { claim: true });
	assert.equal(matchSideSpace(botRoster, "s", "/sidechat"), undefined);
	assert.equal(matchSideSpace(groupRoster, "g", "/side"), undefined);
	assert.equal(matchSideSpace(undefined, "s", "/side"), undefined);
	assert.equal(matchSideClaim(botRoster, "s", "/side"), true);
	assert.equal(matchSideClaim(groupRoster, "g", "/side"), undefined);

	assert.deepEqual(await matchSideEnter(botRoster, "s", "/side what happened", { attachments: 0 }), { claim: true });
	await assert.rejects(matchSideEnter(groupRoster, "g", "/side what happened", { attachments: 0 }), /private chat/);
	await assert.rejects(matchSideEnter(groupRoster, "g", "/side", { attachments: 2 }), /private chat/);
	await assert.rejects(matchSideEnter(botRoster, "s", "/side", { attachments: 0 }), /Write a question/);
	await assert.rejects(matchSideEnter(botRoster, "s", "/side", { attachments: 1 }), /does not take attachments/);
	await assert.rejects(
		matchSideEnter(botRoster, "s", "/side question", { attachments: 2 }),
		/does not take attachments/,
	);
	// A positively non-Bot session sends /side as a normal message.
	assert.equal(await matchSideEnter(otherRoster, "x", "/side question", { attachments: 0 }), undefined);
	assert.equal(await matchSideEnter(botRoster, "s", "/sidechat", { attachments: 0 }), undefined);
	assert.equal(await matchSideEnter(botRoster, "s", "/btw question", { attachments: 0 }), undefined);
	assert.equal(await matchSideEnter(botRoster, "s", "hello", { attachments: 0 }), undefined);
});

test("a not-ready snapshot refuses; a live source is waited on and can be aborted", async () => {
	const snapshot = { ready: false, byId: {}, roomsById: {} };
	await assert.rejects(matchSideEnter(snapshot, "s", "/side q", { attachments: 0 }), /still loading/);

	const source = createSource({ ready: false, byId: {} as Record<string, unknown>, roomsById: {} });
	const pending = matchSideEnter(source, "s", "/side q", { attachments: 0 });
	source.set({ ready: true, byId: { s: { id: "bot" } }, roomsById: {} });
	assert.deepEqual(await pending, { claim: true });

	const again = createSource({ ready: false, byId: {} as Record<string, unknown>, roomsById: {} });
	const controller = new AbortController();
	const aborted = matchSideEnter(again, "s", "/side q", { attachments: 0 }, controller.signal);
	controller.abort(new Error("user stopped"));
	await assert.rejects(aborted, /user stopped/);
});

test("submitSide refuses groups, files and empty questions, and opens the joined chat", async () => {
	const roster = { ready: true, byId: { s: { id: "bot" } }, roomsById: { g: { id: "group" } } };
	await assert.rejects(
		submitSide({
			call: async () => assert.fail(),
			roster,
			sessionId: "g",
			args: "q",
			attachments: [],
			open: () => {},
		}),
		/private chat/,
	);
	await assert.rejects(
		submitSide({
			call: async () => assert.fail(),
			roster,
			sessionId: "s",
			args: "q",
			attachments: ["a"],
			open: () => {},
		}),
		/does not take attachments/,
	);
	await assert.rejects(
		submitSide({
			call: async () => assert.fail(),
			roster,
			sessionId: "s",
			args: "  ",
			attachments: [],
			open: () => {},
		}),
		/Write a question/,
	);
	const calls: unknown[][] = [];
	const opened: unknown[] = [];
	const result = await submitSide({
		call: async (...args: unknown[]) => {
			calls.push(args);
			return { chatId: "c9" };
		},
		roster,
		sessionId: "s",
		args: "  what now  ",
		attachments: [],
		open: (chatId: unknown) => opened.push(chatId),
	});
	assert.deepEqual(result, { kind: "success" });
	assert.deepEqual(calls, [["side-ask", { sessionId: "s", recent: true, text: "what now" }]]);
	assert.deepEqual(opened, ["c9"]);
});

test("the strip and drawer menu keys follow what the Bot can do", () => {
	assert.equal(panelHasStrip(false, 0, 1), true);
	assert.equal(panelHasStrip(false, 0, 0), false);
	assert.equal(panelHasStrip(true, 0, 0), false);
	assert.equal(panelHasStrip(true, 1, 0), true);
	assert.equal(panelHasStrip(true, 0, 2), true);
	assert.deepEqual(stripMenuKeys({ canBrowse: true, canTerminal: true, canFiles: true }), [
		"new-tab",
		"side",
		"sep",
		"terminal",
		"files",
	]);
	assert.deepEqual(stripMenuKeys({ canBrowse: false, canTerminal: false, canFiles: false }), ["side"]);
	assert.deepEqual(stripMenuKeys({ canBrowse: false, canTerminal: true, canFiles: false }), [
		"side",
		"sep",
		"terminal",
	]);
	assert.deepEqual(drawerMenuKeys({ bot: true, canBrowse: true, canTerminal: true, canFiles: true }), [
		"browser",
		"side",
		"sep",
		"terminal",
		"files",
	]);
	assert.deepEqual(drawerMenuKeys({ bot: true, canBrowse: false, canTerminal: false, canFiles: false }), ["side"]);
	assert.deepEqual(drawerMenuKeys({ bot: false, room: true, canBrowse: false, canTerminal: true, canFiles: true }), [
		"terminal",
		"files",
	]);
	assert.deepEqual(
		drawerMenuKeys({ bot: false, room: true, canBrowse: false, canTerminal: false, canFiles: false }),
		[],
	);
	assert.deepEqual(
		drawerMenuKeys({ bot: false, room: false, canBrowse: false, canTerminal: true, canFiles: true }),
		[],
	);
});

// --- learning-card-model ---------------------------------------------------

const turns = new Map([
	[1, { turn: 1, end: { time: 100 }, status: "closed" }],
	[2, { turn: 2, end: { time: 200 }, status: "closed" }],
	[3, { turn: 3, status: "open" }],
]);

test("a proposal belongs to the latest closed turn ending before its timestamp", () => {
	assert.deepEqual(proposalPlacement({ at: 150 }, turns), { kind: "turn", turn: 1 });
	assert.deepEqual(proposalPlacement({ at: 200 }, turns), { kind: "turn", turn: 2 });
});

test("a proposal without an earlier closed turn falls back to the latest closed turn", () => {
	assert.deepEqual(proposalPlacement({ at: 50 }, turns), { kind: "turn", turn: 2 });
});

test("a proposal uses the dock when there are no closed turns", () => {
	assert.deepEqual(proposalPlacement({ at: 150 }, new Map()), { kind: "dock" });
	assert.deepEqual(proposalPlacement({ at: 150 }, new Map([[3, { turn: 3, status: "open" }]])), { kind: "dock" });
});

test("an answered proposal stays where it was answered and never goes to the dock", () => {
	assert.deepEqual(proposalPlacement({ at: 150, outcome: "approved", settledAt: 900 }, turns), {
		kind: "turn",
		turn: 1,
	});
	// Shown after the latest turn while waiting; answered then, it stays there as later turns end.
	const later = new Map([...turns, [4, { turn: 4, end: { time: 1000 }, status: "closed" }]]);
	assert.deepEqual(proposalPlacement({ at: 50, outcome: "declined", settledAt: 300 }, later), {
		kind: "turn",
		turn: 2,
	});
	assert.deepEqual(proposalPlacement({ at: 50 }, later), { kind: "turn", turn: 4 });
	assert.deepEqual(proposalPlacement({ at: 150, outcome: "approved", settledAt: 160 }, new Map()), { kind: "none" });
});

test("a new skill diff marks every line as added", () => {
	assert.deepEqual(lineDiff("", "a\nb\n"), [
		{ kind: "added", line: "a", number: 1 },
		{ kind: "added", line: "b", number: 2 },
	]);
});

test("a skill update diff keeps unchanged lines and shows removals", () => {
	assert.deepEqual(lineDiff("Check tests\nRequire approval", "Check tests\nRun lint"), [
		{ kind: "same", line: "Check tests", number: 1 },
		{ kind: "removed", line: "Require approval" },
		{ kind: "added", line: "Run lint", number: 2 },
	]);
});

test("a large skill rewrite falls back to a block diff quickly", () => {
	const before = Array.from({ length: 4000 }, (_, index) => `old ${index}`).join("\n");
	const after = Array.from({ length: 4000 }, (_, index) => `new ${index}`).join("\n");
	const started = Date.now();
	const rows = lineDiff(before, after);
	assert.ok(Date.now() - started < 1000);
	assert.equal(rows.length, 8000);
	assert.ok(rows.slice(0, 4000).every((row) => row.kind === "removed"));
	assert.deepEqual(rows[4000], { kind: "added", line: "new 0", number: 1 });
});

test("a skill update keeps a long shared head and tail unchanged", () => {
	const head = Array.from({ length: 3000 }, (_, index) => `head ${index}`);
	const tail = Array.from({ length: 3000 }, (_, index) => `tail ${index}`);
	const rows = lineDiff([...head, "before", ...tail].join("\n"), [...head, "after", ...tail].join("\n"));
	assert.equal(rows.filter((row) => row.kind === "same").length, 6000);
	assert.deepEqual(rows.slice(3000, 3002), [
		{ kind: "removed", line: "before" },
		{ kind: "added", line: "after", number: 3001 },
	]);
	assert.deepEqual(rows.at(-1), { kind: "same", line: "tail 2999", number: 6001 });
});

test("AGENTS.md edit previews keep the blank lines the edit writes", () => {
	assert.deepEqual(editLines("\n"), ["", ""]);
	assert.deepEqual(editLines("Rule\n\n"), ["Rule", "", ""]);
	assert.deepEqual(editLines(undefined), []);
	assert.deepEqual(fileLines("a\nb\n\n"), ["a", "b"]);
	assert.deepEqual(fileLines(""), []);
	assert.deepEqual(fileLines(undefined), []);
});
