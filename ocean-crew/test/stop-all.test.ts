// One stop for the whole team: every turn, every group round, every result still owed. What did
// not stop is reported, and what already went out stays true.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { stopAllOf } from "../src/host/work/stop-all.ts";

function setup() {
	const calls: string[] = [];
	const rt: any = {
		state: {
			rooms: { r1: { id: "r1", name: "Launch" } },
		},
		chatOwners: new Map([
			["s-chief", "chief"],
			["s-dev", "dev"],
		]),
		load: async () => {},
		botOf: (id: string) => ({ id, name: id === "chief" ? "Chief" : "Dev" }),
		chatOf: (id: string) => `s-${id}`,
		roomOf: (id: string) => rt.state.rooms[id],
		stopChat: async (botId: string) => {
			calls.push(`chat:${botId}`);
			return botId !== "dev";
		},
		stopRoomWork: async (roomId: string) => {
			calls.push(`room:${roomId}`);
			return true;
		},
		// Dev's turn could not be cancelled and it is still marked running.
		runningOf: (sessionId: string) => sessionId === "s-dev",
		publishDuties: () => [
			{ id: "d1", state: "pending", name: "Report" },
			{ id: "d2", state: "delivered", name: "Done" },
		],
		abandonDuties: (reason: string) => {
			calls.push(`abandon:${reason}`);
			return 1;
		},
		sideEffectGate: {
			decisionsOf: (sessionId: string) =>
				sessionId === "s-chief"
					? [{ tool: "send_message", target: "bob", effect: "external_send", answer: "allowed" }]
					: [],
		},
	} as unknown as Runtime;
	return { rt, calls };
}

test("a team stop stops every chat and group, and closes what was owed", async () => {
	const { rt, calls } = setup();
	const report = await stopAllOf(rt)();
	assert.deepEqual(report.stopped, ["Chief"]);
	assert.deepEqual(report.rooms, ["Launch"]);
	assert.equal(report.abandoned, 1);
	assert.ok(calls.includes("abandon:the user stopped all the team's work"), "the duty names the reason");
});

test("what could not stop is reported, not swallowed", async () => {
	const { rt } = setup();
	const report = await stopAllOf(rt)();
	assert.deepEqual(
		report.residual.map((entry) => `${entry.owner}: ${entry.reason}`),
		["Dev: its turn could not be cancelled"],
	);
});

test("what already went out is in the report, so a stop is not mistaken for an undo", async () => {
	const { rt } = setup();
	const report = await stopAllOf(rt)();
	assert.deepEqual(
		report.sideEffects.map((entry) => `${entry.tool}:${entry.target}:${entry.answer}`),
		["send_message:bob:allowed"],
	);
});

test("a stop that fails is reported with its error", async () => {
	const { rt } = setup();
	rt.stopRoomWork = async () => {
		throw new Error("the round could not be reached");
	};
	const report = await stopAllOf(rt)();
	assert.match(
		report.residual.map((entry) => entry.reason).join(" · "),
		/stopping it failed: the round could not be reached/,
	);
});

// The lines the user reads after a stop, in both directions: what stopped, what was owed, what
// already went out, and what is still running.
test("the report says what stopped, what is owed, what already happened and what did not stop", async () => {
	const { reportLines } = await import("../src/host/work/stop-all-install.ts");
	const text = (key: string, values?: any): string =>
		`${key}${values === undefined ? "" : ` ${JSON.stringify(values)}`}`;
	const report = {
		stopped: ["Chief"],
		rooms: ["Launch"],
		abandoned: 2,
		sideEffects: [{ tool: "send_message", target: "bob", effect: "external_send", answer: "allowed" }],
		residual: [{ owner: "Dev", label: "Dev", reason: "its turn could not be cancelled" }],
	};
	const lines = reportLines(report as any, text);
	assert.match(lines[0], /Chief、Launch/, "the stopped work is named");
	assert.match(lines[1], /"count":2/, "the owed results are counted");
	assert.match(lines[2], /send_message → bob \(allowed\)/);
	assert.match(lines[3], /"owner":"Dev"/, "the work that survived is named");
	// An empty stop still says something, and says nothing it does not know.
	const quiet = reportLines({ stopped: [], rooms: [], abandoned: 0, sideEffects: [], residual: [] } as any, text);
	assert.deepEqual(quiet, ["Nothing was running"]);
});
