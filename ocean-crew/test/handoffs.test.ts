// Hand-off behaviour: the work identity tree, the results that climb it, the long results
// kept whole in their own files, and the views other modules read. The assertions port the

// ownership, waiting views) without its turns engine: this module is driven directly.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
	warnings: unknown[][];
	dispose(): Promise<void>;
}

// Four Bots and one group, so a case can name a plausible team. `a` is in the group.
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

// A result long enough that state.json would cut it: 5,000 characters.
const LONG = "审查意见。".repeat(1000);

const tempHome = (t: TestContext): string => {
	const home = fs.mkdtempSync(join(tmpdir(), "ocean-crew-handoffs-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};

// The plugin in a home of its own, over the real store. A second boot over the same home
// is a restart; the live-turn map the views read is a plain map until turns lands.
async function boot(home: string, seeded?: unknown): Promise<TestHost> {
	const statePath = join(home, "state.json");
	if (seeded !== undefined) fs.writeFileSync(statePath, JSON.stringify(seeded));
	const warnings: unknown[][] = [];
	const disposers: Array<() => unknown> = [];
	const ctx = {
		logger: { warn: (...args: unknown[]) => warnings.push(args) },
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
	};
	const rt = {
		ctx,
		home,
		statePath,
		warn: (...args: unknown[]) => warnings.push(args),
		live: new Map(),
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);
	installHandoffs(rt);
	await rt.load();
	let disposed = false;
	const host: TestHost = {
		rt,
		home,
		statePath,
		warnings,
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const dispose of disposers.splice(0).reverse()) await dispose();
		},
	};
	return host;
}

const saved = (host: TestHost): any => JSON.parse(fs.readFileSync(host.statePath, "utf8"));
const worksOf = (host: TestHost): Record<string, any> => host.rt.state.works as unknown as Record<string, any>;
const savedWorks = (host: TestHost): Record<string, any> => saved(host).works ?? {};
const keptIn = (home: string): string[] =>
	fs.existsSync(join(home, "handoff-results")) ? fs.readdirSync(join(home, "handoff-results")).sort() : [];

const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the expected files");
		await delay(5);
	}
};

test("workOf: a request answers its exchange, a reply goes on with its work", async (t) => {
	const host = await boot(tempHome(t), team());
	const { workOf } = host.rt;
	assert.equal(workOf(undefined), undefined);
	assert.equal(workOf({}), undefined);
	assert.equal(workOf({ role: "request", exchangeId: "x1" }), "x1");
	// A request that answers the user is not a work the answer goes on with.
	assert.equal(workOf({ role: "request", audience: "user", exchangeId: "x1", work: "w0" }), "w0");
	assert.equal(workOf({ role: "reply", work: "w0" }), "w0");
	assert.equal(workOf({ role: "resume" }), undefined);
});

test("a handed-on work opens under its parent and its answer joins the parent's results", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1", fromRoom: "r1" });
	assert.deepEqual(worksOf(host).w1.open, ["w2"]);
	assert.equal(worksOf(host).w2.parent, "w1");
	assert.equal(worksOf(host).w2.fromRoom, "r1");
	assert.deepEqual(worksOf(host).w1.results, []);
	assert.equal(typeof worksOf(host).w1.at, "number");
	// The tree reaches the team file.
	await rt.save();
	assert.deepEqual(savedWorks(host).w1.open, ["w2"]);
	assert.equal(savedWorks(host).w2.parent, "w1");
	// The colleague's answer climbs one step: it joins the parent's results, and the
	// parent keeps waiting until a turn reads it.
	assert.equal(rt.closeWork("w2", "Tester", "two things to fix"), "w1");
	assert.equal(worksOf(host).w2, undefined);
	assert.deepEqual(worksOf(host).w1.open, ["w2"]);
	const result = worksOf(host).w1.results[0];
	assert.equal(result.id, "w2");
	assert.equal(result.name, "Tester");
	assert.equal(result.text, "two things to fix");
	assert.equal(result.length, undefined);
	assert.equal(result.file, undefined);
	assert.equal(typeof result.at, "number");
	// Reading the answer ends the wait; a second read changes nothing.
	rt.takenWork("w1", "w2");
	assert.deepEqual(worksOf(host).w1.open, []);
	rt.takenWork("w1", "w2");
	assert.deepEqual(worksOf(host).w1.open, []);
	rt.takenWork("missing", "w2");
	// Closing the last work of the chain keeps nothing back.
	assert.equal(rt.closeWork("w1", "Writer", "all done"), undefined);
	assert.equal(worksOf(host).w1, undefined);
});

test("a short result stays in the team file and gets no file of its own", async (t) => {
	const home = tempHome(t);
	const host = await boot(home, team());
	host.rt.openWork("w1", { from: "a", to: "b" });
	host.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	host.rt.closeWork("w2", "Tester", "two things to fix");
	await host.rt.save();
	const result = savedWorks(host).w1.results[0];
	assert.equal(result.text, "two things to fix");
	assert.equal(result.length, undefined);
	assert.deepEqual(keptIn(home), []);
});

test("a long result is kept whole in its own file and survives a restart", async (t) => {
	const home = tempHome(t);
	const first = await boot(home, team());
	first.rt.openWork("w1", { from: "a", to: "b" });
	first.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	first.rt.closeWork("w2", "Tester", LONG);
	await first.rt.save();
	const result = savedWorks(first).w1.results[0];
	assert.equal(result.text.length, 2000);
	assert.equal(result.length, LONG.length);
	assert.equal(result.file, "w2.txt");
	assert.deepEqual(keptIn(home), ["w2.txt"]);
	assert.equal(fs.readFileSync(join(home, "handoff-results", "w2.txt"), "utf8"), LONG);
	assert.ok(first.rt.answerText("w1", "", "Writer").includes(LONG));
	// A restart before the asking Bot answers still has the whole result.
	await first.dispose();
	const second = await boot(home);
	assert.equal(worksOf(second).w1.results[0].file, "w2.txt");
	assert.ok(second.rt.answerText("w1", "", "Writer").includes(LONG));
	assert.ok(!second.rt.answerText("w1", "", "Writer").includes("the rest was not kept"));
});

test("a result inside a result survives a restart too", async (t) => {
	const home = tempHome(t);
	const first = await boot(home, team());
	first.rt.openWork("w1", { from: "a", to: "b" });
	first.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	first.rt.openWork("w3", { from: "c", to: "d", parent: "w2" });
	first.rt.closeWork("w3", "Editor", LONG);
	// The Tester answers with what came back inside it, so the whole long result climbs.
	first.rt.closeWork("w2", "Tester", first.rt.answerText("w2", "the review is done", "Tester"));
	await first.rt.save();
	// The old copy goes once the replacement state, which names the composed answer, is saved.
	await waitFor(() => keptIn(home).length === 1);
	assert.deepEqual(keptIn(home), ["w2.txt"]);
	const savedW2 = savedWorks(first).w1.results[0];
	assert.equal(savedW2.id, "w2");
	assert.equal(savedW2.text.length, 2000);
	assert.equal(typeof savedW2.length, "number");
	assert.equal(savedW2.file, "w2.txt");
	// After a restart the composed result still goes up in full.
	await first.dispose();
	const second = await boot(home);
	const answer = second.rt.answerText("w1", "", "Writer");
	assert.ok(answer.includes("the review is done"));
	assert.ok(answer.includes(LONG));
	assert.ok(!answer.includes("the rest was not kept"));
	// Reading the answer and closing the work frees its copy.
	second.rt.takenWork("w1", "w2");
	second.rt.closeWork("w1", "Writer", "all done");
	await waitFor(() => keptIn(home).length === 0);
	assert.deepEqual(keptIn(home), []);
});

test("a result whose file is gone is reported, not passed on as if it were whole", async (t) => {
	const home = tempHome(t);
	const first = await boot(home, team());
	first.rt.openWork("w1", { from: "a", to: "b" });
	first.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	first.rt.closeWork("w2", "Tester", LONG);
	await first.rt.save();
	fs.rmSync(join(home, "handoff-results"), { recursive: true, force: true });
	await first.dispose();
	const second = await boot(home);
	const answer = second.rt.answerText("w1", "", "Writer");
	assert.ok(answer.includes(LONG.slice(0, 2000)));
	assert.ok(!answer.includes(LONG));
	assert.match(answer, /\[cut; 5000 characters in all, the rest was not kept\]/);
});

test("a result file that was cut short is reported as well", async (t) => {
	const home = tempHome(t);
	const first = await boot(home, team());
	first.rt.openWork("w1", { from: "a", to: "b" });
	first.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	first.rt.closeWork("w2", "Tester", LONG);
	await first.rt.save();
	fs.writeFileSync(join(home, "handoff-results", "w2.txt"), LONG.slice(0, 100), "utf8");
	await first.dispose();
	const second = await boot(home);
	const answer = second.rt.answerText("w1", "", "Writer");
	assert.ok(!answer.includes(LONG));
	assert.ok(answer.includes(LONG.slice(0, 100)));
	assert.match(answer, /\[cut; 5000 characters in all, the rest was not kept\]/);
});

test("a result that could not be written is not claimed, and is reported after a restart", async (t) => {
	const home = tempHome(t);
	// A file where the folder of the results should be: the write cannot succeed.
	fs.writeFileSync(join(home, "handoff-results"), "not a folder", "utf8");
	const first = await boot(home, team());
	first.rt.openWork("w1", { from: "a", to: "b" });
	first.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	first.rt.closeWork("w2", "Tester", LONG);
	await first.rt.save();
	const result = savedWorks(first).w1.results[0];
	assert.equal(result.length, LONG.length);
	assert.equal(result.file, undefined);
	assert.ok(first.warnings.some((args) => /not kept whole/.test(String(args))));
	await first.dispose();
	const second = await boot(home);
	const answer = second.rt.answerText("w1", "", "Writer");
	assert.ok(!answer.includes(LONG));
	assert.match(answer, /\[cut; 5000 characters in all, the rest was not kept\]/);
});

test("an unsafe work id keeps its result inside the results folder, under a hashed name", async (t) => {
	const home = tempHome(t);
	const host = await boot(home, team());
	host.rt.openWork("w/1", { from: "a", to: "b" });
	host.rt.openWork("w/1/child", { from: "b", to: "c", parent: "w/1" });
	host.rt.closeWork("w/1/child", "Tester", LONG);
	await host.rt.save();
	const result = savedWorks(host)["w/1"].results[0];
	assert.match(result.file, /^[0-9a-f]{64}\.txt$/);
	assert.deepEqual(keptIn(home), [result.file]);
	assert.equal(fs.readFileSync(join(home, "handoff-results", result.file), "utf8"), LONG);
	assert.ok(host.rt.answerText("w/1", "", "Writer").includes(LONG));
});

test("answerText: what the Bot said last, then what came back", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	// Without a result the answer is what the Bot said, or a fixed line when it said nothing.
	assert.equal(rt.answerText("w1", "fixed both", "Writer"), "fixed both");
	assert.equal(rt.answerText("w1", "", "Writer"), "Writer finished without a reply.");
	// What the Bot said last for the work is held even when its closing reply is empty.
	rt.holdWork("w1", "kept words");
	assert.equal(rt.answerText("w1", "", "Writer"), "kept words");
	// A held text is cut to what state.json keeps.
	rt.holdWork("w1", "x".repeat(2500));
	assert.equal(worksOf(host).w1.held.length, 2000);
	// Once a result came back, the answer says what came back, after the Bot's own words.
	rt.holdWork("w1", "kept words");
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	rt.closeWork("w2", "Tester", "two things to fix");
	assert.equal(
		rt.answerText("w1", "fixed both", "Writer"),
		"fixed both\n\n[Handed back to Writer for this work]\n\nTester:\ntwo things to fix",
	);
	assert.equal(
		rt.answerText("w1", "", "Writer"),
		"kept words\n\n[Handed back to Writer for this work]\n\nTester:\ntwo things to fix",
	);
	// A result whose reply never reached the asker is named as such.
	rt.answerMissed("w2");
	assert.equal(worksOf(host).w1.results[0].failed, true);
	assert.equal(
		rt.answerText("w1", "", "Writer"),
		"kept words\n\n[Handed back to Writer for this work]\n\nTester could not send its reply to you; what it had answered:\ntwo things to fix",
	);
	// A request the restart delayed says so.
	rt.lateWork("w1");
	assert.match(
		rt.answerText("w1", "", "Writer"),
		/^\[This request reached Writer only after DeepSeek Harness restarted\.\]\n\n/,
	);
});

test("upstreamOf names every Bot waiting, on up, and stops at a cycle", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	rt.openWork("w3", { from: "c", to: "d", parent: "w2" });
	assert.deepEqual([...rt.upstreamOf(["w3"])].sort(), ["a", "b", "c"]);
	assert.deepEqual([...rt.upstreamOf(["w3", "w1"])].sort(), ["a", "b", "c"]);
	assert.deepEqual([...rt.upstreamOf([])], []);
	assert.deepEqual([...rt.upstreamOf(["missing"])], []);
	// A hand-edited team can carry a loop; the walk must still end.
	worksOf(host).w1.parent = "w3";
	assert.deepEqual([...rt.upstreamOf(["w3"])].sort(), ["a", "b", "c"]);
});

test("sameWork: two requests belong to the same work when they were sent for it", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	rt.openWork("stray", { from: "c", to: "d" });
	assert.equal(rt.sameWork("w2", "w1"), true);
	assert.equal(rt.sameWork("stray", "w1"), false);
	// A request sent for no work at all and another one too belong together.
	assert.equal(rt.sameWork("stray", undefined), true);
	assert.equal(rt.sameWork(undefined, undefined), true);
	assert.equal(rt.sameWork(undefined, "w1"), false);
});

test("ownsWork and waitsWork answer for the Bot that does the work and its waiters", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	assert.equal(rt.ownsWork("b", "w1"), true);
	assert.equal(rt.ownsWork("a", "w1"), false);
	assert.equal(rt.ownsWork("b", undefined), false);
	assert.equal(rt.ownsWork("b", "missing"), false);
	assert.equal(rt.waitsWork("w1"), false);
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	assert.equal(rt.waitsWork("w1"), true);
	assert.equal(rt.waitsWork(undefined), false);
	assert.equal(rt.waitsWork("missing"), false);
	rt.takenWork("w1", "w2");
	assert.equal(rt.waitsWork("w1"), false);
});

test("workAsker describes the Bot that asked for the work", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1", fromRoom: "r1" });
	assert.deepEqual(rt.workAsker("w1"), {
		kind: "bot",
		role: "request",
		exchangeId: "w1",
		senderSessionId: "a",
	});
	assert.deepEqual(rt.workAsker("w2"), {
		kind: "bot",
		role: "request",
		exchangeId: "w2",
		senderSessionId: "b",
		senderRoomId: "r1",
	});
	assert.equal(rt.workAsker("missing"), undefined);
	assert.equal(rt.workAsker(undefined), undefined);
});

test("dropping a work forgets it and stops its parent waiting on it", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	rt.openWork("w3", { from: "b", to: "d", parent: "w1" });
	assert.deepEqual(worksOf(host).w1.open, ["w2", "w3"]);
	rt.dropWork("w2");
	assert.equal(worksOf(host).w2, undefined);
	assert.deepEqual(worksOf(host).w1.open, ["w3"]);
	await rt.save();
	assert.deepEqual(savedWorks(host).w1.open, ["w3"]);
	rt.dropWork("w2");
	rt.dropWork("missing");
});

test("a deleted Bot answers no more work, and its waiters are told", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	// Chief waits on Writer, Writer waits on Tester, and Writer handed work to itself.
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c" });
	rt.openWork("w3", { from: "b", to: "b" });
	const waiting = rt.forgetBotWork("b");
	assert.deepEqual(waiting, [
		{ kind: "bot", role: "request", exchangeId: "w1", senderSessionId: "a" },
		{ kind: "bot", role: "request", exchangeId: "w3", senderSessionId: "b" },
	]);
	// The works aimed at the deleted Bot stay, so their askers can be told; writes by the
	// deleted Bot are dropped, except a work it handed to itself.
	assert.equal(worksOf(host).w1 !== undefined, true);
	assert.equal(worksOf(host).w2, undefined);
	assert.equal(worksOf(host).w3 !== undefined, true);
	// The work aimed at the deleted Bot is still there, so asking again names it again.
	assert.deepEqual(rt.forgetBotWork("b"), waiting);
});

test("statusOf says what a Bot is doing for the Bots that work with it", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	// Idle, with a card waiting in its own chat.
	assert.equal(rt.statusOf("a"), "idle");
	// Questions are keyed by the asking Session in the saved team.
	host.rt.state.questions.a = { id: "q1", question: "?", askedAt: Date.now() };
	assert.equal(rt.statusOf("a"), "idle; a question card in its own chat waits for the user's answer");
	// A turn from the user, with a tool running.
	rt.doingOf = () => ({ tool: "bash", target: "repo" });
	host.rt.live.set("a", { turn: 1, since: Date.now() });
	assert.equal(
		rt.statusOf("a"),
		"working in its own chat for less than a minute, for the user: running bash on repo; a question card in its own chat waits for the user's answer",
	);
	// A turn in a group Session names the group and the Bot the work is for.
	rt.doingOf = () => ({ said: "checking" });
	host.rt.live.set("ga", { turn: 1, since: Date.now(), info: { askedBy: "b" } });
	assert.match(rt.statusOf("a"), /working in group "Ops" for less than a minute, for Writer: "checking"/);
	host.rt.live.clear();
	delete host.rt.state.questions.a;
	// Waiting for a colleague to hand back what it handed on.
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	assert.equal(rt.statusOf("b"), "waiting for Tester to hand back work, for Chief");
	// A turn of this Bot doing that work itself is "working", not "waiting".
	rt.live.set("b", { turn: 1, info: { work: "w1" } });
	assert.doesNotMatch(rt.statusOf("b"), /waiting for/);
});

test("waitingView lists what each Bot waits for, unless its own turn is on it", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	rt.openWork("g1", { from: "b", to: "c", parent: "w1", room: "r1" });
	assert.deepEqual(rt.waitingView(), {
		b: { bots: ["c"], rooms: ["r1"], for: ["a"] },
	});
	// A Bot whose own turn does the work is not "waiting" for the result.
	rt.live.set("turn-b", { turn: 1, info: { work: "w1" } });
	assert.deepEqual(rt.waitingView(), {});
});

test("a subagent run hangs under the work it was delegated from", async (t) => {
	const host = await boot(tempHome(t), team());
	const rt = host.rt;
	rt.openWork("w1", { from: "a", to: "b" });
	rt.openWork("run1", { from: "b", parent: "w1", name: "subagent", child: "sub1" });
	assert.deepEqual(worksOf(host).w1.open, ["run1"]);
	// The tool result names the run after it started.
	rt.nameSubWork("sub1", "deep review");
	assert.equal(worksOf(host).run1.name, "deep review");
	// While the run is out, the notice finds it by the child's id.
	assert.deepEqual(rt.subWorkRun("sub1"), { id: "run1", parent: "w1" });
	// Its closing text joins the work it was delegated from, named as the child's run.
	assert.equal(rt.settleSubWork("run1", "reviewed: three findings", "sub1"), "w1");
	const result = worksOf(host).w1.results[0];
	assert.equal(result.child, "sub1");
	assert.equal(result.name, "deep review");
	assert.equal(result.text, "reviewed: three findings");
	assert.deepEqual(rt.subWorkRun("sub1"), { id: "run1", parent: "w1", at: result.at });
});

test("closing work keeps result files until the state that stops naming them is saved", async (t) => {
	const home = tempHome(t);
	const host = await boot(home, team());
	host.rt.openWork("w1", { from: "a", to: "b" });
	host.rt.openWork("w2", { from: "b", to: "c", parent: "w1" });
	host.rt.closeWork("w2", "Tester", LONG);
	await host.rt.save();
	assert.deepEqual(keptIn(home), ["w2.txt"]);
	// A save that fails must leave the result available to the next host.
	const store = host.rt.save;
	host.rt.save = async () => {
		throw new Error("disk full");
	};
	host.rt.closeWork("w1", "Writer", LONG);
	await delay(20);
	assert.deepEqual(keptIn(home), ["w2.txt"]);
	host.rt.save = store;
	await host.dispose();
	// A restarted host still answers with the whole result its old state named.
	const restarted = await boot(home);
	assert.match(restarted.rt.answerText("w1", "", "Writer"), /Tester:\n审查意见。/);
	// Once the replacement state is saved, the copy is not needed any more.
	restarted.rt.dropWork("w1");
	await waitFor(() => keptIn(home).length === 0);
	assert.deepEqual(keptIn(home), []);
});
