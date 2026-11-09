// Team tools: the Session-scoped registration, the hidden-tool masks and guard, the
// question and view card state, and what the roster, messaging and group tools return.

// blocking-question, show-view-scope and bot-messages tests, driven through a fake
// runtime so only the module's public surface is asserted: `rt.teamTools`, what each
// Agent's own scope receives, `state.questions`/`state.views`, and the `rt` calls.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime, TeamTool } from "../src/host/core/runtime.ts";
import { normalize, unquote } from "../src/host/core/text.ts";
import { install } from "../src/host/team/tools.ts";
import { type FakeContext, type FakeTool, fakeContext } from "./fake-ctx.ts";

type AnyState = Record<string, any>;

interface FakeAgent {
	id: string;
	session: { id: string };
	registered: FakeTool[];
	restricted: Array<{ deny: string[] }>;
	listeners: Array<{ event: string; listener: (...args: any[]) => any; disposed: boolean }>;
	calls: unknown[][];
	inbox: { nextStep: MessageLike[]; nextTurn: MessageLike[]; remove(id: unknown): boolean };
	cancel(cause: unknown): void;
}

interface MessageLike {
	id?: string;
	content?: unknown[];
	source?: Record<string, any>;
	[key: string]: unknown;
}

// A two-Bot team with one group chat; a test seeds Sessions or extra Bots on it.
function team(): AnyState {
	return {
		version: 1,
		mainBotIds: ["chief"],
		bots: {
			chief: { id: "chief", name: "Chief", role: "Boss", sessionId: "chief", instructions: "", createdAt: 1 },
			writer: { id: "writer", name: "Writer", role: "Write", sessionId: "writer", instructions: "", createdAt: 2 },
		},
		rooms: {
			ops: {
				id: "ops",
				name: "Ops",
				members: ["chief", "writer"],
				mode: "admin",
				admin: "chief",
				named: true,
				sessions: {},
				log: [],
				seq: 0,
				seen: {},
			},
		},
		agents: {},
		capabilities: { items: {} },
		exchanges: [],
		exchangeTurns: {},
		works: {},
		requests: {},
		questions: {},
		views: {},
		closedCards: {},
		prefs: {},
		switching: {},
		privateArchives: [],
		revision: 1,
	};
}

interface StartOptions {
	state?: AnyState;
	services?: Record<string, any>;
	served?: string[];
	attachLong?: (text: string, name: string) => Promise<{ text: string; files: unknown[]; length: number } | undefined>;
}

// The fake host: a context whose per-Agent tool scope, restrictions and listeners are
// recorded, a runtime with the pieces tools.ts calls, and the Session-owner indexes a
// save would rebuild.
function start(options: StartOptions = {}) {
	const state = options.state ?? team();
	const ctx: FakeContext = fakeContext({ services: options.services ?? {} });
	const warnings: unknown[][] = [];
	const agents = new Map<string, FakeAgent>();
	const delivered: Array<Record<string, any>> = [];
	const roomSteps: unknown[][] = [];
	const live = new Map<string, Record<string, any>>();
	const receipts = new Map<string, unknown>();
	const lastRequests: Array<Record<string, any>> = [];
	const chatOwners = new Map<string, string>();
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	const roomOwners = new Map<string, string>();
	const pastOwners = new Map<string, { botId?: string; roomId?: string }>();
	const statuses = new Map<string, string>();
	const connectorPrefixes: string[] = [];
	let restrictThrows: string | undefined;
	const scopedToolNames = (agent: FakeAgent): string[] => agent.registered.map((tool) => tool.name);

	const reindex = (): void => {
		chatOwners.clear();
		groupOwners.clear();
		roomOwners.clear();
		pastOwners.clear();
		for (const bot of Object.values(state.bots) as AnyState[]) {
			chatOwners.set(bot.sessionId ?? bot.id, bot.id);
			for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id });
		}
		for (const room of Object.values(state.rooms) as AnyState[]) {
			const sessionId = room.sessionId ?? room.id;
			if (sessionId !== undefined) roomOwners.set(sessionId, room.id);
			for (const segment of room.parts ?? []) pastOwners.set(segment.sessionId, { roomId: room.id });
			for (const [botId, memberSession] of Object.entries(room.sessions ?? {}))
				groupOwners.set(String(memberSession), { botId, roomId: room.id });
		}
	};
	reindex();

	const botOf = (id?: string): AnyState | undefined => (id === undefined ? undefined : state.bots[id]);
	const chatOf = (botId: string): string => botOf(botId)?.sessionId ?? botId;
	const selfOf = (id?: string): string | undefined =>
		id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId);
	const roomOf = (id?: string): AnyState | undefined =>
		id === undefined ? undefined : (state.rooms[id] ?? state.rooms[roomOwners.get(id) ?? ""]);
	const isMain = (id?: string): boolean => id !== undefined && state.mainBotIds.includes(id);
	const isBotSession = (id?: string): boolean => id !== undefined && (chatOwners.has(id) || groupOwners.has(id));
	const isAdminOf = (room: AnyState, id?: string): boolean => id !== undefined && room.admin === id;
	const findBot = (ref?: unknown): AnyState | undefined => {
		if (ref === undefined) return undefined;
		const byId = state.bots[String(ref)];
		if (byId !== undefined) return byId;
		const wanted = normalize(unquote(ref)).replace(/^@/, "");
		return (Object.values(state.bots) as AnyState[]).find((bot) => normalize(bot.name) === wanted);
	};
	const findRooms = (ref?: unknown): AnyState[] => {
		if (ref === undefined || ref === null) return [];
		const byId = state.rooms[String(ref)];
		if (byId !== undefined) return [byId];
		const wanted = normalize(unquote(ref));
		return (Object.values(state.rooms) as AnyState[]).filter((room) => normalize(room.name) === wanted);
	};

	const agentOf = (sessionId: string): FakeAgent => {
		const held = agents.get(sessionId);
		if (held !== undefined) return held;
		const agent: FakeAgent = {
			id: sessionId,
			session: { id: sessionId },
			registered: [],
			restricted: [],
			listeners: [],
			calls: [],
			inbox: {
				nextStep: [],
				nextTurn: [],
				remove(id: unknown): boolean {
					for (const list of [this.nextStep, this.nextTurn]) {
						const at = list.findIndex((message) => message.id === id);
						if (at !== -1) {
							list.splice(at, 1);
							return true;
						}
					}
					return false;
				},
			},
			cancel(cause: unknown): void {
				agent.calls.push(["cancel", cause]);
			},
		};
		agent.listeners = [];
		// The real service methods read `this`; a detached reference would throw there, so
		// the fake checks that every call is made on the service object itself.
		const surface = {
			register(this: any, tool: FakeTool): () => void {
				assert.equal(this, surface, "tools.register is called on the service");
				const entry = tool;
				agent.registered.push(entry);
				return () => {
					const at = agent.registered.indexOf(entry);
					if (at !== -1) agent.registered.splice(at, 1);
				};
			},
			restrict(this: any, filter: { deny?: string[] }): () => void {
				assert.equal(this, surface, "tools.restrict is called on the service");
				const entry = { deny: [...(filter.deny ?? [])] };
				if (restrictThrows !== undefined && entry.deny.includes(restrictThrows))
					throw new Error(`"${restrictThrows}" is registered in this scope`);
				agent.restricted.push(entry);
				return () => {
					const at = agent.restricted.indexOf(entry);
					if (at !== -1) agent.restricted.splice(at, 1);
				};
			},
		};
		(agent as any).ctx = {
			tools: surface,
			on(event: string, listener: (...args: any[]) => any): () => void {
				const record = { event, listener, disposed: false };
				agent.listeners.push(record);
				return () => {
					record.disposed = true;
				};
			},
			effect(execute: () => unknown): unknown {
				return execute();
			},
		};
		agents.set(sessionId, agent);
		return agent;
	};

	const served = options.served ?? [];
	ctx.tools.schemas = ((agent?: FakeAgent) => [
		...served.map((name) => ({ name })),
		...(agent === undefined ? [] : scopedToolNames(agent).map((name) => ({ name }))),
	]) as unknown as FakeContext["tools"]["schemas"];
	const attachLong =
		options.attachLong ??
		(async (text: string, name: string) => ({ text, files: [], length: text.length, name: `${name}` }));

	const works = new Map<string, Record<string, any>>();
	const rt = {
		ctx,
		state,
		teamTools: [] as TeamTool[],
		live,
		chatOwners,
		groupOwners,
		roomOwners,
		pastOwners,
		warn: (...args: unknown[]) => warnings.push(args),
		load: async () => {},
		save: async () => {},
		readOnly: () => undefined,
		own: (table: Record<string, unknown> | null | undefined, key: string) =>
			table !== null && table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined,
		botOf,
		roomOf,
		isMain,
		isBotSession,
		isAdminOf,
		findBot,
		findRooms,
		chatOf,
		selfOf,
		groupSessionsOf: (botId: string) =>
			(Object.values(state.rooms) as AnyState[])
				.map((room) => room.sessions?.[botId])
				.filter((value): value is string => typeof value === "string"),
		statusOf: (botId: string) => statuses.get(botId) ?? "idle",
		resolveAgent: async (sessionId: string) => agentOf(sessionId),
		deliver: async (args: Record<string, any>) => {
			delivered.push(args);
		},
		attachLong,
		workOf: (info?: Record<string, any>) =>
			info === undefined
				? undefined
				: info.role === "request" && info.audience !== "user"
					? info.exchangeId
					: info.work,
		openWork: (id: string, info: Record<string, any>) => {
			const above = info.parent === undefined ? undefined : works.get(info.parent);
			const work = { ...info, open: [], results: [], at: 1 };
			works.set(id, work);
			state.works[id] = { ...info, open: [], results: [], at: 1 };
			if (above !== undefined) above.open.push(id);
		},
		dropWork: (id: string) => {
			works.delete(id);
			delete state.works[id];
		},
		ownsWork: (botId: string, id?: string) =>
			id !== undefined && (works.get(id)?.from ?? state.works[id]?.from) === botId,
		upstreamOf: (_ids: string[]) => new Set<string>(),
		sameWork: (id: string | undefined, parent: string | undefined) =>
			(id === undefined ? undefined : works.get(id)?.parent) === (parent === undefined ? undefined : parent),
		forgetDelivery: () => {},
		requestIdentity: ({ caller, context, name, payload }: Record<string, any>) => {
			const request = { key: `${caller}\u0000${context}\u0000${name}`, payload };
			lastRequests.push(request);
			return request;
		},
		knownRequest: async (request: { key: string }) =>
			receipts.has(request.key) ? { status: "replay", receipt: receipts.get(request.key) } : undefined,
		admitRequest: async (request: Record<string, any>, work: () => Promise<unknown>) => {
			const receipt = await work();
			if (request.unsent === true) return { status: "sent", receipt };
			receipts.set(request.key, receipt);
			return { status: "sent", receipt };
		},
		sessionFolder: () => "/team",
		inData: undefined,
		catalog: async () => [] as AnyState[],
		defaultRef: () => undefined,
		cleanWorkDir: async (path: string) => path,
		approveFolder: async () => {},
		sessionsOfBot: () => [] as string[],
		createBot: async (args: Record<string, any>) => ({ id: "new", name: args.name }),
		updateBot: async (id: string, patch: Record<string, any>) => ({ ...state.bots[id], ...patch }),
		createRoom: async (args: Record<string, any>) => ({
			id: "newroom",
			name: args.name ?? "Group",
			members: args.members,
			mode: args.mode ?? "admin",
			admin: args.admin,
		}),
		updateRoom: async () => ({ room: { id: "ops", name: "Ops" }, changes: [] as string[] }),
		deleteRoom: async () => {},
		roomBusy: () => false,
		roomStepText: async (...args: unknown[]) => {
			roomSteps.push(args);
		},
		postToRoom: async (...args: unknown[]) => {
			roomSteps.push(args);
		},
		connectorOffFor: () => connectorPrefixes,
		shadowShells: () => [] as Array<() => void>,
	} as unknown as Runtime & Record<string, any>;
	install(rt);

	const agentCreated = async (sessionId: string): Promise<void> => {
		const agent = agentOf(sessionId);
		await ctx.emitAsync("agent/created", { agent });
	};
	const tool = (name: string, args: Record<string, any>, sessionId: string, extra: Record<string, any> = {}) => {
		const definition = rt.teamTools.find((candidate) => candidate.name === name);
		assert.ok(definition, `no tool ${name}`);
		assert.ok(definition.execute);
		return definition.execute(args, { agent: agentOf(sessionId), name, callId: "c1", ...extra });
	};
	const guard = (name: string, sessionId?: string, args?: Record<string, any>) =>
		ctx.guards
			.map((check) =>
				check({ name, arguments: args, agent: sessionId === undefined ? undefined : { id: sessionId } }),
			)
			.find((reason) => reason !== undefined);
	const denied = (sessionId: string): string[] =>
		agents.get(sessionId)?.restricted.flatMap((entry) => entry.deny) ?? [];
	const assemble = async (agent: FakeAgent, assembly: Record<string, any>): Promise<Record<string, any>> => {
		const listeners = ctx.listeners.get("system-prompt/assemble") ?? [];
		const listener = listeners[listeners.length - 1];
		assert.ok(listener);
		return (await listener(assembly, { agent, signal: undefined }, async () => assembly)) as Record<string, any>;
	};
	return {
		ctx,
		rt,
		state,
		agents,
		agentOf,
		agentCreated,
		assemble,
		chatOwners,
		groupOwners,
		delivered,
		roomSteps,
		live,
		warnings,
		receipts,
		lastRequests,
		reindex,
		tool,
		guard,
		denied,
		scopedNames: (sessionId: string) => scopedToolNames(agentOf(sessionId)),
		setStatus: (botId: string, status: string) => statuses.set(botId, status),
		setRestrictThrows: (name: string) => {
			restrictThrows = name;
		},
		setConnectorPrefixes: (prefixes: string[]) => {
			connectorPrefixes.splice(0, connectorPrefixes.length, ...prefixes);
		},
	};
}

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("until: the condition did not hold within the timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

// ----- scoping: what each kind of Session receives -----

// The tools this module registers, plus the three the groups module pushes into the same
// teamTools list: what a Bot's own Session and a member's group Session must both serve.
const M2_TOOLS = [
	"list_bots",
	"message_bot",
	"stop_bot",
	"create_bot",
	"update_bot",
	"list_bot_models",
	"create_group",
	"update_group",
	"delete_group",
	"post_to_group",
	"ask_user",
	"show_view",
	"send_file",
];
const GROUP_TOOLS = ["group_relay", "read_own_chat", "read_group_chat"];
const addGroupTools = (host: ReturnType<typeof start>): void => {
	for (const name of GROUP_TOOLS)
		host.rt.addTeamTool({ name, description: `${name} tool`, parameters: {}, execute: async () => "" });
};

test("a Bot Session gets every team tool in its own scope, never the global layer", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	await host.agentCreated("chief");
	assert.deepEqual(host.scopedNames("chief").sort(), [...M2_TOOLS, ...GROUP_TOOLS].sort());
	assert.equal(host.rt.teamTools.length, M2_TOOLS.length + GROUP_TOOLS.length);
	assert.equal(host.ctx.registeredTools.size, 0, "team tools are never registered globally");
});

test("a group member Session gets the whole scope; the group's own Session gets only its relay", async (t) => {
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	await host.agentCreated("group-writer");
	await host.agentCreated("ops");
	assert.deepEqual(host.scopedNames("group-writer").sort(), [...M2_TOOLS, ...GROUP_TOOLS].sort());
	assert.deepEqual(host.scopedNames("ops"), ["group_relay"]);
});

test("a Session ocean-crew does not own sees none of the team tools and no masks", async (t) => {
	const host = start({ served: ["read", "ask_user_question", "subagent"] });
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	await host.agentCreated("plain1");
	assert.deepEqual(host.scopedNames("plain1"), []);
	assert.deepEqual(host.denied("plain1"), []);
	assert.equal(host.ctx.registeredTools.size, 0);
});

test("unloading lifts every scoped tool and mask and disposes the Agent listeners", async (t) => {
	const host = start({ served: ["read", "ask_user_question"] });
	addGroupTools(host);
	await host.agentCreated("chief");
	assert.ok(host.scopedNames("chief").length > 0);
	assert.ok(host.denied("chief").length > 0);
	const agent = host.agentOf("chief");
	await host.ctx.dispose();
	assert.deepEqual(host.scopedNames("chief"), []);
	assert.deepEqual(agent.restricted, []);
	for (const record of agent.listeners) assert.equal(record.disposed, true);
	t.after(() => {});
});

test("a Bot that leaves the team loses its scope on the next sync", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	await host.agentCreated("writer");
	assert.ok(host.scopedNames("writer").includes("message_bot"));
	delete host.state.bots.writer;
	host.reindex();
	host.rt.syncScopedTools?.();
	assert.deepEqual(host.scopedNames("writer"), []);
	assert.deepEqual(host.denied("writer"), []);
	// A Session that becomes a Bot's again gets the scope back.
	host.state.bots.writer = { id: "writer", name: "Writer", sessionId: "writer", createdAt: 2 };
	host.reindex();
	host.rt.syncScopedTools?.();
	await host.agentCreated("writer");
	assert.ok(host.scopedNames("writer").includes("message_bot"));
});

test("a tool added after the first scoping reaches every Bot Session, and removing it lifts it", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	await host.agentCreated("chief");
	host.rt.addTeamTool({ name: "late_tool", description: "late", parameters: {}, execute: async () => "" });
	assert.ok(host.scopedNames("chief").includes("late_tool"));
	host.rt.removeTeamTool("late_tool");
	assert.ok(!host.scopedNames("chief").includes("late_tool"));
	assert.ok(!host.rt.teamTools.some((tool) => tool.name === "late_tool"));
	assert.equal(host.rt.teamTools.length, 13);
});

// ----- the hidden tools: masks, assembly filter, guard -----

const HIDDEN_SERVED = [
	"read",
	"ask_user_question",
	"create_goal",
	"update_goal",
	"get_goal",
	"subagent",
	"send_message",
];

test("a Bot Session masks DSH's blocking question, goal and delegation tools; other Sessions keep them", async (t) => {
	const host = start({ served: HIDDEN_SERVED });
	t.after(() => host.ctx.dispose());
	for (const id of ["chief", "writer", "plain1"]) await host.agentCreated(id);
	assert.deepEqual(host.denied("chief"), [
		"ask_user_question",
		"create_goal",
		"update_goal",
		"get_goal",
		"subagent",
		"send_message",
	]);
	assert.deepEqual(host.denied("writer"), host.denied("chief"));
	assert.deepEqual(host.denied("plain1"), []);
	// Masking again on a second resolve adds nothing.
	await host.agentCreated("chief");
	assert.equal(host.denied("chief").length, 6);
});

test("a profile that does not serve the hidden tools gets no mask, which restrict() would refuse", async (t) => {
	const host = start({ served: ["read", "ask_user_question"] });
	t.after(() => host.ctx.dispose());
	await host.agentCreated("chief");
	assert.deepEqual(host.denied("chief"), ["ask_user_question"]);
	assert.match(String(host.guard("ask_user_question", "chief")), /Bots cannot use ask_user_question/);
	const empty = start({ served: ["read", "ask_user"] });
	t.after(() => empty.ctx.dispose());
	await empty.agentCreated("chief");
	assert.deepEqual(empty.denied("chief"), []);
});

test("when one delegation name cannot be masked, the rest still are and the guard still refuses", async (t) => {
	const host = start({ served: ["read", "ask_user_question", "subagent", "send_message"] });
	t.after(() => host.ctx.dispose());
	host.setRestrictThrows("send_message");
	await host.agentCreated("chief");
	assert.deepEqual(host.denied("chief"), ["ask_user_question", "subagent"]);
	await host.agentCreated("chief");
	assert.deepEqual(host.denied("chief"), ["ask_user_question", "subagent"]);
	assert.match(String(host.guard("send_message", "chief")), /Bots do not start subagents/);
});

test("the guard refuses the blocking question and delegation tools in Bot Sessions only", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.state.rooms.ops.sessions = { writer: "group-writer" };
	host.reindex();
	for (const id of ["chief", "group-writer"]) {
		for (const name of [
			"ask_user_question",
			"subagent",
			"subagent_fork",
			"send_message",
			"spawn_teammate",
			"workflow",
			"interrupt_agent",
			"list_agents",
		]) {
			const reason = host.guard(name, id);
			assert.match(
				String(reason),
				name === "ask_user_question" ? /Ask with ask_user in your own chat/ : /Bots do not start subagents/,
			);
		}
	}
	for (const id of ["plain1", "ops", undefined])
		for (const name of ["ask_user_question", "subagent", "send_message"])
			assert.equal(host.guard(name, id), undefined);
	assert.equal(host.guard("ask_user", "chief"), undefined);
	assert.equal(host.guard("read", "chief"), undefined);
	assert.equal(host.guard("message_bot", "chief"), undefined);
});

test("a Bot schedules only into its own chat", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	for (const target of ["new_once", "new"])
		assert.match(String(host.guard("schedule_create", "chief", { target })), /this_session/);
	assert.match(
		String(host.guard("schedule_edit", "chief", { id: "s1", action: "update", target: "new" })),
		/this_session/,
	);
	assert.equal(host.guard("schedule_create", "chief", { target: "this_session" }), undefined);
	assert.equal(host.guard("schedule_edit", "chief", { id: "s1", action: "delete" }), undefined);
	assert.equal(host.guard("schedule_create", "plain1", { target: "new" }), undefined);
});

test("a Bot Session filters the hidden tools and their guidance out of the prompt assembly", async (t) => {
	const host = start({ served: ["read"] });
	t.after(() => host.ctx.dispose());
	for (const id of ["chief", "ops"]) await host.agentCreated(id);
	const filters = host.agentOf("chief").listeners.filter((record) => record.event === "system-prompt/assemble");
	assert.equal(filters.length, 1);
	const assembled = await filters[0].listener({}, {}, async () => ({
		sections: [{ name: "bot-identity" }, { name: "tool:goal" }, { name: "team:policy" }, { name: "tool:bash" }],
		contexts: [{ name: "x" }],
		tools: [
			{ name: "read" },
			{ name: "subagent" },
			{ name: "send_message" },
			{ name: "message_bot" },
			{ name: "ask_user_question" },
		],
		variables: { a: 1 },
	}));
	assert.deepEqual(
		assembled.sections.map((section: { name: string }) => section.name),
		["bot-identity", "tool:bash"],
	);
	assert.deepEqual(
		assembled.tools.map((tool: { name: string }) => tool.name),
		["read", "message_bot"],
	);
	assert.deepEqual(assembled.contexts, [{ name: "x" }]);
	assert.deepEqual(assembled.variables, { a: 1 });
	// DSH 0.2.2 adds the tool list after this waterfall, so that assembly has none.
	const current = await filters[0].listener({}, {}, async () => ({
		sections: [{ name: "bot-identity" }, { name: "tool:subagent" }],
		contexts: [],
		variables: {},
	}));
	assert.deepEqual(current, { sections: [{ name: "bot-identity" }], contexts: [], variables: {} });
	// The group's own Session gets no hidden-tool filter of its own.
	assert.equal(host.agentOf("ops").listeners.filter((record) => record.event === "system-prompt/assemble").length, 0);
});

test("a Bot Session the creation path missed is scoped at the step's assemble", async (t) => {
	const host = start({ served: ["read"] });
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	const agent = host.agentOf("chief");
	const assembled = await host.assemble(agent, { tools: [{ name: "read" }], sections: [] });
	const expected = [...M2_TOOLS, ...GROUP_TOOLS];
	assert.deepEqual(host.scopedNames("chief").sort(), [...expected].sort());
	assert.deepEqual(
		assembled.tools.map((tool: { name: string }) => tool.name),
		["read", ...expected],
	);
	// The recovered names are offered once, not on every step.
	const second = { tools: [{ name: "read" }], sections: [] };
	assert.equal(await host.assemble(agent, second), second);
	// An unowned Session passes through unchanged.
	const plain = host.agentOf("plain1");
	const untouched = { tools: [{ name: "read" }], sections: [] };
	assert.equal(await host.assemble(plain, untouched), untouched);
	assert.deepEqual(host.scopedNames("plain1"), []);
});

test("a PTC Session gets its relay scoped but keeps run_code alone in the list", async (t) => {
	const host = start({ served: ["read"] });
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	const agent = host.agentOf("ops");
	const assembly = { tools: [{ name: "run_code" }], sections: [] };
	assert.equal(await host.assemble(agent, assembly), assembly);
	assert.deepEqual(host.scopedNames("ops"), ["group_relay"]);
});

test("a same-named global in the step's list is replaced by the scoped schema", async (t) => {
	const host = start({ served: ["read"] });
	t.after(() => host.ctx.dispose());
	addGroupTools(host);
	const agent = host.agentOf("chief");
	host.ctx.tools.schemas = ((target?: FakeAgent) => [
		{ name: "read" },
		{ name: "show_view", description: "global" },
		...(target === undefined ? [] : host.scopedNames(target.id).map((name) => ({ name, description: "scoped" }))),
	]) as unknown as FakeContext["tools"]["schemas"];
	const assembled = await host.assemble(agent, {
		tools: [{ name: "show_view", description: "global" }],
		sections: [],
	});
	const named = assembled.tools.filter((tool: { name: string }) => tool.name === "show_view");
	assert.equal(named.length, 1);
	assert.notEqual(named[0].description, "global");
});

test("tools/change re-applies the connector masks", async (t) => {
	const host = start({ served: ["read", "mcp__github", "mcp__mail"] });
	t.after(() => host.ctx.dispose());
	await host.agentCreated("chief");
	assert.deepEqual(host.denied("chief"), []);
	host.setConnectorPrefixes(["mcp__"]);
	host.ctx.emit("tools/change");
	assert.deepEqual(host.denied("chief"), ["mcp__github", "mcp__mail"]);
	// A second change with the same prefixes does not mask again.
	host.ctx.emit("tools/change");
	assert.deepEqual(host.denied("chief"), ["mcp__github", "mcp__mail"]);
});

test("a goal started in a Bot chat or a group is blocked; one elsewhere runs", async (t) => {
	const current = new Map<string, Record<string, any>>();
	const blocked: Array<Record<string, any>> = [];
	const goals = {
		get: (agent: { id: string }) => current.get(agent.id),
		block: (agent: { id: string }, ref: Record<string, any>, reason: Record<string, any>) => {
			current.set(agent.id, { ...current.get(agent.id), revision: ref.revision + 1, phase: "blocked" });
			blocked.push({ sessionId: agent.id, ...reason });
		},
	};
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed, services: { goals } });
	t.after(() => host.ctx.dispose());
	const ids = ["chief", "group-writer", "ops", "plain1"];
	const emitSession = (id: string, event: Record<string, any>) => {
		for (const listener of host.ctx.listeners.get("session/event") ?? []) void listener({ id }, event);
	};
	for (const id of ids) {
		await host.agentCreated(id);
		current.set(id, { id: `goal-${id}`, revision: 1, phase: "active" });
		emitSession(id, { type: "goal/change", data: { goal: { phase: "active" } } });
	}
	await until(() => blocked.length === 3);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(
		blocked.map((entry) => entry.sessionId),
		["chief", "group-writer", "ops"],
	);
	for (const entry of blocked)
		assert.deepEqual(
			[entry.code, entry.message],
			["not-supported", "Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu."],
		);
	assert.equal(current.get("plain1")?.phase, "active");
});

// ----- ask_user and show_view -----

test("ask_user stores the question card for its Session and ends the turn", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	let concluded = 0;
	const answer = await host.tool(
		"ask_user",
		{
			question: "Which tone?",
			detail: "One line",
			options: [{ label: " Warm ", description: " friendly " }, { label: "Short" }],
			multiSelect: true,
			allowCustom: true,
		},
		"chief",
		{ concludeTurn: () => concluded++ },
	);
	assert.equal(answer, "The card is on screen; the user's answer arrives as their next message.");
	assert.equal(concluded, 1);
	const card = host.state.questions.chief;
	assert.equal(typeof card.id, "string");
	assert.equal(card.callId, "c1");
	assert.equal(card.question, "Which tone?");
	assert.equal(card.detail, "One line");
	assert.deepEqual(card.options, [{ label: "Warm", description: "friendly" }, { label: "Short" }]);
	assert.equal(card.multiSelect, true);
	assert.equal(card.allowCustom, true);
	assert.equal(typeof card.askedAt, "number");
});

test("ask_user's card carries no callId in a hidden Bot-to-Bot turn", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.live.set("chief", { turn: 3 });
	host.state.exchangeTurns.chief = [3];
	await host.tool("ask_user", { question: "Which?", options: [{ label: "A" }, { label: "B" }] }, "chief");
	assert.equal(host.state.questions.chief.callId, undefined);
	assert.equal(host.state.questions.chief.multiSelect, false);
	assert.equal(host.state.questions.chief.allowCustom, undefined);
});

test("ask_user refuses in a group and outside the team, and needs an option", async (t) => {
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	assert.equal(
		await host.tool("ask_user", { question: "q", options: [{ label: "A" }] }, "group-writer"),
		"Question cards only work in your own chat. In a group, ask in your message instead.",
	);
	assert.equal(
		await host.tool("ask_user", { question: "q", options: [{ label: "A" }] }, "plain1"),
		"Only Bots on the team can use ask_user. Use ask_user_question if it is available in this session, or ask the user in your reply.",
	);
	assert.equal(await host.tool("ask_user", { question: "q", options: [] }, "chief"), "Give at least one option.");
	// The DSH tool schema validates the model's arguments before the handler runs.
	await assert.rejects(
		async () => host.tool("ask_user", { question: "q", options: ["A"] }, "chief"),
		/invalid arguments/,
	);
});

test("show_view keeps the wire shape, the byte limit and the answer branches", async (t) => {
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	let concluded = 0;
	const view = { type: "text", text: "hello" };
	// A view without answers shows and ends nothing.
	assert.equal(await host.tool("show_view", { title: "T", view }, "chief"), "The view is on screen.");
	assert.equal(host.state.views.chief, undefined);
	assert.equal(
		await host.tool("show_view", { view, await_reply: true }, "chief"),
		"This view has nothing to submit; call show_view with await_reply: false.",
	);
	assert.equal(await host.tool("show_view", { view, await_reply: false }, "chief"), "The view is on screen.");
	// A view with controls waits for the answer and stores the card.
	const interactive = { type: "options", id: "pick", options: [{ label: "Yes" }] };
	assert.equal(
		await host.tool("show_view", { view: interactive, await_reply: false }, "chief"),
		"This view has controls to submit, so it waits for the user's answer; call show_view without await_reply: false.",
	);
	const answer = await host.tool("show_view", { title: " T ", view: interactive }, "chief", {
		concludeTurn: () => concluded++,
	});
	assert.equal(answer, "The view is on screen; the user's answer arrives as their next message.");
	assert.equal(concluded, 1);
	const card = host.state.views.chief;
	assert.equal(typeof card.id, "string");
	assert.equal(card.callId, "c1");
	assert.equal(card.title, "T");
	assert.deepEqual(card.view, interactive);
	assert.equal(typeof card.askedAt, "number");
	// The blueprint shape is checked before it is stored.
	const tooBig = { type: "text", text: "x".repeat(9000) };
	const bytes = new TextEncoder().encode(JSON.stringify(tooBig)).length;
	assert.equal(
		await host.tool("show_view", { view: tooBig }, "chief"),
		`The view is ${bytes} bytes; the limit is 8192.`,
	);
	assert.equal(
		await host.tool("show_view", { view }, "group-writer"),
		"View cards only work in your own chat. In a group, ask in your message instead.",
	);
});

test("show_view's card carries no callId in a hidden Bot-to-Bot turn", async (t) => {
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	host.live.set("chief", { turn: 2 });
	host.state.exchangeTurns.chief = [2];
	await host.tool("show_view", { view: { type: "text", text: "hi" }, await_reply: false }, "chief");
	host.live.set("chief", { turn: 2 });
	await host.tool("show_view", { view: { type: "options", id: "a", options: [{ label: "A" }] } }, "chief");
	assert.equal(host.state.views.chief.callId, undefined);
});

// ----- message_bot and stop_bot -----

test("message_bot steers by default and starts an idle Bot's next turn", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	const out = await host.tool("message_bot", { to: "Writer", message: "how are you" }, "chief");
	assert.equal(out, "Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.");
	assert.equal(host.delivered.length, 1);
	const delivery = host.delivered[0];
	assert.deepEqual(
		[delivery.fromId, delivery.toId, delivery.text, delivery.role, delivery.steer, delivery.audience],
		["chief", "writer", "how are you", "request", true, undefined],
	);
	assert.equal(typeof delivery.exchangeId, "string");
	assert.equal(host.state.works[delivery.exchangeId].from, "chief");
});

test("message_bot reports a working Bot's status and what the reply will be", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.live.set("writer", { turn: 1 });
	host.setStatus("writer", "working in its own chat for less than a minute, for the user");
	const working = await host.tool("message_bot", { to: "Writer", message: "watch out" }, "chief");
	assert.equal(
		working,
		"Delivered to Writer while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it. Writer now: working in its own chat for less than a minute, for the user.",
	);
	host.live.delete("writer");
	host.setStatus("writer", "idle");
	const idle = await host.tool("message_bot", { to: "Writer", message: "again" }, "chief");
	assert.equal(idle, "Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.");
});

test('message_bot when "queue" waits for the current work; reply_to "user" always queues', async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.live.set("writer", { turn: 1 });
	host.setStatus("writer", "working in its own chat for less than a minute, for the user");
	const queued = await host.tool("message_bot", { to: "Writer", message: "later", when: "queue" }, "chief");
	assert.equal(
		queued,
		"Queued for Writer: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it. Writer now: working in its own chat for less than a minute, for the user.",
	);
	assert.equal(host.delivered[0].steer, false);
	// reply_to "user" always queues, and the Bot answers the user in its own chat.
	const toUser = await host.tool(
		"message_bot",
		{ to: "Writer", message: "tell them", reply_to: "user", when: "now" },
		"chief",
	);
	assert.match(
		String(toUser),
		/^Delivered to Writer\. It will answer the user in its own chat; nothing comes back to you, so point the user to Writer's chat instead of relaying\./,
	);
	assert.equal(host.delivered[1].steer, false);
	assert.equal(host.delivered[1].audience, "user");
});

test("a message its recipient has not read yet takes in the next one, under the first exchange", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	const agent = host.agentOf("writer");
	host.live.set("writer", { turn: 1 });
	agent.inbox.nextStep.push({
		id: "m1",
		content: [{ type: "text", text: "[Message from Chief]\ntask 1" }],
		source: { kind: "bot", role: "request", senderSessionId: "chief", exchangeId: "e0" },
	});
	const merged = await host.tool("message_bot", { to: "Writer", message: "task 2", when: "queue" }, "chief");
	assert.match(
		String(merged),
		/Writer had not read your earlier message yet, so this one was added to it, and it answers both at once\./,
	);
	assert.equal(host.delivered.length, 1);
	assert.equal(host.delivered[0].text, "task 1\n\ntask 2");
	assert.equal(host.delivered[0].exchangeId, "e0");
	assert.equal(host.delivered[0].merged, true);
	assert.equal(host.delivered[0].steer, true);
	assert.equal(host.state.works.e0, undefined, "a merged request does not open a second work");
});

test("message_bot refuses a Bot outside the group and calls a member in it from a group Session", async (t) => {
	const seed = team();
	seed.bots.scout = { id: "scout", name: "Scout", sessionId: "scout", createdAt: 3 };
	seed.rooms.ops.sessions = { chief: "group-chief", writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	await assert.rejects(
		async () => host.tool("message_bot", { to: "Scout", message: "hi" }, "group-chief"),
		/Not sent: Scout is not in "Ops", and work for this group stays in it\. Ask the user to add Scout to the group, or add it yourself with update_group first\./,
	);
	const called = await host.tool("message_bot", { to: "Writer", message: "check this" }, "group-chief");
	assert.equal(
		called,
		'Called Writer in "Ops" with your message, as writing "@Writer" there does: it works on it in the group, and you answer its result there. Nothing went to its own chat.',
	);
	assert.equal(host.roomSteps.length, 1);
	assert.deepEqual(host.roomSteps[0].slice(0, 3), ["group-chief", undefined, "@Writer check this"]);
	assert.equal(host.delivered.length, 0);
});

test("message_bot turns down a self message, an empty message, an unknown Bot and a long request id", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	assert.equal(await host.tool("message_bot", { to: "Writer", message: "   " }, "chief"), "Write a message to send.");
	assert.equal(
		await host.tool("message_bot", { to: "Chief", message: "hi" }, "chief"),
		"You cannot message yourself.",
	);
	assert.equal(
		await host.tool("message_bot", { to: "Nobody", message: "hi" }, "chief"),
		"No Bot named Nobody. Team: Chief, Writer",
	);
	assert.equal(
		await host.tool("message_bot", { to: "Writer", message: "hi", request_id: "x".repeat(201) }, "chief"),
		"The request_id is 201 characters long; a request name is at most 200.",
	);
});

test("a named request is sent once and its receipt comes back on a repeat", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	const first = await host.tool("message_bot", { to: "Writer", message: "do it", request_id: "r1" }, "chief");
	assert.match(String(first), /^Delivered to Writer/);
	assert.equal(host.delivered.length, 1);
	const second = await host.tool("message_bot", { to: "Writer", message: "do it", request_id: "r1" }, "chief");
	assert.equal(second, first);
	assert.equal(host.delivered.length, 1);
});

test("a named request whose outcome is not known is not sent again", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.rt.knownRequest = async () => ({ status: "uncertain" });
	await assert.rejects(
		async () => host.tool("message_bot", { to: "Writer", message: "do it", request_id: "r1" }, "chief"),
		/Not sent again: the outcome of request_id "r1" is not known/,
	);
	host.rt.knownRequest = async () => ({ status: "conflict" });
	await assert.rejects(
		async () => host.tool("message_bot", { to: "Writer", message: "other", request_id: "r1" }, "chief"),
		/Not sent: request_id "r1" was already used for a different request\./,
	);
	host.rt.knownRequest = async () => ({ status: "readonly" });
	await assert.rejects(
		async () => host.tool("message_bot", { to: "Writer", message: "do it", request_id: "r1" }, "chief"),
		/Not sent: this window cannot save the Bot team/,
	);
	host.rt.knownRequest = async () => ({ status: "expired" });
	assert.match(
		String(await host.tool("message_bot", { to: "Writer", message: "do it", request_id: "r1" }, "chief")),
		/^Nothing was sent again: request_id "r1" was admitted before/,
	);
});

test("a message past 20,000 characters is not sent, and a named request stays free to retry", async (t) => {
	const host = start({
		attachLong: async (text) => (text.length > 20_000 ? undefined : { text, files: [], length: text.length }),
	});
	t.after(() => host.ctx.dispose());
	const long = "x".repeat(20_001);
	const out = await host.tool("message_bot", { to: "Writer", message: long, request_id: "r1" }, "chief");
	assert.match(
		String(out),
		/^Not sent: the message has 20001 characters, more than 20000, and this DeepSeek Harness cannot send it as a file\./,
	);
	assert.equal(host.delivered.length, 0);
	assert.equal(host.lastRequests.at(-1)?.unsent, true);
	// The same name with a short message can still be sent: the failed call left no receipt.
	assert.match(
		String(await host.tool("message_bot", { to: "Writer", message: "short", request_id: "r1" }, "chief")),
		/^Delivered to Writer/,
	);
	assert.equal(host.delivered.length, 1);
});

test("message_bot refuses a Bot that waits for the result of the work being done", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.rt.upstreamOf = () => new Set(["writer"]);
	const out = await host.tool("message_bot", { to: "Writer", message: "one more" }, "chief");
	assert.equal(
		out,
		"Not sent: Writer is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Finish the work and end your turn; to ask Writer something, end your turn with the question.",
	);
});

test("message_bot tells the sender when the message does not reach the target's work in a group", async (t) => {
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	host.live.set("group-writer", { turn: 1 });
	host.setStatus("writer", 'working in group "Ops" for less than a minute');
	const out = await host.tool("message_bot", { to: "Writer", message: "status?" }, "chief");
	assert.equal(
		out,
		'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it. Writer now: working in group "Ops" for less than a minute. Your message does not reach its work in group "Ops". If it must not go on there, use stop_bot.',
	);
});

test("stop_bot ends the running turns and tells the Bot why; it belongs to a Main Bot", async (t) => {
	const seed = team();
	seed.rooms.ops.sessions = { writer: "group-writer" };
	const host = start({ state: seed });
	t.after(() => host.ctx.dispose());
	await assert.rejects(async () => host.tool("stop_bot", { bot: "Writer" }, "chief"), /not running/);
	await assert.rejects(async () => host.tool("stop_bot", { bot: "Writer" }, "writer"), {
		message: "Only a Main Bot can stop other Bots.",
	});
	host.live.set("writer", { turn: 1 });
	host.live.set("group-writer", { turn: 1 });
	await assert.rejects(async () => host.tool("stop_bot", { bot: "Chief" }, "chief"), {
		message: "You cannot stop yourself.",
	});
	const out = await host.tool("stop_bot", { bot: "Writer", reason: "that command deletes data" }, "chief");
	assert.equal(
		out,
		'Stopped Writer in its own chat and group "Ops". It is told why in a new turn, whose reply comes back to you.',
	);
	assert.deepEqual(host.agentOf("writer").calls, [["cancel", { kind: "hook", reason: "ocean-crew/stopped" }]]);
	assert.deepEqual(host.agentOf("group-writer").calls, [["cancel", { kind: "hook", reason: "ocean-crew/stopped" }]]);
	const notice = host.delivered[0];
	assert.deepEqual(
		[notice.fromId, notice.toId, notice.text, notice.role],
		["chief", "writer", "that command deletes data", "stopped"],
	);
});

// ----- list_bots and the roster and group tools -----

test("list_bots names the team, its groups and the caller", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.state.rooms.ops.notice = "Keep it short\nnot shown";
	const out = await host.tool("list_bots", {}, "chief");
	assert.equal(
		out,
		'Bots:\n- Chief (Boss, Main Bot, you)\n- Writer (Write)\n  now: idle\n\nGroup chats:\n- "Ops" — members: Chief (admin) (you), Writer; plain messages go to the admin first; notice: Keep it short',
	);
});

test("a private Bot is only named to the other Bots", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.state.bots.writer.private = true;
	const out = String(await host.tool("list_bots", {}, "chief"));
	assert.match(out, /- Writer \(Write, private Bot, closed to other Bots\)/);
	assert.doesNotMatch(out, /Writer \(Write, model|now: idle\n/);
});

test("pickRoom finds one visible group and refuses an unknown or ambiguous name", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	assert.equal(host.rt.pickRoom("Ops", "chief").room.id, "ops");
	assert.equal(
		host.rt.pickRoom("Nope", "chief").error,
		'No group chat called "Nope" that you can see. Groups: "Ops".',
	);
	host.state.rooms.ops2 = { id: "ops2", name: "Ops", members: ["chief"], mode: "admin", admin: "chief" };
	assert.equal(host.rt.pickRoom("Ops", "chief").error, 'Several group chats are called "Ops". Rename one first.');
});

test("create_bot belongs to the Main Bot and returns a one-line receipt", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	assert.equal(
		await host.tool("create_bot", { name: "Scout", role: "Find", instructions: "Look" }, "writer"),
		"Only the Main Bot can create Bots. Ask the Main Bot instead.",
	);
	host.rt.catalog = async () => [{ ref: "deepseek/v4", id: "v4", name: "V4" }];
	const out = await host.tool("create_bot", { name: "Scout", role: "Find", instructions: "Look" }, "chief");
	assert.equal(out, "Created Scout. It is greeting the user now.");
	assert.deepEqual(host.state.bots.scout, undefined);
});

test("update_bot lets a Bot change itself; another Bot needs a Main Bot", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	const self = await host.tool("update_bot", { name: "Chief of Ops" }, "chief");
	assert.equal(self, "Updated Chief of Ops.");
	assert.equal(
		await host.tool("update_bot", { bot: "Chief", role: "Boss" }, "writer"),
		"Only a Main Bot can change another Bot. Leave out bot to change yourself, or ask a Main Bot with message_bot.",
	);
});

test("the group tools refuse a non-Main Bot and an unknown group", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	assert.equal(
		await host.tool("create_group", { members: ["Writer"] }, "writer"),
		"Only a Main Bot can create group chats. Ask a Main Bot instead.",
	);
	assert.equal(await host.tool("delete_group", { group: "Ops" }, "writer"), "Only a Main Bot can delete group chats.");
	assert.equal(
		await host.tool("update_group", { group: "Nope" }, "chief"),
		'No group chat called "Nope" that you can see. Groups: "Ops".',
	);
});

test("post_to_group posts into a visible group, and the round names it called in this turn", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	host.live.set("chief", { turn: 1 });
	const out = await host.tool("post_to_group", { group: "Ops", message: "@Writer check the draft" }, "chief");
	assert.equal(out, 'Posted in "Ops". Members reply there, where the user reads them, and nothing comes back to you.');
	assert.equal(host.roomSteps.length, 1);
	// Called there in this turn, so the same work is not also sent to its own chat.
	await assert.rejects(
		async () => host.tool("message_bot", { to: "Writer", message: "check the draft" }, "chief"),
		/Not sent: you called Writer in "Ops" in this turn/,
	);
});

test("a member's post calls only the members it names; report_back needs one", async (t) => {
	const host = start();
	t.after(() => host.ctx.dispose());
	assert.equal(
		await host.tool("post_to_group", { group: "Ops", message: "just a note" }, "writer"),
		'Posted in "Ops", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.',
	);
	assert.equal(
		await host.tool("post_to_group", { group: "Ops", message: "just a note", report_back: true }, "writer"),
		'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post without report_back.',
	);
	assert.match(
		String(await host.tool("post_to_group", { group: "Ops", message: "@Chief look", report_back: true }, "writer")),
		/^Posted in "Ops"\. Members reply there, where the user reads them; their replies also come back to you as a new message when the round ends\./,
	);
});
