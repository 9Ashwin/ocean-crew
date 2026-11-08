// against the fake DSH context, the api/bot and feed routes are registered, the state view

// modules, and disposal tears the runtime down without a module failing to clean up. This is
// the seam no single module test covers: install order, cross-module members and the wire
// contract from docs/contracts.md.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DshContext } from "../src/host/core/runtime.ts";
import { createRuntime } from "../src/index.ts";
import type { FakeRoute } from "./fake-ctx.ts";
import { fakeContext } from "./fake-ctx.ts";

// A one-Bot team with one group, so `state` answers without bootstrapping a new Main Bot
// (that path needs a real DSH workspace and Session controller).
// shapes of this small team, not of a fixture's projections.
const TEAM = {
	version: 1,
	revision: 3,
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
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-team-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	const ctx = fakeContext();
	const prompts: unknown[] = [];
	// The DSH services the modules reach directly.
	// use, cuaAccess, fileUploads) are deliberately absent: their modules must stay usable
	// without them, and the endpoints must say so.
	Object.assign(ctx, {
		workspaceRegistry: {
			archivedSessionIds: [],
			archiveSession: async (sessionId: string) => {
				prompts.push(sessionId);
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
	// Capture every route the modules register, so the test can both assert on the
	// registration and call the api/bot handler.
	const routes: FakeRoute[] = [];
	// What the modules hand back from `connection.fetch.register` is their route disposer;
	// the test records a route as released when the runtime's effects are disposed.
	const released: string[] = [];
	const originalRegister = ctx.connection.fetch.register;
	ctx.connection.fetch.register = (candidate) => {
		routes.push(candidate);
		const off = originalRegister(candidate);
		return () => {
			released.push(candidate.path);
			return off();
		};
	};
	const rt = createRuntime(ctx as unknown as DshContext, { home });
	const api = routes.find((route) => route.path === "/api/bot");
	assert.ok(api !== undefined, "the channel registered /api/bot");
	// The api/bot handler refreshes the team before answering.
	const call = async (endpoint: string, payload: Record<string, unknown> = {}) => {
		const response = await api.fetch(
			new Request("http://localhost/api/bot", { method: "POST", body: JSON.stringify({ endpoint, payload }) }),
		);
		return response.json();
	};
	t.after(async () => {
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	});
	return { ctx, rt: rt as unknown as Record<string, any>, routes, released, call, prompts, home };
}

test("every M2–M5 module installs, and the routes and M5 members are present", async (t) => {
	const { ctx, rt, routes } = host(t);
	const calls = ctx.calls;
	// Every module registered at least one thing: the runtime object is only complete when
	// MODULES has run, so a short list of registrations means an install went missing.
	assert.ok(calls.length > 60, `only ${calls.length} registrations`);
	assert.ok(rt.teamTools.length > 0, "M2-M5 modules contributed team tools");

	assert.ok(calls.includes("effect ocean-crew: state lock"), "store");
	assert.ok(
		calls.some((call) => call.startsWith("route POST /api/bot")),
		"api/bot route",
	);
	assert.ok(
		calls.some((call) => call.startsWith("route GET /api/bot/feed")),
		"feed route",
	);
	assert.ok(calls.includes("effect ocean-crew: browser channel") || rt.browserChannel === undefined, "browser module");
	assert.ok(calls.includes("effect ocean-crew: im"), "im module");
	assert.ok(calls.includes("effect ocean-crew: computer use"), "computer module");
	assert.ok(calls.includes("effect ocean-crew: api route"), "channel module");
	// The two routes the browser and the feed clients depend on.
	assert.equal(routes.filter((route) => route.path === "/api/bot" && route.methods.includes("POST")).length, 1);
	assert.equal(routes.filter((route) => route.path === "/api/bot/feed" && route.methods.includes("GET")).length, 1);
	// The feed route is live, not just registered: an opened stream answers with SSE.
	const feed = routes.find((route) => route.path === "/api/bot/feed");
	assert.ok(feed !== undefined);
	const stream = await feed.fetch(new Request("http://localhost/api/bot/feed"));
	assert.equal(stream.status, 200);
	assert.match(String(stream.headers.get("content-type")), /text\/event-stream/);
	await stream.body?.cancel();

	for (const member of [
		"imView",
		"imStatusView",
		"imViaView",
		"imEndpoint",
		"browserEnabled",
		"browserOpen",
		"computerEndpoint",
		"computerView",
		"computerStatus",
		"computerLive",
		"computerLevelOf",
		"computerEnabled",
	]) {
		assert.notEqual(rt[member], undefined, member);
	}
	// No Desktop profile in the fake context: browsers stay off, with the member set the
	// channel checks (browserOpen present, browserChannel absent).
	assert.equal(rt.browserEnabled, false);
	assert.equal(typeof rt.browserOpen, "function");
	assert.equal(typeof rt.imView, "function");
});

test("the state answer carries the M5 fields with the earlier view shapes", async (t) => {
	const { rt, call } = host(t);
	const answer = await call("state");
	assert.equal(answer.ok, true, JSON.stringify(answer.error ?? answer));
	const value = answer.value;

	assert.deepEqual(
		value.bots.map((bot: any) => bot.id),
		["chief", "writer"],
	);
	assert.deepEqual(
		value.rooms.map((room: any) => room.id),
		["room1"],
	);
	assert.equal(value.readOnly, null);
	assert.equal(typeof value.modelsKey, "string");
	assert.equal(typeof value.liveKey, "string");

	assert.equal(value.browser, false);
	assert.deepEqual(value.im, { connections: [], platforms: ["weixin", "feishu"] });
	assert.deepEqual(value.computer, {
		enabled: false,
		provider: { state: "off" },
		macos: process.platform === "darwin",
		bots: { chief: { level: "background", apps: {} }, writer: { level: "background", apps: {} } },
	});
	// The same shapes are what the runtime members publish for the live/status channels.
	assert.deepEqual(rt.imView(), value.im);
	assert.deepEqual(rt.imStatusView(), {});
	assert.deepEqual(rt.imViaView(), {});
	assert.deepEqual(rt.computerView(), value.computer);
	assert.deepEqual(rt.computerStatus(), { state: "off" });
	assert.deepEqual(rt.computerLive(), { bots: {}, leases: [], cursors: [], asks: {}, holds: {} });
});

test("M5 endpoints answer through their modules, and say what is missing", async (t) => {
	const { call } = host(t);
	// The browser module is installed but this host has no Desktop Bridge: the channel keeps

	const wait = await call("browser-wait", { clientId: "w1" });
	assert.equal(wait.ok, false);
	assert.equal(wait.error.code, "bot/browser-off");
	// The computer module is installed without a computer-use provider (cuaAccess absent):
	// the system-status probe answers null rather than failing the window.
	const status = await call("computer-system-status", {});
	assert.equal(status.ok, true);
	assert.equal(status.value, null);
	// An invalid im-add reaches the IM module: it is a refusal with the module's message,

	const add = await call("im-add", {});
	assert.equal(add.ok, false);
	assert.notEqual(add.error.code, "bot/not-found");
	assert.equal(add.error.code, "bot/refused");
	assert.match(add.error.message, /platform is not available|Choose a Bot/);

	const level = await call("computer-set-level", { botId: "nope", level: "background" });
	assert.notEqual(level.error?.code, "bot/not-found");
});

test("dispose settles every module's cleanup, releases the routes and the state lock", async (t) => {
	const { ctx, routes, released, rt, home } = host(t);
	const api = routes.find((route) => route.path === "/api/bot");
	assert.ok(api !== undefined);
	// The store holds the team lock and the effects keep the routes registered.
	const lockPath = join(home, "state.lock");
	assert.equal(existsSync(lockPath), true, "the runtime holds the team state lock");
	assert.deepEqual(released, [], "no route is released while the runtime runs");
	// The runtime answers while it is up.
	const before = await api.fetch(
		new Request("http://localhost/api/bot", {
			method: "POST",
			body: JSON.stringify({ endpoint: "im-add", payload: {} }),
		}),
	);
	assert.equal(before.status, 200);
	const disposed = await ctx.dispose();
	// Every module's disposer ran and none threw: a rejected cleanup would surface here.
	assert.ok(disposed.length > 0, "modules registered disposers");
	assert.deepEqual(
		disposed.filter((result) => result.status === "rejected"),
		[],
	);
	// Cleanup reached the shared resources: both routes were handed back to the connection
	// service and the store released the state lock. The published members stay readable,
	// but nothing the runtime registered is still live.
	assert.deepEqual(released.sort(), ["/api/bot", "/api/bot/feed"]);
	assert.equal(existsSync(lockPath), false, "the state lock was released");
	assert.equal(typeof rt.imEndpoint, "function");
	const again = await ctx.dispose();
	assert.deepEqual(again, [], "a second dispose finds nothing left to clean");
});
