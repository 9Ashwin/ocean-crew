// island's derivations and event lines, the app update rows, the feedback clock, and the
// DSH update rules. The page components themselves need the platform React run time, which
// the test process does not carry, so the modules that import it are loaded under a stub:
// registration happens at the top of this file, before any of those modules load.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { sameVersion, showsDshRow } from "../src/client/pages/dsh-offer.ts";
import {
	compact,
	HOUR,
	hourMs,
	MODEL,
	mondayOf,
	OWNER,
	percent,
	RANGES,
	spanRange,
	summarize,
	tokensOf,
} from "../src/client/pages/usage-data.ts";

// The smallest platform React the client modules call at import time; no component is
// rendered here, so hooks may be inert.
const REACT_STUB = `data:text/javascript,${encodeURIComponent(`
export const Fragment = Symbol.for("react.fragment");
export const createElement = () => null;
export const useEffect = () => {};
export const useLayoutEffect = () => {};
export const useMemo = (factory) => factory();
export const useRef = (initial) => ({ current: initial ?? null });
export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
export const useCallback = (callback) => callback;
export const useId = () => "id";
export const useSyncExternalStore = (_subscribe, get) => get();
export const startTransition = (action) => action();
export const memo = (component) => component;
export class Component {}
`)}`;
const REACT_DOM_STUB = "data:text/javascript,export const createPortal = () => null;";
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "react") return { url: REACT_STUB, shortCircuit: true, format: "module" };
		if (specifier === "react-dom") return { url: REACT_DOM_STUB, shortCircuit: true, format: "module" };
		return nextResolve(specifier, context);
	},
});

const loaded = new Map<string, Promise<any>>();
// The module set is fixed by the test file, not by input: this is the only way to load a
// module that imports the platform React, which has no copy in the test process.
function loadPage(name: "schedules" | "goal" | "about" | "feedback"): Promise<any> {
	if (!loaded.has(name)) loaded.set(name, import(`../src/client/pages/${name}.ts`));
	return loaded.get(name) as Promise<any>;
}

// ---------------------------------------------------------------------------
// usage-data: the ledger summed by hour, day, week, and month.

test("usage constants and presets are the earlier ones", () => {
	assert.deepEqual(
		RANGES.map((range) => [range.id, range.unit, range.count, range.stride]),
		[
			["24h", "hour", 24, 6],
			["7d", "day", 7, 1],
			["30d", "day", 30, 5],
			["12w", "week", 12, 2],
			["12m", "month", 12, 1],
		],
	);
	assert.deepEqual([HOUR, OWNER, MODEL], [0, 1, 2]);
	const row = ["2024-03-10 10", 0, 1, 2, 100, 50, 10, 20, 3];
	assert.equal(tokensOf(row as any), 180);
});

test("hour keys read as wall-clock UTC, and weeks start on Monday", () => {
	assert.equal(hourMs("2024-03-10 10"), Date.UTC(2024, 2, 10, 10));
	assert.equal(hourMs("2024-03-10"), Date.UTC(2024, 2, 10));
	assert.equal(mondayOf(Date.UTC(2024, 2, 10)), Date.UTC(2024, 2, 4));
	assert.equal(mondayOf(Date.UTC(2024, 2, 4)), Date.UTC(2024, 2, 4));
});

test("a picked span picks the unit and stride of its length", () => {
	const one = spanRange("2024-03-10", "2024-03-10");
	// Two days or less read by the hour, so a single picked day shows 24 bars.
	assert.equal(one.unit, "hour");
	assert.equal(one.days, 1);
	assert.equal(one.count, 24);
	const two = spanRange("2024-03-10", "2024-03-11");
	assert.equal(two.unit, "hour");
	assert.equal(two.count, 48);
	const week = spanRange("2024-03-04", "2024-03-10");
	assert.equal(week.unit, "day");
	assert.equal(week.count, 7);
	assert.equal(week.stride, 1);
	const months = spanRange("2023-01-01", "2024-12-31");
	assert.equal(months.unit, "month");
	assert.equal(months.count, 24);
	// The span is normalized when it is handed over backwards.
	assert.deepEqual(spanRange("2024-03-11", "2024-03-10"), spanRange("2024-03-10", "2024-03-11"));
});

test("summarize sums the range, its stacks, owners, models, and kinds", () => {
	const view = {
		now: "2024-03-10 12",
		rows: [
			["2024-03-09 10", 0, 1, 2, 100, 50, 10, 20, 3],
			["2024-03-10 09", 0, 1, 2, 200, 100, 0, 40, 5],
			["2024-03-10 11", 1, 0, 0, 7, 0, 0, 1, 1],
			["2024-03-08 23", 1, 0, 0, 11, 1, 1, 3, 2],
			["2024-02-01 00", 0, 0, 0, 999, 0, 0, 0, 1],
		],
	};
	const range = RANGES.find((item) => item.id === "7d") as (typeof RANGES)[number];
	const summary = summarize(view as any, range);
	assert.equal(summary.total.total, 180 + 340 + 8 + 16);
	assert.equal(summary.total.calls, 3 + 5 + 1 + 2);
	// Cache writes count as input in the totals.
	assert.equal(summary.total.input, 110 + 200 + 7 + 12);
	assert.equal(summary.total.cacheRead, 151);
	assert.equal(summary.total.output, 64);
	assert.equal(summary.previous, 0);
	assert.equal(summary.buckets.length, 7);
	const last = summary.buckets[summary.buckets.length - 1];
	assert.equal(last.key, "2024-03-10");
	assert.equal(last.sum.total, 348);
	assert.deepEqual([...last.stacks], [["all", 348]]);
	assert.deepEqual(
		[...summary.owners],
		[
			[0, { input: 310, cacheRead: 150, output: 60, calls: 8, total: 520 }],
			[1, { input: 19, cacheRead: 1, output: 4, calls: 3, total: 24 }],
		],
	);
	assert.deepEqual(
		[...summary.models],
		[
			[1, { input: 310, cacheRead: 150, output: 60, calls: 8, total: 520 }],
			[0, { input: 19, cacheRead: 1, output: 4, calls: 3, total: 24 }],
		],
	);
	// A keep filter narrows every sum, and a series function splits a bucket's bar.
	const kept = summarize(view as any, range, (row: any) => row[OWNER] === 1);
	assert.equal(kept.total.total, 24);
	assert.equal(kept.buckets[6].sum.total, 8);
	const series = summarize(view as any, range, undefined, (row: any) => (row[OWNER] === 0 ? "bot" : "rest"));
	assert.deepEqual(
		[...series.buckets[6].stacks],
		[
			["bot", 340],
			["rest", 8],
		],
	);
});

test("compact and percent follow the page's wording rules", () => {
	assert.equal(compact(0), "0");
	assert.equal(compact(999), "999");
	assert.equal(compact(1000), "1K");
	assert.equal(compact(1500), "1.5K");
	assert.equal(compact(999_999), "1M");
	assert.equal(compact(1_000_000), "1M");
	assert.equal(compact(1_234_567), "1.23M");
	assert.equal(compact(1e9), "1B");
	assert.equal(percent(0, 10), "0");
	assert.equal(percent(5, 0), "0");
	assert.equal(percent(1, 1000), "<1");
	assert.equal(percent(1, 100), "1");
	assert.equal(percent(1, 3), "33");
});

// ---------------------------------------------------------------------------
// dsh-offer: which DSH updates the update card offers.

test("sameVersion ignores a leading v and build metadata", () => {
	assert.equal(sameVersion("1.2.3", "1.2.3"), true);
	assert.equal(sameVersion("v1.2.3", "1.2.3"), true);
	assert.equal(sameVersion("1.2.3+build.9", "1.2.3"), true);
	assert.equal(sameVersion("", ""), false);
	assert.equal(sameVersion(undefined, "1.2.3"), false);
	assert.equal(sameVersion("1.2.3", "1.2.4"), false);
});

test("showsDshRow offers an npm update at once and an app update at the verified release", () => {
	assert.equal(showsDshRow({}, {}), false);
	assert.equal(showsDshRow({ verified: "1.2.3", current: "1.2.3" }, {}), false);
	assert.equal(showsDshRow({ verified: "v1.2.3", current: "1.2.2", kind: "npm" }, {}), true);
	const app = (phase: string, version: string) =>
		showsDshRow({ verified: "1.2.3", current: "1.2.2", kind: "app" }, { phase, version });
	assert.equal(app("ready", "1.2.3"), true);
	assert.equal(app("ready", "1.2.2"), false);
	assert.equal(app("idle", "1.2.3"), false);
	assert.equal(showsDshRow({ verified: "1.2.3+build", current: "1.2.2", kind: "npm" } as any, {}), true);
});

// ---------------------------------------------------------------------------
// schedules: how a task's timing reads.

test("timingText names every schedule kind", async () => {
	const { timingText } = await loadPage("schedules");
	assert.equal(timingText({ kind: "every", everySeconds: 60 }), "Every 1 minutes");
	assert.equal(timingText({ kind: "every", everySeconds: 1800 }), "Every 30 minutes");
	assert.equal(timingText({ kind: "every", everySeconds: 3600 }), "Every hour");
	assert.equal(timingText({ kind: "every", everySeconds: 7200 }), "Every 2 hours");
	assert.equal(timingText({ kind: "every", everySeconds: 86_400 }), "Every day");
	assert.equal(timingText({ kind: "every", everySeconds: 3 * 86_400 }), "Every 3 days");
	assert.equal(timingText({ kind: "daily", time: "09:05" }), "Every day at 09:05");
	assert.equal(timingText({ kind: "weekly", time: "08:00", weekdays: [1, 2, 3, 4, 5] }), "Every weekday at 08:00");
	assert.equal(timingText({ kind: "weekly", time: "08:00", weekdays: [6, 7] }), "Every weekend at 08:00");
	assert.equal(timingText({ kind: "weekly", time: "08:00", weekdays: [1, 3, 5] }), "Every Mon, Wed, Fri at 08:00");
	assert.equal(timingText({ kind: "weekly", time: "08:00", weekdays: [1, 2, 3, 4, 5, 6, 7] }), "Every day at 08:00");
	assert.equal(timingText({ kind: "cron", expression: "0 9 * * *" }), "On the schedule 0 9 * * *");
	assert.equal(timingText({ kind: "rrule" }), "Custom schedule");
	assert.equal(timingText({ kind: "other" }), "");
	// A foreign zone is named after the time; the machine's own zone is left implicit.
	const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
	assert.equal(timingText({ kind: "daily", time: "09:05", timeZone: local }), "Every day at 09:05");
	assert.ok(timingText({ kind: "daily", time: "09:05", timeZone: "Asia/Tokyo" }).endsWith(" (Asia/Tokyo)"));
	// A one-off task names its moment; the exact clock depends on the machine's locale.
	assert.ok(timingText({ kind: "at", scheduledAt: "2030-03-10T09:30:00.000Z" }).startsWith("Once, "));
});

// ---------------------------------------------------------------------------
// goal: what the island draws, as plain data.

test("a goal needs an admin among the room's members", async () => {
	const { hasGoalAdmin, canSetGoal } = await loadPage("goal");
	const roster = { byId: { a: { id: "a" }, b: { id: "b" } } };
	assert.equal(hasGoalAdmin(undefined, roster), false);
	assert.equal(hasGoalAdmin({ members: ["a"], admin: "a" }, roster), true);
	assert.equal(hasGoalAdmin({ members: ["b"], admin: "a" }, roster), false);
	assert.equal(hasGoalAdmin({ members: ["a"], admin: "z" }, roster), false);
	assert.equal(canSetGoal({ members: ["a"], admin: "a", goal: null }, roster), true);
	assert.equal(canSetGoal({ members: ["a"], admin: "a", goal: { status: "active" } }, roster), false);
	assert.equal(canSetGoal({ members: ["a"], admin: "a", goal: { status: "paused" } }, roster), false);
	assert.equal(canSetGoal({ members: ["a"], admin: "a", goal: { status: "complete" } }, roster), true);
});

test("goalView derives the capsule number, the bar label, the segments, and the faces", async () => {
	const { goalView } = await loadPage("goal");
	const roster = { byId: { a: { id: "a", name: "A" }, b: { id: "b", name: "B" } } };
	assert.equal(goalView(null, { roster }), null);
	const running = {
		status: "active",
		current: 0,
		title: "Ship it",
		stages: [
			{
				title: "Build",
				status: "current",
				acceptance: "builds",
				tasks: [
					{ botId: "a", task: "write", status: "working" },
					{ botId: "b", task: "test", status: "todo" },
				],
			},
			{ title: "Ship", status: "todo" },
		],
	};
	const view = goalView(running, { roster, roomWork: [{ botId: "b" }] });
	assert.equal(view.status, "active");
	assert.equal(view.number, 1);
	assert.equal(view.count, 2);
	assert.equal(view.barLabel, "Build");
	assert.deepEqual(view.segments, ["current", "todo"]);
	assert.deepEqual(
		view.faces.map((face: any) => [face.bot.id, face.working]),
		[
			["a", true],
			["b", true],
		],
	);
	assert.equal(view.stages[1].kind, "upcoming");
	assert.equal(view.stages[0].tasks[0].bot.id, "a");
	// Every task reported makes the stage "checking"; a paused goal with no idle marker
	// names the state in the bar.
	const checking = goalView(
		{
			...running,
			stages: [{ title: "Build", status: "current", tasks: [{ botId: "a", task: "x", status: "reported" }] }],
		},
		{ roster },
	);
	assert.equal(checking.segments[0], "checking");
	const paused = goalView({ ...running, status: "paused" }, { roster });
	assert.equal(paused.barLabel, "Paused · Build");
	assert.equal(paused.segments[0], "paused");
	const idle = goalView({ ...running, idle: true }, { roster });
	assert.equal(idle.barLabel, "Waiting for you · Build");
	const complete = goalView(
		{ status: "complete", title: "Done", stages: [{ title: "One", status: "passed" }] },
		{ roster },
	);
	assert.equal(complete.number, 1);
	assert.equal(complete.barLabel, "Goal reached");
	const stopped = goalView(
		{
			status: "stopped",
			stages: [
				{ title: "One", status: "passed" },
				{ title: "Two", status: "todo" },
			],
		},
		{ roster },
	);
	assert.equal(stopped.number, 1);
	assert.equal(stopped.barLabel, "Stopped");
});

test("goalEventText is the transcript's one line per goal change", async () => {
	const { goalEventText } = await loadPage("goal");
	assert.equal(goalEventText({ event: "draft" }), "Setting a goal");
	assert.equal(goalEventText({ event: "start", title: "Ship", count: 3 }), "Goal set: Ship · 3 stages");
	assert.equal(goalEventText({ event: "pass", count: 3 }), "All 3 stages passed");
	assert.equal(goalEventText({ event: "pass", stage: 1, next: "Ship" }), "Stage 1 passed · now stage 2: Ship");
	assert.equal(goalEventText({ event: "rework", stage: 2 }), "Stage 2 sent back for rework");
	assert.equal(goalEventText({ event: "revise" }), "Goal updated");
	assert.equal(goalEventText({ event: "pause" }), "Goal paused");
	assert.equal(goalEventText({ event: "resume" }), "Goal resumed");
	assert.equal(goalEventText({ event: "complete", title: "Ship" }), "Goal reached: Ship");
	assert.equal(goalEventText({ event: "stop" }), "Goal stopped");
	assert.equal(goalEventText({ title: "unchanged" }), "unchanged");
	assert.equal(goalEventText(null), "");
});

// ---------------------------------------------------------------------------
// about: the desktop app's own update row.

test("ownAppRow maps the app's update phases", async () => {
	const { ownAppRow } = await loadPage("about");
	assert.equal(ownAppRow(null), null);
	assert.equal(ownAppRow("checking"), null);
	assert.equal(ownAppRow({}), null);
	assert.deepEqual(ownAppRow({ phase: "checking" }), { hint: "Checking for updates…", button: null });
	assert.deepEqual(ownAppRow({ phase: "current" }), { hint: "Up to date", button: "check" });
	assert.deepEqual(ownAppRow({ phase: "downloading", version: "1.2.3" }), {
		hint: "Downloading 1.2.3…",
		button: null,
	});
	assert.deepEqual(ownAppRow({ phase: "downloaded", version: "1.2.3" }), {
		hint: "1.2.3 is ready; it installs when you restart",
		button: "restart",
	});
	assert.deepEqual(ownAppRow({ phase: "available", version: "1.2.3" }), {
		hint: "1.2.3 is available",
		button: "open",
	});
	assert.deepEqual(ownAppRow({ phase: "failed" }), { hint: "Could not check for updates.", button: "check" });
});

// ---------------------------------------------------------------------------
// feedback: the error log's clock.

test("whenText names a time today, and the day and time before that", async () => {
	const { whenText } = await loadPage("feedback");
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5);
	assert.equal(whenText(today.getTime()), today.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }));
	const older = new Date(2020, 0, 2, 13, 7);
	assert.equal(
		whenText(older.getTime()),
		`${older.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${older.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
	);
});

// The memory panel and the "Runs on" card hold no pure derivation of their own: their
// visible logic is hooks and rendered elements (the task grouping behind both lives in
// model-menu.ts), so tsc and the client build cover them, as the task says.
