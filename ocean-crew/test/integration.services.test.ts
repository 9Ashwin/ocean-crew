// Integration: browser and IM endpoints against a runtime whose side-effect
// modules are attached one at a time. Each endpoint refuses `bot/unavailable` before its
// module publishes the member and answers once it does; the browser's two absences stay
// distinct: no module is `bot/unavailable`, a module without a

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHANNEL_ENDPOINTS,
	install,
	MODULE_ENDPOINTS,
	READS,
	SERVICE_ENDPOINTS,
	UNAVAILABLE_ENDPOINTS,
} from "../src/host/chat/channel.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { emptyTeam } from "../src/shared/state.ts";
import type { FakeRoute } from "./fake-ctx.ts";
import { fakeContext } from "./fake-ctx.ts";

interface Rig {
	rt: Runtime & Record<string, any>;
	state: ReturnType<typeof emptyTeam>;
	calls: Array<[string, ...unknown[]]>;
	followups: any[];
	flushes: number;
	live: Map<string, any>;
	attach(name: string, value: unknown): void;
	attachAll(members: Record<string, unknown>): void;
	setFollowupFailure(fail: boolean): void;
	call(endpoint: string, payload?: unknown): Promise<any>;
	dispose(): Promise<unknown[]>;
}

function teamState() {
	const state = emptyTeam();
	state.revision = 3;
	state.mainBotIds = ["chief"];
	state.bots = {
		chief: { id: "chief", name: "Chief", role: "Boss", createdAt: 1 },
		dev: { id: "dev", name: "Dev", createdAt: 2 },
	};
	state.rooms = { r1: { id: "r1", name: "Ops", members: ["chief", "dev"], mode: "admin", admin: "chief" } };
	return state;
}

function makeRig(): Rig {
	const calls: Array<[string, ...unknown[]]> = [];
	const rec = (name: string, ...args: unknown[]): void => {
		calls.push([name, ...args]);
	};
	const ctx = fakeContext();
	const routes: FakeRoute[] = [];
	const originalRegister = ctx.connection.fetch.register;
	ctx.connection.fetch.register = (route) => {
		routes.push(route);
		return originalRegister(route);
	};
	let followupFails = false;
	const followups: any[] = [];
	let flushes = 0;
	(ctx as any).sessionController = { prompt: async () => {} };
	(ctx as any).sessions = {
		flush: async () => {
			flushes += 1;
		},
	};
	const state = teamState();
	const chatOwners = new Map([
		["chief", "chief"],
		["dev", "dev"],
	]);
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	const roomOwners = new Map<string, string>();
	const pastOwners = new Map<string, { botId?: string; roomId?: string }>();
	const live = new Map<string, any>();
	const botOf = (id?: string) => (id === undefined ? undefined : state.bots[id]);
	const roomOf = (id?: string) => (id === undefined ? undefined : state.rooms[id]);
	const chatOf = (botId: string) => state.bots[botId]?.sessionId ?? botId;
	const sessionOfRoom = (room?: { sessionId?: string; id?: string }) => room?.sessionId ?? room?.id;
	const rt = {
		ctx,
		config: {},
		dshHome: "/tmp/ocean-crew",
		home: "/tmp/ocean-crew/bot",
		statePath: "/tmp/ocean-crew/bot/state.json",
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief of Staff" },
		warn: (...args: unknown[]) => rec("warn", ...args),
		state,
		load: async () => rec("load"),
		save: async () => rec("save"),
		refresh: async () => rec("refresh"),
		readOnly: () => undefined,
		own: <T>(table: Record<string, T> | null | undefined, key: string): T | undefined =>
			table != null && Object.hasOwn(table, key) ? table[key] : undefined,
		onSaved: () => () => {},
		closeCard: () => {},
		botOf,
		roomOf,
		isMain: (id?: string) => id !== undefined && state.mainBotIds.includes(id),
		chatOf,
		sessionOfRoom,
		selfOf: (id?: string) => (id === undefined ? undefined : (chatOwners.get(id) ?? pastOwners.get(id)?.botId)),
		isBotSession: (id?: string) => id !== undefined && chatOwners.has(id),
		chatOwners,
		groupOwners,
		roomOwners,
		pastOwners,
		groupSessionsOf: () => [],
		dropGroupSession: () => {},
		retireGroupSession: () => {},
		findBot: (ref?: unknown) => (typeof ref === "string" ? state.bots[ref] : undefined),
		findRooms: () => [],
		isAdminOf: (room: { admin?: string | null }, id?: string) => id !== undefined && room.admin === id,
		catalog: async () => rec("catalog"),
		cachedCatalog: () => [],
		cachedDefault: () => null,
		bootstrap: async () => rec("bootstrap"),
		resolveAgent: async (sessionId: string) => ({
			session: { id: sessionId },
			followup(message: unknown) {
				if (followupFails) throw new Error("followup failed");
				followups.push(message);
			},
			cancel(reason: unknown) {
				rec("cancel", sessionId, reason);
			},
		}),
		ensureCapabilities: async (sessionId: string) => rec("ensureCapabilities", sessionId),
		stopMemberWork: async (roomId: string, botId: string) => rec("stopMemberWork", roomId, botId),
		live,
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	const route = routes[0];
	assert.ok(route !== undefined);
	return {
		rt,
		state,
		calls,
		followups,
		get flushes() {
			return flushes;
		},
		live,
		attach: (name, value) => {
			rt[name] = value;
		},
		attachAll: (members) => {
			for (const [name, value] of Object.entries(members)) rt[name] = value;
		},
		setFollowupFailure: (fail) => {
			followupFails = fail;
		},
		call: async (endpoint, payload) => {
			const response = (await route.fetch(
				new Request("http://127.0.0.1/api/bot", {
					method: "POST",
					body: JSON.stringify({ endpoint, payload }),
				}),
			)) as Response;
			assert.equal(response.status, 200);
			return await response.json();
		},
		dispose: () => ctx.dispose(),
	};
}

/** The module side of the M5 runtime contract, with the browser's hold book. */
function moduleMembers(rig: Rig): Record<string, unknown> {
	const holds = new Map<string, any>();
	const rec = (name: string, ...args: unknown[]) => {
		rig.calls.push([name, ...args]);
	};
	return {
		browserOpen: (open: unknown) => {
			rec("browserOpen", open);
			return open ?? {};
		},
		browserChannel: {
			async wait(clientId: string, open: unknown) {
				rec("browser.wait", clientId, open);
				return [{ requestId: "read-1" }];
			},
			result(body: unknown) {
				rec("browser.result", body);
				return { body, ok: true };
			},
			holdSnapshot: () => ({ chief: { by: "user" } }),
			holdOf: (botId: string) => holds.get(botId) ?? null,
			setHold: (botId: string, hold: unknown) => {
				rec("browser.setHold", botId, hold);
				if (hold === null) holds.delete(botId);
				else holds.set(botId, hold);
			},
		},
		imEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
	};
}

const PROBES: Record<string, unknown> = {
	"browser-wait": { clientId: "client-1", open: { tab: "t1" } },
	"browser-result": { clientId: "client-1", result: { ok: true } },
	"browser-takeover": { botId: "chief" },
	"browser-give-back": { botId: "chief" },
	"browser-stop": { botId: "chief" },
};

test("the service surface is disjoint from the channel and module endpoints, and no static placeholder remains", () => {
	assert.equal(SERVICE_ENDPOINTS.length, 14);
	assert.equal(UNAVAILABLE_ENDPOINTS.size, 0, "every known endpoint is wired dynamically");
	for (const endpoint of SERVICE_ENDPOINTS) {
		assert.ok(!CHANNEL_ENDPOINTS.includes(endpoint), `${endpoint} is not M2`);
		assert.ok(!MODULE_ENDPOINTS.includes(endpoint), `${endpoint} is not M3`);
	}
	for (const endpoint of READS) {
		const known =
			CHANNEL_ENDPOINTS.includes(endpoint) ||
			MODULE_ENDPOINTS.includes(endpoint) ||
			SERVICE_ENDPOINTS.includes(endpoint);
		assert.ok(known, `${endpoint} is a known read endpoint`);
	}
});

test("every service endpoint refuses before its module loads, naming the missing member", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	for (const endpoint of SERVICE_ENDPOINTS) {
		const answer = await rig.call(endpoint, PROBES[endpoint] ?? {});
		assert.equal(answer.ok, false, endpoint);
		assert.equal(answer.error.code, "bot/unavailable", endpoint);
		assert.match(answer.error.message, /not installed in this build/, `${endpoint} names the missing member`);
	}
});

test("IM endpoints pass the endpoint name and body through", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.attachAll(moduleMembers(rig));
	for (const endpoint of SERVICE_ENDPOINTS.filter((name) => name.startsWith("im-"))) {
		const body = { probe: endpoint };
		const answer = await rig.call(endpoint, body);
		assert.equal(answer.ok, true, endpoint);
		assert.deepEqual(answer.value, { endpoint, body }, endpoint);
	}
});

test("browser-wait and browser-result answer from the channel and keep browser-off distinct", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});

	rig.attach("browserOpen", (open: unknown) => open ?? {});
	const off = await rig.call("browser-wait", PROBES["browser-wait"]);
	assert.equal(off.error.code, "bot/browser-off");
	assert.equal(off.error.message, "Bot browsers are off on this host");
	assert.equal((await rig.call("browser-result", {})).error.code, "bot/browser-off");

	rig.attachAll(moduleMembers(rig));
	const wait = await rig.call("browser-wait", { clientId: "client-1", open: { tab: "t1" } });
	assert.deepEqual(wait.value, { requests: [{ requestId: "read-1" }], holds: { chief: { by: "user" } } });
	const waitCall = rig.calls.filter(([name]) => name === "browser.wait").at(-1);
	assert.deepEqual(waitCall?.slice(1), ["client-1", { tab: "t1" }], "the browserOpen result reaches wait");
	const clientId = rig.calls.filter(([name]) => name === "browser.wait").at(-1);
	assert.equal(clientId !== undefined, true);
	const missing = await rig.call("browser-wait", { open: {} });
	assert.equal(missing.error.code, "bot/invalid");
	const result = await rig.call("browser-result", { clientId: "c1", result: { ok: true } });
	assert.deepEqual(result.value, { body: { clientId: "c1", result: { ok: true } }, ok: true });
});

test("browser takeover and give-back keep the handoff card contract", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.attachAll(moduleMembers(rig));
	// A plain takeover holds the browser for the user; an existing handoff keeps its call.
	const simple = await rig.call("browser-takeover", { botId: "chief" });
	assert.equal(simple.value, true);
	let setHold = rig.calls.filter(([name]) => name === "browser.setHold").at(-1);
	assert.deepEqual(setHold?.slice(1), [
		"chief",
		{ by: "user", reason: "takeover", note: "The user is controlling this browser." },
	]);
	const channel = (rig.rt as any).browserChannel;
	channel.holdOf = () => ({ callId: "call-1", reason: "handoff", note: "Carry on" });
	await rig.call("browser-takeover", { botId: "chief" });
	setHold = rig.calls.filter(([name]) => name === "browser.setHold").at(-1);
	assert.deepEqual(setHold?.slice(1), [
		"chief",
		{ by: "user", reason: "handoff", note: "Carry on", callId: "call-1" },
	]);
	assert.equal((await rig.call("browser-takeover", { botId: "nobody" })).error.code, "bot/not-found");

	// Give back refused: nothing held, a bad outcome, a stale handoff.
	channel.holdOf = () => null;
	assert.equal((await rig.call("browser-give-back", { botId: "chief" })).error.code, "bot/forbidden");
	channel.holdOf = () => ({ callId: "call-1", reason: "handoff" });
	assert.equal((await rig.call("browser-give-back", { botId: "chief", outcome: "later" })).error.code, "bot/invalid");
	assert.equal((await rig.call("browser-give-back", { botId: "chief", callId: "call-0" })).error.code, "bot/stale");

	// A held handoff answered: claimed first, then the reply reaches the Bot's chat.
	rig.setFollowupFailure(false);
	const given = await rig.call("browser-give-back", { botId: "chief", outcome: "done", callId: "call-1" });
	assert.equal(given.value, true);
	const claimed = rig.calls.filter(([name]) => name === "browser.setHold").at(-1);
	assert.deepEqual(claimed?.slice(1), ["chief", null], "the hold is claimed before queueing");
	assert.equal(rig.followups.length, 1);
	const message = rig.followups[0];
	assert.equal(message.source.kind, "user-question-reply");
	assert.equal(message.source.callId, "call-1");
	assert.match(JSON.parse(message.content[0].text).kind, /^answer_to_pending_handoff$/);
	assert.equal(rig.flushes, 1);

	// A failed queue puts the hold back; Give back without a call just releases it.
	rig.setFollowupFailure(true);
	channel.holdOf = () => ({ callId: "call-2", reason: "handoff" });
	const failed = await rig.call("browser-give-back", { botId: "chief", outcome: "skip", callId: "call-2" });
	assert.equal(failed.error.code, "bot/refused");
	assert.deepEqual(channel.holdOf(), { callId: "call-2", reason: "handoff" });
	rig.setFollowupFailure(false);
	channel.holdOf = () => ({ by: "user", reason: "takeover" });
	const release = await rig.call("browser-give-back", { botId: "chief" });
	assert.equal(release.value, true);
	assert.equal(rig.followups.length, 1, "a plain give-back queues nothing");
});

test("browser-stop cancels the turn, stops group work and records the hold", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.attachAll(moduleMembers(rig));
	rig.live.set("chief", { turn: 4 });
	const stopped = await rig.call("browser-stop", { botId: "chief" });
	assert.equal(stopped.value, true);
	const cancel = rig.calls.filter(([name]) => name === "cancel").at(-1);
	assert.deepEqual(cancel?.slice(1), ["chief", { kind: "user" }]);
	assert.deepEqual(
		rig.calls.filter(([name]) => name === "stopMemberWork").map((call) => call.slice(1)),
		[["r1", "chief"]],
		"the Bot's groups stop its work",
	);
	const setHold = rig.calls.filter(([name]) => name === "browser.setHold").at(-1);
	assert.deepEqual(setHold?.slice(1), [
		"chief",
		{ by: "user", reason: "stopped", note: "The user is controlling this browser." },
	]);
	assert.equal((await rig.call("browser-stop", { botId: "nobody" })).error.code, "bot/not-found");
});

test("the state and live answers carry the service views once the modules are installed", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const before = await rig.call("state", {});
	assert.equal(before.value.browser, false);
	assert.deepEqual(before.value.im, { connections: [], platforms: [] });
	rig.attachAll({
		browserEnabled: true,
		imView: () => ({ connections: [{ id: "im-1" }], platforms: ["feishu"] }),
		imStatusView: () => ({ "im-1": { state: "on" } }),
		imViaView: () => ({ chief: "feishu" }),
	});
	const after = await rig.call("state", {});
	assert.equal(after.value.browser, true);
	assert.deepEqual(after.value.im, { connections: [{ id: "im-1" }], platforms: ["feishu"] });
	assert.deepEqual(after.value.imStatus, { "im-1": { state: "on" } });
	assert.deepEqual(after.value.imVia, { chief: "feishu" });
});
