// Channel behaviour: the closed `api/bot` endpoint set, the response envelope and error
// code mapping, the read-only gate, the `state`/live answer with its unchanged shortcut,

// The cases are the public

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
import type { FakeContext, FakeRoute } from "./fake-ctx.ts";
import { fakeContext } from "./fake-ctx.ts";

interface Counters {
	bootstrap: number;
	catalog: number;
	loadSecrets: number;
	refresh: number;
	load: number;
	save: number;
	prompts: any[];
	followups: any[];
	flushes: number;
	ensure: string[];
	createBot: any[];
	updateBot: any[];
	deleteBot: string[];
	setMain: any[];
	setFlags: any[];
	resumeBot: string[];
	createRoom: any[];
	updateRoom: any[];
	deleteRoom: string[];
	greetRoom: string[];
	stopMemberWork: any[];
	stopRoomWork: string[];
	goalUserStopped: string[];
	failures: any[];
}

interface Rig {
	ctx: FakeContext;
	rt: Runtime & Record<string, any>;
	state: ReturnType<typeof emptyTeam>;
	route: FakeRoute;
	counters: Counters;
	warnings: unknown[][];
	calls: (...args: [unknown, unknown?, string?]) => Promise<any>;
	setReadOnly(message?: string): void;
	setResolveModel(resolve: ((ref: string) => Promise<string>) | undefined): void;
	dispose(): Promise<unknown[]>;
}

interface RigOptions {
	projections?: boolean;
	sessionController?: boolean;
}

// A two-Bot team, one group and the card/exchange records the channel reads.
function teamState() {
	const state = emptyTeam();
	state.revision = 7;
	state.mainBotIds = ["chief"];
	state.bots = {
		chief: { id: "chief", name: "Chief", role: "Boss", createdAt: 1 },
		worker: {
			id: "worker",
			name: "Dev",
			createdAt: 2,
			segments: [{ sessionId: "worker-old" }],
			kickoff: { text: "hi" },
		},
	};
	state.rooms = {
		r1: {
			id: "r1",
			name: "Ops",
			members: ["chief", "worker"],
			mode: "admin",
			admin: "chief",
			named: true,
			sessionId: "room-current",
			parts: [{ sessionId: "room-old" }],
			sessions: { worker: "group-worker" },
			segments: { worker: [{ sessionId: "group-worker-old" }] },
			log: [
				{ seq: 1, who: "User", text: "hello" },
				{ seq: 2, who: "Chief", text: "hi there" },
			],
			seen: {},
			paused: false,
			seq: 2,
		},
	};
	state.questions = {
		"sess-1": {
			id: "q1",
			callId: "call-q1",
			botId: "chief",
			sessionId: "sess-1",
			askedAt: 1,
			question: "Which?",
			options: [{ label: "A" }, { label: "B" }],
		} as any,
	};
	state.views = {
		"sess-1": { id: "v1", callId: "call-v1", botId: "chief", sessionId: "sess-1", title: "View", view: {} } as any,
	};
	state.exchanges = [
		{ id: "e1", from: "chief", to: "worker", text: "do it", role: "request", time: 1, at: 1 },
		{ id: "e2", from: "worker", to: "chief", text: "done", role: "reply", time: 2, at: 2 },
		{ id: "e3", from: "worker", to: "stranger", text: "not this pair", role: "request", time: 3, at: 3 },
	];
	state.prefs = { theme: "mono" } as any;
	return state;
}

function makeRig(options: RigOptions = {}): Rig {
	const services: Record<string, any> = {};
	if (options.projections !== false) {
		services.sessionProjections = {
			snapshot: (_session: unknown, names: readonly string[]) => ({
				values: { sessionStats: { turns: 1 }, names },
			}),
		};
	}
	const ctx = fakeContext({ services });
	const routes: FakeRoute[] = [];
	const originalRegister = ctx.connection.fetch.register;
	ctx.connection.fetch.register = (route) => {
		routes.push(route);
		return originalRegister(route);
	};

	const counters: Counters = {
		bootstrap: 0,
		catalog: 0,
		loadSecrets: 0,
		refresh: 0,
		load: 0,
		save: 0,
		prompts: [],
		followups: [],
		flushes: 0,
		ensure: [],
		createBot: [],
		updateBot: [],
		deleteBot: [],
		setMain: [],
		setFlags: [],
		resumeBot: [],
		createRoom: [],
		updateRoom: [],
		deleteRoom: [],
		greetRoom: [],
		stopMemberWork: [],
		stopRoomWork: [],
		goalUserStopped: [],
		failures: [],
	};
	const warnings: unknown[][] = [];
	const state = teamState();
	let readOnly: string | undefined;

	const chatOwners = new Map<string, string>([
		["chief", "chief"],
		["worker", "worker"],
	]);
	const groupOwners = new Map([["group-worker", { botId: "worker", roomId: "r1" }]]);
	const roomOwners = new Map([["room-current", "r1"]]);
	const pastOwners = new Map<string, { botId?: string; roomId?: string }>([
		["worker-old", { botId: "worker" }],
		["group-worker-old", { botId: "worker", roomId: "r1" }],
		["room-old", { roomId: "r1" }],
	]);

	const botOf = (id?: string) => (id === undefined ? undefined : state.bots[id]);
	const roomOf = (id?: string) => {
		if (id === undefined) return undefined;
		const direct = state.rooms[id];
		if (direct !== undefined) return direct;
		const owner = roomOwners.get(id);
		return owner === undefined ? undefined : state.rooms[owner];
	};
	const chatOf = (botId: string) => state.bots[botId]?.sessionId ?? botId;
	const sessionOfRoom = (room?: { sessionId?: string; id?: string }) => room?.sessionId ?? room?.id;
	const selfOf = (id?: string) =>
		id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId);
	const isMain = (id?: string) => id !== undefined && state.mainBotIds.includes(id);
	const isAdminOf = (room: { admin?: string | null }, id?: string) => id !== undefined && room.admin === id;
	const findBot = (ref?: unknown) => {
		if (typeof ref !== "string") return undefined;
		return state.bots[ref] ?? Object.values(state.bots).find((bot) => bot.name === ref);
	};
	const findRooms = (ref?: unknown) => {
		if (typeof ref !== "string") return [];
		return state.rooms[ref] !== undefined
			? [state.rooms[ref]]
			: Object.values(state.rooms).filter((room) => room.name === ref);
	};

	const agentFor = (sessionId: string, failFollowup = false) => ({
		session: { id: sessionId },
		followup(message: unknown) {
			if (failFollowup) throw new Error("followup failed");
			counters.followups.push(message);
		},
		cancel() {},
	});

	const rt = {
		ctx,
		config: {},
		dshHome: "/tmp/ocean-crew",
		home: "/tmp/ocean-crew/bot",
		statePath: "/tmp/ocean-crew/bot/state.json",
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief of Staff" },
		warn: (...args: unknown[]) => warnings.push(args),
		state,
		load: async () => {
			counters.load += 1;
		},
		save: async () => {
			counters.save += 1;
		},
		refresh: async () => {
			counters.refresh += 1;
		},
		readOnly: () => readOnly,
		own: <T>(table: Record<string, T> | null | undefined, key: string): T | undefined =>
			table != null && Object.hasOwn(table, key) ? table[key] : undefined,
		onSaved: () => () => {},
		closeCard: (sessionId: string, card: { callId?: string } | undefined, outcome: string) => {
			if (typeof card?.callId !== "string") return;
			state.closedCards[sessionId] = { ...state.closedCards[sessionId], [card.callId]: outcome };
		},
		botOf,
		roomOf,
		isMain,
		chatOf,
		sessionOfRoom,
		selfOf,
		isBotSession: (id?: string) => id !== undefined && (chatOwners.has(id) || groupOwners.has(id)),
		chatOwners,
		groupOwners,
		roomOwners,
		pastOwners,
		groupSessionsOf: () => [],
		dropGroupSession: () => {},
		retireGroupSession: () => {},
		findBot,
		findRooms,
		isAdminOf,
		// Optional cross-module doubles the channel calls.
		catalog: async () => {
			counters.catalog += 1;
			return [{ ref: "deepseek/deepseek-chat", needsKey: false }];
		},
		cachedCatalog: () => [
			{ ref: "deepseek/deepseek-chat", needsKey: false },
			{ ref: "deepseek/reasoner", needsKey: true, reasoning: { efforts: [{ id: "high" }] } },
		],
		cachedDefault: () => "deepseek/deepseek-chat",
		reasoningOf: async (ref: string) => (ref === "" ? { efforts: [] } : { efforts: [{ id: "high" }] }),
		bootstrap: async () => {
			counters.bootstrap += 1;
		},
		loadSecrets: async () => {
			counters.loadSecrets += 1;
		},
		activityView: () => ({ chief: "thinking" }),
		workView: () => ({ bots: { chief: { since: 1 } } }),
		roomWorkView: () => ({ r1: [{ botId: "worker", since: 2 }] }),
		approvalsView: () => [{ botId: "chief" }],
		waitingView: () => ({ worker: "chief" }),
		turnsView: () => ({ chief: 1 }),
		steeredView: () => ({}),
		roomProgress: new Map([
			[
				"call-1",
				{
					roomId: "r1",
					replies: [{ kind: "user", text: "hi" }],
					slots: [
						{ id: "chief", status: "speaking" },
						{ id: "worker", status: "posted" },
					],
				},
			],
		]),
		ensureCapabilities: async (sessionId: string) => {
			counters.ensure.push(sessionId);
		},
		resolveAgent: async (sessionId: string) => agentFor(sessionId),
		exchangeText: async (entry: { id: string }) => ({ text: `whole ${entry.id}`, whole: true }),
		fileText: async (file: { attachmentId: string }) => ({ text: `file ${file.attachmentId}`, whole: true }),
		createBot: async (input: any) => {
			counters.createBot.push(input);
			if (input?.name === "type") throw new TypeError("boom");
			if (input?.name === "sys") throw Object.assign(new Error("fs failed"), { code: "ENOENT" });
			if (input?.name === "stale") throw Object.assign(new Error("gone"), { code: "bot/stale" });
			if (input?.name === "plain") throw new Error("nope");
			return { id: "new-bot", name: input?.name };
		},
		updateBot: async (id: string, patch: any) => {
			counters.updateBot.push([id, patch]);
			return { id, ...patch };
		},
		duplicateBot: async (id: string) => ({ id: `${id}-copy` }),
		deleteBot: async (id: string) => {
			counters.deleteBot.push(id);
			delete state.bots[id];
		},
		setMain: async (...args: unknown[]) => {
			counters.setMain.push(args);
		},
		setFlags: async (id: string, body: any) => {
			counters.setFlags.push([id, body]);
			return { id };
		},
		resumeBot: async (bot: { id: string }) => {
			counters.resumeBot.push(bot.id);
		},
		createRoom: async (input: any) => {
			counters.createRoom.push(input);
			return { id: "room-new", name: input?.name ?? "New" };
		},
		updateRoom: async (id: string, patch: any) => {
			counters.updateRoom.push([id, patch]);
			return { room: { id }, changes: ["renamed it"] };
		},
		deleteRoom: async (id: string) => {
			counters.deleteRoom.push(id);
		},
		greetRoom: async (id: string) => {
			counters.greetRoom.push(id);
		},
		stopMemberWork: async (roomId: string, botId: string) => {
			counters.stopMemberWork.push([roomId, botId]);
			return true;
		},
		stopRoomWork: async (roomId: string) => {
			counters.stopRoomWork.push(roomId);
			return true;
		},
		goalUserStopped: (roomId: string) => {
			counters.goalUserStopped.push(roomId);
		},
		noteFailure: (record: any) => {
			counters.failures.push(record);
		},
		resolveModel: async (ref: string) => `resolved/${ref}`,
		isLocalAgentRef: (ref: string) => ref.startsWith("local/"),
	} as unknown as Runtime & Record<string, any>;

	if (options.sessionController !== false) {
		(ctx as any).sessionController = {
			prompt: async (request: unknown) => {
				counters.prompts.push(request);
			},
		};
		(ctx as any).sessions = {
			flush: async () => {
				counters.flushes += 1;
			},
		};
	}

	install(rt);
	const route = routes[0];
	assert.ok(route !== undefined, "channel registers the /api/bot route");

	const call: Rig["calls"] = async (endpoint, payload?, raw?) => {
		const body = raw ?? JSON.stringify({ endpoint, payload });
		const response = (await route.fetch(
			new Request("http://127.0.0.1/api/bot", { method: "POST", body }),
		)) as Response;
		assert.equal(response.status, 200, "every api/bot answer is HTTP 200");
		assert.match(response.headers.get("content-type") ?? "", /application\/json/);
		return await response.json();
	};

	return {
		ctx,
		rt,
		state,
		route,
		counters,
		warnings,
		calls: call,
		setReadOnly: (message) => {
			readOnly = message;
		},
		setResolveModel: (resolve) => {
			if (resolve === undefined) delete (rt as Record<string, any>).resolveModel;
			else (rt as Record<string, any>).resolveModel = async (ref: string) => resolve(ref);
		},
		dispose: () => ctx.dispose(),
	};
}

test("the route is registered on /api/bot and the module publishes what other modules call", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	assert.equal(rig.route.path, "/api/bot");
	assert.deepEqual(rig.route.methods, ["POST"]);
	assert.equal(rig.route.requestBody, "buffered");
	assert.ok(rig.ctx.calls.includes("route POST /api/bot"));
	assert.ok(rig.ctx.calls.includes("effect ocean-crew: api route"));
	assert.ok(rig.ctx.calls.includes("effect ocean-crew: load state"));
	assert.equal(typeof rig.rt.sendUser, "function");
	assert.equal(typeof rig.rt.answerQuestion, "function");
	assert.equal(typeof rig.rt.uiLanguage, "function");
	assert.equal(rig.rt.uiLanguage(), undefined);
});

test("an unreadable body is an unknown endpoint and every answer keeps the envelope", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	for (const raw of ["{", "", "null"]) {
		const answer = await rig.calls(undefined, undefined, raw);
		assert.equal(answer.ok, false);
		assert.equal(answer.error.code, "bot/not-found");
		assert.deepEqual(answer.error.details, {});
	}
	const unknown = await rig.calls("nope", {});
	assert.equal(unknown.ok, false);
	assert.equal(unknown.error.code, "bot/not-found");
	assert.match(unknown.error.message, /Unknown endpoint nope/);
});

test("every channel endpoint is served and every deferred endpoint answers bot/unavailable", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	assert.equal(CHANNEL_ENDPOINTS.length, 25);
	for (const endpoint of CHANNEL_ENDPOINTS) {
		assert.ok(!UNAVAILABLE_ENDPOINTS.has(endpoint), `${endpoint} is not also deferred`);
		const answer = await rig.calls(endpoint, {});
		// Endpoints that look a record up by id answer not-found for the empty payload.
		if (endpoint === "resume" || endpoint === "run-stats") {
			assert.equal(answer.error.code, "bot/not-found", `${endpoint} looks the record up`);
			continue;
		}
		assert.notEqual(answer.error?.code, "bot/not-found", `${endpoint} reaches a handler`);
	}
	for (const [endpoint, module] of UNAVAILABLE_ENDPOINTS) {
		assert.ok(!CHANNEL_ENDPOINTS.includes(endpoint), `${endpoint} is deferred, not served`);
		const answer = await rig.calls(endpoint, {});
		assert.equal(answer.ok, false, endpoint);
		assert.equal(answer.error.code, "bot/unavailable", endpoint);
		assert.match(answer.error.message, new RegExp(module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	const computer = await rig.calls("computer-shot", {});
	assert.equal(computer.error.code, "bot/unavailable");
	assert.match(computer.error.message, /not installed in this build/);

	for (const endpoint of READS) {
		const known =
			CHANNEL_ENDPOINTS.includes(endpoint) ||
			MODULE_ENDPOINTS.includes(endpoint) ||
			SERVICE_ENDPOINTS.includes(endpoint) ||
			UNAVAILABLE_ENDPOINTS.has(endpoint) ||
			endpoint.startsWith("computer-");
		assert.ok(known, `${endpoint} is a known read endpoint`);
	}
});

test("module endpoints are wired dynamically: unavailable without the module, served once it lands", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	assert.ok(MODULE_ENDPOINTS.length > 60, "the module surface is wired");
	// Endpoints that validate their payload or look a record up before reaching the module
	// every other endpoint takes `{}`.
	const probes: Record<string, unknown> = {
		"bot-new-part": { botId: "chief" },
		"bot-open-part": { botId: "chief", sessionId: "worker-old" },
		"view-reply": { sessionId: "sess-1", viewId: "v1" },
		"btw-delete": { sessionId: "sess-1", cardId: "c1" },
		"side-new": { sessionId: "chief" },
		"side-ask": { sessionId: "chief", text: "question" },
		"side-cancel": { chatId: "c1", entryId: "e1" },
		"side-close": { chatId: "c1" },
	};
	for (const endpoint of MODULE_ENDPOINTS) {
		assert.ok(!CHANNEL_ENDPOINTS.includes(endpoint), `${endpoint} is not a channel endpoint`);
		assert.ok(!UNAVAILABLE_ENDPOINTS.has(endpoint), `${endpoint} is wired, not a static placeholder`);
		const answer = await rig.calls(endpoint, probes[endpoint] ?? {});
		assert.equal(answer.ok, false, endpoint);
		assert.equal(answer.error.code, "bot/unavailable", endpoint);
		assert.match(answer.error.message, /not installed in this build/, `${endpoint} names the missing member`);
	}

	rig.setReadOnly("The Bot team is open in another dsh (pid 42).");
	const write = await rig.calls("provider-add", {});
	assert.equal(write.error.code, "bot/read-only");
	const read = await rig.calls("providers", {});
	assert.equal(read.error.code, "bot/unavailable");
});

test("browser, IM and computer endpoints are wired dynamically: unavailable until their modules load", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	assert.equal(SERVICE_ENDPOINTS.length, 29, "5 browser, 9 IM and 15 computer endpoints");
	for (const endpoint of SERVICE_ENDPOINTS) {
		assert.ok(!CHANNEL_ENDPOINTS.includes(endpoint), `${endpoint} is not a channel endpoint`);
		assert.ok(!MODULE_ENDPOINTS.includes(endpoint), `${endpoint} is not a module endpoint`);
		const answer = await rig.calls(endpoint, {});
		assert.equal(answer.ok, false, endpoint);
		assert.equal(answer.error.code, "bot/unavailable", endpoint);
		assert.match(answer.error.message, /not installed in this build/, `${endpoint} names the missing member`);
	}
	// The computer family's prefix is dynamic too: a suffix the list does not name still
	// reaches the module, and refuses while it is missing.
	const unknownSuffix = await rig.calls("computer-future-action", {});
	assert.equal(unknownSuffix.error.code, "bot/unavailable");
	assert.match(unknownSuffix.error.message, /computerEndpoint/);
	// A read-only host keeps the browser long poll readable and refuses the write endpoints.
	rig.setReadOnly("The Bot team is open in another dsh (pid 42).");
	const read = await rig.calls("browser-wait", {});
	assert.equal(read.error.code, "bot/unavailable");
	const write = await rig.calls("browser-takeover", {});
	assert.equal(write.error.code, "bot/read-only");
});

test("the read-only gate runs before dispatch: writes refuse, reads answer", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.setReadOnly("The Bot team is open in another dsh (pid 42).");
	const write = await rig.calls("create-bot", { name: "New" });
	assert.equal(write.error.code, "bot/read-only");
	assert.match(write.error.message, /another dsh/);
	// Not in READS either way, so the gate wins over "unknown".
	const unknown = await rig.calls("nope", {});
	assert.equal(unknown.error.code, "bot/read-only");
	const deferredWrite = await rig.calls("im-add", {});
	assert.equal(deferredWrite.error.code, "bot/read-only");

	const deferredRead = await rig.calls("usage", {});
	assert.equal(deferredRead.error.code, "bot/unavailable");
	const stateAnswer = await rig.calls("state", {});
	assert.equal(stateAnswer.ok, true);
	assert.equal(stateAnswer.value.readOnly, "The Bot team is open in another dsh (pid 42).");
	assert.equal(rig.counters.bootstrap, 0, "a reading host does not bootstrap the team");
});

test("errors map to the documented codes and an internal one is recorded", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const missing = await rig.calls("answer-question", {});
	assert.equal(missing.error.code, "bot/invalid");
	assert.equal(missing.error.message, "Nothing to send");

	const typeError = await rig.calls("create-bot", { name: "type" });
	assert.equal(typeError.error.code, "bot/internal");
	assert.equal(typeError.error.message, "boom");
	const systemError = await rig.calls("create-bot", { name: "sys" });
	assert.equal(systemError.error.code, "bot/internal");
	assert.equal(systemError.error.message, "fs failed");
	const preserved = await rig.calls("create-bot", { name: "stale" });
	assert.equal(preserved.error.code, "bot/stale");
	assert.equal(preserved.error.message, "gone");
	const refused = await rig.calls("create-bot", { name: "plain" });
	assert.equal(refused.error.code, "bot/refused");
	assert.equal(refused.error.message, "nope");
	assert.equal(rig.counters.failures.length, 2, "internal faults reach diagnostics");
	assert.equal(rig.counters.failures[0].source, "api");
	assert.match(rig.counters.failures[0].text, /^create-bot: /);
});

test("state answers the roster view and keeps the unchanged shortcut small", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const first = await rig.calls("state", {});
	assert.equal(first.ok, true);
	const value = first.value;
	assert.equal(value.revision, 7);
	assert.equal(value.mainBotId, "chief");
	assert.deepEqual(value.mainBotIds, ["chief"]);
	const chief = value.bots.find((bot: any) => bot.id === "chief");
	assert.equal(chief.sessionId, "chief");
	assert.deepEqual(chief.parts, []);
	const worker = value.bots.find((bot: any) => bot.id === "worker");
	assert.equal(worker.sessionId, "worker");
	assert.deepEqual(worker.parts, ["worker-old"]);
	assert.equal(worker.waiting, true, "a held greeting reads as waiting");
	const room = value.rooms[0];
	assert.equal(room.sessionId, "room-current");
	assert.deepEqual(room.ownParts, ["room-old"]);
	assert.deepEqual(room.parts, ["group-worker", "group-worker-old", "room-old"]);
	assert.equal(room.preview, "Chief：hi there");
	assert.ok(value.colors.includes("deepseek"));
	assert.ok(value.colors.includes("charcoal"));
	assert.equal(value.memory, true);
	assert.equal(value.browser, false);
	assert.equal(value.readOnly, null);
	assert.deepEqual(value.im, { connections: [], platforms: [] });
	assert.deepEqual(value.computer, { enabled: false });
	assert.deepEqual(value.privateArchives, []);
	assert.deepEqual(value.agents, []);
	assert.deepEqual(value.btwCards, {});
	assert.equal(value.revision, rig.state.revision);
	assert.equal(typeof value.modelsKey, "string");
	assert.equal(rig.counters.bootstrap, 1);
	assert.equal(rig.counters.loadSecrets, 1);
	// The live fields ride the same answer.
	assert.deepEqual(value.activity, { chief: "thinking" });
	assert.deepEqual(value.work.bots, { bots: { chief: { since: 1 } } });
	assert.deepEqual(value.work.rooms, { r1: [{ botId: "worker", since: 2 }] });
	assert.equal(typeof value.liveKey, "string");

	const unchanged = await rig.calls("state", { since: 7, models: value.modelsKey });
	assert.equal(unchanged.value.unchanged, true);
	assert.equal(unchanged.value.revision, 7);
	assert.equal(unchanged.value.liveKey, value.liveKey);
	assert.deepEqual(unchanged.value.activity, { chief: "thinking" });
	const stillLive = await rig.calls("state", { since: 7, models: value.modelsKey, live: value.liveKey });
	assert.deepEqual(Object.keys(stillLive.value).sort(), ["liveKey", "revision", "unchanged"]);
	// A changed team revision always answers the full view.
	rig.state.revision = 8;
	const next = await rig.calls("state", { since: 7, models: value.modelsKey, live: value.liveKey });
	assert.equal(next.value.revision, 8);
	assert.ok(Array.isArray(next.value.bots));
});

test("state records the browser language for model-facing text", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	await rig.calls("state", { locale: "zh-CN" });
	assert.equal(rig.rt.uiLanguage(), "Chinese (简体中文)");
	await rig.calls("state", { locale: "en-US" });
	assert.equal(rig.rt.uiLanguage(), "English");
	await rig.calls("state", { locale: "not a locale" });
	assert.equal(rig.rt.uiLanguage(), "English");
});

test("models and efforts answer from the model module", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const models = await rig.calls("models", {});
	assert.equal(models.ok, true);
	assert.equal(typeof models.value.modelsKey, "string");
	assert.equal(rig.counters.catalog, 1);
	const efforts = await rig.calls("efforts", { ref: "deepseek/reasoner" });
	assert.deepEqual(efforts.value, { efforts: [{ id: "high" }] });
	const none = await rig.calls("efforts", { ref: "" });
	assert.deepEqual(none.value, { efforts: [] });
});

test("set-prefs validates each field and saves only what the client may change", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const saved = await rig.calls("set-prefs", { enterToSend: false, theme: "mono", width: 70, accent: "#aabbcc" });
	assert.equal(saved.ok, true);
	assert.equal(saved.value.enterToSend, false);
	assert.equal(saved.value.width, 70);
	assert.equal(saved.value.accent, "#aabbcc");
	assert.equal(rig.counters.save, 1);

	const accent = await rig.calls("set-prefs", { accent: "#zzzzzz" });
	assert.equal(accent.error.code, "bot/invalid");
	const width = await rig.calls("set-prefs", { width: 20 });
	assert.equal(width.error.code, "bot/invalid");
	const layout = await rig.calls("set-prefs", { layout: "wide" });
	assert.equal(layout.error.code, "bot/invalid");
	const local = await rig.calls("set-prefs", { defaultBotModel: "local/agent" });
	assert.equal(local.error.code, "bot/invalid");

	const chosen = await rig.calls("set-prefs", { defaultBotModel: "deepseek/reasoner" });
	assert.equal(chosen.value.defaultBotModel, "resolved/deepseek/reasoner");
	rig.setResolveModel(undefined);
	const noModels = await rig.calls("set-prefs", { defaultBotModel: "deepseek/reasoner" });
	assert.equal(noModels.error.code, "bot/unavailable");
});

test("exchange, exchange-text and file-text keep the earlier shapes", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const pair = await rig.calls("exchange", { a: "chief", b: "worker" });
	assert.deepEqual(
		pair.value.map((entry: any) => entry.id),
		["e1", "e2"],
	);
	const whole = await rig.calls("exchange-text", { id: "e1" });
	assert.deepEqual(whole.value, { text: "whole e1", whole: true });
	const tooOld = await rig.calls("exchange-text", { id: "gone" });
	assert.equal(tooOld.error.code, "bot/stale");
	const file = await rig.calls("file-text", { file: { attachmentId: "sha256:1" } });
	assert.deepEqual(file.value, { text: "file sha256:1", whole: true });
	const noFile = await rig.calls("file-text", {});
	assert.equal(noFile.error.code, "bot/invalid");
});

test("roster and group CRUD endpoints pass the client body through and answer the view", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const created = await rig.calls("create-bot", { name: "Writer", role: "Write", instructions: "write" });
	assert.deepEqual(created.value, { id: "new-bot", name: "Writer" });
	assert.equal(rig.counters.bootstrap, 1);
	assert.equal(rig.counters.createBot[0].name, "Writer");
	assert.equal(rig.counters.createBot[0].role, "Write");

	const updated = await rig.calls("update-bot", { id: "worker", role: "Dev 2" });
	assert.equal(updated.value.role, "Dev 2");
	assert.deepEqual(rig.counters.updateBot[0][0], "worker");
	const copy = await rig.calls("duplicate-bot", { id: "worker" });
	assert.deepEqual(copy.value, { id: "worker-copy" });

	const main = await rig.calls("set-main", { id: "chief", main: true, primary: true });
	assert.equal(main.ok, true);
	assert.deepEqual(rig.counters.setMain[0], ["chief", true, { primary: true, replace: undefined }]);
	const flags = await rig.calls("set-flags", { id: "chief", pinned: true });
	assert.deepEqual(flags.value, { id: "chief" });
	assert.deepEqual(rig.counters.setFlags[0][1], { id: "chief", pinned: true });

	const resumeUnknown = await rig.calls("resume", { botId: "nobody" });
	assert.equal(resumeUnknown.error.code, "bot/not-found");
	const resumed = await rig.calls("resume", { botId: "worker" });
	assert.equal(resumed.value, true);
	assert.deepEqual(rig.counters.resumeBot, ["worker"]);

	const room = await rig.calls("create-room", { members: ["worker"], name: "New", greet: true });
	assert.equal(room.value.id, "room-new");
	assert.deepEqual(rig.counters.createRoom[0], { members: ["worker"], name: "New" });
	assert.deepEqual(rig.counters.greetRoom, ["room-new"]);
	const updateRoom = await rig.calls("update-room", {
		id: "r1",
		name: "Renamed",
		members: ["chief"],
		add: ["worker"],
		remove: [],
	});
	assert.equal(updateRoom.value.changes[0], "renamed it");
	assert.deepEqual(rig.counters.updateRoom[0][1].add, ["worker"]);
	const deletedRoom = await rig.calls("delete-room", { id: "r1" });
	assert.equal(deletedRoom.value.revision, 7);
	assert.deepEqual(rig.counters.deleteRoom, ["r1"]);
	const deletedBot = await rig.calls("delete-bot", { id: "worker" });
	assert.equal(deletedBot.value.revision, 7);
	assert.deepEqual(rig.counters.deleteBot, ["worker"]);
});

test("room-progress answers only the named group's round, also from an earlier part", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const current = await rig.calls("room-progress", { roomId: "r1" });
	assert.deepEqual(current.value, [
		{ callId: "call-1", replies: [{ kind: "user", text: "hi" }], speaking: ["chief"] },
	]);
	const earlier = await rig.calls("room-progress", { roomId: "room-old" });
	assert.deepEqual(earlier.value, current.value);
	const other = await rig.calls("room-progress", { roomId: "nope" });
	assert.deepEqual(other.value, []);
});

test("run-stats reads DSH's projection, or answers null without the service", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const stats = await rig.calls("run-stats", { botId: "chief" });
	assert.deepEqual(stats.value, {
		sessionStats: { turns: 1 },
		names: ["sessionStats", "tokenUsage", "contextPressure"],
	});
	const unknown = await rig.calls("run-stats", { botId: "nobody" });
	assert.equal(unknown.error.code, "bot/not-found");

	const bare = makeRig({ projections: false });
	t.after(async () => {
		await bare.dispose();
	});
	const none = await bare.calls("run-stats", { botId: "chief" });
	assert.equal(none.value, null);
});

test("send resolves a Bot, a group, an earlier part or a group member's part", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const send = async (sessionId: string) => {
		const answer = await rig.calls("send", { sessionId, text: "hello" });
		assert.equal(answer.value, true);
		return rig.counters.prompts.at(-1);
	};
	const own = await send("chief");
	assert.equal(own.sessionId, "chief");
	assert.equal(own.mode, "queue");
	assert.deepEqual(own.content, [{ type: "text", text: "hello" }]);
	assert.equal(typeof own.requestId, "string");
	assert.equal(own.requestId.length, 36, "a request id lands on the message source");
	assert.deepEqual(rig.counters.ensure, ["chief"]);

	assert.equal((await send("r1")).sessionId, "room-current");
	assert.equal((await send("worker-old")).sessionId, "worker");
	assert.equal((await send("group-worker-old")).sessionId, "room-current");
	assert.equal((await send("stranger")).sessionId, "stranger");

	const empty = await rig.calls("send", { sessionId: "chief", text: "   " });
	assert.equal(empty.error.code, "bot/invalid");
	const missing = await rig.calls("send", { text: "hi" });
	assert.equal(missing.error.code, "bot/invalid");
});

test("send refuses honestly when this host cannot prompt a Session", async (t) => {
	const rig = makeRig({ sessionController: false });
	t.after(async () => {
		await rig.dispose();
	});
	const answer = await rig.calls("send", { sessionId: "chief", text: "hi" });
	assert.equal(answer.ok, false);
	assert.equal(answer.error.code, "bot/unavailable");
});

test("answer-question claims the card, queues the reply and rolls back on failure", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const answer = await rig.calls("answer-question", {
		sessionId: "sess-1",
		questionId: "q1",
		answer: { selected: ["B"], custom: "because" },
	});
	assert.equal(answer.value, true);
	assert.equal(rig.state.questions["sess-1"], undefined, "the card is claimed");
	assert.equal(rig.counters.followups.length, 1);
	const message = rig.counters.followups[0];
	const payload = JSON.parse(message.content[0].text);
	assert.equal(payload.kind, "answer_to_pending_question");
	assert.equal(payload.tool, "ask_user");
	assert.equal(payload.callId, "call-q1");
	assert.deepEqual(payload.answers, [{ id: "q1", selected: ["B"], custom: "because" }]);
	assert.equal(message.source.kind, "user-question-reply");
	assert.equal(message.source.callId, "call-q1");
	assert.equal(message.source.outcome, "answered");
	assert.equal(rig.counters.flushes, 1);
	assert.equal(rig.counters.save, 1);

	const stale = await rig.calls("answer-question", {
		sessionId: "sess-1",
		questionId: "q1",
		answer: { selected: ["A"] },
	});
	assert.equal(stale.error.code, "bot/stale");

	// A card answered with nothing still stays open.
	rig.state.questions["sess-1"] = {
		id: "q2",
		botId: "chief",
		sessionId: "sess-1",
		askedAt: 2,
		question: "Again?",
		options: [{ label: "A" }],
	} as any;
	const empty = await rig.calls("answer-question", { sessionId: "sess-1", questionId: "q2", answer: {} });
	assert.equal(empty.error.code, "bot/invalid");
	assert.ok(rig.state.questions["sess-1"] !== undefined);

	// A queue failure puts the claimed card back so the user can retry.
	rig.rt.resolveAgent = async (sessionId: string) => ({
		session: { id: sessionId },
		followup: () => {
			throw new Error("boom");
		},
		cancel() {},
	});
	const failed = await rig.calls("answer-question", {
		sessionId: "sess-1",
		questionId: "q2",
		answer: { selected: ["A"] },
	});
	assert.equal(failed.error.code, "bot/refused");
	assert.ok(rig.state.questions["sess-1"] !== undefined, "the card is restored");
});

test("dismiss-question and dismiss-view close the card in the chat", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const question = await rig.calls("dismiss-question", { sessionId: "sess-1" });
	assert.equal(question.value, true);
	assert.equal(rig.state.questions["sess-1"], undefined);
	assert.deepEqual(rig.state.closedCards["sess-1"], { "call-q1": "dismissed" });
	const view = await rig.calls("dismiss-view", { sessionId: "sess-1" });
	assert.equal(view.value, true);
	assert.equal(rig.state.views["sess-1"], undefined);
	assert.deepEqual(rig.state.closedCards["sess-1"], { "call-q1": "dismissed", "call-v1": "dismissed" });
	const again = await rig.calls("dismiss-question", { sessionId: "nobody" });
	assert.equal(again.value, true);
});

test("stop endpoints settle the goal even when the stop throws", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const member = await rig.calls("stop-member-work", { roomId: "r1", botId: "worker" });
	assert.equal(member.value, true);
	assert.deepEqual(rig.counters.stopMemberWork, [["r1", "worker"]]);
	assert.deepEqual(rig.counters.goalUserStopped, ["r1"]);

	rig.rt.stopRoomWork = async () => {
		throw new Error("cannot stop");
	};
	const failing = await rig.calls("stop-room-work", { roomId: "r1" });
	assert.equal(failing.error.code, "bot/refused");
	assert.deepEqual(rig.counters.goalUserStopped, ["r1", "r1"], "the goal is parked even when the stop fails");
});

test("an install without the connection service warns instead of crashing", async () => {
	const ctx = fakeContext();
	delete (ctx as any).connection;
	const warnings: unknown[][] = [];
	const rt = {
		ctx,
		state: emptyTeam(),
		warn: (...args: unknown[]) => warnings.push(args),
	} as unknown as Runtime;
	install(rt);
	assert.equal(warnings.length, 1);
	assert.match(String(warnings[0][0]), /connection service is missing/);
	await ctx.dispose();
});
