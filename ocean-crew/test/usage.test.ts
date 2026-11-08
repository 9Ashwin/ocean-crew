// Usage behavior: the ledger folds a Session's log into one row per billed attempt, scans
// every known Session into usage.sqlite (rebuilding the file only when it is proven
// damaged), meters the calls that no Session log holds, and answers tokens per hour,
// owner, model and use. A scan that cannot read Sessions says so once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "node:util";
import type { Runtime } from "../src/host/core/runtime.ts";
import { foldCalls, install } from "../src/host/work/usage.ts";
import { fakeContext } from "./fake-ctx.ts";

const header = (provider: string, model: string) => ({
	type: "request/header",
	data: { header: { config: { provider, model } }, reason: "change" },
});
const message = (turn: number, step: number, usage: any, time = 0) => ({
	type: "assistant/message",
	time,
	data: { turn, step, message: { role: "assistant", content: [] }, stream: [], usage },
});
const streamed = (type: string, turn: number, step: number, usage: any, time = 0) => ({
	type,
	time,
	data: { turn, step, stream: [{ type: "chunk", chunk: { type: "usage", usage } }] },
});
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) => ({
	inputTokens,
	outputTokens,
	cacheReadTokens,
});
const tokens = (row: any) => [row.model, row.input, row.cacheRead, row.output];

test("each billed attempt is one row, on the model its request named", () => {
	const { rows, state } = foldCalls([
		header("deepseek", "v4-flash"),
		// A failed attempt, then its retry: two billed attempts in one step.
		streamed("assistant/attempt", 1, 0, usage(10, 0)),
		{ type: "llm/retry-started", data: { turn: 1, step: 0 } },
		message(1, 0, usage(20, 3, 5)),

		streamed("assistant/message", 1, 1, usage(30, 1)),
		message(1, 1, usage(30, 4, 2)),
		header("deepseek", "v4-pro"),
		streamed("assistant/message", 2, 0, usage(7, 7)),
		// No usage reported: nothing billed to count.
		message(2, 1, undefined),
	]);
	assert.deepEqual(rows.map(tokens), [
		["v4-flash", 10, 0, 0],
		["v4-flash", 20, 5, 3],
		["v4-flash", 30, 2, 4],
		["v4-pro", 7, 0, 7],
	]);
	assert.deepEqual(state, { provider: "deepseek", model: "v4-pro", retry: { turn: 1, step: 0, count: 1 } });
});

test("a fold goes on from where the last read stopped", () => {
	const first = foldCalls([
		header("p", "m"),
		streamed("assistant/attempt", 3, 2, usage(1, 0)),
		{ type: "llm/retry-started", data: { turn: 3, step: 2 } },
	]);
	const { rows } = foldCalls([message(3, 2, usage(2, 2))], first.state);
	assert.deepEqual(
		rows.map((row) => [row.key, ...tokens(row)]),
		[["3:2:1", "m", 2, 0, 2]],
	);
});

test("a fork does not count the calls it inherited from its parent", () => {
	const { rows, reset } = foldCalls([
		header("p", "m"),
		message(1, 0, usage(100, 100)),
		{ type: "session/end-seed", data: { inherited: true } },
		message(2, 0, usage(1, 1)),
	]);
	assert.equal(reset, true);
	assert.deepEqual(rows.map(tokens), [["m", 1, 0, 1]]);
});

const HOUR = 3_600_000;
const LONG_AGO = 1_000;

// A team with Chief (whose own chat and subagent both count), Writer in a group chat, and
// the DSH Agent; the Session logs the scan reads.
const TEAM = {
	version: 1,
	mainBotIds: ["b1"],
	revision: 1,
	bots: {
		b1: {
			id: "b1",
			sessionId: "s-b1",
			segments: [{ sessionId: "b1", endedAt: LONG_AGO }],
			name: "Chief",
			instructions: "",
			createdAt: 1,
		},
		b2: { id: "b2", sessionId: "b2", name: "Writer", instructions: "", createdAt: 2 },
	},
	rooms: {
		r1: {
			id: "r1",
			name: "研发群",
			named: true,
			members: ["b1", "b2"],
			admin: "b1",
			mode: "everyone",
			notice: "",
			sessions: { b1: "s-g1" },
			log: [],
			createdAt: 3,
		},
	},
	agents: { a1: { id: "a1", name: "DSH Agent", sessions: ["s-a1"], createdAt: 4 } },
	exchanges: [],
	exchangeTurns: {},
	questions: {},
};

const LOGS: Record<string, any[]> = {
	b1: [header("deepseek", "v4-flash"), message(1, 0, usage(100, 10, 50), 0)],
	"s-b1": [header("deepseek", "v4-flash"), message(1, 0, usage(200, 20), HOUR)],
	"s-g1": [header("deepseek", "v4-pro"), message(1, 0, usage(300, 30), HOUR)],
	"s-sub": [header("deepseek", "v4-flash"), message(1, 0, usage(5, 5), HOUR)],
	"s-x": [header("kimi", "k3"), message(1, 0, usage(40, 4), 2 * HOUR)],
	"s-a1": [header("deepseek", "v4-flash"), message(1, 0, usage(70, 7), HOUR)],
};

interface StartOptions {
	listedExtra?: any[];
	logsExtra?: Record<string, any[]>;
	subagentsExtra?: Record<string, string>;
	state?: any;
}

function start(home: string, { listedExtra, logsExtra, subagentsExtra, state: seeded }: StartOptions = {}) {
	const logs: Record<string, any[]> = { ...LOGS, ...logsExtra };
	for (const log of Object.values(logs)) {
		log.forEach((event, seq) => {
			event.seq = seq;
		});
	}
	// Child Session → the parent its header names, as DSH checks a page address.
	const subagents: Record<string, string> = { "s-sub": "s-b1", ...subagentsExtra };
	const pages: string[] = [];
	const warnings: unknown[][] = [];
	const ctx = fakeContext() as any;
	ctx.logger.warn = (template: string, ...args: unknown[]) => warnings.push([template, ...args]);
	ctx.sessionController = {
		list: async () => ({
			items: [
				{ sessionId: "s-x", projections: { kind: "cached", asOfSeq: 1, values: {} } },
				{
					sessionId: "s-sub",
					parentSessionId: "s-b1",
					origin: "subagent",
					projections: { kind: "cached", asOfSeq: 1, values: {} },
				},
				{ sessionId: "s-empty", blank: true },
				...(listedExtra ?? []),
			],
		}),
		projections: async ({ sessionId }: any) =>
			logs[sessionId] ? { asOfSeq: logs[sessionId].length - 1, values: {} } : null,
		page: async ({ address, throughSeq, beforeSeq }: any) => {
			const sessionId = address.kind === "session" ? address.sessionId : address.childSessionId;
			if (address.kind === "session" && sessionId in subagents)
				throw new Error("subagent Sessions require their durable parent address");
			if (address.kind === "subagent" && subagents[sessionId] !== address.parentSessionId)
				throw new Error("subagent does not belong to the supplied parent");
			if (logs[sessionId] === undefined) throw new Error(`no log for ${sessionId}`);
			pages.push(sessionId);
			const events = logs[sessionId].filter(
				(event) => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq),
			);
			return { records: events.map((event) => ({ event })), hasMore: false };
		},
	};
	const state = seeded ?? JSON.parse(JSON.stringify(TEAM));
	const rt: any = {
		ctx,
		home,
		state,
		load: async () => {},
		warn: (...args: unknown[]) => warnings.push([format(String(args[0]), ...args.slice(1))]),
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		sessionOfRoom: (room: any) => room?.sessionId ?? room?.id,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		roomOf: (id?: string) => (id === undefined ? undefined : state.rooms[id]),
		cachedCatalog: () => [],
		own: (table: any, key: string) =>
			table !== null && table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined,
	};
	install(rt as Runtime);
	if (typeof ctx === "object" && typeof (ctx as any).dispose === "function")
		pendingDispose.push(() => (ctx as any).dispose());
	const meter = (ctx.listeners.get("llm/stream") ?? []).at(-1);
	return { rt, ctx, meter, pages, warnings, state };
}

// Total tokens per owner name and use.
const totals = (view: any) => {
	const sums: Record<string, number> = {};
	for (const [, owner, , kind, input, cacheRead, cacheWrite, output] of view.rows) {
		const name = view.owners[owner].name ?? view.owners[owner].key;
		const key = `${name}/${view.kinds[kind]}`;
		sums[key] = (sums[key] ?? 0) + input + cacheRead + cacheWrite + output;
	}
	return sums;
};

async function drain(stream: AsyncIterable<any>): Promise<any[]> {
	const chunks: any[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

// The module opens a SQLite ledger in the home; close it before the temporary directory
// is removed, or Windows refuses to unlink the open database file.
const pendingDispose: Array<() => Promise<unknown>> = [];
const freshHome = (t: any): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-usage-"));
	pendingDispose.length = 0;
	t.after(async () => {
		for (const dispose of pendingDispose.splice(0).reverse()) await dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
	});
	return home;
};

test("the usage view counts every Session under its owner, by hour in the asked time zone", async (t) => {
	const home = freshHome(t);
	const { rt, ctx, meter, pages } = start(home);
	const view = await rt.usageView({ timeZone: "Asia/Shanghai" });
	// Chief: both parts of its own chat and its subagent; its group Session counts as group
	// use. The DSH Agent's Sessions count beside the Bots, not with the other sessions.
	assert.deepEqual(totals(view), { "Chief/chat": 390, "Chief/group": 330, "DSH Agent/chat": 77, "other/chat": 44 });
	assert.deepEqual(
		view.rows.map((row: any[]) => row[0]),
		["1970-01-01 08", "1970-01-01 09", "1970-01-01 09", "1970-01-01 09", "1970-01-01 10"],
	);
	assert.deepEqual(view.models.map((model: any) => model.key).sort(), [
		"deepseek/v4-flash",
		"deepseek/v4-pro",
		"kimi/k3",
	]);
	assert.equal(view.scanning, false);
	assert.ok(!pages.includes("s-empty"));

	// A Session's own requests are in its log, so the meter lets them through untouched.
	const passed = (async function* () {
		yield { type: "usage", usage: usage(1, 1) };
	})();
	assert.equal(
		meter({ sessionId: "s-b1", messages: [] }, () => passed),
		passed,
	);
	// A checkpoint is outside every log: the meter counts it, once.
	const chunk = { type: "usage", usage: usage(1000, 100) };
	assert.deepEqual(
		await drain(
			meter(
				{ sessionId: "s-b1", purpose: "compaction", provider: "deepseek", model: "v4-flash", messages: [] },
				async function* () {
					yield chunk;
				},
			),
		),
		[chunk],
	);
	await drain(
		meter(
			{ sessionId: "s-b1", purpose: "compaction", provider: "deepseek", model: "v4-flash", messages: [] },
			async function* () {
				yield chunk;
			},
		),
	);
	const again = await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(totals(again)["Chief/compaction"], 1100);
	await ctx.dispose();
});

test("a call made in a group chat stays group use after the room is gone", async (t) => {
	const home = freshHome(t);
	const first = start(home);
	assert.equal(totals(await first.rt.usageView({ timeZone: "Asia/Shanghai" }))["Chief/group"], 330);
	await first.ctx.dispose();

	const state = JSON.parse(JSON.stringify(TEAM));
	state.rooms = {};
	const second = start(home, { state });
	assert.equal(totals(await second.rt.usageView({ timeZone: "Asia/Shanghai" }))["Chief/group"], 330);
	await second.ctx.dispose();
});

test("a plain chat journals its owner before the first scan, so a deleted Bot keeps its name", async (t) => {
	const home = freshHome(t);
	const first = start(home);
	const passed = (async function* () {
		yield { type: "text", text: "hi" };
	})();
	assert.equal(
		first.meter({ sessionId: "b2", messages: [] }, () => passed),
		passed,
	);
	// The owner is written once the team and the ledger have loaded behind the meter.
	for (let tries = 0; ; tries += 1) {
		await delay(20);
		const dbPath = join(home, "usage.sqlite");
		let found = false;
		try {
			const db = new DatabaseSync(dbPath);
			try {
				found = db
					.prepare("SELECT session FROM owners")
					.all()
					.some((row: any) => row.session === "b2");
			} finally {
				db.close();
			}
		} catch {
			found = false;
		}
		if (found) break;
		assert.ok(tries < 200, "the owner of b2 was never journaled");
	}
	await first.ctx.dispose();

	const state = JSON.parse(JSON.stringify(TEAM));
	delete state.bots.b2;
	const second = start(home, {
		state,
		listedExtra: [{ sessionId: "b2", projections: { kind: "cached", asOfSeq: 1, values: {} } }],
		logsExtra: { b2: [header("deepseek", "v4-flash"), message(1, 0, usage(50, 5), HOUR)] },
	});
	assert.equal(totals(await second.rt.usageView({ timeZone: "Asia/Shanghai" }))["Writer/chat"], 55);
	await second.ctx.dispose();
});

test("a subagent Session is read through its parent, even a parent that is gone; one that cannot be read warns once", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 10 * HOUR });
	const home = freshHome(t);
	const { rt, pages, warnings } = start(home, {
		listedExtra: [
			{
				sessionId: "s-orphan",
				parentSessionId: "s-gone",
				origin: "subagent",
				projections: { kind: "cached", asOfSeq: 1, values: {} },
			},
			{ sessionId: "s-lost", origin: "subagent", projections: { kind: "cached", asOfSeq: 1, values: {} } },
			{ sessionId: "s-broken", projections: { kind: "sequenced", asOfSeq: 1, values: {} } },
			{ sessionId: "s-broken2", projections: { kind: "sequenced", asOfSeq: 1, values: {} } },
		],
		logsExtra: {
			"s-orphan": [header("deepseek", "v4-flash"), message(1, 0, usage(8, 1), HOUR)],
			"s-lost": [header("deepseek", "v4-flash"), message(1, 0, usage(9, 9), HOUR)],
		},
		subagentsExtra: { "s-orphan": "s-gone", "s-lost": "s-gone" },
	});
	const view = await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(totals(view)["Chief/chat"], 390);
	assert.equal(totals(view)["other/chat"], 44 + 9);
	// No parent on record: it cannot be addressed, so it is not asked for.
	assert.ok(!pages.includes("s-lost"));
	// A scan reports one summarized line, not one per Session it could not read.
	const unread = () =>
		warnings
			.map(([template, ...args]) => (template === "%s" ? args[0] : template))
			.filter((line) => String(line).includes("usage could not read"));
	assert.equal(unread().length, 1);
	assert.match(String(unread()[0]), /usage could not read 2 Sessions: s-broken, s-broken2 \(first error: /);

	t.mock.timers.tick(60_000);
	await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(pages.filter((sessionId) => sessionId === "s-orphan").length, 1);
	assert.equal(unread().length, 1);
});

test("a cold Session seals at its checkpoint watermark and is read again once it warms or the watermark moves", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 10 * HOUR });
	const home = freshHome(t);
	const logX = [header("kimi", "k3"), message(1, 0, usage(40, 4), 2 * HOUR)];
	const { rt, ctx } = start(home, { logsExtra: { "s-x": logX } });
	let reads = 0;
	const projections = ctx.sessionController.projections;
	ctx.sessionController.projections = async (request: any) => {
		if (request.sessionId === "s-x") reads += 1;
		return projections(request);
	};
	let agentAvailable = false;
	let watermark = 1;
	ctx.sessionController.list = async () => ({
		items: [
			{
				sessionId: "s-x",
				agentAvailable,
				running: false,
				projections: { kind: "cached", asOfSeq: watermark, values: {} },
			},
		],
	});
	const scan = async () => {
		t.mock.timers.tick(60_000);
		return rt.usageView({ timeZone: "Asia/Shanghai" });
	};
	// First scan: cold but never read, so read once and sealed.
	await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(reads, 1);
	// Still cold at the same watermark: the seal skips it without any read.
	await scan();
	assert.equal(reads, 1);
	// Listed warm, a scan reads it and clears the seal, since it may run.
	agentAvailable = true;
	await scan();
	assert.equal(reads, 2);
	// Cold again: read once more, then sealed at the watermark and skipped.
	agentAvailable = false;
	await scan();
	assert.equal(reads, 3);
	await scan();
	assert.equal(reads, 3);
	// The log grew and its checkpoint moved on: read again, and the new calls count.
	logX.push({ ...message(2, 0, usage(7, 7)), seq: 2 } as any);
	watermark = 2;
	const view = await scan();
	assert.equal(reads, 4);
	assert.equal(totals(view)["other/chat"], 44 + 14);
	await scan();
	assert.equal(reads, 4);
});

test("a damaged ledger is rebuilt once, and its rows are readable again", async (t) => {
	const home = freshHome(t);
	writeFileSync(join(home, "usage.sqlite"), "not a database file");
	const { rt, warnings } = start(home);
	const view = await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(totals(view)["Chief/chat"], 390);
	// The file was replaced by a real ledger, at the current version.
	const db = new DatabaseSync(join(home, "usage.sqlite"));
	try {
		assert.equal((db.prepare("PRAGMA user_version").get() as any).user_version, 3);
	} finally {
		db.close();
	}
	assert.equal(
		warnings.some((args) => String(args[0]).includes("in memory only")),
		false,
	);
});

test("a ledger from the previous version keeps its metered calls and gains the seal watermark", async (t) => {
	const home = freshHome(t);
	const first = start(home);
	const chunk = { type: "usage", usage: usage(1000, 100) };
	await drain(
		first.meter(
			{ sessionId: "s-b1", purpose: "compaction", provider: "deepseek", model: "v4-flash", messages: [] },
			async function* () {
				yield chunk;
			},
		),
	);
	await first.rt.usageView({ timeZone: "Asia/Shanghai" });
	await first.ctx.dispose();
	const db = new DatabaseSync(join(home, "usage.sqlite"));
	db.exec("ALTER TABLE marks DROP COLUMN listed; PRAGMA user_version = 2");
	db.close();

	const second = start(home);
	const view = await second.rt.usageView({ timeZone: "Asia/Shanghai" });
	await second.ctx.dispose();
	assert.equal(totals(view)["Chief/compaction"], 1100);
	assert.equal(totals(view)["Chief/chat"], 390);
	assert.deepEqual(second.warnings, []);
});

test("a cached projection watermark is not used as a page cursor", async (t) => {
	const home = freshHome(t);
	const { rt, ctx, warnings } = start(home, {
		listedExtra: [{ sessionId: "s-x", projections: { kind: "cached", asOfSeq: 202, values: {} } }],
	});
	const page = ctx.sessionController.page;
	ctx.sessionController.page = async (request: any) => {
		if (request.address.sessionId === "s-x" && request.throughSeq > 1)
			throw new Error(`session page through seq ${request.throughSeq} is past cursor 1`);
		return page(request);
	};
	const view = await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(totals(view)["other/chat"], 44);
	assert.deepEqual(warnings, []);
	await ctx.dispose();
});

test("a sequenced projection watermark cuts the page without another projection read", async (t) => {
	const home = freshHome(t);
	const { rt, ctx } = start(home, {
		listedExtra: [{ sessionId: "s-x", projections: { kind: "sequenced", asOfSeq: 1, values: {} } }],
	});
	const projections = ctx.sessionController.projections;
	ctx.sessionController.projections = async (request: any) => {
		assert.notEqual(request.sessionId, "s-x");
		return projections(request);
	};
	const view = await rt.usageView({ timeZone: "Asia/Shanghai" });
	assert.equal(totals(view)["other/chat"], 44);
	await ctx.dispose();
});
