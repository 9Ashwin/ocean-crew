// Publish duties on hand-off results: a result that a Bot took up still owes the user a
// delivery, the duty survives its work, and GC turns it into an explicit abandoned
// record instead of deleting the fact.

import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { install as installHandoffs } from "../src/host/chat/handoffs.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";

interface TestContext {
	after(fn: () => Promise<void> | void): void;
}

interface TestHost {
	rt: Runtime & Record<string, any>;
	home: string;
	statePath: string;
	dispose(): Promise<void>;
}

const team = (): Record<string, any> => ({
	version: 1,
	mainBotIds: ["a"],
	bots: {
		a: { id: "a", name: "Chief", role: "Boss", createdAt: 1 },
		b: { id: "b", name: "Writer", role: "Write", createdAt: 2 },
		c: { id: "c", name: "Tester", role: "Test", createdAt: 3 },
		d: { id: "d", name: "Editor", role: "Edit", createdAt: 4 },
	},
	rooms: {
		r1: { id: "r1", name: "Ops", members: ["a", "b"], mode: "admin", admin: "a", named: true, sessions: { a: "ga" } },
	},
	agents: {},
	exchanges: [],
	exchangeTurns: {},
	works: {},
	requests: {},
	questions: {},
	views: {},
	prefs: {},
	revision: 0,
});

const LONG = "审查意见。".repeat(1000);

async function boot(t: TestContext, home = fs.mkdtempSync(join(tmpdir(), "ocean-crew-publish-"))): Promise<TestHost> {
	if (t && home !== undefined && !fs.existsSync(join(home, "state.json")))
		fs.writeFileSync(join(home, "state.json"), JSON.stringify(team()));
	const disposers: Array<() => unknown> = [];
	const ctx = {
		logger: { warn: () => {} },
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
	};
	const rt = {
		ctx,
		home,
		statePath: join(home, "state.json"),
		warn: () => {},
		live: new Map(),
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);
	installHandoffs(rt);
	await rt.load();
	let disposed = false;
	return {
		rt,
		home,
		statePath: join(home, "state.json"),
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const dispose of disposers.splice(0).reverse()) await dispose();
		},
	};
}

const saved = (host: TestHost): any => JSON.parse(fs.readFileSync(host.statePath, "utf8"));

test("a closed result owes a publish duty, and taking it is not delivering it", async (t) => {
	const host = await boot(t);
	t.after(() => host.dispose());
	const { rt } = host;
	rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1", fromRoom: "r1" });
	rt.closeWork("w2", "Tester", "two things to fix");
	const pending = rt.publishOf("w2");
	assert.deepEqual(
		[pending?.state, pending?.by, pending?.room, pending?.parent, pending?.text],
		["pending", "b", "r1", "w1", "two things to fix"],
	);
	await rt.save();
	assert.equal(saved(host).publishDuties.w2.state, "pending");

	// The asking Bot read it: the duty is taken, not delivered.
	rt.takenWork("w1", "w2");
	assert.equal(rt.publishOf("w2")?.state, "taken");
	await rt.save();
	assert.equal(saved(host).publishDuties.w2.state, "taken");

	// The line that reaches the group is the delivery.
	assert.equal(rt.deliverWorkInRoom("r1", "c"), 0, "the wrong Bot delivered nothing");
	assert.equal(rt.deliverWorkInRoom("r2", "b"), 0, "the wrong room delivered nothing");
	assert.equal(rt.deliverWorkInRoom("r1", "b"), 1);
	assert.equal(rt.publishOf("w2")?.state, "delivered");
	await rt.save();
	assert.equal(saved(host).publishDuties.w2.state, "delivered");
});

test("a publish duty survives a restart until the group line delivers it", async (t) => {
	const home = fs.mkdtempSync(join(tmpdir(), "ocean-crew-publish-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	const first = await boot(t, home);
	first.rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	first.rt.openWork("w2", { from: "b", to: "c", parent: "w1", room: "r1" });
	first.rt.closeWork("w2", "Tester", "reviewed: one finding");
	await first.rt.save();
	await first.dispose();

	const second = await boot(t, home);
	t.after(() => second.dispose());
	assert.equal(second.rt.publishOf("w2")?.state, "pending");
	assert.equal(second.rt.publishOf("w2")?.text, "reviewed: one finding");
	assert.equal(second.rt.deliverWorkInRoom("r1", "b"), 1);
	assert.equal(second.rt.publishOf("w2")?.state, "delivered");
});

test("one delivered summary settles the results it was built from", async (t) => {
	const host = await boot(t);
	t.after(() => host.dispose());
	const { rt } = host;
	rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1", room: "r1" });
	rt.openWork("w3", { from: "c", to: "d", parent: "w2", room: "r1" });
	rt.closeWork("w3", "Editor", "checked the copy");
	rt.closeWork("w2", "Tester", rt.answerText("w2", "done", "Tester"));
	assert.equal(rt.publishOf("w3")?.state, "pending");
	assert.equal(rt.publishOf("w2")?.state, "pending");
	// The answer carrying both results is delivered once; the child duty settles with it.
	rt.takenWork("w1", "w2");
	assert.equal(rt.publishOf("w2")?.state, "taken");
	assert.equal(rt.deliverWork("w2"), true);
	assert.equal(rt.publishOf("w2")?.state, "delivered");
	assert.equal(rt.publishOf("w3")?.state, "delivered");
});

test("dropping a work leaves an abandoned duty instead of forgetting the result", async (t) => {
	const host = await boot(t);
	t.after(() => host.dispose());
	const { rt } = host;
	rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1", room: "r1" });
	rt.closeWork("w2", "Tester", "reviewed: two findings");
	assert.equal(rt.publishOf("w2")?.state, "pending");
	rt.dropWork("w1");
	const duty = rt.publishOf("w2");
	assert.equal(duty?.state, "abandoned");
	assert.match(String(duty?.reason), /dropped before/);
	assert.equal(duty?.text, "reviewed: two findings");
	await rt.save();
	assert.equal(saved(host).publishDuties.w2.state, "abandoned");
	assert.match(String(saved(host).publishDuties.w2.reason), /dropped before/);
});

test("a top-level result keeps a duty after its work record is closed", async (t) => {
	const host = await boot(t);
	t.after(() => host.dispose());
	const { rt } = host;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.closeWork("w1", "Writer", "all done");
	assert.equal((rt.state as any).works.w1, undefined);
	const duty = rt.publishOf("w1");
	assert.equal(duty?.state, "pending");
	assert.equal(duty?.by, "a");
	assert.equal(duty?.room, undefined);
	// Nothing has shown it to the user yet; taking it by a parent is not a delivery.
	assert.equal(rt.deliverWork("w1"), true);
	assert.equal(rt.publishOf("w1")?.state, "delivered");
});

test("a long result's publish duty keeps only the head state.json would keep", async (t) => {
	const host = await boot(t);
	t.after(() => host.dispose());
	host.rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	host.rt.closeWork("w1", "Writer", LONG);
	const duty = host.rt.publishOf("w1");
	assert.equal(duty?.text?.length, 2000);
	assert.equal(duty?.text, LONG.slice(0, 2000));
});

test("a work id replayed by a turn opens once, not a duplicate hand-off", async (t) => {
	const host = await boot(t);
	t.after(() => host.dispose());
	const { rt } = host;
	rt.openWork("w1", { from: "a", to: "b", room: "r1" });
	rt.openWork("w1", { from: "b", to: "c", room: "r1" });
	const work = (rt.state as any).works.w1;
	assert.equal(work.from, "a");
	assert.equal(work.to, "b");
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	rt.openWork("w2", { from: "a", to: "d", parent: "w1" });
	assert.deepEqual((rt.state as any).works.w1.open, ["w2"]);
	assert.equal((rt.state as any).works.w2.to, "c");
});
