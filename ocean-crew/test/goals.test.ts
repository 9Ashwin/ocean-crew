// Group goals: the validation contract, the state machine (start, pass, revise, rework,
// complete, pause, resume, stop), the user's goal endpoints, the idle driver, and the

// objective revision; optional tasks need an explicit waiver; an older result never
// passes a revised plan). Roster- and group-engine-free: the group round world is a
// stub, so the assertions exercise the goal module itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOAL_IDLE_NUDGES } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import {
	archiveGoal,
	completeGoal,
	draftGoal,
	goalBudget,
	install,
	markTasks,
	passGoal,
	pauseGoal,
	resumeGoal,
	reviseGoal,
	reworkGoal,
	startGoal,
	stopGoal,
	TASK_LABEL,
	taskGoal,
	touchGoal,
} from "../src/host/work/goals.ts";

type R = Runtime & Record<string, any>;

interface GoalTest {
	rt: R;
	state: any;
	room: any;
	bots: Record<string, any>;
	rooms: Record<string, any>;
	posts: Array<{ sessionId: string; message: any }>;
	log: any[];
	messages: any[];
	stopped: any[];
	saves: () => number;
	tool: (args: Record<string, unknown>, agentId?: string) => Promise<string>;
	roomOf: (id?: string) => any;
	botOf: (id?: string) => any;
}

const GOAL_STAGES = [
	{ title: "Draft", acceptance: "draft reviewed", tasks: [{ bot: "Writer", task: "write the draft" }] },
	{ title: "Check", acceptance: "checks pass", tasks: [{ bot: "Tester", task: "run the checks" }] },
];

function seed(roomPatch: Record<string, unknown> = {}, extraRooms: Record<string, unknown> = {}) {
	const bots: Record<string, any> = {
		a: { id: "a", name: "Chief", role: "Boss", sessionId: "a", createdAt: 1, instructions: "", capabilities: [] },
		b: { id: "b", name: "Writer", role: "Write", sessionId: "b", createdAt: 2, instructions: "", capabilities: [] },
		c: { id: "c", name: "Tester", role: "Test", sessionId: "c", createdAt: 3, instructions: "", capabilities: [] },
	};
	const rooms: Record<string, any> = {
		r1: {
			id: "r1",
			name: "Ops",
			members: ["a", "b", "c"],
			mode: "admin",
			admin: "a",
			named: true,
			log: [],
			seq: 0,
			seen: {},
			...roomPatch,
		},
		...extraRooms,
	};
	return { bots, rooms };
}

function runtime(
	t: { after(fn: () => void | Promise<void>): void },
	options: { room?: Record<string, unknown>; extraRooms?: Record<string, unknown> } = {},
): GoalTest {
	const { bots, rooms } = seed(options.room, options.extraRooms);
	const state: any = {
		version: 1,
		mainBotIds: ["a"],
		bots,
		rooms,
		agents: {},
		exchanges: [],
		exchangeTurns: {},
		questions: {},
		views: {},
		closedCards: {},
		prefs: {},
		switching: {},
		capabilities: { items: {} },
		revision: 0,
	};
	const posts: GoalTest["posts"] = [];
	const log: any[] = [];
	const messages: any[] = [];
	const stopped: any[] = [];
	let saves = 0;
	const groupOwners = new Map<string, { botId: string; roomId: string }>([
		["ga", { botId: "a", roomId: "r1" }],
		["gb", { botId: "b", roomId: "r1" }],
		["gc", { botId: "c", roomId: "r1" }],
	]);
	const chatOwners = new Map([
		["a", "a"],
		["b", "b"],
		["c", "c"],
	]);
	const findBot = (ref: unknown): any => {
		const text = String(ref ?? "")
			.trim()
			.toLowerCase();
		return Object.values(bots).find((bot) => bot.id === String(ref) || String(bot.name).toLowerCase() === text);
	};
	const rt = {
		state,
		config: {},
		ctx: { sessions: { flush: async () => {} } } as unknown as Runtime["ctx"],
		warn: () => {},
		botOf: (id?: string) => (id === undefined ? undefined : bots[id]),
		roomOf: (id?: string) => (id === undefined ? undefined : rooms[id]),
		findBot,
		isMain: (id?: string) => id === "a",
		isAdminOf: (room: any, id?: string) => room?.admin === id,
		selfOf: (sessionId?: string) =>
			sessionId === undefined
				? undefined
				: (groupOwners.get(sessionId)?.botId ?? (chatOwners.has(sessionId) ? sessionId : undefined)),
		chatOf: (botId: string) => bots[botId]?.sessionId ?? botId,
		sessionOfRoom: (room: any) => room?.sessionId ?? room?.id,
		groupOwners,
		chatOwners,
		roomProgress: new Map(),
		roomInbox: new Map(),
		workingInRoom: () => [],
		roomBatchPending: () => false,
		logRoom: (_room: any, line: any) => log.push(line),
		resolveAgent: async (sessionId: string) => ({
			session: { id: sessionId },
			followup: (message: any) => posts.push({ sessionId, message }),
		}),
		pickRoom: (ref: unknown, _self?: string) => {
			const wanted = String(ref ?? "").trim();
			const room = Object.values(rooms).find((entry: any) => entry.id === wanted || entry.name === wanted);
			if (room === undefined) return { error: `No group chat named ${wanted}.` };
			return { room };
		},
		stopMemberWork: async (roomId: string, botId: string) => {
			stopped.push(["member", roomId, botId]);
			return true;
		},
		stopRoomWork: async (roomId: string) => {
			stopped.push(["room", roomId]);
			return true;
		},
		save: async () => {
			saves += 1;
		},
		load: async () => {},
		readOnly: () => undefined,
		teamTools: [],
		uiLanguage: () => undefined,
	} as unknown as R;
	install(rt as Runtime);
	t.after(() => {});
	return {
		rt,
		state,
		room: rooms.r1,
		bots,
		rooms,
		posts,
		log,
		messages,
		stopped,
		saves: () => saves,
		tool: async (args, agentId = "ga") => {
			const tool = (rt.teamTools as any[]).find((entry) => entry.name === "group_goal");
			return tool.execute(args, { agent: { id: agentId } });
		},
		roomOf: (id?: string) => (id === undefined ? rooms.r1 : rooms[id]),
		botOf: (id?: string) => (id === undefined ? undefined : bots[id]),
	};
}

const report = async (test: GoalTest, bot: string, evidence = "done") => {
	await test.tool({ action: "task", bot, status: "reported", evidence }, "ga");
};

test("group_goal start validates the goal with the contract refusals", async (t) => {
	const host = runtime(t);
	const run = (args: Record<string, unknown>) => host.tool(args);
	assert.equal(
		await run({ action: "start", acceptance: "ok", stages: GOAL_STAGES }),
		"objective is required for start.",
	);
	assert.equal(
		await run({ action: "start", objective: "o", stages: GOAL_STAGES }),
		"acceptance is required for start.",
	);
	assert.equal(await run({ action: "start", objective: "o", acceptance: "a" }), "stages is required for start.");
	assert.equal(
		await run({
			action: "start",
			objective: "o",
			acceptance: "a",
			stages: [{ acceptance: "x", tasks: [{ bot: "Writer", task: "t" }] }],
		}),
		"stage 1 title is required for start.",
	);
	assert.equal(
		await run({
			action: "start",
			objective: "o",
			acceptance: "a",
			stages: [{ title: "S", acceptance: "x", tasks: [{ bot: "Nobody", task: "t" }] }],
		}),
		'Nobody is not a member of "Ops". Members: Chief, Writer, Tester.',
	);
	const many = {
		title: "S",
		acceptance: "x",
		tasks: Array.from({ length: 13 }, (_, i) => ({ bot: "Writer", task: `t${i}` })),
	};
	assert.equal(
		await run({ action: "start", objective: "o", acceptance: "a", stages: [many] }),
		"At most 12 tasks in stage 1.",
	);
	assert.equal(host.room.goal, undefined);
});

test("a goal starts, passes its stages only once each task reported, and completes", async (t) => {
	const host = runtime(t);
	assert.match(
		await host.tool({
			action: "start",
			title: "Ship it",
			objective: "Ship the thing",
			acceptance: "it is shipped",
			stages: GOAL_STAGES,
		}),
		/Started\. Hand out the tasks of stage 1 now/,
	);
	const started = host.room.goal;
	assert.deepEqual([started.status, started.current, started.objectiveRevision], ["active", 0, 1]);
	assert.deepEqual(
		started.stages.map((stage: any) => stage.status),
		["active", "pending"],
	);
	assert.deepEqual(
		started.stages[0].tasks.map((task: any) => task.status),
		["pending"],
	);
	assert.ok(host.log.some((line) => line.reason === "goal" && line.event === "start" && line.title === "Ship it"));

	assert.equal(await host.tool({ action: "pass" }, "ga"), "evidence is required for pass.");
	assert.equal(
		await host.tool({ action: "pass", evidence: "reviewed" }, "ga"),
		'Writer\'s task "write the draft" has not been reported yet; it cannot pass the stage.',
	);
	await report(host, "Writer", "draft.md written");
	assert.match(
		await host.tool({ action: "pass", evidence: "reviewed" }, "ga"),
		/Stage 1 passed\. Stage 2 "Check" is current/,
	);
	const second = host.room.goal;
	assert.deepEqual([second.current, second.stages.map((stage: any) => stage.status)], [1, ["passed", "active"]]);
	assert.equal(second.stages[0].tasks[0].status, "done");
	assert.equal(second.stages[0].evidence, "reviewed");

	await report(host, "Tester", "checks green");
	assert.match(await host.tool({ action: "pass", evidence: "green" }, "ga"), /Every stage passed/);
	assert.equal(host.room.goal.current, 2);
	assert.equal(await host.tool({ action: "complete", summary: "s" }, "ga"), "evidence is required for complete.");
	assert.equal(await host.tool({ action: "complete", evidence: "e" }, "ga"), "summary is required for complete.");
	assert.match(
		await host.tool({ action: "complete", evidence: "all green", summary: "shipped" }, "ga"),
		/Complete\. Tell the user what was delivered\./,
	);
	assert.equal(host.room.goal.status, "complete");
});

test("a reported result from before a revise is stale and cannot pass the new plan", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	await report(host, "Writer", "first pass");
	assert.equal(host.room.goal.stages[0].tasks[0].result.revision, 1);
	// The plan is revised: the kept task still holds the old result, which is stale.
	await host.tool(
		{
			action: "revise",
			reason: "scope changed",
			stages: [
				{ title: "Draft", acceptance: "draft reviewed twice", tasks: [{ bot: "Writer", task: "write the draft" }] },
			],
		},
		"ga",
	);
	const goal = host.room.goal;
	assert.equal(goal.objectiveRevision, 2);
	assert.equal(goal.stages[0].tasks[0].status, "reported");
	assert.equal(
		await host.tool({ action: "pass", evidence: "ok" }, "ga"),
		'Writer\'s task "write the draft" was reported for an older version of the goal; have it reported again.',
	);
	await report(host, "Writer", "second pass");
	assert.match(await host.tool({ action: "pass", evidence: "ok" }, "ga"), /Every stage passed/);
});

test("required tasks cannot be waived, optional tasks need an explicit waiver", async (t) => {
	const host = runtime(t);
	await host.tool(
		{
			action: "start",
			objective: "o",
			acceptance: "a",
			stages: [
				{
					title: "Draft",
					acceptance: "draft reviewed",
					tasks: [
						{ bot: "Writer", task: "write the draft" },
						{ bot: "Tester", task: "optional review", required: false },
					],
				},
			],
		},
		"ga",
	);
	await report(host, "Writer");
	assert.equal(
		await host.tool({ action: "pass", evidence: "ok" }, "ga"),
		'Optional task Tester\'s task "optional review" is not reported; pass it, or waive it with a reason in group_goal pass.',
	);
	assert.equal(
		await host.tool({ action: "pass", evidence: "ok", waiver: [{ bot: "Writer", reason: "no need" }] }, "ga"),
		'The task "write the draft" is required; it cannot be waived. Have it reported instead.',
	);
	assert.match(
		await host.tool(
			{ action: "pass", evidence: "ok", waiver: [{ bot: "Tester", reason: "review adds nothing here" }] },
			"ga",
		),
		/Every stage passed/,
	);
	assert.deepEqual(host.room.goal.stages[0].waivers, [
		{ by: "a", reason: "review adds nothing here", at: host.room.goal.stages[0].waivers[0].at },
	]);
});

test("a failed or unknown result cannot pass the stage", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	await host.tool({ action: "task", bot: "Writer", status: "failed", note: "build broke" }, "ga");
	assert.equal(
		await host.tool({ action: "pass", evidence: "ok" }, "ga"),
		'Writer\'s task "write the draft" is failed; it cannot pass the stage.',
	);
	await host.tool({ action: "task", bot: "Writer", status: "unknown" }, "ga");
	assert.equal(
		await host.tool({ action: "pass", evidence: "ok" }, "ga"),
		'Writer\'s task "write the draft" is unknown; it cannot pass the stage.',
	);
});

test("a task with its own acceptance needs evidence before the stage passes", async (t) => {
	const host = runtime(t);
	await host.tool(
		{
			action: "start",
			objective: "o",
			acceptance: "a",
			stages: [
				{
					title: "Draft",
					acceptance: "draft reviewed",
					tasks: [{ bot: "Writer", task: "write the draft", acceptance: "the draft links its sources" }],
				},
			],
		},
		"ga",
	);
	await host.tool({ action: "task", bot: "Writer", status: "reported" }, "ga");
	assert.equal(
		await host.tool({ action: "pass", evidence: "ok" }, "ga"),
		'Writer\'s task "write the draft" needs its evidence before the stage can pass.',
	);
	await host.tool({ action: "task", bot: "Writer", evidence: "sources.md line 4" }, "ga");
	assert.match(await host.tool({ action: "pass", evidence: "ok" }, "ga"), /Every stage passed/);
});

test("rework sends the current stage back; revise keeps passed stages and a matching task", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	await host.tool({ action: "task", bot: "Writer", status: "working" }, "ga");
	assert.equal(await host.tool({ action: "rework" }, "ga"), "reason is required for rework.");
	await host.tool({ action: "rework", reason: "missing tests" }, "ga");
	const back = host.room.goal;
	assert.equal(back.stages[0].tasks[0].status, "pending");
	assert.deepEqual([back.stages[0].reworks, back.stages[0].feedback], [1, "missing tests"]);
	await report(host, "Writer");
	await host.tool({ action: "pass", evidence: "ok" }, "ga");
	await host.tool({ action: "task", bot: "Tester", status: "working" }, "ga");
	assert.equal(
		await host.tool({ action: "revise", stages: [GOAL_STAGES[1]] }, "ga"),
		"reason is required for revise.",
	);
	await host.tool(
		{
			action: "revise",
			reason: "scope changed",
			stages: [
				{ title: "Check", acceptance: "checks pass", tasks: [{ bot: "Tester", task: "run the checks" }] },
				{ title: "Wrap", acceptance: "wrapped", tasks: [{ bot: "Writer", task: "wrap up" }] },
			],
		},
		"ga",
	);
	const revised = host.room.goal;
	assert.deepEqual(
		revised.stages.map((stage: any) => [stage.id, stage.status]),
		[
			["s1", "passed"],
			["s3", "active"],
			["s4", "pending"],
		],
	);
	assert.equal(revised.current, 1);
	// The same member's same task in the replaced current stage kept its status.
	assert.equal(revised.stages[1].tasks[0].status, "working");
	assert.equal(revised.stages[1].tasks[0].botId, "c");
});

test("pause, resume and stop refuse the wrong state and follow it", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	assert.equal(
		await host.tool({ action: "resume" }, "ga"),
		'The goal of "Ops" is active; resume needs it to be paused.',
	);
	await host.tool({ action: "pause" }, "ga");
	assert.equal(host.room.goal.status, "paused");
	assert.equal(
		await host.tool({ action: "pass", evidence: "e" }, "ga"),
		'The goal of "Ops" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.',
	);
	await host.tool({ action: "resume" }, "ga");
	assert.equal(host.room.goal.status, "active");
	assert.equal(await host.tool({ action: "stop" }, "ga"), "reason is required for stop.");
	await host.tool({ action: "stop", reason: "no longer needed" }, "ga");
	assert.deepEqual([host.room.goal.status, host.room.goal.reason], ["stopped", "no longer needed"]);
	assert.equal(
		await host.tool({ action: "pause" }, "ga"),
		'The goal of "Ops" is stopped; pause needs it to be active.',
	);
});

test("only the admin or a Main Bot changes a goal; any member can show it", async (t) => {
	const host = runtime(t, {
		extraRooms: {
			r2: {
				id: "r2",
				name: "Lab",
				members: ["a", "c"],
				mode: "admin",
				admin: null,
				named: true,
				sessions: {},
				log: [],
				seq: 0,
				seen: {},
			},
		},
	});
	assert.equal(
		await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "gb"),
		'Only Chief, the admin of "Ops", or a Main Bot changes its goal. Tell the admin in the group.',
	);
	assert.match(await host.tool({ action: "show" }, "gb"), /"Ops" has no goal/);
	assert.match(
		await host.tool(
			{ action: "start", group: "Ops", title: "Ship it", objective: "o", acceptance: "a", stages: GOAL_STAGES },
			"ga",
		),
		/Started\./,
	);
	assert.match(await host.tool({ action: "show" }, "gb"), /The group works toward: Ship it/);
	assert.equal(
		await host.tool({ action: "start", group: "Lab", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "a"),
		'"Lab" has no admin, and a goal needs one to run it. Set an admin with update_group first.',
	);
	assert.equal(
		await host.tool({ action: "stop", group: "Lab", reason: "r" }, "c"),
		'Only a Main Bot changes the goal of "Lab".',
	);
});

test("events keep the newest 50 and pastGoals keep 5", async (t) => {
	const host = runtime(t);
	const run = (args: Record<string, unknown>, agent = "ga") => host.tool(args, agent);
	await run({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES });
	for (let i = 0; i < 60; i += 1)
		await run({ action: "task", bot: "Writer", status: i % 2 === 0 ? "working" : "pending" });
	assert.equal(host.room.goal.events.length, 50);
	for (let i = 0; i < 7; i += 1) {
		const id = host.room.goal.id;
		await run({ action: "stop", reason: `r${i}` });
		assert.deepEqual(await host.rt.goalControl("r1", { goalId: id, action: "clear" }), {});
		await run({ action: "start", title: `g${i}`, objective: "o", acceptance: "a", stages: GOAL_STAGES });
	}
	assert.equal(host.room.pastGoals.length, 5);
	assert.equal(host.room.pastGoals.at(-1).status, "stopped");
});

test("the goal block carries the ledger for the admin and the member's task", async (t) => {
	const host = runtime(t);
	await host.tool(
		{
			action: "start",
			title: "Ship it",
			objective: "Ship the thing",
			acceptance: "it is shipped",
			stages: GOAL_STAGES,
		},
		"ga",
	);
	const adminBlock = (host.rt as R).goalBlock(host.room, host.bots.a);
	assert.match(adminBlock, /<group_goal status="active">/);
	assert.match(adminBlock, /\[current\] 1\. Draft — done when: draft reviewed/);
	assert.match(adminBlock, /- Writer: write the draft \[not started\]/);
	assert.match(adminBlock, /\[next\] 2\. Check: Tester/);
	assert.match(adminBlock, /You run this goal\./);
	await host.tool({ action: "task", bot: "Writer", status: "working" }, "ga");
	const memberBlock = (host.rt as R).goalBlock(host.room, host.bots.b);
	assert.match(memberBlock, /<group_goal status="active" stage="1\/2">/);
	assert.match(memberBlock, /Your task in it: write the draft \(working\)\./);
	const noTask = (host.rt as R).goalBlock(host.room, host.bots.c);
	assert.match(noTask, /You have no task in this stage\./);
	// A finished goal has no block at all.
	await report(host, "Writer");
	await host.tool({ action: "pass", evidence: "ok" }, "ga");
	await report(host, "Tester");
	await host.tool({ action: "pass", evidence: "ok" }, "ga");
	await host.tool({ action: "complete", evidence: "e", summary: "s" }, "ga");
	assert.equal((host.rt as R).goalBlock(host.room, host.bots.a), "");
});

test("a goal draft opens as the user's line and calls only the admin", async (t) => {
	const host = runtime(t);
	assert.deepEqual(await host.rt.goalDraft("r1", "Ship the thing"), {});
	const drafted = host.room.goal;
	assert.deepEqual([drafted.status, drafted.by, drafted.brief], ["drafting", "user", "Ship the thing"]);
	const post = host.posts.at(-1) as { sessionId: string; message: any };
	assert.equal(post.sessionId, "r1");
	assert.deepEqual([post.message.source.role, post.message.source.goal], ["goal", "draft"]);
	assert.ok(host.log.some((line) => line.reason === "goal" && line.event === "draft"));
	// A second draft while drafting replaces the brief instead of opening another goal.
	assert.deepEqual(await host.rt.goalDraft("r1", "Ship the other thing"), {});
	assert.equal(host.room.goal.brief, "Ship the other thing");
	assert.equal(host.room.goal.status, "drafting");
	// No admin: no goal draft.
	const other = runtime(t, {
		extraRooms: { r2: { id: "r2", name: "Lab", members: ["a", "c"], admin: null, log: [] } },
	});
	assert.deepEqual(await other.rt.goalDraft("r2", "x"), {
		error: "This group has no admin. Set one in the group settings first.",
	});
	// One more draft on a finished goal archives it and opens a new drafting goal.
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	await host.tool({ action: "stop", reason: "r" }, "ga");
	assert.deepEqual(await host.rt.goalDraft("r1", "New thing"), {});
	assert.equal(host.room.goal.status, "drafting");
	assert.equal(host.room.pastGoals.length, 1);
});

test("goal-control pauses, resumes, stops and clears a goal, refusing a stale goal id", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	const stale = await host.rt.goalControl("r1", { goalId: "goal-nope", action: "pause" });
	assert.deepEqual([stale.code, stale.error], ["bot/stale", "The goal has changed. Look again."]);
	assert.deepEqual(await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "pause" }), {});
	assert.equal(host.room.goal.status, "paused");
	assert.equal(
		(await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "pause" })).error,
		'The goal of "Ops" is paused; pause needs it to be active.',
	);
	assert.deepEqual(await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "resume" }), {});
	assert.equal(host.room.goal.status, "active");
	const resumed = host.posts.at(-1) as { message: any };
	assert.deepEqual([resumed.message.source.goal, resumed.message.content[0].text], ["resume", "[Goal resumed]"]);
	assert.deepEqual(await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "stop" }), {});
	assert.equal(host.room.goal.status, "stopped");
	assert.deepEqual(host.stopped, [["room", "r1"]]);
	assert.deepEqual(await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "clear" }), {});
	assert.equal(host.room.goal, undefined);
	assert.equal(host.room.pastGoals.length, 1);
});

test("pause with stopWork and stop stop the room's work", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "pause", stopWork: true });
	assert.deepEqual(host.stopped, [["room", "r1"]]);
});

test("the tool stop stops the other members' work, not the caller's", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	await host.tool({ action: "stop", reason: "done for now" }, "ga");
	assert.equal(host.room.goal.status, "stopped");
	assert.deepEqual(host.stopped, [
		["member", "r1", "b"],
		["member", "r1", "c"],
	]);
});

test("the idle driver queues one check, waits after [PASS], and gives up after two fruitless checks", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	const round = (over: Record<string, unknown>) => ({ roomId: "r1", replies: [], slots: [{ id: "a" }], ...over });
	// A user-message round ends with nothing running: the goal check queues once.
	await host.rt.goalDrive(host.room, round({ userMessage: true }));
	const nudge = host.posts.at(-1) as { message: any };
	assert.equal(nudge.message.content[0].text, "[Goal check]");
	assert.equal(nudge.message.source.goal, "nudge");
	assert.equal(host.room.goal.nudges, 1);
	assert.equal(host.room.goal.spent.checks, 1);
	// A [PASS] on the check makes the goal wait for the user.
	await host.rt.goalDrive(host.room, round({ goalNudge: true, slots: [{ id: "a", status: "passed" }] }));
	assert.equal(host.room.goal.idle, true);
	const posts = host.posts.length;
	await host.rt.goalDrive(host.room, round({ userMessage: true }));
	assert.equal(host.posts.length, posts);
	// A user message clears the wait and the count starts over.
	host.rt.goalUserMessage("r1");
	assert.deepEqual([host.room.goal.idle, host.room.goal.nudges], [undefined, 0]);
	// Two checks without progress mark the goal idle instead of waking it again.
	host.rt.goalUserMessage("r1");
	await host.rt.goalDrive(host.room, round({ userMessage: true }));
	await host.rt.goalDrive(host.room, round({ slots: [{ id: "a" }] }));
	await host.rt.goalDrive(host.room, round({ slots: [{ id: "a" }] }));
	assert.equal(host.room.goal.idle, true);
	assert.equal(host.room.goal.nudges, GOAL_IDLE_NUDGES);
	// A paused goal never gets a check.
	host.rt.goalUserMessage("r1");
	await host.tool({ action: "pause" }, "ga");
	const before = host.posts.length;
	await host.rt.goalDrive(host.room, round({ userMessage: true }));
	assert.equal(host.posts.length, before);
});

test("a room at work, a pending batch or an inbox holds the check; a settle check runs once", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	const round = { roomId: "r1", replies: [], slots: [{ id: "a" }], userMessage: true };
	host.rt.workingInRoom = () => ["b"];
	await host.rt.goalDrive(host.room, round);
	assert.equal(host.posts.length, 0);
	host.rt.workingInRoom = () => [];
	host.rt.roomBatchPending = () => true;
	await host.rt.goalDrive(host.room, round);
	assert.equal(host.posts.length, 0);
	host.rt.roomBatchPending = () => false;
	host.rt.roomInbox.set("r1", [{}]);
	await host.rt.goalDrive(host.room, round);
	assert.equal(host.posts.length, 0);
	host.rt.roomInbox.delete("r1");
	await host.rt.goalDrive(host.room, round);
	assert.equal(host.posts.length, 1);
	// A settle check is skipped while a round of the room still runs.
	host.rt.roomProgress.set("s1", { roomId: "r1" });
	await host.rt.goalSettled(host.room);
	assert.equal(host.posts.length, 1);
	host.rt.roomProgress.clear();
	await host.rt.goalSettled(host.room);
	assert.equal(host.posts.length, 2);
	// A stopped-only round (the stop notice) never nudges.
	await host.rt.goalSettled(host.room);
	const before = host.posts.length;
	await host.rt.goalDrive(host.room, { roomId: "r1", replies: [], slots: [{ id: "a" }], stoppedOnly: true });
	assert.equal(host.posts.length, before);
});

test("the goal budget stops the idle checks and a user message clears the wait", async (t) => {
	const host = runtime(t);
	await host.tool(
		{ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES, budget: { maxChecks: 1 } },
		"ga",
	);
	assert.deepEqual(goalBudget(host.room.goal), { exhausted: false });
	const round = { roomId: "r1", replies: [], slots: [{ id: "a" }], userMessage: true };
	await host.rt.goalDrive(host.room, round);
	assert.equal(host.posts.length, 1);
	assert.deepEqual(goalBudget(host.room.goal), { exhausted: true, reason: "all 1 checks were used" });
	// The next check marks the goal budget-wait instead of waking the admin again.
	await host.rt.goalDrive(host.room, { ...round, userMessage: false });
	assert.equal(host.posts.length, 1);
	assert.equal(host.room.goal.waiting, "budget");
	assert.match((host.rt as R).goalBlock(host.room, host.bots.a), /used its budget of checks/);
	// A user message clears the wait; the spent count stays.
	host.rt.goalUserMessage("r1");
	assert.equal(host.room.goal.waiting, undefined);
	// An explicit user resume opens a fresh budget window.
	await host.tool({ action: "pause" }, "ga");
	await host.rt.goalControl("r1", { goalId: host.room.goal.id, action: "resume" });
	assert.equal(host.room.goal.spent.checks, 0);
	// A past deadline also exhausts the budget.
	const deadlined = runtime(t);
	await deadlined.tool(
		{
			action: "start",
			objective: "o",
			acceptance: "a",
			stages: GOAL_STAGES,
			budget: { deadline: Date.now() + 50_000 },
		},
		"ga",
	);
	deadlined.room.goal.budget.deadline = Date.now() - 1;
	assert.deepEqual(goalBudget(deadlined.room.goal), { exhausted: true, reason: "the deadline passed" });
});

test("task automation moves a task through working and reported with the current revision", async (t) => {
	const host = runtime(t);
	await host.tool({ action: "start", objective: "o", acceptance: "a", stages: GOAL_STAGES }, "ga");
	const task = () => host.room.goal.stages[0].tasks[0];
	assert.equal(markTasks(host.room, "b", "pending", "working"), true);
	assert.equal(task().status, "working");
	assert.equal(task().result, undefined);
	assert.equal(markTasks(host.room, "b", "working", "reported"), true);
	assert.deepEqual([task().status, task().result.revision], ["reported", 1]);
	assert.equal(markTasks(host.room, "b", "working", "pending"), false);
	// A failure or a user stop only moves a task that is at work.
	host.rt.goalTaskReset("r1", "b", "Could not finish: its model call failed");
	assert.equal(task().status, "reported");
	assert.equal(markTasks(host.room, "b", "reported", "working"), true);
	host.rt.goalTaskReset("r1", "b", "Could not finish: its model call failed");
	assert.equal(task().status, "pending");
	assert.equal(task().note, "Could not finish: its model call failed");
	assert.equal(task().result, undefined);
	// A non-active goal is left alone.
	await host.tool({ action: "pause" }, "ga");
	assert.equal(markTasks(host.room, "b", "pending", "working"), false);
});

test("the pure state machine helpers keep the earlier shapes", () => {
	const room: any = { id: "r1", name: "Ops", members: ["a"] };
	const bot = { id: "a" };
	const of = (name: string) => (name === "Chief" ? bot : undefined);
	const now = 1_000;
	let result = draftGoal(room, { brief: "Do it", by: "user" }, now);
	assert.equal(result.error, undefined);
	assert.equal(room.goal.status, "drafting");
	result = startGoal(
		room,
		{
			objective: "o",
			acceptance: "a",
			stages: [{ title: "S", acceptance: "x", tasks: [{ bot: "Chief", task: "t" }] }],
		},
		"a",
		of,
		["Chief"],
		now,
	);
	assert.equal(result.error, undefined);
	assert.equal(room.goal.objectiveRevision, 1);
	touchGoal(room.goal, { kind: "custom", by: "a" }, now);
	assert.equal(room.goal.revision, 3);
	assert.equal(
		taskGoal(room, { bot: "Chief", status: "reported", evidence: "e" }, "a", of, ["Chief"], now).error,
		undefined,
	);
	result = passGoal(room, { evidence: "ok" }, "a", now, () => "Chief", of);
	assert.equal(result.error, undefined);
	assert.equal(room.goal.current, 1);
	assert.equal(pauseGoal(room, "user", now).goal?.status, "paused");
	assert.equal(resumeGoal(room, "user", now).goal?.status, "active");
	assert.equal(pauseGoal(room, "user", now).goal?.status, "paused");
	assert.equal(stopGoal(room, "reason", "user", now).goal?.status, "stopped");
	archiveGoal(room);
	assert.equal(room.goal, undefined);
	assert.equal(room.pastGoals.length, 1);
	assert.equal(TASK_LABEL.reported, "reported");
});

test("rework refuses an unknown member and clears the task result with the status", () => {
	const room: any = { id: "r1", name: "Ops", members: ["a", "b"] };
	const bot = { id: "b" };
	const of = (name: string) => (name === "Writer" ? bot : undefined);
	startGoal(
		room,
		{
			objective: "o",
			acceptance: "a",
			stages: [{ title: "S", acceptance: "x", tasks: [{ bot: "Writer", task: "t" }] }],
		},
		"a",
		of,
		["Writer"],
		1,
	);
	taskGoal(room, { bot: "Writer", status: "reported" }, "a", of, ["Writer"], 2);
	assert.equal(room.goal.stages[0].tasks[0].result.revision, 1);
	assert.equal(
		reworkGoal(room, { bot: "Nobody", reason: "r" }, "a", of, ["Writer"], 3).error,
		'Nobody is not a member of "Ops". Members: Writer.',
	);
	assert.equal(reworkGoal(room, { reason: "r" }, "a", of, ["Writer"], 3).error, undefined);
	assert.equal(room.goal.stages[0].tasks[0].status, "pending");
	assert.equal(room.goal.stages[0].tasks[0].result, undefined);
	assert.equal(
		completeGoal(room, { evidence: "e", summary: "s" }, "a", 4).error,
		'Stage 1 "S" has not passed yet. Pass every stage before complete.',
	);
	reviseGoal(
		room,
		{ reason: "r", stages: [{ title: "S2", acceptance: "x2", tasks: [{ bot: "Writer", task: "t2" }] }] },
		"a",
		of,
		["Writer"],
		5,
	);
	assert.equal(room.goal.objectiveRevision, 2);
	assert.equal(room.goal.stages[0].title, "S2");
});
