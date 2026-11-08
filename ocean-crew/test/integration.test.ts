// context, the browser route answers, and the state view projects a saved team. This is
// the seam no single module test covers — module order, cross-module calls at run time,
// and the api/bot contract from docs/contracts.md.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DshContext } from "../src/host/core/runtime.ts";
import { createRuntime } from "../src/index.ts";
import { fakeContext } from "./fake-ctx.ts";

const TEAM = {
	version: 1,
	revision: 7,
	mainBotIds: ["chief"],
	bots: {
		chief: {
			id: "chief",
			name: "Chief",
			role: "Chief of Staff",
			sessionId: "chief-current",
			segments: [{ sessionId: "chief-past" }],
		},
		writer: { id: "writer", name: "Writer", role: "Writer" },
	},
	rooms: {
		room1: {
			id: "room1",
			name: "Room",
			named: true,
			members: ["chief", "writer"],
			mode: "admin",
			admin: "chief",
			sessionId: "room-current",
			sessions: { writer: "room-writer" },
		},
	},
	exchanges: [],
	questions: {},
	views: {},
	works: {},
	requests: {},
	agentState: null,
};

function host(t: { after(fn: () => void | Promise<void>): void }) {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-integration-"));
	if (TEAM !== undefined) writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	const ctx = fakeContext();
	const prompts: unknown[] = [];
	const archived: string[] = [];
	// The DSH services the modules reach directly;
	Object.assign(ctx, {
		workspaceRegistry: {
			archivedSessionIds: [],
			archiveSession: async (sessionId: string) => {
				archived.push(sessionId);
				return {};
			},
			unarchiveSession: async () => ({}),
			get: () => undefined,
		},
		sessions: { flush: async () => {} },
		sessionController: {
			prompt: async (request: unknown) => {
				prompts.push(request);
			},
			// The session controller also serves the usage index, which reads saved
			// projections and pages; the fixture team has no such Session data.
			projections: async () => null,
			page: async () => undefined,
			list: async () => ({ items: [] }),
		},
		llm: {
			listProviders: () => [],
			registerAdapter: () => {
				const handle = (() => {}) as (() => void) & { replace: (next: unknown) => void };
				handle.replace = () => {};
				return handle;
			},
		},
	});
	let route: any;
	const register = ctx.connection.fetch.register;
	ctx.connection.fetch.register = (candidate: any) => {
		route = candidate;
		return register(candidate);
	};
	const rt = createRuntime(ctx as unknown as DshContext, { home });
	// The api/bot handler refreshes the team before answering.
	const call = async (endpoint: string, payload: Record<string, unknown> = {}) => {
		const response = await route.fetch(
			new Request("http://localhost/api/bot", { method: "POST", body: JSON.stringify({ endpoint, payload }) }),
		);
		return response.json();
	};
	t.after(async () => {
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	});
	return { ctx, rt, call, prompts, archived, home };
}

test("every M2 module installs in the earlier order and registers the api route", async (t) => {
	const { ctx, rt } = host(t);
	// The install order is the contract: usage meters last, privacy before the tool hooks,
	// feed before channel. Each module contributes at least one registration.
	const calls = ctx.calls;
	assert.ok(calls.includes("effect ocean-crew: state lock"), "store");
	// Tools are scoped per Bot Session, never registered globally; their module only
	// contributes them to the shared team-tool list.
	assert.ok(rt.teamTools.map((tool) => tool.name).includes("list_bots"), "tools");
	assert.ok(calls.includes("prompt bot-identity 640"), "prompt");
	assert.ok(
		calls.some((call) => call.startsWith("route POST /api/bot")),
		"channel",
	);
	assert.ok(
		calls.some((call) => call.startsWith("route GET /api/bot/feed")),
		"feed",
	);
	// Cross-module members are all present on the runtime.
	for (const member of [
		"botOf",
		"state",
		"catalog",
		"permissionCatalog",
		"deliver",
		"createBot",
		"sessionFolder",
		"workOf",
		"admitRequest",
		"live",
		"keepGroupLine",
		"syncScopedTools",
		"stopChat",
		"sendUser",
		"activityView",
		"workView",
		"roomProgress",
	]) {
		assert.notEqual((rt as any)[member], undefined, member);
	}
});

test("the state answer projects the saved team without leaking internals", async (t) => {
	const { call } = host(t);
	const answer = await call("state");
	assert.equal(answer.ok, true);
	const value = answer.value;
	// Loading an older-shaped team writes the migrated file once, so the revision only
	// moves forward.
	assert.ok(value.revision >= 7, String(value.revision));
	assert.equal(value.mainBotId, "chief");
	assert.deepEqual(value.mainBotIds, ["chief"]);

	const chief = value.bots.find((bot: any) => bot.id === "chief");
	assert.equal(chief.sessionId, "chief-current");
	assert.deepEqual(chief.parts, ["chief-past"]);
	// A group's current Session resolves the same way and its member Sessions are listed
	// as parts for usage.
	const room = value.rooms.find((entry: any) => entry.id === "room1");
	assert.equal(room.sessionId, "room-current");
	assert.deepEqual(room.parts, ["room-writer"]);
	assert.equal(room.mode, "admin");
	assert.equal(room.admin, "chief");
	// The saved team file is not part of the wire answer.
	assert.equal(value.state, undefined);
	assert.equal(value.works, undefined);
	// Secrets are names and who may use them; values never leave the host.
	assert.deepEqual(value.secrets, []);

	assert.equal(value.memory, true);
	assert.deepEqual(value.memoryNews, {});
	assert.equal(value.memoryReviews, 0);
	assert.equal(value.readOnly, null);
	assert.equal(typeof value.modelsKey, "string");
	assert.equal(typeof value.liveKey, "string");
});

test("a Bot or a group Session resolves to its current Session on send", async (t) => {
	const { call, prompts } = host(t);
	assert.deepEqual(await call("send", { sessionId: "chief", text: "hello" }), { ok: true, value: true });
	assert.deepEqual(await call("send", { sessionId: "room1", text: "hello group" }), { ok: true, value: true });
	assert.deepEqual(await call("send", { sessionId: "chief-past", text: "hello past" }), { ok: true, value: true });
	const sessions = prompts.map((request: any) => request.sessionId);
	assert.deepEqual(sessions, ["chief-current", "room-current", "chief-current"]);
	for (const request of prompts as any[]) {
		assert.equal(request.mode, "queue");
		assert.equal(typeof request.requestId, "string");
		assert.deepEqual(request.content, [{ type: "text", text: request.content[0].text }]);
	}
});

test("unknown and not-yet-built endpoints answer the documented error codes", async (t) => {
	const { call } = host(t);
	const unknown = await call("nonsense");
	assert.equal(unknown.ok, false);
	assert.equal(unknown.error.code, "bot/not-found");

	// Every endpoint now has its module, so an unknown name is the only miss; a known
	// endpoint answers through its module.
	const missing = await call("nothing-here");
	assert.equal(missing.error?.code, "bot/not-found");
	const known = await call("im-add", {});
	assert.notEqual(known.error?.code, "bot/not-found");
});

test("M3 endpoints answer once their modules are installed", async (t) => {
	const { call } = host(t);
	const calls: Array<[string, Record<string, unknown>?]> = [
		["providers"],
		["usage"],
		["schedules"],
		["memory-view", { botId: "chief" }],
		["diagnostics"],
		["avatar-library"],
	];
	for (const [endpoint, payload] of calls) {
		const answer = await call(endpoint, payload);
		assert.equal(answer.ok, true, `${endpoint}: ${JSON.stringify(answer.error)}`);
	}
});
