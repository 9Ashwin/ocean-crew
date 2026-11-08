// Usage: the team's spend grouped by Bot and group chat, read from DSH's token-meter
// session projections.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/work/usage.ts";
import type { Bot, Room, TeamState } from "../src/shared/state.ts";
import { fakeContext } from "./fake-ctx.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	uncachedInputTokens: input,
	outputTokens: output,
	cacheReadTokens: cacheRead,
	cacheWriteTokens: cacheWrite,
});

interface Setup {
	rt: Runtime & Record<string, any>;
	view: () => Promise<any>;
}

function setup(
	options: { state?: Partial<TeamState>; sessions?: Record<string, any>; withoutRegistry?: boolean } = {},
): Setup {
	const sessions = options.sessions ?? {};
	const registry = {
		snapshot: (session: any) => ({ values: { tokenUsage: sessions[session.id] } }),
	};
	const ctx = fakeContext({ services: options.withoutRegistry ? {} : { sessionProjections: registry } }) as any;
	const state = {
		version: 1,
		mainBotIds: [],
		bots: {},
		rooms: {},
		revision: 1,
		...options.state,
	} as TeamState;
	const rt = {
		ctx,
		state,
		load: async () => {},
		resolveAgent: async (id: string) => (sessions[id] === undefined ? undefined : { session: { id } }),
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	return { rt, view: () => rt.usageView() };
}

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({ id, name, ...extra }) as Bot;

test("usage groups a Bot's parts and a group chat's Sessions, and adds the team total", async () => {
	const { view } = setup({
		state: {
			bots: {
				chief: bot("chief", "Chief", { sessionId: "s1", segments: [{ sessionId: "s2" }] }),
				writer: bot("writer", "Writer"),
			},
			rooms: {
				room1: {
					id: "room1",
					name: "Ops",
					members: ["chief", "writer"],
					mode: "admin",
					sessionId: "g1",
					sessions: { writer: "g2" },
				} as Room,
			},
		},
		sessions: {
			s1: usage(100, 10),
			s2: usage(5, 1, 2, 3),
			writer: usage(7, 2),
			g1: usage(20, 4),
			g2: usage(1, 1, 1, 1),
		},
	});
	const result = await view();
	assert.equal(result.available, true);
	const chief = result.rows.find((row: any) => row.id === "chief");
	assert.deepEqual(chief.totals, { input: 105, output: 11, cacheRead: 2, cacheWrite: 3 });
	assert.equal(chief.sessions, 2);
	const writer = result.rows.find((row: any) => row.id === "writer");
	assert.deepEqual(writer.totals, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 });
	const room = result.rows.find((row: any) => row.id === "room1");
	assert.deepEqual(room.totals, { input: 21, output: 5, cacheRead: 1, cacheWrite: 1 });
	assert.equal(room.kind, "room");
	assert.deepEqual(result.total, { input: 133, output: 18, cacheRead: 3, cacheWrite: 4 });
});

test("rows are sorted by spent tokens, then by name", async () => {
	const { view } = setup({
		state: {
			bots: { b: bot("b", "Beta"), a: bot("a", "Alpha") },
			rooms: { r: { id: "r", name: "Room", members: [], mode: "admin" } as Room },
		},
		sessions: { b: usage(10, 0), a: usage(10, 0) },
	});
	const result = await view();
	assert.deepEqual(
		result.rows.map((row: any) => row.name),
		["Alpha", "Beta", "Room"],
	);
});

test("without the projection service usage reports unavailable instead of zero spend", async () => {
	const { view } = setup({
		withoutRegistry: true,
		state: { bots: { a: bot("a", "Alpha") } },
	});
	const result = await view();
	assert.equal(result.available, false);
	assert.equal(result.rows.length, 1);
	assert.deepEqual(result.rows[0].totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.rows[0].sessions, 0);
});

test("a Session without a live agent or without a usage sample is skipped", async () => {
	const { view } = setup({
		state: {
			bots: { a: bot("a", "Alpha", { sessionId: "missing" }), b: bot("b", "Beta", { sessionId: "noUsage" }) },
		},
		sessions: { noUsage: undefined, present: usage(3, 1) },
	});
	const result = await view();
	const alpha = result.rows.find((row: any) => row.id === "a");
	const beta = result.rows.find((row: any) => row.id === "b");
	assert.equal(alpha.sessions, 0);
	assert.equal(beta.sessions, 0);
	assert.deepEqual(result.total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
