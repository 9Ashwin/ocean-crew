// The background view: what the team is doing, and the two shapes of stuck. A loop is recognised
// from repeated identical calls, and a quiet run from time without progress; each is announced
// once, not every time the window asks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundOf, IDLE_MS, REPEAT_LIMIT } from "../src/host/work/background.ts";

let clock = 1_000_000;
const now = () => clock;

const make = () =>
	backgroundOf({
		now,
		ownerOf: (sessionId) => (sessionId === "s1" ? "Dev" : undefined),
		isTeamSession: (sessionId) => sessionId === "s1",
		doingOf: (sessionId) => (sessionId === "s1" ? { tool: "bash", since: clock - 5_000 } : undefined),
		workOf: (sessionId) => (sessionId === "s1" ? { id: "w1", held: "checking the build" } : undefined),
	});

test("a session is listed with what it is doing and what for", () => {
	const background = make();
	background.noteTurn("s1", true);
	background.noteCall("s1", "bash", { cmd: "npm test" });
	const view = background.view();
	assert.equal(view.entries.length, 1);
	assert.equal(view.entries[0].owner, "Dev");
	assert.equal(view.entries[0].doing, "bash");
	assert.equal(view.entries[0].forWork, "w1");
	assert.equal(view.entries[0].held, "checking the build");
	assert.equal(view.entries[0].stuck, undefined);
});

test("the same call over and over is a loop, reported once", () => {
	const background = make();
	background.noteTurn("s1", true);
	for (let index = 0; index < REPEAT_LIMIT; index += 1) background.noteCall("s1", "bash", { cmd: "npm test" });
	assert.equal(background.view().entries[0].stuck, "repeating");
	assert.match(String(background.view().entries[0].stuckWhy), /npm test|bash/);
	assert.equal(background.takeAnnouncements().length, 1);
	assert.equal(background.takeAnnouncements().length, 0, "the same loop is not announced again");
});

test("a different argument is not a loop", () => {
	const background = make();
	background.noteTurn("s1", true);
	for (let index = 0; index < REPEAT_LIMIT; index += 1) background.noteCall("s1", "bash", { cmd: `test ${index}` });
	assert.equal(background.view().entries[0].stuck, undefined);
});

test("a run with no progress reads as quiet, and a result clears it", () => {
	const background = make();
	background.noteTurn("s1", true);
	clock += IDLE_MS + 1;
	assert.equal(background.view().entries[0].stuck, "quiet");
	background.noteProgress("s1");
	assert.equal(background.view().entries[0].stuck, undefined);
});

test("a new turn starts its own evidence", () => {
	const background = make();
	background.noteTurn("s1", true);
	for (let index = 0; index < REPEAT_LIMIT; index += 1) background.noteCall("s1", "bash", { cmd: "x" });
	assert.equal(background.view().entries[0].stuck, "repeating");
	background.noteTurn("s1", true);
	assert.equal(background.view().entries[0].stuck, undefined, "the last turn's calls are not this turn's loop");
});

test("a session the team does not own is ignored", () => {
	const background = make();
	background.noteCall("other", "bash", {});
	assert.deepEqual(background.view().entries, []);
});
