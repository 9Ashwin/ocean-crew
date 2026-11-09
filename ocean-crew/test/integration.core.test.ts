// Integration: the real channel install against a runtime whose side-effect modules are
// attached one at a time. Each endpoint refuses `bot/unavailable` before its module
// publishes the member, and answers from the runtime member once it does; the
// module-less half doubles as the missing-module contract.
//
// The doubles are the module side of the runtime contract; the channel side is the real
// `install` from src/host/chat/channel.ts against `fakeContext`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_ENDPOINTS, install, MODULE_ENDPOINTS, UNAVAILABLE_ENDPOINTS } from "../src/host/chat/channel.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { emptyTeam } from "../src/shared/state.ts";
import type { FakeRoute } from "./fake-ctx.ts";
import { fakeContext } from "./fake-ctx.ts";

type Member = (...args: any[]) => any;

interface Rig {
	rt: Runtime & Record<string, any>;
	state: ReturnType<typeof emptyTeam>;
	route: FakeRoute;
	calls: Array<[string, ...unknown[]]>;
	attach(name: string, value: unknown): void;
	attachAll(members: Record<string, unknown>): void;
	failFollowup(fail: boolean): void;
	call(endpoint: string, payload?: unknown): Promise<any>;
	dispose(): Promise<unknown[]>;
}

// A two-Bot team with one group, one pending view card and the identity maps the channel
// resolves user messages through.
function teamState() {
	const state = emptyTeam();
	state.revision = 12;
	state.mainBotIds = ["chief"];
	state.bots = {
		chief: { id: "chief", name: "Chief", role: "Boss", createdAt: 1 },
		worker: { id: "worker", name: "Dev", createdAt: 2 },
	};
	state.rooms = {
		r1: { id: "r1", name: "Ops", members: ["chief", "worker"], mode: "admin", admin: "chief", named: true },
	};
	state.views = {
		"sess-1": { id: "v1", botId: "chief", sessionId: "sess-1", title: "Chart", view: { type: "chart" } } as any,
	};
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
	(ctx as any).sessionController = { prompt: async (request: unknown) => rec("prompt", request) };
	(ctx as any).sessions = { flush: async () => rec("flush") };

	const state = teamState();
	const chatOwners = new Map([
		["chief", "chief"],
		["worker", "worker"],
	]);
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	const roomOwners = new Map<string, string>();
	const pastOwners = new Map<string, { botId?: string; roomId?: string }>([["worker-old", { botId: "worker" }]]);
	const botOf = (id?: string) => (id === undefined ? undefined : state.bots[id]);
	const roomOf = (id?: string) => (id === undefined ? undefined : state.rooms[id]);
	const chatOf = (botId: string) => state.bots[botId]?.sessionId ?? botId;
	const sessionOfRoom = (room?: { sessionId?: string; id?: string }) => room?.sessionId ?? room?.id;
	const selfOf = (id?: string) => (id === undefined ? undefined : (chatOwners.get(id) ?? pastOwners.get(id)?.botId));

	let followupFails = false;
	const agent = (sessionId: string) => ({
		session: { id: sessionId },
		followup(message: unknown) {
			if (followupFails) throw new Error("followup failed");
			rec("followup", message);
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
		selfOf,
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
		cachedCatalog: () => [{ ref: "deepseek/deepseek-chat", needsKey: false }],
		cachedDefault: () => "deepseek/deepseek-chat",
		bootstrap: async () => rec("bootstrap"),
		resolveAgent: async (sessionId: string) => agent(sessionId),
		ensureCapabilities: async (sessionId: string) => rec("ensureCapabilities", sessionId),
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	const route = routes[0];
	assert.ok(route !== undefined, "channel registers the /api/bot route");

	return {
		rt,
		state,
		route,
		calls,
		attach: (name, value) => {
			rt[name] = value;
		},
		attachAll: (members) => {
			for (const [name, value] of Object.entries(members)) {
				rt[name] = value;
			}
		},
		failFollowup: (fail) => {
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

// Endpoints
// that share a body use the empty object.
const PROBES: Record<string, unknown> = {
	"provider-key": { provider: "deepseek-official", value: null },
	"provider-add": { provider: "router" },
	"provider-models": { baseURL: "https://gateway.example/v1" },
	"provider-remove": { provider: "router" },
	thinking: { sessionId: "chief", turn: 1 },
	earlier: { sessionId: "sess-1", cursor: "cursor-1" },
	chat: { botId: "chief", cursor: "cursor-1" },
	"bot-new-part": { botId: "chief" },
	"bot-open-part": { botId: "chief", sessionId: "worker-old" },
	usage: { timeZone: "Asia/Shanghai" },
	"team-workspace": { path: "/tmp/team" },
	"private-release": { id: "private-1" },
	"avatar-library": { offset: 0, limit: 10 },
	"avatar-import": { items: [{ name: "a.png" }] },
	"avatar-delete": { id: "a1" },
	"agent-session": { agentId: "agent-1", workspaceId: "ws-1" },
	"agent-adopt": { agentId: "agent-1", sessionId: "sess-9" },
	"agent-archive": { agentId: "agent-1", sessionId: "sess-9" },
	"agent-rename": { agentId: "agent-1", sessionId: "sess-9", title: "Work" },
	"remove-agent": { agentId: "agent-1" },
	"approval-answer": { id: "approval-1", choice: "allow" },
	"goal-draft": { roomId: "r1", text: "Ship the release" },
	"goal-control": { roomId: "r1", action: "pause" },
	"room-budget": { roomId: "r1" },
	"view-reply": { sessionId: "sess-1", viewId: "v1", action: "submit", values: { answer: "B" } },
	"btw-delete": { sessionId: "sess-1", cardId: "card-1" },
	"side-new": { sessionId: "chief" },
	"side-ask": { sessionId: "chief", chatId: "chat-1", text: "Why?", recent: true },
	"side-cancel": { chatId: "chat-1", entryId: "entry-1" },
	"side-close": { chatId: "chat-1" },
	"update-check": { fresh: true },
	diagnostics: { kind: "all" },
};

function moduleMembers(calls: Array<[string, ...unknown[]]>): Record<string, Member | Record<string, Member>> {
	const rec =
		(name: string) =>
		(...args: unknown[]): void => {
			calls.push([name, ...args]);
		};
	return {
		providersView: async () => ({ providers: [{ provider: "deepseek-official" }] }),
		setProviderKey: rec("setProviderKey"),
		clearProviderKey: rec("clearProviderKey"),
		addProvider: async (body: any) => ({ provider: body.provider }),
		discoverModels: async (body: any) => ({ models: [body.baseURL] }),
		removeProvider: async (provider: string) => ({ removed: provider }),
		thinkingOf: async (sessionId: string, turn: number) => {
			rec("thinkingOf")(sessionId, turn);
			return 42;
		},
		earlierPage: async (sessionId: string, cursor?: string) => ({ sessionId, cursor, lines: ["earlier"] }),
		chatPage: async (botId: string, cursor?: string) => ({ botId, cursor, items: ["chat"] }),
		newPart: async (sessionId: string) => `part:${sessionId}`,
		switchPart: async (botId: string, sessionId: string) => `switched:${botId}:${sessionId}`,
		usageView: async (options: unknown) => ({ total: 5, options }),
		folderEndpoint: async (endpoint: string, body: unknown, signal?: AbortSignal) => ({
			endpoint,
			body,
			abortable: signal !== undefined,
		}),
		setTeamWorkspace: async (path: string) => ({ id: "workspace-1", path }),
		releaseArchive: rec("releaseArchive"),
		resetTeam: async () => ({ backup: "backups/reset-test", path: "/tmp/backups/reset-test" }),
		avatarLibraryView: async (options: unknown) => ({ items: [], options }),
		avatarLibraryImport: async (items: unknown[]) => ({ added: items.length }),
		avatarLibraryDelete: async (id: string) => ({ deleted: id }),
		addAgent: async () => ({ id: "agent-1" }),
		createAgentSession: async (agentId: string, workspaceId: string) => `session:${agentId}:${workspaceId}`,
		adoptAgentSession: async (agentId: string, sessionId: string) => `adopted:${agentId}:${sessionId}`,
		archiveAgentSession: rec("archiveAgentSession"),
		renameAgentSession: rec("renameAgentSession"),
		removeAgent: rec("removeAgent"),
		answerApproval: rec("answerApproval"),
		goalDraft: async (roomId: string, text: string) => {
			rec("goalDraft")(roomId, text);
			return { room: roomId, text };
		},
		goalControl: async (roomId: string, body: unknown) => {
			rec("goalControl")(roomId, body);
			return { room: roomId, body };
		},
		groupBudgetView: async (roomId: string) => ({
			available: true,
			members: { spent: 0 },
			summary: { spent: 0 },
			idle: { streak: 0, paused: false },
			roomId,
		}),
		setGroupBudget: async (roomId: string, body: unknown) => {
			rec("setGroupBudget")(roomId, body);
			return { available: true, members: { spent: 0 }, summary: { spent: 0 }, idle: { streak: 0, paused: false } };
		},
		ttsSettingsView: async () => ({ enabled: true, model: "breeze-tts-2", hasSecret: true }),
		ttsSettingsSet: async (patch: unknown) => ({ saved: true, patch }),
		ttsVoices: async () => [{ id: "voc_1", name: "Narrator" }],
		ttsTest: async () => ({ ms: 12, name: "voice.mp3" }),
		secretEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
		connectorEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
		capabilityEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
		scheduleEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
		memoryEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
		learningEndpoint: async (endpoint: string, body: unknown) => ({ endpoint, body }),
		validateViewAnswer: (view: unknown, action: unknown, values: unknown) => {
			rec("validateViewAnswer")(view, action, values);
			return {};
		},
		viewReply: (pending: { id: string }) => ({
			text: JSON.stringify({ kind: "answer_to_pending_view", viewId: pending.id }),
			source: { kind: "user-question-reply", callId: pending.id, outcome: "answered" },
		}),
		btwDelete: async (input: { cardId: string }) => ({ deleted: input.cardId }),
		sideNew: async (input: { sessionId: string }) => ({ chatId: `chat:${input.sessionId}` }),
		sideAsk: async (input: { text: string }) => ({ answered: input.text }),
		sideCancel: async (input: { entryId: string }) => ({ cancelled: input.entryId }),
		sideClose: async (input: { chatId: string }) => ({ closed: input.chatId }),
		updateCheck: async ({ fresh }: { fresh: boolean }) => ({ version: "0.3.0", fresh }),
		dshUpdateCheck: async ({ fresh }: { fresh: boolean }) => ({ version: "2.0.0", fresh }),
		updateStart: () => "update-started",
		dshUpdateStart: () => "dsh-update-started",
		repoStars: async () => 42,
		diagnostics: {
			report: async (body: unknown) => ({ errors: [], body }),
			logText: async () => "log text",
			clear: rec("diagnostics.clear"),
		},
	};
}

function lastCall(calls: Array<[string, ...unknown[]]>, name: string): [string, ...unknown[]] | undefined {
	return calls.filter(([called]) => called === name).at(-1);
}

test("the module surface is disjoint from the channel and placeholder surfaces", () => {
	assert.ok(MODULE_ENDPOINTS.length > 60);
	for (const endpoint of MODULE_ENDPOINTS) {
		assert.ok(!CHANNEL_ENDPOINTS.includes(endpoint), `${endpoint} is not a channel endpoint`);
		assert.ok(!UNAVAILABLE_ENDPOINTS.has(endpoint), `${endpoint} is not a static placeholder`);
	}
	for (const endpoint of UNAVAILABLE_ENDPOINTS.keys()) {
		assert.ok(!MODULE_ENDPOINTS.includes(endpoint), `${endpoint} is still a placeholder`);
	}
});

test("every module endpoint refuses before its module loads, naming the missing member", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	for (const endpoint of MODULE_ENDPOINTS) {
		const answer = await rig.call(endpoint, PROBES[endpoint] ?? {});
		assert.equal(answer.ok, false, endpoint);
		assert.equal(answer.error.code, "bot/unavailable", endpoint);
		assert.match(answer.error.message, /not installed in this build/, `${endpoint} names the missing member`);
	}
});

test("attaching the module members makes each M3 endpoint answer with the earlier shape", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.attachAll(moduleMembers(rig.calls));
	for (const endpoint of MODULE_ENDPOINTS) {
		const answer = await rig.call(endpoint, PROBES[endpoint] ?? {});
		assert.equal(answer.ok, true, `${endpoint}: ${JSON.stringify(answer.error ?? null)}`);
	}

	assert.deepEqual((await rig.call("providers")).value, { providers: [{ provider: "deepseek-official" }] });
	const key = await rig.call("provider-key", PROBES["provider-key"]);
	assert.equal(key.value.providers.length, 1);
	assert.deepEqual(lastCall(rig.calls, "clearProviderKey")?.slice(1), ["deepseek-official"]);
	const added = await rig.call("provider-add", PROBES["provider-add"]);
	assert.deepEqual(added.value, { provider: "router" });
	const discovered = await rig.call("provider-models", PROBES["provider-models"]);
	assert.deepEqual(discovered.value, { models: ["https://gateway.example/v1"] });
	const removed = await rig.call("provider-remove", PROBES["provider-remove"]);
	assert.deepEqual(removed.value, { removed: "router" });

	// Parts and history.
	assert.deepEqual((await rig.call("thinking", PROBES.thinking)).value, { ms: 42 });
	const earlier = await rig.call("earlier", PROBES.earlier);
	assert.deepEqual(earlier.value, { sessionId: "sess-1", cursor: "cursor-1", lines: ["earlier"] });
	assert.deepEqual((await rig.call("chat", PROBES.chat)).value, {
		botId: "chief",
		cursor: "cursor-1",
		items: ["chat"],
	});
	assert.equal((await rig.call("bot-new-part", PROBES["bot-new-part"])).value, "part:chief");
	assert.equal((await rig.call("bot-open-part", PROBES["bot-open-part"])).value, "switched:chief:worker-old");
	assert.equal((await rig.call("usage", PROBES.usage)).value.total, 5);
	assert.equal((await rig.call("usage", PROBES.usage)).value.options.timeZone, "Asia/Shanghai");

	// Folders, workspace and the private archive.
	const folder = await rig.call("folder-pick", { path: "/tmp/team" });
	assert.equal(folder.value.endpoint, "folder-pick");
	assert.equal(folder.value.abortable, true, "the request signal reaches folderEndpoint");
	assert.deepEqual((await rig.call("team-workspace", PROBES["team-workspace"])).value, {
		team: { id: "workspace-1", path: "/tmp/team" },
	});
	const released = await rig.call("private-release", PROBES["private-release"]);
	assert.equal(released.value.revision, 12, "private-release answers the view");
	assert.deepEqual(lastCall(rig.calls, "releaseArchive")?.slice(1), ["private-1"]);

	// Avatar library.
	assert.deepEqual((await rig.call("avatar-import", PROBES["avatar-import"])).value, { added: 1 });
	assert.deepEqual((await rig.call("avatar-delete", PROBES["avatar-delete"])).value, { deleted: "a1" });

	// The team's DSH Agent.
	assert.deepEqual((await rig.call("add-agent")).value, { id: "agent-1" });
	assert.deepEqual((await rig.call("agent-session", PROBES["agent-session"])).value, {
		sessionId: "session:agent-1:ws-1",
	});
	assert.deepEqual((await rig.call("agent-adopt", PROBES["agent-adopt"])).value, {
		sessionId: "adopted:agent-1:sess-9",
	});
	assert.equal((await rig.call("agent-archive", PROBES["agent-archive"])).value, true);
	assert.equal((await rig.call("agent-rename", PROBES["agent-rename"])).value, true);
	assert.deepEqual(lastCall(rig.calls, "renameAgentSession")?.slice(1), ["agent-1", "sess-9", "Work"]);
	assert.equal((await rig.call("remove-agent", PROBES["remove-agent"])).value.revision, 12);

	// Approvals and goals.
	const approval = await rig.call("approval-answer", PROBES["approval-answer"]);
	assert.equal(approval.value, true);
	assert.deepEqual(lastCall(rig.calls, "answerApproval")?.slice(1), ["approval-1", "allow"]);
	const draft = await rig.call("goal-draft", PROBES["goal-draft"]);
	assert.equal(draft.value.revision, 12);
	assert.deepEqual(lastCall(rig.calls, "goalDraft")?.slice(1), ["r1", "Ship the release"]);
	assert.equal((await rig.call("goal-control", PROBES["goal-control"])).value.revision, 12);

	// Families pass the endpoint name and the body through unchanged, one sample each.
	for (const endpoint of [
		"secret-set",
		"connector-connect",
		"mail-sign-in-code",
		"capability-approve",
		"schedule-create",
		"memory-forget",
		"learning-answer",
	]) {
		const answer = await rig.call(endpoint, { probe: endpoint });
		assert.equal(answer.value.endpoint, endpoint, `${endpoint} passes its name to the module`);
		assert.deepEqual(answer.value.body, { probe: endpoint }, `${endpoint} passes its body through`);
	}

	// Session cards.
	assert.equal((await rig.call("btw-delete", PROBES["btw-delete"])).value.deleted, "card-1");
	assert.deepEqual((await rig.call("side-new", PROBES["side-new"])).value, { chatId: "chat:chief" });
	assert.deepEqual((await rig.call("side-ask", PROBES["side-ask"])).value, { answered: "Why?" });
	assert.deepEqual((await rig.call("side-cancel", PROBES["side-cancel"])).value, { cancelled: "entry-1" });
	assert.deepEqual((await rig.call("side-close", PROBES["side-close"])).value, { closed: "chat-1" });

	// Updates, stars and diagnostics.
	const update = await rig.call("update-check", PROBES["update-check"]);
	assert.equal(update.value.version, "0.3.0");
	assert.equal(update.value.dsh.version, "2.0.0");
	assert.equal((await rig.call("update-install")).value, "update-started");
	assert.equal((await rig.call("dsh-update-install")).value, "dsh-update-started");
	assert.equal((await rig.call("repo-stars")).value, 42);
	assert.deepEqual((await rig.call("diagnostics", PROBES.diagnostics)).value, {
		errors: [],
		body: { kind: "all" },
	});
	assert.equal((await rig.call("diagnostics-log")).value, "log text");
	assert.equal((await rig.call("diagnostics-clear")).value, true);
	assert.ok(lastCall(rig.calls, "diagnostics.clear") !== undefined, "clear reaches diagnostics");
});

test("a goal control failure keeps its earlier error code", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.attachAll(moduleMembers(rig.calls));
	rig.rt.goalDraft = async () => ({ error: "No goal is running in Ops", code: "bot/not-found" });
	const coded = await rig.call("goal-draft", PROBES["goal-draft"]);
	assert.equal(coded.error.code, "bot/not-found");
	assert.equal(coded.error.message, "No goal is running in Ops");
	rig.rt.goalControl = async () => ({ error: "The goal is paused" });
	const refused = await rig.call("goal-control", PROBES["goal-control"]);
	assert.equal(refused.error.code, "bot/refused");
});

test("view-reply claims the card before queueing and restores it on failure", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	rig.attachAll(moduleMembers(rig.calls));
	const stale = await rig.call("view-reply", { ...(PROBES["view-reply"] as Record<string, unknown>), viewId: "old" });
	assert.equal(stale.error.code, "bot/stale");
	// The failed queue puts the claimed view back.
	rig.failFollowup(true);
	const failed = await rig.call("view-reply", PROBES["view-reply"]);
	assert.equal(failed.error.code, "bot/refused");
	assert.ok(rig.state.views["sess-1"] !== undefined, "the view is restored");
	// The next answer goes through and the view is claimed.
	rig.failFollowup(false);
	const answered = await rig.call("view-reply", PROBES["view-reply"]);
	assert.equal(answered.value, true);
	assert.equal(rig.state.views["sess-1"], undefined);
	const followup = lastCall(rig.calls, "followup");
	assert.ok(followup !== undefined);
	const message = followup[1] as { content: Array<{ text: string }>; source: { kind: string; callId: string } };
	const payload = JSON.parse(message.content[0].text);
	assert.equal(payload.kind, "answer_to_pending_view");
	assert.equal(message.source.kind, "user-question-reply");
	assert.equal(message.source.callId, "v1");
	assert.ok(lastCall(rig.calls, "flush") !== undefined);
});

test("the state answer carries the M3 views once their modules are installed", async (t) => {
	const rig = makeRig();
	t.after(async () => {
		await rig.dispose();
	});
	const before = await rig.call("state", {});
	assert.deepEqual(before.value.btwCards, {});
	assert.deepEqual(before.value.sideChats, {});
	assert.deepEqual(before.value.privateArchives, []);
	assert.deepEqual(before.value.secrets, []);
	// without the module the
	// channel answers the empty list rather than a differently shaped object.
	assert.deepEqual(before.value.capabilities, []);

	rig.attachAll({
		loadSecrets: async () => {
			rig.calls.push(["loadSecrets"]);
		},
		secretsView: () => [{ name: "DEEPSEEK_API_KEY", holders: [] }],
		capabilityLibraryView: () => ({ items: { github: { kind: "mcp" } } }),
		archivesView: () => [{ id: "private-1", name: "Quiet" }],
		btwView: () => ({ chief: [{ id: "c1", text: "aside" }] }),
		sideView: () => ({ chief: [{ id: "s1", title: "why" }] }),
		imView: () => ({ connections: [{ id: "im-1" }], platforms: ["feishu"] }),
	});
	const after = await rig.call("state", {});
	assert.deepEqual(after.value.secrets, [{ name: "DEEPSEEK_API_KEY", holders: [] }]);
	assert.deepEqual(after.value.capabilities, { items: { github: { kind: "mcp" } } });
	assert.deepEqual(after.value.privateArchives, [{ id: "private-1", name: "Quiet" }]);
	assert.deepEqual(after.value.btwCards, { chief: [{ id: "c1", text: "aside" }] });
	assert.deepEqual(after.value.sideChats, { chief: [{ id: "s1", title: "why" }] });
	assert.deepEqual(after.value.im, { connections: [{ id: "im-1" }], platforms: ["feishu"] });
	assert.ok(lastCall(rig.calls, "loadSecrets") !== undefined, "state reloads the secrets view");
});
