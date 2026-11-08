// The DSH Agent: a team's one plain dsh entry, listed beside the Bots but not one of
// them. Its Sessions are ordinary root Sessions in the Ocean Crew workspace, so they get
// the whole dsh conversation surface and none of the team tools.
import { randomUUID } from "node:crypto";
import { AGENT_NAME, AGENT_SESSION_TITLE_MAX } from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";

/** One DSH Agent record as `state.agents` keeps it. */
export interface AgentRecord {
	id: string;
	name?: string;
	sessions?: string[];
	createdAt?: number;
}

// the

// The single cast states that gap; no shared file changes.
interface StateWithAgents {
	agents?: Record<string, AgentRecord>;
}

interface WorkspaceRegistryService {
	get?(workspaceId: string): unknown;
	archiveSession(sessionId: string): Promise<unknown>;
}

interface SessionControllerService {
	create(options: { workspaceId?: string }): Promise<{ sessionId: string }>;
}

interface SessionTitleService {
	rename(session: unknown, title: string): Promise<unknown>;
}

interface ResolvedAgent {
	session?: unknown;
}

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state = rt.state;
	const table = state as unknown as StateWithAgents;
	const agents = (): Record<string, AgentRecord> => {
		table.agents ??= {};
		return table.agents;
	};
	const registry = (): WorkspaceRegistryService => {
		const service = ctx.workspaceRegistry as WorkspaceRegistryService | undefined;
		if (service === undefined) throw new Error("This DSH has no workspace registry, so it has no DSH Agent");
		return service;
	};
	const controller = (): SessionControllerService => ctx.sessionController as unknown as SessionControllerService;
	const titles = (): SessionTitleService => ctx.sessionTitle as unknown as SessionTitleService;

	/** Session id -> DSH Agent record id. */
	const sessionIndex = new Map<string, string>();
	// store.js calls this from indexSessions after every adopt and save.
	rt.indexAgents = (): void => {
		sessionIndex.clear();
		for (const agent of Object.values(agents())) {
			for (const sessionId of agent.sessions ?? []) sessionIndex.set(sessionId, agent.id);
		}
	};
	// The DSH Agent a Session belongs to; Bot and group Sessions get undefined.
	const agentOf = (sessionId: string): AgentRecord | undefined => agents()[sessionIndex.get(sessionId) ?? ""];

	const writeCheck = (): void => {
		const readOnly = rt.readOnly();
		if (readOnly !== undefined) throw new Error(readOnly);
	};
	const record = (agentId: string): AgentRecord => {
		const agent = rt.own(agents(), agentId);
		if (agent === undefined) throw new Error("Unknown DSH Agent");
		return agent;
	};
	const sessionsOf = (agent: AgentRecord): string[] => {
		if (agent.sessions === undefined) agent.sessions = [];
		return agent.sessions;
	};

	async function createAgentSession(agentId: string, workspaceId?: unknown): Promise<string> {
		writeCheck();
		const agent = record(agentId);
		// A known workspace id wins (the Agent's latest Session may live outside the
		// team workspace after a workspace switch); anything else gets the team's own.
		const target =
			typeof workspaceId === "string" && registry().get?.(workspaceId)
				? workspaceId
				: await (rt.ensureWorkspace as () => Promise<string>)();
		const { sessionId } = await controller().create({ workspaceId: target });
		sessionsOf(agent).push(sessionId);
		await rt.save();
		return sessionId;
	}

	// A root Session the user opened from a DSH Agent page (the hero's workspace picker
	// or a fork) is adopted into the same Agent: it keeps dsh's surface and the team
	// tools stay hidden.
	async function adoptAgentSession(agentId: string, sessionId: string): Promise<string> {
		writeCheck();
		const agent = record(agentId);
		if (sessionsOf(agent).includes(sessionId)) return sessionId;
		await rt.resolveAgent(sessionId);
		const owned =
			rt.selfOf(sessionId) !== undefined ||
			rt.botOf(sessionId) !== undefined ||
			rt.roomOf(sessionId) !== undefined ||
			agentOf(sessionId) !== undefined;
		if (owned) throw new Error("Session already belongs to the team");
		sessionsOf(agent).push(sessionId);
		await rt.save();
		return sessionId;
	}

	async function addAgent(): Promise<AgentRecord> {
		writeCheck();
		if (Object.keys(agents()).length > 0) throw new Error("The team already has a DSH Agent");
		const agent: AgentRecord = { id: randomUUID(), name: AGENT_NAME, sessions: [], createdAt: Date.now() };
		agents()[agent.id] = agent;
		try {
			await createAgentSession(agent.id);
		} catch (error) {
			// The first Session may already be created and saved: archive it and persist
			// the rollback, or the Agent returns on restart with its team tools never denied.
			const createdSessions = [...sessionsOf(agent)];
			delete agents()[agent.id];
			for (const sessionId of createdSessions)
				await registry()
					.archiveSession(sessionId)
					.catch(() => {});
			await rt.save().catch(() => {});
			throw error;
		}
		return agent;
	}

	async function archiveAgentSession(agentId: string, sessionId: string): Promise<void> {
		writeCheck();
		const agent = record(agentId);
		if (!sessionsOf(agent).includes(sessionId)) throw new Error("Session does not belong to the DSH Agent");
		// Archive first: the Session leaves the Agent only once it is actually gone,
		// so a failed archive stays retryable and keeps its tool restriction.
		await registry().archiveSession(sessionId);
		agent.sessions = sessionsOf(agent).filter((id) => id !== sessionId);
		await rt.save();
	}

	async function renameAgentSession(agentId: string, sessionId: string, title: unknown): Promise<void> {
		writeCheck();
		const agent = record(agentId);
		if (!sessionsOf(agent).includes(sessionId)) throw new Error("Session does not belong to the DSH Agent");
		const clean = String(title ?? "").trim();
		if (clean === "") throw new Error("A session needs a title");
		const resolved = (await rt.resolveAgent(sessionId)) as ResolvedAgent;
		await titles().rename(resolved.session, clean.slice(0, AGENT_SESSION_TITLE_MAX));
	}

	async function removeAgent(agentId: string): Promise<void> {
		writeCheck();
		const agent = record(agentId);
		const sessions = [...sessionsOf(agent)];
		const kept: string[] = [];
		let failure: unknown;
		for (const sessionId of sessions) {
			try {
				await registry().archiveSession(sessionId);
			} catch (error) {
				failure ??= error;
				kept.push(sessionId);
			}
		}
		// What could not be archived stays with the Agent, so it keeps its tool
		// restriction and the removal can be retried from the same place.
		if (kept.length > 0) {
			agent.sessions = kept;
			await rt.save();
			throw failure;
		}
		delete agents()[agentId];
		await rt.save();
	}

	Object.assign(rt, {
		agentOf,
		addAgent,
		createAgentSession,
		adoptAgentSession,
		archiveAgentSession,
		renameAgentSession,
		removeAgent,
	});
}
