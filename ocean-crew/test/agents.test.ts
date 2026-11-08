// DSH Agent behaviour: one plain dsh entry per team, its Sessions created in the team
// workspace, archived only once DSH has actually archived them, renamed only when they
// belong to it, and adopted only when no one else owns them.
// build's public assertions.
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { AGENT_NAME, AGENT_SESSION_TITLE_MAX } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { type AgentRecord, install } from "../src/host/team/agents.ts";

type TestRuntime = Runtime & Record<string, any>;

interface Services {
	workspaces: Map<string, { id: string; path: string }>;
	created: Array<{ workspaceId?: string }>;
	archived: string[];
	renamed: Array<{ id: unknown; title: string }>;
	resolveCalls: string[];
	failArchive: { on: boolean; for?: string };
	createFails: { on: boolean };
}

interface Host {
	rt: TestRuntime;
	home: string;
	statePath: string;
	services: Services;
	dispose(): Promise<void>;
}

const team = (): Record<string, any> => ({
	version: 1,
	mainBotIds: ["m1"],
	revision: 2,
	bots: { m1: { id: "m1", name: "Chief", role: "Boss", sessionId: "m1", createdAt: 1 } },
	rooms: {},
	agents: {},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
	prefs: {},
});

async function boot(home: string, seeded?: unknown): Promise<Host> {
	const statePath = join(home, "state.json");
	if (seeded !== undefined) fs.writeFileSync(statePath, JSON.stringify(seeded));
	const services: Services = {
		workspaces: new Map([["w1", { id: "w1", path: join(home, "workspace") }]]),
		created: [],
		archived: [],
		renamed: [],
		resolveCalls: [],
		failArchive: { on: false },
		createFails: { on: false },
	};
	let sessions = 0;
	const warnings: unknown[][] = [];
	const disposers: Array<() => unknown> = [];
	const ctx = {
		logger: { warn: (...args: unknown[]) => warnings.push(args) },
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
		workspaceRegistry: {
			get: (id: string) => services.workspaces.get(id),
			archiveSession: async (sessionId: string) => {
				if (
					services.failArchive.on &&
					(services.failArchive.for === undefined || services.failArchive.for === sessionId)
				)
					throw new Error("session is running");
				services.archived.push(sessionId);
			},
		},
		sessionController: {
			create: async (options: { workspaceId?: string }) => {
				if (services.createFails.on) throw new Error("the model catalog is unavailable");
				services.created.push(options);
				return { sessionId: `s${++sessions}` };
			},
			resolveAgent: async (sessionId: string) => {
				services.resolveCalls.push(sessionId);
				return { agent: { session: { id: sessionId } } };
			},
		},
		sessionTitle: {
			rename: async (session: unknown, title: string) => {
				services.renamed.push({ id: (session as { id?: unknown })?.id, title });
			},
		},
	};
	const rt = {
		ctx,
		home,
		statePath,
		warn: (...args: unknown[]) => warnings.push(args),
	} as unknown as TestRuntime;
	installStore(rt);
	install(rt);
	rt.ensureWorkspace = async () => "w1";
	// `delivery` publishes resolveAgent, which opens a Session DSH can still open.
	rt.resolveAgent = async (sessionId: string) => {
		services.resolveCalls.push(sessionId);
		return { session: { id: sessionId } };
	};
	await rt.load();
	let disposed = false;
	const host: Host = {
		rt,
		home,
		statePath,
		services,
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const cleanup of disposers.splice(0).reverse()) await cleanup();
		},
	};
	return host;
}

const tempHome = (t: TestContext): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-agents-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};

const saved = (host: Host): any => JSON.parse(fs.readFileSync(host.statePath, "utf8"));
const agentRecord = (host: Host, agent: AgentRecord): AgentRecord => host.rt.state.agents[agent.id];

test("add-agent creates one record with a first Session in the Ocean Crew workspace", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	assert.equal(agent.name, AGENT_NAME);
	assert.equal(agent.sessions?.length, 1);
	assert.equal(typeof agent.createdAt, "number");
	// The Session was created in the workspace the Bots live in.
	assert.equal(host.services.created.at(-1)?.workspaceId, "w1");
	assert.deepEqual(Object.keys(saved(host).agents), [agent.id]);
	assert.equal(host.rt.agentOf(agent.sessions?.[0])?.id, agent.id);
});

test("a team holds at most one DSH Agent", async (t) => {
	const host = await boot(tempHome(t), team());
	await host.rt.addAgent();
	await assert.rejects(async () => host.rt.addAgent(), /The team already has a DSH Agent/);
});

test("createAgentSession appends Sessions and honors a known workspace", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const second = await host.rt.createAgentSession(agent.id);
	assert.equal(typeof second, "string");
	assert.equal(agentRecord(host, agent).sessions?.length, 2);
	// An unknown workspace id falls back to the team workspace; a real one is used.
	await host.rt.createAgentSession(agent.id, "nope");
	assert.equal(host.services.created.at(-1)?.workspaceId, "w1");
	host.services.workspaces.set("w2", { id: "w2", path: join(host.home, "other") });
	await host.rt.createAgentSession(agent.id, "w2");
	assert.equal(host.services.created.at(-1)?.workspaceId, "w2");
	// A Session the Agent owns is resolved from the index rebuilt on every save.
	assert.equal(host.rt.agentOf(second)?.id, agent.id);
});

test("archiveAgentSession archives first, then drops the Session from the Agent", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const second = await host.rt.createAgentSession(agent.id);
	await host.rt.archiveAgentSession(agent.id, second);
	assert.deepEqual(host.services.archived, [second]);
	assert.deepEqual(agentRecord(host, agent).sessions, agent.sessions);
	assert.deepEqual(saved(host).agents[agent.id].sessions, agent.sessions);
	// A Session that is not this Agent's is refused.
	await assert.rejects(async () => host.rt.archiveAgentSession(agent.id, "m1"), /does not belong to the DSH Agent/);
});

test("a failed archive keeps the Session in the Agent and answers with the error", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const second = await host.rt.createAgentSession(agent.id);
	host.services.failArchive.on = true;
	await assert.rejects(async () => host.rt.archiveAgentSession(agent.id, second), /session is running/);
	// The Session stays with the Agent, so the restriction and the retry stay.
	assert.deepEqual(agentRecord(host, agent).sessions, [agent.sessions?.[0], second]);
	assert.deepEqual(host.services.archived, []);
	host.services.failArchive.on = false;
	await host.rt.archiveAgentSession(agent.id, second);
	assert.deepEqual(host.services.archived, [second]);
});

test("renameAgentSession retitles an owned Session and refuses others", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const owned = agent.sessions?.[0] as string;
	await host.rt.renameAgentSession(agent.id, owned, "  Scratch  ");
	assert.deepEqual(host.services.renamed.at(-1), { id: owned, title: "Scratch" });
	await host.rt.renameAgentSession(agent.id, owned, "x".repeat(200));
	assert.equal(host.services.renamed.at(-1)?.title.length, AGENT_SESSION_TITLE_MAX);
	await assert.rejects(async () => host.rt.renameAgentSession(agent.id, owned, "   "), /A session needs a title/);
	// A Bot's Session cannot be renamed through the agent call.
	await assert.rejects(
		async () => host.rt.renameAgentSession(agent.id, "m1", "x"),
		/does not belong to the DSH Agent/,
	);
});

test("remove-agent keeps the Agent with the Sessions it could not archive", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const second = await host.rt.createAgentSession(agent.id);
	host.services.failArchive.on = true;
	await assert.rejects(async () => host.rt.removeAgent(agent.id), /session is running/);
	assert.deepEqual(agentRecord(host, agent).sessions, [agent.sessions?.[0], second]);
	assert.deepEqual(host.services.archived, []);
	host.services.failArchive.on = false;
	await host.rt.removeAgent(agent.id);
	assert.deepEqual(Object.keys(saved(host).agents), []);
});

test("remove-agent archives every Session and drops the record", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const second = await host.rt.createAgentSession(agent.id);
	await host.rt.removeAgent(agent.id);
	assert.deepEqual(Object.keys(saved(host).agents), []);
	assert.deepEqual([...host.services.archived].sort(), [agent.sessions?.[0], second].sort());
});

test("only the Sessions that archived leave the Agent on a partial removal", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const first = agent.sessions?.[0] as string;
	const second = await host.rt.createAgentSession(agent.id);
	host.services.failArchive.on = true;
	host.services.failArchive.for = second;
	await assert.rejects(async () => host.rt.removeAgent(agent.id), /session is running/);
	// The first Session went; the one that failed stays, and the retry finishes the job.
	assert.deepEqual(agentRecord(host, agent).sessions, [second]);
	assert.deepEqual(host.services.archived, [first]);
	host.services.failArchive.on = false;
	await host.rt.removeAgent(agent.id);
	assert.deepEqual(Object.keys(saved(host).agents), []);
});

test("agents survive a state reload", async (t) => {
	const home = tempHome(t);
	const first = await boot(home, team());
	const agent = (await first.rt.addAgent()) as AgentRecord;
	await first.dispose();
	// Restart on the saved file: the agent record is adopted, not lost, and its Session
	// is in the index again.
	const again = await boot(home);
	assert.deepEqual(Object.keys(again.rt.state.agents), [agent.id]);
	assert.equal(again.rt.agentOf(agent.sessions?.[0])?.id, agent.id);
});

test("a corrupt agents field resets instead of crashing", async (t) => {
	const host = await boot(tempHome(t), { ...team(), agents: "junk" });
	assert.deepEqual(host.rt.state.agents, {});
	// The count of Agents is what the one-Agent rule reads, so a fresh Agent can be made.
	const agent = await host.rt.addAgent();
	assert.deepEqual(Object.keys(host.rt.state.agents), [agent.id]);
});

test("agent-adopt takes an unowned Session and refuses team-owned ones", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const firstSession = agent.sessions?.[0] as string;
	// A plain root Session (the workspace picker's blank, or a fork) joins the Agent.
	const adopted = await host.rt.adoptAgentSession(agent.id, "fresh");
	assert.equal(adopted, "fresh");
	assert.deepEqual(agentRecord(host, agent).sessions, [firstSession, "fresh"]);
	assert.deepEqual(saved(host).agents[agent.id].sessions, [firstSession, "fresh"]);
	// Adopting again is a no-op.
	assert.equal(await host.rt.adoptAgentSession(agent.id, "fresh"), "fresh");
	// A Bot's Session and an unknown Agent are refused.
	await assert.rejects(async () => host.rt.adoptAgentSession(agent.id, "m1"), /Session already belongs to the team/);
	await assert.rejects(async () => host.rt.adoptAgentSession("none", "fresh2"), /Unknown DSH Agent/);
	// A Session another Agent already owns is refused too.
	host.rt.state.agents.other = { id: "other", name: AGENT_NAME, sessions: ["taken"] };
	host.rt.indexAgents?.();
	await assert.rejects(
		async () => host.rt.adoptAgentSession(agent.id, "taken"),
		/Session already belongs to the team/,
	);
});

test("a read-only host refuses to change the DSH Agent", async (t) => {
	const host = await boot(tempHome(t), team());
	const agent = (await host.rt.addAgent()) as AgentRecord;
	const second = await host.rt.createAgentSession(agent.id);
	const readOnly = "The Bot team is open in another dsh (pid 1).";
	host.rt.readOnly = () => readOnly;
	await assert.rejects(
		async () => host.rt.addAgent(),
		(error: Error) => error.message === readOnly,
	);
	await assert.rejects(
		async () => host.rt.archiveAgentSession(agent.id, second),
		(error: Error) => error.message === readOnly,
	);
	await assert.rejects(
		async () => host.rt.renameAgentSession(agent.id, second, "Title"),
		(error: Error) => error.message === readOnly,
	);
	await assert.rejects(
		async () => host.rt.removeAgent(agent.id),
		(error: Error) => error.message === readOnly,
	);
	await assert.rejects(
		async () => host.rt.adoptAgentSession(agent.id, "fresh"),
		(error: Error) => error.message === readOnly,
	);
});

test("a failed first Session rolls the new Agent back", async (t) => {
	const host = await boot(tempHome(t), team());
	host.services.createFails.on = true;
	await assert.rejects(async () => host.rt.addAgent(), /the model catalog is unavailable/);
	// Nothing is left in memory or in the team file, so a later retry starts clean.
	assert.deepEqual(host.rt.state.agents, {});
	assert.deepEqual(saved(host).agents ?? {}, {});
	assert.deepEqual(host.services.archived, []);
	host.services.createFails.on = false;
	const agent = await host.rt.addAgent();
	assert.deepEqual(Object.keys(host.rt.state.agents), [agent.id]);
});
