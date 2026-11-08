// The group task card: what a call was asked under, where it stands, what came back and
// whether the user has been told. Pure view over saved state, so the fixtures are state.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cardsOfRoom, tasksViewOf } from "../src/host/groups/tasks.ts";

const room = (extra: Record<string, unknown> = {}): any => ({
	id: "r1",
	name: "Ops",
	members: ["a", "b"],
	admin: "a",
	goal: { id: "g1", revision: 2, objectiveRevision: 3 },
	calls: {},
	callRuns: {},
	...extra,
});

const batch = (extra: Record<string, unknown> = {}): any => ({
	key: "b1",
	roomId: "r1",
	by: "a",
	callees: ["b", "c"],
	pending: [],
	done: ["b"],
	worked: true,
	answered: true,
	state: "open",
	createdAt: 10,
	updatedAt: 20,
	goal: { id: "g1", revision: 1, objectiveRevision: 2 },
	results: [{ botId: "b", name: "Writer", text: "Draft is done", at: 15 }],
	...extra,
});

test("a running call shows the goal it was asked under", () => {
	const [card] = cardsOfRoom(room({ calls: { b1: batch() } }));
	assert.equal(card.status, "running");
	assert.deepEqual(card.goal, { id: "g1", revision: 1, objectiveRevision: 2 });
	// The goal moved on: the card shows both, so a stale answer is visible as stale.
	assert.deepEqual(card.currentGoal, { id: "g1", revision: 2, objectiveRevision: 3 });
	assert.equal(card.delivery, "open");
	assert.equal(card.result, "Draft is done");
	assert.deepEqual(card.members, ["b", "c"]);
});

test("a batch that owes its summary is waiting, and the user has not been told", () => {
	const [card] = cardsOfRoom(
		room({
			calls: {
				b1: batch({ state: "awaiting-summary", done: ["b", "c"], summary: { state: "pending", attempts: 1 } }),
			},
		}),
	);
	assert.equal(card.status, "waiting_summary");
	assert.equal(card.delivery, "pending");
});

test("a delivered batch that answered with part of its members is partial", () => {
	const [card] = cardsOfRoom(
		room({
			calls: {
				b1: batch({
					state: "delivered",
					done: ["b"],
					completedAt: 30,
					summary: { state: "posted", attempts: 1, text: "Only Writer answered" },
				}),
			},
		}),
	);
	assert.equal(card.status, "partial");
	assert.equal(card.delivery, "delivered");
	assert.equal(card.summary, "Only Writer answered");
	assert.equal(card.completedAt, 30);
});

test("a failed batch is failed and its delivery abandoned", () => {
	const [card] = cardsOfRoom(room({ calls: { b1: batch({ state: "failed", error: "the caller never posted" }) } }));
	assert.equal(card.status, "failed");
	assert.equal(card.delivery, "abandoned");
	assert.equal(card.error, "the caller never posted");
});

test("a failed summary is not shown as delivered", () => {
	const [card] = cardsOfRoom(
		room({
			calls: {
				b1: batch({
					state: "delivered",
					done: ["b", "c"],
					summary: { state: "failed", attempts: 2, error: "lost" },
				}),
			},
		}),
	);
	assert.equal(card.delivery, "abandoned");
	assert.equal(card.reason, "lost");
});

test("a relay call cut by a restart reads as stopped, never as done", () => {
	const [card] = cardsOfRoom(
		room({
			callRuns: {
				call1: {
					callId: "call1",
					at: 40,
					state: "running",
					result: { replies: [], passed: ["b"], interrupted: true },
				},
			},
		}),
	);
	assert.equal(card.kind, "relay");
	assert.equal(card.status, "stopped");
	assert.equal(card.delivery, "open");
	assert.match(String(card.reason), /interrupted/);
});

test("a finished relay call is completed and delivered", () => {
	const [card] = cardsOfRoom(
		room({ callRuns: { call1: { callId: "call1", at: 40, state: "done", result: { replies: [], passed: ["b"] } } } }),
	);
	assert.equal(card.status, "completed");
	assert.equal(card.delivery, "delivered");
});

// A group blocked on the user shows up as its own card, not as a note on other work.
test("a group waiting on the user gets a waiting card", () => {
	const fake = {
		state: {
			rooms: { r1: room() },
			questions: { r1: { id: "q1", question: "Which provider?" } },
		},
		sessionOfRoom: () => "g-room",
		chatOf: () => undefined,
		groupOwners: new Map(),
		approvalsView: () => [{ id: "a1", roomId: "r1", reason: "publish the release" }],
	} as any;
	const cards = (tasksViewOf as any)(fake);
	const pending = cards.find((card: any) => card.kind === "pending");
	assert.ok(pending !== undefined, "the waiting card exists");
	assert.equal(pending.status, "waiting_user");
	assert.equal(pending.delivery, "pending");
	assert.equal(pending.result, "Which provider?");
	assert.equal(pending.summary, "2 items are waiting for you");
});

test("a group with nothing waiting has no waiting card", () => {
	const fake = {
		state: { rooms: { r1: room() }, questions: {} },
		sessionOfRoom: () => "g-room",
		chatOf: () => undefined,
		groupOwners: new Map(),
		approvalsView: () => [],
	} as any;
	const cards = (tasksViewOf as any)(fake);
	assert.equal(
		cards.some((card: any) => card.kind === "pending"),
		false,
	);
});

// A result handed up in the group shows its publishing duty and its kept file.
test("a handed-up result shows whether it reached the user, and where it is kept", () => {
	const fake = {
		state: { rooms: { r1: room() }, questions: {} },
		sessionOfRoom: () => "g-room",
		chatOf: () => undefined,
		groupOwners: new Map(),
		approvalsView: () => [],
		publishDuties: () => [
			{ id: "res1", parent: "w1", room: "r1", state: "taken", at: 30, text: "The plan is ready", name: "Plan" },
			{ id: "res2", parent: "w1", room: "r1", state: "abandoned", at: 31, reason: "the answer was dropped" },
			{ id: "res3", parent: "w1", room: "r1", state: "delivered", at: 32 },
		],
		workOf: () => ({ results: [{ id: "res1", name: "Plan", file: "res1.txt", length: 4000 }] }),
	} as any;
	const cards = (tasksViewOf as any)(fake);
	const results = cards.filter((card: any) => card.kind === "result");
	assert.equal(results.length, 2, "a delivered result is not listed again");
	const taken = results.find((card: any) => card.id === "result:res1");
	assert.equal(taken.status, "waiting_delivery");
	assert.equal(taken.delivery, "pending", "taken is not delivered");
	assert.equal(taken.artifacts[0].file, "res1.txt");
	assert.equal(taken.artifacts[0].length, 4000);
	const gone = results.find((card: any) => card.id === "result:res2");
	assert.equal(gone.status, "failed");
	assert.equal(gone.delivery, "abandoned");
	assert.equal(gone.reason, "the answer was dropped");
});
