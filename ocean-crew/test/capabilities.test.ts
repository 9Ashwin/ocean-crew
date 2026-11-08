// Capabilities: the shared library of MCP servers, skills and packs, the capability
// tools and their approval texts, mount/reconcile behaviour per Bot Session, health
// statuses, secret resolution inside MCP configs, and unload cleanup.

// mounted plugins.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Runtime } from "../src/host/core/runtime.ts";
import { own } from "../src/host/core/store.ts";
import { expandCapabilityNames, install, validateCapabilityName } from "../src/host/work/capabilities.ts";
import { redactor } from "../src/host/work/secrets.ts";
import { emptyTeam, type TeamState } from "../src/shared/state.ts";

type TestRuntime = Runtime & Record<string, any>;

interface MountRecord {
	plugin: Record<string, any>;
	config?: Record<string, any>;
	sessionId: string;
	disposed: boolean;
	cleanup?: () => void;
}

type Skills = Map<string, { name: string; description?: string; content?: string }>;

interface TestAgent {
	id: string;
	session: { id: string };
	ctx: Record<string, any>;
}

type Listener = (payload?: unknown) => unknown;

const team = (): TeamState => {
	const state = emptyTeam();
	state.mainBotIds = ["chief"];
	state.bots = {
		chief: { id: "chief", sessionId: "chief", name: "Chief", capabilities: [], createdAt: 1 },
		worker: { id: "worker", sessionId: "worker", name: "Worker", capabilities: [], createdAt: 2 },
		helper: { id: "helper", sessionId: "helper", name: "Helper", capabilities: [], createdAt: 3 },
	};
	state.rooms = {
		room: {
			id: "room",
			members: ["chief"],
			sessions: { chief: "room-chief" },
			admin: "chief",
			mode: "everyone",
			name: "Room",
		},
	};
	return state;
};

const mcp = (name: string, command = "node"): Record<string, any> => ({
	name,
	kind: "mcp",
	description: "Echo service",
	transport: "stdio",
	command,
	args: [],
	env: {},
});

function testAgent(
	id: string,
	mounts: MountRecord[],
	skillsBySession: Map<string, Skills>,
	{ awaitMount = async (): Promise<void> => {} }: { awaitMount?: (record: MountRecord) => Promise<void> } = {},
): TestAgent {
	const disposers: Array<() => unknown> = [];
	const skills: Skills = new Map();
	skillsBySession.set(id, skills);
	const agentCtx: Record<string, any> = {
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
		plugin(plugin: Record<string, any>, config?: Record<string, any>) {
			const record: MountRecord = { plugin, config, sessionId: id, disposed: false };
			mounts.push(record);
			if (plugin.inject?.includes("skills")) {
				const scoped = {
					skills: {
						register(skill: { name: string; description?: string; content?: string }) {
							skills.set(skill.name, skill);
							return () => skills.delete(skill.name);
						},
					},
					effect: (execute: () => () => void) => {
						record.cleanup = execute();
					},
				};
				plugin.apply(scoped);
			}
			return {
				await: () => awaitMount(record),
				dispose: () => {
					record.disposed = true;
					record.cleanup?.();
				},
			};
		},
		dispose() {
			for (const dispose of disposers.reverse()) dispose();
		},
	};
	return { id, session: { id }, ctx: agentCtx };
}

interface SetupOptions {
	state?: TeamState;
	secret?: { name: string; value: string; scope: "all" | string[] };
	beforeLoad?: (env: {
		ctx: Record<string, any>;
		rt: TestRuntime;
		mounts: MountRecord[];
		skills: Map<string, Skills>;
		mcpPlugin: Record<string, any>;
	}) => void;
}

function setup({ state = team(), secret, beforeLoad }: SetupOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-capabilities-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(state));
	const mounts: MountRecord[] = [];
	const skills = new Map<string, Skills>();
	const warnings: unknown[][] = [];
	const mcpPlugin = { name: "mcp-client", apply() {} };
	const loader = {
		import: async () => ({ default: mcpPlugin }),
		unwrapExports: (exports: Record<string, any>) => exports.default,
	};
	const listeners = new Map<string, Listener[]>();
	const disposers: Array<() => unknown> = [];
	const services: Record<string, any> = { loader };
	const ctx: Record<string, any> = {
		on(name: string, listener: Listener) {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return () => {};
		},
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
			return () => {};
		},
		get: (name: string) => services[name],
		logger: { warn: () => {} },
	};
	const chatOwners = new Map<string, string>();
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	for (const room of Object.values(state.rooms))
		for (const [botId, sessionId] of Object.entries(room.sessions ?? {}))
			groupOwners.set(sessionId, { botId, roomId: room.id });
	for (const bot of Object.values(state.bots)) chatOwners.set(bot.sessionId ?? bot.id, bot.id);
	const installed = new Map<string, TestAgent>();
	const secrets = new Map<string, { value: string; scope: "all" | string[] }>();
	if (secret) secrets.set(secret.name, { value: secret.value, scope: secret.scope });
	const rt = {
		ctx,
		state,
		home,
		teamTools: [] as Array<Record<string, any>>,
		warn: (...args: unknown[]) => warnings.push(args),
		load: async () => {},
		save: async () => {
			writeFileSync(join(home, "state.json"), JSON.stringify(state));
		},
		readOnly: () => undefined as string | undefined,
		isMain: (id?: string) => id !== undefined && state.mainBotIds.includes(id),
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		findBot: (ref?: unknown) => {
			if (ref === undefined) return undefined;
			const byId = state.bots[String(ref)];
			if (byId !== undefined) return byId;
			const wanted = String(ref).trim().toLowerCase();
			return Object.values(state.bots).find((bot) => bot.name.trim().toLowerCase() === wanted);
		},
		selfOf: (id?: string) => (id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId)),
		isBotSession: (id?: string) => id !== undefined && (chatOwners.has(id) || groupOwners.has(id)),
		chatOwners,
		groupOwners,
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		groupSessionsOf: (botId: string) =>
			Object.values(state.rooms)
				.map((room) => room.sessions?.[botId])
				.filter((value): value is string => typeof value === "string"),
		resolveAgent: async (sessionId: string) => installed.get(sessionId),
		own,
		loadSecrets: async () => {},
		canUseSecret: (name: string, botId: string) => {
			const found = secrets.get(name);
			return found !== undefined && (found.scope === "all" || found.scope.includes(botId));
		},
		secretValue: (name: string) => secrets.get(name)?.value,
		redactSecrets: redactor([...secrets].map(([name, found]) => ({ name, value: found.value }))),
		capabilityEnsureTimeoutMs: 15_000,
	} as unknown as TestRuntime;
	beforeLoad?.({ ctx, rt, mounts, skills, mcpPlugin });
	install(rt);
	const agentCreated = (agent: TestAgent) =>
		Promise.all((listeners.get("agent/created") ?? []).map((listener) => listener({ agent })));
	const tool = async (name: string, args: Record<string, any>, agentId: string) => {
		const definition = rt.teamTools.find((candidate) => candidate.name === name);
		assert.ok(definition, `no tool ${name}`);
		const run = definition.execute as (args: Record<string, any>, exec: Record<string, any>) => Promise<unknown>;
		return String(await run(args, { agent: { id: agentId }, callId: `call-${name}` }));
	};
	const mountAgents = async (...agents: TestAgent[]): Promise<void> => {
		for (const agent of agents) installed.set(agent.session.id, agent);
		for (const agent of agents) await agentCreated(agent);
		await rt.scheduleCapabilitiesReconcile();
	};
	const dispose = async (): Promise<void> => {
		for (const run of disposers.splice(0).reverse()) await run();
		await rt.scheduleCapabilitiesReconcile();
		await delay(0);
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return {
		home,
		ctx,
		rt,
		state,
		mounts,
		skills,
		warnings,
		mcpPlugin,
		listeners,
		installed,
		agentCreated,
		mountAgents,
		tool,
		dispose,
	};
}

test("capability names use the MCP and skill validator intersection", () => {
	assert.equal(validateCapabilityName("a"), "a");
	assert.equal(validateCapabilityName("web-search-1"), "web-search-1");
	for (const name of ["github", "with_underscore", "with--dash", "1tool", "A", "a".repeat(33)])
		assert.throws(() => validateCapabilityName(name));
});

test("packs expand only to MCP and skill items", () => {
	const items = {
		server: { kind: "mcp" },
		guide: { kind: "skill" },
		team: { kind: "pack", items: ["server", "guide"] },
	};
	assert.deepEqual([...expandCapabilityNames(["team", "server"], items as any)], ["server", "guide"]);
	assert.throws(() => expandCapabilityNames(["missing"], items as any), /No capability/);
	assert.throws(
		() => expandCapabilityNames(["bad"], { ...items, bad: { kind: "pack", items: ["team"] } } as any),
		/unavailable capability/,
	);
});

test("Bot saves enforce approval and ownership, and deletion cascades", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const { rt } = env;
	const { state } = rt;
	const created = await rt.capabilitySave(mcp("echo"), { botId: "worker" });
	assert.equal(created.approved, false);
	const description = await rt.capabilitySave({ ...mcp("echo"), description: "Updated" }, { botId: "worker" });
	assert.equal(description.approved, false);
	await rt.capabilityEndpoint("capability-approve", { name: "echo" });
	const approved = await rt.capabilitySave(
		{ ...mcp("echo"), description: "Another description" },
		{ botId: "worker" },
	);
	assert.equal(approved.approved, true);
	const changed = await rt.capabilitySave(mcp("echo", "node-new"), { botId: "worker" });
	assert.equal(changed.approved, false);
	await assert.rejects(
		rt.capabilitySave(
			{ name: "echo", kind: "skill", description: "Other kind", content: "Instructions" },
			{ botId: "worker" },
		),
		(error: Error) => error.message === "A capability cannot change its kind. Delete it and save a new one.",
	);
	await assert.rejects(rt.capabilitySave(mcp("echo"), { botId: "helper" }), /creator or a Main Bot/);
	await assert.rejects(rt.capabilityDelete("echo", { botId: "helper" }), /creator or a Main Bot/);
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "Guide", content: "Do the work." },
		{ botId: "worker" },
	);
	await rt.capabilitySave({ name: "team", kind: "pack", items: ["echo", "guide"] }, { botId: "worker" });
	state.bots.worker.capabilities = ["echo", "team"];
	await rt.capabilityDelete("echo", { botId: "worker" });
	assert.equal(state.capabilities.items.echo, undefined);
	assert.deepEqual(state.capabilities.items.team.items, ["guide"]);
	assert.deepEqual(state.bots.worker.capabilities, ["team"]);
});

test("capability Bot tools refuse DSH Agent sessions", async (t) => {
	const env = setup();
	t.after(env.dispose);
	assert.match(await env.tool("list_capabilities", {}, "outside"), /Only Bots on the team/);
});

test("capability tool descriptions and attach results explain approval", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const definition = env.rt.teamTools.find((candidate) => candidate.name === "save_capability") as any;
	const parameters = definition.parameters.properties;
	assert.deepEqual(
		Object.fromEntries(
			["transport", "command", "args", "env", "url", "headers", "content"].map((name) => [
				name,
				parameters[name].description,
			]),
		),
		{
			transport: "How to reach an MCP server: a local command or an HTTP URL",
			command: "Program that starts a local MCP server",
			args: "Arguments for command",
			env: "Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value",
			url: "MCP server URL; write $DSH_SECRET_<NAME> in the path or query to insert a saved secret, URL-encoded. Prefer headers for keys",
			headers: "HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value",
			content: "Skill instructions",
		},
	);
	await env.rt.capabilitySave(mcp("blocked"), { botId: "worker" });
	const attached = await env.tool("attach_capability", { name: "blocked" }, "worker");
	assert.ok(attached.endsWith(" The user must allow blocked in Ocean Crew settings before it can work."));
});

test("a deleted Bot drops only a pending local MCP it alone asked for", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const { rt } = env;
	const { items } = rt.state.capabilities;
	// A local MCP the Bot asked for and nobody approved has no requester left.
	await rt.capabilitySave(mcp("pending-mine"), { botId: "worker" });
	// Everything else stays: an approved one it asked for, a pending one the Main Bot
	// asked for, one the user saved in settings, and a skill.
	await rt.capabilitySave(mcp("approved-mine"), { botId: "worker" });
	await rt.capabilityEndpoint("capability-approve", { name: "approved-mine" });
	await rt.capabilitySave(mcp("pending-chief"), { botId: "chief" });
	await rt.capabilitySave(mcp("shared"), { ui: true });
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "Guide", content: "Do the work." },
		{ botId: "worker" },
	);
	rt.state.bots.worker.capabilities = ["pending-mine", "approved-mine", "pending-chief", "shared", "guide"];
	rt.dropOrphanCapabilities(rt.state.bots.worker);
	await rt.save();
	assert.equal(items["pending-mine"], undefined);
	assert.deepEqual(Object.keys(items).sort(), ["approved-mine", "guide", "pending-chief", "shared"]);
	const saved = JSON.parse(readFileSync(join(env.home, "state.json"), "utf8"));
	assert.equal(saved.capabilities.items["pending-mine"], undefined);
});

test("a deleted Bot leaves pack members and other packs untouched", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const { rt } = env;
	const { items } = rt.state.capabilities;
	await rt.capabilitySave(mcp("pending-pack"), { botId: "worker" });
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "Guide", content: "Do the work." },
		{ botId: "worker" },
	);
	// Two packs share the skill; only one was on the deleted Bot. The pending MCP the Bot
	// asked for also sits in its pack, so it belongs to the pack.
	await rt.capabilitySave({ name: "pack-p", kind: "pack", items: ["guide", "pending-pack"] }, { botId: "worker" });
	await rt.capabilitySave({ name: "pack-q", kind: "pack", items: ["guide"] }, { botId: "chief" });
	rt.state.bots.worker.capabilities = ["pack-p", "pending-pack"];
	rt.dropOrphanCapabilities(rt.state.bots.worker);
	assert.deepEqual(Object.keys(items).sort(), ["guide", "pack-p", "pack-q", "pending-pack"]);
	assert.deepEqual(items["pack-q"].items, ["guide"]);
	assert.deepEqual(items["pack-p"].items, ["guide", "pending-pack"]);
});

test("startup and empty-to-nonempty attachments track existing Bot Agents", async (t) => {
	const state: any = team();
	state.capabilities = {
		items: { echo: { ...mcp("echo"), approved: true, createdBy: "chief", createdAt: 1, updatedAt: 1 } },
	};
	state.bots.chief.capabilities = ["echo"];
	const resolved: string[] = [];
	const env = setup({
		state,
		beforeLoad: ({ rt, mounts, skills }) => {
			const existing = Object.fromEntries(
				["chief", "room-chief", "worker", "helper"].map((id) => [id, testAgent(id, mounts, skills)]),
			);
			rt.chatOf = (botId: string) => botId;
			rt.groupSessionsOf = (botId: string) => (botId === "chief" ? ["room-chief", "room-chief"] : []);
			rt.resolveAgent = async (sessionId: string) => {
				if (Object.hasOwn(existing, sessionId)) resolved.push(sessionId);
				return existing[sessionId];
			};
		},
	});
	t.after(env.dispose);
	await delay(0);
	await env.rt.scheduleCapabilitiesReconcile();
	assert.deepEqual(resolved, ["chief", "room-chief"]);
	assert.deepEqual(
		env.mounts.map((mount) => mount.sessionId),
		["chief", "room-chief"],
	);

	await env.rt.changeCapabilityAttachment("attach", { name: "echo" }, "worker");
	await env.rt.capabilityEndpoint("bot-capability", { botId: "helper", name: "echo", attached: true });
	await env.rt.scheduleCapabilitiesReconcile();
	assert.deepEqual(resolved, ["chief", "room-chief", "worker", "helper"]);
	assert.deepEqual(
		env.mounts.filter((mount) => !mount.disposed).map((mount) => mount.sessionId),
		["chief", "room-chief", "worker", "helper"],
	);
});

test("a read-only secret reload does not requeue capability reconciliation", async (t) => {
	const env = setup();
	t.after(env.dispose);
	await env.rt.loadSecrets();
	await env.rt.scheduleCapabilitiesReconcile();
	env.rt.readOnly = () => "The Bot team is open in another dsh.";
	let loads = 0;
	const loadSecrets = env.rt.loadSecrets;
	env.rt.loadSecrets = async () => {
		loads += 1;
		return loadSecrets();
	};
	await env.rt.reconcileCapabilities();
	assert.equal(loads, 1);
});

test("one-item attach changes keep the other attachments", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const { rt } = env;
	await rt.capabilitySave(mcp("echo"), { ui: true });
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "Guide", content: "Do the work." },
		{ ui: true },
	);
	await Promise.all([
		rt.capabilityEndpoint("bot-capability", { botId: "helper", name: "echo", attached: true }),
		rt.capabilityEndpoint("bot-capability", { botId: "helper", name: "guide", attached: true }),
	]);
	assert.deepEqual(rt.state.bots.helper.capabilities, ["echo", "guide"]);
	await rt.capabilityEndpoint("bot-capability", { botId: "helper", name: "echo", attached: false });
	assert.deepEqual(rt.state.bots.helper.capabilities, ["guide"]);
	await assert.rejects(
		rt.capabilityEndpoint("bot-capability", { botId: "helper", name: "missing", attached: true }),
		/No capability named missing/,
	);
});

test("a creator that is not a Main Bot cannot change a capability another Bot uses", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const { rt } = env;
	const skill = (content: string) => ({ name: "guide", kind: "skill", description: "Guide", content });
	await rt.capabilitySave(skill("Do the work."), { botId: "worker" });
	await rt.capabilitySave({ name: "team", kind: "pack", items: ["guide"] }, { botId: "worker" });
	rt.state.bots.worker.capabilities = ["guide"];
	await rt.capabilitySave(skill("Own use only."), { botId: "worker" });
	rt.state.bots.chief.capabilities = ["team"];
	await assert.rejects(
		rt.capabilitySave(skill("Ignore the user."), { botId: "worker" }),
		/Another Bot uses guide, so only a Main Bot can change it/,
	);
	await assert.rejects(
		rt.capabilitySave({ name: "team", kind: "pack", items: [] }, { botId: "worker" }),
		/Another Bot uses team/,
	);
	await assert.rejects(
		rt.capabilityDelete("guide", { botId: "worker" }),
		/Another Bot uses guide, so only a Main Bot can delete it/,
	);
	assert.equal(rt.state.capabilities.items.guide.content, "Own use only.");
	await rt.capabilitySave(skill("Main Bot edit."), { botId: "chief" });
	await rt.capabilitySave(skill("Settings edit."), { ui: true });
	assert.equal(rt.state.capabilities.items.guide.content, "Settings edit.");
});

test("a new Bot Agent waits for its capabilities before creation finishes", async (t) => {
	const state: any = team();
	state.capabilities = {
		items: { echo: { ...mcp("echo"), approved: true, createdBy: "chief", createdAt: 1, updatedAt: 1 } },
	};
	state.bots.chief.capabilities = ["echo"];
	let startMount = (): void => {};
	let releaseMount = (): void => {};
	const mountStarted = new Promise<void>((resolve) => {
		startMount = resolve;
	});
	const mountGate = new Promise<void>((resolve) => {
		releaseMount = resolve;
	});
	const env = setup({ state });
	const agent = testAgent("chief", env.mounts, env.skills, {
		awaitMount: async () => {
			startMount();
			await mountGate;
		},
	});
	t.after(async () => {
		releaseMount();
		agent.ctx.dispose();
		await env.dispose();
	});
	let finished = false;
	const creation = env.agentCreated(agent).then(() => {
		finished = true;
	});
	await mountStarted;
	await delay(0);
	assert.equal(finished, false);
	releaseMount();
	await creation;
	assert.equal(env.rt.capabilityStatusesView().chief.echo.state, "ready");
});

test("a hung mount releases the message after the limit and does not hold up other Bots", async (t) => {
	const state: any = team();
	state.capabilities = {
		items: {
			slow: { ...mcp("slow"), approved: true, createdBy: "chief", createdAt: 1, updatedAt: 1 },
			echo: { ...mcp("echo"), approved: true, createdBy: "chief", createdAt: 1, updatedAt: 1 },
		},
	};
	state.bots.chief.capabilities = ["slow", "echo"];
	state.bots.worker.capabilities = ["echo"];
	let startMount = (): void => {};
	let releaseMount = (): void => {};
	const mountStarted = new Promise<void>((resolve) => {
		startMount = resolve;
	});
	const mountGate = new Promise<void>((resolve) => {
		releaseMount = resolve;
	});
	const hang = async (record: MountRecord): Promise<void> => {
		if (record.config?.serverName !== "slow") return;
		startMount();
		await mountGate;
	};
	const env = setup({
		state,
		beforeLoad: ({ rt }) => {
			rt.capabilityEnsureTimeoutMs = 20;
		},
	});
	const chief = testAgent("chief", env.mounts, env.skills, { awaitMount: hang });
	const worker = testAgent("worker", env.mounts, env.skills, { awaitMount: hang });
	env.installed.set("chief", chief);
	env.installed.set("worker", worker);
	env.rt.resolveAgent = async (sessionId: string) => ({ chief, worker })[sessionId as "chief" | "worker"];
	t.after(async () => {
		releaseMount();
		chief.ctx.dispose();
		worker.ctx.dispose();
		await env.dispose();
	});
	const timeouts = (name: string): number =>
		env.warnings.filter(
			(line) => line[1] === name && String(line[0]).includes("did not finish within %dms; continuing"),
		).length;
	await env.rt.ensureCapabilities("chief");
	await mountStarted;
	assert.equal(timeouts("chief"), 1);
	assert.equal(env.rt.capabilityStatusesView().chief.slow.state, "connecting");
	assert.equal(env.rt.capabilityStatusesView().chief.echo.state, "ready");
	await env.rt.ensureCapabilities("chief");
	await env.rt.ensureCapabilities("worker");
	assert.equal(timeouts("chief"), 1);
	assert.equal(timeouts("worker"), 0);
	assert.equal(env.rt.capabilityStatusesView().worker.echo.state, "ready");
	releaseMount();
	await env.rt.scheduleCapabilitiesReconcile();
	assert.equal(env.rt.capabilityStatusesView().chief.slow.state, "ready");
});

test("unloading the plugin disposes every capability mount", async (t) => {
	const state: any = team();
	state.capabilities = {
		items: {
			echo: { ...mcp("echo"), approved: true, createdBy: "chief", createdAt: 1, updatedAt: 1 },
			guide: {
				name: "guide",
				kind: "skill",
				description: "Guide",
				content: "Do the work.",
				createdBy: "chief",
				createdAt: 1,
				updatedAt: 1,
			},
		},
	};
	state.bots.chief.capabilities = ["echo", "guide"];
	const env = setup({ state });
	t.after(env.dispose);
	const chief = testAgent("chief", env.mounts, env.skills);
	await env.agentCreated(chief);
	assert.equal(env.mounts.length, 2);
	assert.equal(env.skills.get("chief")?.has("guide"), true);
	await env.dispose();
	assert.deepEqual(
		env.mounts.map((mount) => mount.disposed),
		[true, true],
	);
	assert.equal(env.skills.get("chief")?.has("guide"), false);
});

test("unset capability statuses are omitted from the view and tool listing", async (t) => {
	const env = setup();
	t.after(env.dispose);
	const { rt } = env;
	await rt.capabilitySave({ ...mcp("echo"), approved: true }, { botId: "chief" });
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "Guide", content: "Instructions" },
		{ botId: "chief" },
	);
	await rt.capabilitySave({ name: "team", kind: "pack", items: ["echo", "guide"] }, { botId: "chief" });
	rt.state.bots.chief.capabilities = ["echo", "team"];
	await rt.save();
	assert.deepEqual(rt.capabilityStatusesView().chief, {});
	const listed = await env.tool("list_capabilities", {}, "chief");
	assert.match(listed, /echo \(mcp\).*; attached to you(?:\n|$)/);
	assert.doesNotMatch(listed, /attached to you \(connecting\)/);
});

test("mounts agent-only MCP and skills, remounts changed config, resolves scoped secrets and reports missing secrets", async (t) => {
	const env = setup({ secret: { name: "TOKEN", value: "fake-secret-value", scope: ["chief"] } });
	t.after(env.dispose);
	const { rt, mounts, skills, mcpPlugin } = env;
	await rt.capabilitySave(
		{
			...mcp("echo"),
			transport: "streamable-http",
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer $DSH_SECRET_TOKEN" },
		},
		{ botId: "chief" },
	);
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "How to work", content: "Capability marker." },
		{ botId: "chief" },
	);
	await rt.capabilitySave({ name: "team", kind: "pack", items: ["echo", "guide"] }, { botId: "chief" });
	await rt.changeCapabilityAttachment("attach", { name: "team" }, "chief");
	await rt.changeCapabilityAttachment("attach", { name: "team", bot: "Worker" }, "chief");
	await assert.rejects(rt.changeCapabilityAttachment("attach", { name: "team", bot: "Chief" }, "worker"), /Main Bot/);
	await assert.rejects(rt.changeCapabilityAttachment("detach", { name: "team", bot: "Chief" }, "worker"), /Main Bot/);
	await rt.capabilitySave(mcp("blocked"), { botId: "worker" });
	await rt.changeCapabilityAttachment("attach", { name: "blocked" }, "worker");
	const chief = testAgent("chief", mounts, skills);
	const room = testAgent("room-chief", mounts, skills);
	const worker = testAgent("worker", mounts, skills);
	const dsh = testAgent("outside", mounts, skills);
	for (const agent of [chief, room, worker, dsh]) env.installed.set(agent.session.id, agent);
	for (const agent of [chief, room, worker, dsh]) await env.agentCreated(agent);
	await rt.scheduleCapabilitiesReconcile();
	assert.equal(mounts.filter((mount) => mount.plugin === mcpPlugin).length, 2);
	assert.equal(
		mounts.find((mount) => mount.config?.serverName === "echo")?.config?.headers.Authorization,
		"Bearer fake-secret-value",
	);
	assert.equal(skills.get("chief")?.has("guide"), true);
	assert.deepEqual(
		mounts.filter((mount) => mount.plugin === mcpPlugin).map((mount) => mount.sessionId),
		["chief", "room-chief"],
	);
	assert.equal(JSON.stringify(rt.state.capabilities).includes("fake-secret-value"), false);
	assert.equal(JSON.stringify(rt.capabilityLibraryView()).includes("fake-secret-value"), false);
	assert.equal(rt.capabilityStatusesView().chief.team.state, "ready");
	assert.equal(rt.capabilityStatusesView().worker.team.state, "error");
	assert.equal(rt.capabilityStatusesView().worker.blocked.state, "needs-approval");
	assert.equal(
		mounts.some((mount) => mount.config?.serverName === "blocked"),
		false,
	);
	await rt.capabilityEndpoint("capability-approve", { name: "blocked" });
	await rt.scheduleCapabilitiesReconcile();
	assert.equal(
		mounts.some((mount) => mount.config?.serverName === "blocked" && mount.sessionId === "worker"),
		true,
	);
	const first = mounts.find((mount) => mount.config?.serverName === "echo");
	const firstSkill = mounts.find((mount) => mount.sessionId === "chief" && mount.plugin.inject?.includes("skills"));
	await rt.capabilitySave(
		{
			...mcp("echo"),
			transport: "streamable-http",
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer changed" },
		},
		{ botId: "chief" },
	);
	await rt.capabilitySave(
		{ name: "guide", kind: "skill", description: "How to work", content: "Changed capability marker." },
		{ botId: "chief" },
	);
	await rt.scheduleCapabilitiesReconcile();
	assert.equal(first?.disposed, true);
	assert.equal(firstSkill?.disposed, true);
	assert.equal(skills.get("chief")?.get("guide")?.content, "Changed capability marker.");
	assert.equal(mounts.filter((mount) => mount.plugin === mcpPlugin && mount.config?.serverName === "echo").length, 5);
	assert.equal(rt.capabilityStatusesView().worker.team.state, "ready");
	await rt.capabilitySave(
		{
			...mcp("missing-secret"),
			transport: "streamable-http",
			url: "https://example.test/mcp",
			headers: { Authorization: "$DSH_SECRET_TOKEN" },
		},
		{ botId: "worker" },
	);
	await rt.changeCapabilityAttachment("attach", { name: "missing-secret" }, "worker");
	await rt.scheduleCapabilitiesReconcile();
	assert.equal(rt.capabilityStatusesView().worker["missing-secret"].state, "error");
	assert.match(rt.capabilityStatusesView().worker["missing-secret"].error, /TOKEN/);
	await rt.changeCapabilityAttachment("detach", { name: "team" }, "chief");
	await rt.scheduleCapabilitiesReconcile();
	assert.equal(first?.disposed, true);
	assert.equal(
		mounts.findLast((mount) => mount.sessionId === "chief" && mount.plugin.inject?.includes("skills"))?.disposed,
		true,
	);
	assert.equal(rt.capabilityStatusesView().chief.team, undefined);
});

test("secret references in an HTTP MCP URL are resolved, and an unavailable one is an error", async (t) => {
	const env = setup({ secret: { name: "EXA_API_KEY", value: "fake-exa-key", scope: ["chief"] } });
	t.after(env.dispose);
	const { rt, mounts, skills } = env;
	await rt.capabilitySave(
		{
			name: "exa-cap",
			kind: "mcp",
			description: "",
			transport: "streamable-http",
			url: "https://mcp.exa.test/mcp?apiKey=$DSH_SECRET_EXA_API_KEY",
			headers: {},
		},
		{ botId: "chief" },
	);
	for (const bot of ["chief", "worker"])
		await rt.changeCapabilityAttachment("attach", { name: "exa-cap", bot: rt.state.bots[bot].name }, "chief");
	const chief = testAgent("chief", mounts, skills);
	const worker = testAgent("worker", mounts, skills);
	for (const agent of [chief, worker]) env.installed.set(agent.session.id, agent);
	for (const agent of [chief, worker]) await env.agentCreated(agent);
	await rt.scheduleCapabilitiesReconcile();
	const mountFor = (bot: string) =>
		mounts.find((mount) => mount.sessionId === bot && mount.config?.serverName === "exa-cap");
	assert.equal(mountFor("chief")?.config?.url, "https://mcp.exa.test/mcp?apiKey=fake-exa-key");
	assert.equal(rt.capabilityStatusesView().chief["exa-cap"].state, "ready");
	assert.equal(JSON.stringify(rt.state.capabilities).includes("fake-exa-key"), false);
	assert.equal(mountFor("worker"), undefined);
	assert.equal(rt.capabilityStatusesView().worker["exa-cap"].state, "error");
	assert.match(rt.capabilityStatusesView().worker["exa-cap"].error, /EXA_API_KEY/);
});

test("a secret in an HTTP MCP URL query is encoded as one parameter value", async (t) => {
	const value = "mock key/+&?=#'!()* 中文";
	const env = setup({ secret: { name: "EXA_API_KEY", value, scope: ["chief"] } });
	t.after(env.dispose);
	const { rt, mounts, skills } = env;
	await rt.capabilitySave(
		{
			name: "exa-cap",
			kind: "mcp",
			description: "",
			transport: "streamable-http",
			url: "https://mcp.exa.test/mcp?apiKey=$DSH_SECRET_EXA_API_KEY&mode=test",
			headers: {},
		},
		{ botId: "chief" },
	);
	await rt.changeCapabilityAttachment("attach", { name: "exa-cap" }, "chief");
	const chief = testAgent("chief", mounts, skills);
	env.installed.set("chief", chief);
	await env.agentCreated(chief);
	await rt.scheduleCapabilitiesReconcile();
	const mount = mounts.find((entry) => entry.sessionId === "chief" && entry.config?.serverName === "exa-cap");
	assert.ok(mount?.config);
	const url = new URL(mount.config.url);
	assert.equal(url.searchParams.get("apiKey"), value);
	assert.equal(url.searchParams.get("mode"), "test");
	assert.equal([...url.searchParams].length, 2);
	const saved = JSON.stringify(rt.state.capabilities);
	assert.equal(saved.includes(value), false);
	assert.equal(saved.includes(encodeURIComponent(value)), false);
});

test("a failed HTTP MCP mount does not show the encoded secret from its URL", async (t) => {
	const value = "mock key/+&?=#'!()* 中文";
	const env = setup({ secret: { name: "EXA_API_KEY", value, scope: ["chief"] } });
	t.after(env.dispose);
	const { rt, mounts, skills } = env;
	await rt.capabilitySave(
		{
			name: "exa-cap",
			kind: "mcp",
			description: "",
			transport: "streamable-http",
			url: "https://mcp.exa.test/mcp?apiKey=$DSH_SECRET_EXA_API_KEY",
			headers: {},
		},
		{ botId: "chief" },
	);
	await rt.changeCapabilityAttachment("attach", { name: "exa-cap" }, "chief");
	const chief = testAgent("chief", mounts, skills, {
		awaitMount: async (mount) => {
			throw new Error("Connection failed", { cause: new Error(`fetch ${mount.config?.url}`) });
		},
	});
	env.installed.set("chief", chief);
	await env.agentCreated(chief);
	await rt.scheduleCapabilitiesReconcile();
	const status = rt.capabilityStatusesView().chief["exa-cap"];
	assert.equal(status.state, "error");
	assert.equal(status.error, "Connection failed: fetch https://mcp.exa.test/mcp?apiKey=[secret:EXA_API_KEY]");
});
