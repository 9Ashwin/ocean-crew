// Schedule behavior: the settings page's task list, creation and deletion through DSH's
// schedule service (both the Session-owned and the Host-wide service), moving a Bot's
// tasks to a fresh part, and the reminder framing a group receives when one is due.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install, reminderText } from "../src/host/work/schedules.ts";
import { fakeContext } from "./fake-ctx.ts";

const TEAM = {
	version: 1,
	mainBotIds: ["m1"],
	revision: 1,
	bots: {
		m1: { id: "m1", sessionId: "m1", name: "Chief", role: "Chief of Staff", instructions: "", createdAt: 1 },
		w1: {
			id: "w1",
			sessionId: "w2",
			name: "Writer",
			role: "",
			instructions: "",
			createdAt: 2,
			segments: [{ sessionId: "w1", endedAt: 3 }],
		},
	},
	rooms: {
		g1: {
			id: "g1",
			name: "Launch",
			named: true,
			members: ["m1", "w1"],
			admin: "m1",
			mode: "admin",
			notice: "",
			createdAt: 4,
		},
	},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
};

// An in-memory stand-in for DSH's schedule service (0.2.1: tasks belong to a Session).
function scheduleService() {
	const tasks = new Map<string, any>();
	let next = 1;
	return {
		tasks,
		async create(sessionId: string, request: any) {
			const id = `schedule-${next++}`;
			const timingKey = Object.keys(request).find((key) => !["title", "prompt"].includes(key)) as string;
			const kind = ({ every_seconds: "every" } as Record<string, string>)[timingKey] ?? timingKey;
			const record = {
				id,
				kind,
				title: request.title,
				prompt: request.prompt,
				timing: request[timingKey],
				scheduledAt: request.at ?? "2030-01-01T01:00:00.000Z",
				everySeconds: request.every_seconds,
				time: request.daily?.time ?? request.weekly?.time,
				timeZone: request.daily?.time_zone ?? request.weekly?.time_zone ?? request.cron?.time_zone,
				weekdays: request.weekly?.weekdays,
				expression: request.cron?.expression,
			};
			tasks.set(id, { sessionId, record });
			return record;
		},
		async list({ sessionId }: { sessionId: string }) {
			return [...tasks.values()].filter((task) => task.sessionId === sessionId).map((task) => task.record);
		},
		async catalog() {
			return [...tasks.values()]
				.map((task) => ({ ...task.record, sessionId: task.sessionId, status: task.status ?? "active" }))
				.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));
		},
		async delete({ sessionId, id }: { sessionId: string; id: string }) {
			if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: "schedule_not_found" };
			tasks.delete(id);
			return { id, deleted: true };
		},
	};
}

// The Host-wide service of DSH 0.2.2: each task has a delivery target and changes through edit().
function hostSchedule() {
	const tasks = new Map<string, any>();
	let next = 1;
	const edits: any[] = [];
	return {
		tasks,
		edits,
		async create({ title, prompt, timing, target }: any) {
			const id = `schedule-${next++}`;
			const [selector] = Object.keys(timing).filter((key) => key !== "kind");
			tasks.set(id, {
				record: { id, kind: timing.kind, title, prompt, scheduledAt: timing.at ?? "2030-01-01T01:00:00.000Z" },
				timing: timing[selector],
				target,
				status: "active",
			});
			return { id };
		},
		async catalog() {
			return [...tasks.values()].map((task) => ({ ...task.record, target: task.target, status: task.status }));
		},
		async edit(request: any) {
			edits.push(request);
			if (request.action === "delete") tasks.delete(request.id);
			else Object.assign(tasks.get(request.id), request.patch);
			return { id: request.id };
		},
	};
}

function setup(services: Record<string, any> = {}) {
	const ctx = fakeContext({ services });
	const rt: any = {
		ctx,
		// The run log needs a team directory; a fresh one per setup keeps the tests apart.
		home: mkdtempSync(join(tmpdir(), "ocean-crew-schedules-")),
		state: JSON.parse(JSON.stringify(TEAM)),
		chatOwners: new Map<string, string>([
			["m1", "m1"],
			["w2", "w1"],
			["w1", "w1"],
		]),
		groupOwners: new Map<string, any>(),
		pastOwners: new Map<string, any>([["w1", { botId: "w1" }]]),
		load: async () => {},
		warn: () => {},
		botOf: (id?: string) => (id === undefined ? undefined : rt.state.bots[id]),
		roomOf: (id?: string) => (id === undefined ? undefined : rt.state.rooms[id]),
		chatOf: (botId: string) => rt.state.bots[botId]?.sessionId ?? botId,
		sessionOfRoom: (room: any) => room?.sessionId ?? room?.id,
		isBotSession: (id?: string) =>
			id !== undefined && (rt.chatOwners.has(id) || rt.groupOwners.has(id) || rt.pastOwners.has(id)),
	};
	install(rt as Runtime);
	return { rt, ctx };
}

test("without the schedule service the page says so and creating is refused", async () => {
	const { rt } = setup();
	assert.deepEqual(await rt.scheduleEndpoint("schedules", {}), { available: false, tasks: [] });
	await assert.rejects(
		rt.scheduleEndpoint("schedule-create", {
			target: "m1",
			title: "Briefing",
			prompt: "Sum up",
			when: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
		}),
		/Automation tasks are off/,
	);
});

test("tasks are created on the Bot's current part, listed by Bot, and deleted", async () => {
	const schedule = scheduleService();
	const { rt } = setup({ schedule });
	const daily = await rt.scheduleEndpoint("schedule-create", {
		target: "w1",
		title: " Briefing ",
		prompt: "Sum up the day",
		when: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
	});
	assert.equal(daily.available, true);
	const [created] = [...schedule.tasks.values()] as any[];
	assert.equal(created.sessionId, "w2");
	assert.deepEqual(created.record.timing, { time: "09:00:00", time_zone: "Asia/Shanghai" });
	assert.equal(created.record.title, "Briefing");

	await schedule.create("w1", { title: "Old part", prompt: "x", every_seconds: 3600 });
	await schedule.create("outside", { title: "Not ours", prompt: "x", every_seconds: 3600 });
	// A task past its firing reads overdue; an inactive one is finished.
	schedule.tasks.set("schedule-late", {
		sessionId: "w2",
		record: { id: "schedule-late", kind: "at", title: "Late", prompt: "x", scheduledAt: "2020-01-01T00:00:00.000Z" },
	});
	schedule.tasks.set("schedule-done", {
		sessionId: "w2",
		record: { id: "schedule-done", kind: "at", title: "Done", prompt: "x", scheduledAt: "2020-01-01T00:00:00.000Z" },
		status: "inactive",
	});
	const listed = await rt.scheduleEndpoint("schedules", {});
	assert.equal(listed.available, true);
	assert.deepEqual(
		listed.tasks.map((task: any) => [task.title, task.botId]),
		[
			["Done", "w1"],
			["Late", "w1"],
			["Briefing", "w1"],
			["Old part", "w1"],
		],
	);
	assert.deepEqual(
		listed.tasks.map((task: any) => task.state),
		["finished", "overdue", "scheduled", "scheduled"],
	);

	await rt.scheduleEndpoint("schedule-create", {
		target: "m1",
		title: "Week",
		prompt: "Plan",
		when: { kind: "weekly", time: "18:30", timeZone: "UTC", weekdays: [5, 1, 1, 9] },
	});
	assert.deepEqual(([...schedule.tasks.values()].at(-1) as any).record.timing, {
		time: "18:30:00",
		time_zone: "UTC",
		weekdays: [1, 5],
	});
	await rt.scheduleEndpoint("schedule-create", {
		target: "m1",
		title: "Ping",
		prompt: "Check",
		when: { kind: "every", minutes: 30 },
	});
	assert.equal(([...schedule.tasks.values()].at(-1) as any).record.timing, 1800);

	for (const [when, message] of [
		[{ kind: "at", at: "2000-01-01T00:00:00Z" }, /future/],
		[{ kind: "weekly", time: "09:00", weekdays: [] }, /at least one day/],
		[{ kind: "daily", time: "9am" }, /time of day/],
		[{ kind: "every", minutes: 0 }, /1 minute to 7 days/],
	] as Array<[any, RegExp]>) {
		await assert.rejects(
			rt.scheduleEndpoint("schedule-create", { target: "m1", title: "x", prompt: "y", when }),
			message,
		);
	}
	await assert.rejects(
		rt.scheduleEndpoint("schedule-create", {
			target: "m1",
			title: "",
			prompt: "y",
			when: { kind: "every", minutes: 5 },
		}),
		/name/,
	);

	const removed = await rt.scheduleEndpoint("schedule-delete", { sessionId: "w2", id: created.record.id });
	assert.deepEqual(
		removed.tasks.map((task: any) => task.title),
		["Done", "Late", "Old part", "Week", "Ping"],
	);
	await assert.rejects(
		rt.scheduleEndpoint("schedule-delete", { sessionId: "outside", id: "schedule-3" }),
		/No such task/,
	);
});

test("a group chat task lives on the group Session and lists under the group", async () => {
	const schedule = scheduleService();
	const { rt } = setup({ schedule });
	const made = await rt.scheduleEndpoint("schedule-create", {
		target: "g1",
		title: "Standup",
		prompt: "Where are we?",
		when: { kind: "daily", time: "10:00", timeZone: "UTC" },
	});
	assert.equal(made.available, true);
	assert.equal(([...schedule.tasks.values()][0] as any).sessionId, "g1");
	assert.deepEqual(
		made.tasks.map((task: any) => [task.title, task.roomId, task.botId]),
		[["Standup", "g1", undefined]],
	);
	await assert.rejects(
		rt.scheduleEndpoint("schedule-create", {
			target: "nobody",
			title: "x",
			prompt: "y",
			when: { kind: "every", minutes: 5 },
		}),
		/No such Bot or group chat/,
	);
});

test("a due reminder reaches a group as its prompts", () => {
	const one = [
		"[SCHEDULE REMINDER]",
		"framing",
		'schedule_id_json: "s1"',
		"occurrence_at: 2030-01-01T00:00:00Z",
		'reminder_prompt_json: "Where are we?"',
	].join("\n");
	assert.equal(reminderText(one), "[Scheduled task] Where are we?");
	const batch = [
		"[SCHEDULE REMINDER BATCH]",
		"framing",
		`reminders_json: ${JSON.stringify([
			{ schedule_id: "a", reminder_prompt: "One" },
			{ schedule_id: "b", reminder_prompt: "Two" },
		])}`,
	].join("\n");
	assert.equal(reminderText(batch), "[Scheduled task] One\n[Scheduled task] Two");
	assert.equal(reminderText("plain text"), "plain text");
});

test("on the Host-wide service tasks target the Bot's current part, list by target, delete by id and move in place", async () => {
	const schedule = hostSchedule();
	const { rt } = setup({ schedule });
	const made = await rt.scheduleEndpoint("schedule-create", {
		target: "w1",
		title: "Briefing",
		prompt: "Sum up the day",
		when: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
	});
	assert.equal(made.available, true);
	const [created] = [...schedule.tasks.values()] as any[];
	assert.deepEqual(created.target, { kind: "session", sessionId: "w2" });
	assert.equal(created.record.kind, "daily");
	assert.deepEqual(created.timing, { time: "09:00:00", time_zone: "Asia/Shanghai" });
	await rt.scheduleEndpoint("schedule-create", {
		target: "m1",
		title: "Ping",
		prompt: "Check",
		when: { kind: "every", minutes: 30 },
	});
	assert.equal(([...schedule.tasks.values()].at(-1) as any).timing, 1800);

	schedule.tasks.set("schedule-paused", {
		record: {
			id: "schedule-paused",
			kind: "rrule",
			title: "Held",
			prompt: "x",
			scheduledAt: "2030-01-01T00:00:00.000Z",
		},
		target: { kind: "session", sessionId: "w2" },
		status: "paused",
	});
	schedule.tasks.set("schedule-ended", {
		record: { id: "schedule-ended", kind: "at", title: "Done", prompt: "x", scheduledAt: "2020-01-01T00:00:00.000Z" },
		target: { kind: "session", sessionId: "w2" },
		status: "ended",
	});
	schedule.tasks.set("schedule-new", {
		record: {
			id: "schedule-new",
			kind: "at",
			title: "Elsewhere",
			prompt: "x",
			scheduledAt: "2030-01-01T00:00:00.000Z",
		},
		target: { kind: "new_once" },
		status: "active",
	});
	const listed = await rt.scheduleEndpoint("schedules", {});
	assert.deepEqual(
		listed.tasks.map((task: any) => [task.title, task.botId, task.sessionId, task.state]),
		[
			["Briefing", "w1", "w2", "scheduled"],
			["Ping", "m1", "m1", "scheduled"],
			["Held", "w1", "w2", "paused"],
			["Done", "w1", "w2", "finished"],
		],
	);

	await rt.moveSchedules("w2", "s9");
	assert.deepEqual(
		schedule.edits.map((edit: any) => [edit.id, edit.patch?.target?.sessionId]),
		[
			["schedule-1", "s9"],
			["schedule-paused", "s9"],
		],
	);
	assert.deepEqual(schedule.tasks.get("schedule-ended").target, { kind: "session", sessionId: "w2" });

	await assert.rejects(rt.scheduleEndpoint("schedule-delete", { sessionId: "w2", id: "schedule-1" }), /No such task/);
	await assert.rejects(
		rt.scheduleEndpoint("schedule-delete", { sessionId: "m1", id: "schedule-new" }),
		/No such task/,
	);
	const removed = await rt.scheduleEndpoint("schedule-delete", { sessionId: "m1", id: "schedule-2" });
	assert.equal(removed.available, true);
	assert.equal(schedule.tasks.has("schedule-2"), false);
	assert.deepEqual(schedule.edits.at(-1), { id: "schedule-2", action: "delete" });
});

test("on the Host-wide service a Bot reads and changes only the tasks of its own chat", async () => {
	const schedule = hostSchedule();
	const { rt, ctx } = setup({ schedule });
	await rt.load();
	schedule.tasks.set("own", {
		record: { id: "own", kind: "at", title: "Mine", prompt: "x", scheduledAt: "2030-01-01T00:00:00.000Z" },
		target: { kind: "session", sessionId: "w1" },
		status: "active",
	});
	schedule.tasks.set("chief", {
		record: { id: "chief", kind: "at", title: "Chief", prompt: "x", scheduledAt: "2030-01-01T00:00:00.000Z" },
		target: { kind: "session", sessionId: "m1" },
		status: "active",
	});
	schedule.tasks.set("elsewhere", {
		record: { id: "elsewhere", kind: "at", title: "New", prompt: "x", scheduledAt: "2030-01-01T00:00:00.000Z" },
		target: { kind: "new_once" },
		status: "active",
	});
	const gate: any = (ctx.listeners.get("tools/pre-execute") ?? [])[0];
	const check = (name: string, id: string, sessionId: string) =>
		gate({ name, arguments: { id, action: "delete" }, agent: { id: sessionId } }, async () => ({ kind: "allow" }));
	assert.deepEqual(await check("schedule_edit", "own", "w2"), { kind: "allow" });
	assert.deepEqual(await check("schedule_view", "own", "w2"), { kind: "allow" });
	for (const id of ["chief", "elsewhere"]) {
		for (const name of ["schedule_edit", "schedule_view"]) assert.equal((await check(name, id, "w2")).kind, "deny");
	}
	assert.deepEqual(await check("schedule_edit", "chief", "m1"), { kind: "allow" });
	assert.deepEqual(await check("schedule_edit", "missing", "w2"), { kind: "allow" });
	assert.deepEqual(await check("schedule_list", "chief", "w2"), { kind: "allow" });
	assert.deepEqual(await check("schedule_edit", "chief", "outside"), { kind: "allow" });

	// schedule_list asks the tool for the Host range that holds the caller's page and keeps
	// the caller's own tasks. Other modules wrap tools/execute too.
	schedule.tasks.set("own2", {
		record: { id: "own2", kind: "at", title: "Mine too", prompt: "x", scheduledAt: "2030-01-01T00:00:00.000Z" },
		target: { kind: "session", sessionId: "w2" },
		status: "active",
	});
	const list = (ctx.listeners.get("tools/execute") ?? []).find(
		(listener: any) => listener.name === "listOwnSchedules",
	) as any;
	const asked: any[] = [];
	// The tool's own page: the catalog order, cut at offset and limit.
	const run = async (sessionId: string, args: any) => {
		const exec = { name: "schedule_list", arguments: args, agent: { id: sessionId } };
		const result: any = await list(exec, async () => {
			asked.push(exec.arguments);
			const { limit = 100, offset = 0 } = exec.arguments;
			const all = (await schedule.catalog()).map((entry) => ({
				id: entry.id,
				title: entry.title,
				target: entry.target,
			}));
			const items = all.slice(offset, offset + limit);
			return { isError: false, value: { items, shown: items.length, total: all.length, limit, offset } };
		});
		return { result, args: exec.arguments };
	};
	const second = await run("w2", { active: true, limit: 1, offset: 1 });
	assert.deepEqual(asked.at(-1), { active: true, limit: 1, offset: 3 });
	assert.deepEqual(second.args, { active: true, limit: 1, offset: 1 });
	assert.deepEqual(second.result.value, {
		items: [{ id: "own2", title: "Mine too", target: { kind: "session", sessionId: "w2" } }],
		shown: 1,
		total: 2,
		limit: 1,
		offset: 1,
	});
	const both = await run("w2", {});
	assert.deepEqual(asked.at(-1), { limit: 4, offset: 0 });
	assert.deepEqual(
		both.result.value.items.map((task: any) => task.id),
		["own", "own2"],
	);
	assert.deepEqual((await run("w2", { offset: 5 })).result.value, {
		items: [],
		shown: 0,
		total: 2,
		limit: 100,
		offset: 5,
	});
	// A page out of DSH's range goes to DSH as asked, and what comes back is still narrowed.
	const wide = await run("w2", { limit: 501 });
	assert.deepEqual(asked.at(-1), { limit: 501 });
	assert.deepEqual(
		wide.result.value.items.map((task: any) => task.id),
		["own", "own2"],
	);
	assert.equal(wide.result.value.total, 2);
	assert.deepEqual(
		(await run("m1", {})).result.value.items.map((task: any) => task.id),
		["chief"],
	);
	assert.equal((await run("outside", {})).result.value.items.length, 4);
});

test("a failed task move can resume without losing identical remaining tasks", async () => {
	const schedule = scheduleService();
	const { rt } = setup({ schedule });
	await schedule.create("w2", { title: "Ping", prompt: "Check", every_seconds: 3600 });
	await schedule.create("w2", { title: "Ping", prompt: "Check", every_seconds: 3600 });

	const create = (schedule as any).create;
	let attempts = 0;
	(schedule as any).create = async (...args: any[]) => {
		if (++attempts === 2) throw new Error("down");
		return create(...args);
	};
	await assert.rejects(rt.moveSchedules("w2", "s9"), /down/);
	const on = (id: string) => [...schedule.tasks.values()].filter((task: any) => task.sessionId === id);
	assert.equal(on("s9").length, 1);
	assert.equal(on("w2").length, 1);

	(schedule as any).create = create;
	await rt.moveSchedules("w2", "s9");
	assert.equal(on("s9").length, 2);
	assert.equal(on("w2").length, 0);
});
