// Capabilities: the shared MCP servers, skills and packs in the team library, their
// per-Session health, and the mounts that give each Bot Session its tools and skills.
// The MCP client is loaded through DSH's own loader; a mounted fiber lives in the
// Agent's own context, so this module keeps it reachable and disposes it on unload.
//
// The capability tools (list/save/delete/attach/detach) are registered here — the

import { createHash } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { TeamState } from "../../shared/state.ts";
import type { Runtime, TeamTool } from "../core/runtime.ts";
import { own } from "../core/store.ts";
import { encodeUrlComponent } from "./secrets.ts";

const MCP_CLIENT = "@deepseek-ai/dsh-mcp-client";
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g;
const ENSURE_TIMEOUT_MS = 15_000;

// Connector ids are reserved: a capability named like one would collide with its
// mcp__<id>__* tool prefix. The connectors module registers its ids here.
export const CONNECTOR_IDS = new Set(["github", "mail"]);
export function validateCapabilityName(value: unknown, reserved: ReadonlySet<string> = CONNECTOR_IDS): string {
	const name = String(value ?? "").trim();
	if (name.length > 32 || !NAME.test(name) || name === "github" || reserved.has(name)) {
		throw new Error(
			"Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.",
		);
	}
	return name;
}

/** One saved library item; the fields depend on `kind`. */
export interface CapabilityItem {
	name: string;
	kind: "mcp" | "skill" | "pack";
	description?: string;
	createdBy?: string | null;
	createdAt?: number;
	updatedAt?: number;
	transport?: "stdio" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	approved?: boolean;
	url?: string;
	headers?: Record<string, string>;
	content?: string;
	items?: string[];
	[key: string]: unknown;
}

export interface CapabilityStatus {
	state: "error" | "needs-approval" | "connecting" | "ready";
	error?: string;
}

export interface CapabilityView {
	bot: string;
	attached: boolean;
}

export function expandCapabilityNames(
	capabilities: readonly string[] | undefined,
	library: Record<string, CapabilityItem>,
): Set<string> {
	const expanded = new Set<string>();
	for (const name of capabilities ?? []) {
		const item = own(library, name);
		if (!item) throw new Error(`No capability named ${name}.`);
		if (item.kind === "pack") {
			for (const childName of item.items ?? []) {
				const child = own(library, childName);
				if (!child || !["mcp", "skill"].includes(child.kind))
					throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`);
				expanded.add(childName);
			}
		} else if (item.kind === "mcp" || item.kind === "skill") {
			expanded.add(name);
		} else {
			throw new Error(`Capability ${name} has an unknown kind.`);
		}
	}
	return expanded;
}

interface AgentLike {
	id?: string;
	session: { id: string };
	ctx: Record<string, any>;
	[key: string]: unknown;
}

interface Mount {
	key: string;
	fiber: { await?: () => Promise<unknown>; dispose?: () => unknown };
}

interface LoaderService {
	import(specifier: string): Promise<unknown>;
	unwrapExports?(exports: unknown): unknown;
}

interface BotLike {
	id: string;
	name: string;
	capabilities?: string[];
	[key: string]: unknown;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const strings = (value: unknown): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error("Arguments must be a list of text values.");
	return [...value];
};
const stringMap = (value: unknown, label: string): Record<string, string> => {
	if (value === undefined) return {};
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.values(value).some((item) => typeof item !== "string")
	)
		throw new Error(`${label} must contain text values.`);
	return Object.fromEntries(Object.entries(value) as Array<[string, string]>);
};

const output = {
	schema: { type: "string" },
	render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
		{ type: "text", text: String(value) },
	],
};

interface ToolOptions {
	name: string;
	description: string;
	parameters: Record<string, any>;
	execute(args: Record<string, any>, exec: Record<string, any>): unknown | Promise<unknown>;
}

const tool = (options: ToolOptions): TeamTool => defineTool({ ...options, output } as never) as unknown as TeamTool;

export function install(rt: Runtime): void {
	const { ctx, state } = rt;
	const agents = new Map<string, WeakRef<AgentLike>>();
	// Mounted fibers live in each Agent's own context, so they outlive this plugin unless
	// its cleanup disposes them; a strong map keeps them reachable for that.
	const mounts = new Map<AgentLike, Map<string, Mount>>();
	// One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
	const chains = new WeakMap<AgentLike, Promise<void>>();
	const queued = new WeakSet<AgentLike>();
	const sessionStatuses = new Map<string, Map<string, Map<string, CapabilityStatus>>>();
	let pluginPromise: Promise<unknown> | undefined;
	let scheduled: Promise<void> | null = null;
	let loadingSecrets = 0;
	let stopped = false;

	const library = (): Record<string, CapabilityItem> =>
		(state as unknown as TeamState).capabilities.items as unknown as Record<string, CapabilityItem>;
	const ensureLibrary = (): Record<string, CapabilityItem> => {
		const team = state as unknown as TeamState;
		team.capabilities ??= { items: {} };
		const items = team.capabilities.items as unknown as Record<string, CapabilityItem>;
		return items;
	};
	const writeCheck = (): void => {
		const readOnly = rt.readOnly();
		if (readOnly !== undefined) throw new Error(readOnly);
	};
	const allowedToEdit = (item: CapabilityItem, botId: string | undefined): boolean =>
		rt.isMain(botId) || item.createdBy === botId;
	const usedByOthers = (name: string, botId: string | undefined): boolean =>
		Object.values(state.bots).some(
			(bot) =>
				bot.id !== botId &&
				(bot.capabilities ?? []).some((attached) => {
					const item = own(library(), attached);
					return attached === name || (item?.kind === "pack" && (item.items ?? []).includes(name));
				}),
		);

	const editCheck = (item: CapabilityItem, botId: string | undefined, verb: string): void => {
		if (!allowedToEdit(item, botId))
			throw new Error(
				`Only ${item.createdBy ? "its creator or a Main Bot" : "a Main Bot"} can ${verb} ${item.name}.`,
			);
		if (!rt.isMain(botId) && usedByOthers(item.name, botId))
			throw new Error(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`);
	};
	const itemInput = (body: Record<string, any>, { botId, ui }: { botId?: string; ui?: boolean }): CapabilityItem => {
		const name = validateCapabilityName(body.name);
		const kind = body.kind as CapabilityItem["kind"];
		if (!["mcp", "skill", "pack"].includes(kind)) throw new Error("Choose an MCP server, skill, or pack.");
		const items = ensureLibrary();
		const previous = own(items, name);
		if (previous && !ui) editCheck(previous, botId, "change");
		if (previous && previous.kind !== kind)
			throw new Error("A capability cannot change its kind. Delete it and save a new one.");
		const now = Date.now();
		const item: CapabilityItem = {
			name,
			kind,
			description: String(body.description ?? "")
				.trim()
				.slice(0, 2000),
			createdBy: previous?.createdBy ?? (ui ? null : (botId ?? null)),
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		};
		if (kind === "mcp") {
			const transport = body.transport === "streamable-http" ? "streamable-http" : "stdio";
			if (transport === "stdio") {
				const command = String(body.command ?? "").trim();
				if (command === "") throw new Error("Enter a command for the MCP server.");
				const args = strings(body.args);
				const env = stringMap(body.env, "Environment variables");
				const changed =
					!previous ||
					previous.kind !== "mcp" ||
					previous.transport !== "stdio" ||
					previous.command !== command ||
					!same(previous.args ?? [], args) ||
					!same(previous.env ?? {}, env);
				Object.assign(item, {
					transport,
					command,
					args,
					env,
					approved: ui ? true : changed ? false : previous.approved === true,
				});
			} else {
				const url = String(body.url ?? "").trim();
				try {
					const parsed = new URL(url);
					if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
				} catch {
					throw new Error("Enter a valid HTTP or HTTPS URL.");
				}
				Object.assign(item, {
					transport,
					url,
					headers: stringMap(body.headers, "Headers"),
					approved: true,
				});
			}
		} else if (kind === "skill") {
			item.content = String(body.content ?? "").trim();
		} else {
			const names = [...new Set(strings(body.items))];
			for (const childName of names) {
				const child = own(items, childName);
				if (!child || !["mcp", "skill"].includes(child.kind))
					throw new Error(`Packs can include only saved MCP servers and skills. ${childName} is not one.`);
			}
			item.items = names;
		}
		items[name] = item;
		return item;
	};
	const capabilitySave = async (
		body: Record<string, any>,
		options: { botId?: string; ui?: boolean } = {},
	): Promise<CapabilityItem> => {
		await rt.load();
		writeCheck();
		const item = itemInput(body ?? {}, options);
		await rt.save();
		return item;
	};
	const capabilityDelete = async (
		name: unknown,
		{ botId, ui }: { botId?: string; ui?: boolean } = {},
	): Promise<boolean> => {
		await rt.load();
		writeCheck();
		const items = ensureLibrary();
		const item = own(items, String(name ?? ""));
		if (!item) throw new Error(`No capability named ${name}.`);
		if (!ui) editCheck(item, botId, "delete");
		delete items[item.name];
		for (const pack of Object.values(items))
			if (pack.kind === "pack") pack.items = (pack.items ?? []).filter((child) => child !== item.name);
		for (const bot of Object.values(state.bots))
			bot.capabilities = (bot.capabilities ?? []).filter((attached) => attached !== item.name);
		await rt.save();
		return true;
	};
	// Called with the Bot being deleted, after it left the team. The shared list belongs
	// to the user, so only a local MCP this Bot added, nobody approved and no other Bot or
	// pack uses goes: no one is left to ask for it, and approving it would start a server
	// for no one. Anything a pack lists stays.
	const dropOrphanCapabilities = (bot: BotLike): void => {
		const items = library();
		const packed = (name: string): boolean =>
			Object.values(items).some((item) => item.kind === "pack" && (item.items ?? []).includes(name));
		for (const name of bot.capabilities ?? []) {
			const item = own(items, name);
			if (item === undefined || item.kind !== "mcp" || item.transport !== "stdio" || item.approved === true)
				continue;
			if (item.createdBy !== bot.id || usedByOthers(name, bot.id) || packed(name)) continue;
			delete items[item.name];
		}
	};
	const changeAttachment = async (
		endpoint: "attach" | "detach",
		body: { name?: unknown; bot?: unknown },
		callerId: string | undefined,
	): Promise<CapabilityView> => {
		await rt.load();
		writeCheck();
		const caller = rt.botOf(callerId);
		if (!caller) throw new Error("Only Bots on the team can change capabilities.");
		const target = body.bot ? rt.findBot(body.bot) : caller;
		if (!target) throw new Error(`No Bot named ${body.bot}.`);
		if (target.id !== caller.id && !rt.isMain(callerId))
			throw new Error("Only a Main Bot can change another Bot’s capabilities.");
		const item = own(ensureLibrary(), String(body.name ?? ""));
		if (!item) throw new Error(`No capability named ${body.name}.`);
		await setAttached(target, item.name, endpoint === "attach");
		return { bot: target.name, attached: endpoint === "attach" };
	};
	// Changes one name against the saved list, so two quick changes both land.
	const setAttached = async (bot: BotLike, name: string, attached: boolean): Promise<string[]> => {
		bot.capabilities ??= [];
		const wasEmpty = bot.capabilities.length === 0;
		if (attached && !bot.capabilities.includes(name)) bot.capabilities.push(name);
		if (!attached) bot.capabilities = bot.capabilities.filter((entry) => entry !== name);
		await rt.save();
		if (wasEmpty && bot.capabilities.length > 0) {
			await trackBotAgents(bot);
			void scheduleReconcile();
		}
		return bot.capabilities;
	};

	const statusSet = (botId: string, itemName: string, sessionId: string, status: CapabilityStatus): void => {
		let byItem = sessionStatuses.get(botId);
		if (!byItem) {
			byItem = new Map();
			sessionStatuses.set(botId, byItem);
		}
		let bySession = byItem.get(itemName);
		if (!bySession) {
			bySession = new Map();
			byItem.set(itemName, bySession);
		}
		bySession.set(sessionId, status);
	};
	const clearStatus = (botId: string, itemName: string, sessionId: string): void => {
		const byItem = sessionStatuses.get(botId);
		const bySession = byItem?.get(itemName);
		bySession?.delete(sessionId);
		if (bySession?.size === 0) byItem?.delete(itemName);
		if (byItem?.size === 0) sessionStatuses.delete(botId);
	};
	const clearSession = (sessionId: string): void => {
		for (const [botId, byItem] of sessionStatuses) {
			for (const [name, bySession] of byItem) {
				bySession.delete(sessionId);
				if (bySession.size === 0) byItem.delete(name);
			}
			if (byItem.size === 0) sessionStatuses.delete(botId);
		}
	};
	const statusFor = (botId: string, name: string): CapabilityStatus | undefined => {
		const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])];
		if (values.some((status) => status.state === "error")) return values.find((status) => status.state === "error");
		if (values.some((status) => status.state === "needs-approval")) return { state: "needs-approval" };
		if (values.some((status) => status.state === "connecting")) return { state: "connecting" };
		return values.length > 0 ? { state: "ready" } : undefined;
	};
	const capabilityStatusesView = (): Record<string, Record<string, CapabilityStatus>> => {
		const result: Record<string, Record<string, CapabilityStatus>> = {};
		for (const bot of Object.values(state.bots)) {
			const statuses: Record<string, CapabilityStatus> = {};
			for (const name of bot.capabilities ?? []) {
				const item = own(library(), name);
				if (!item) continue;
				if (item.kind !== "pack") {
					const status = statusFor(bot.id, name);
					if (status) statuses[name] = status;
					continue;
				}
				const children = (item.items ?? [])
					.map((child) => statusFor(bot.id, child))
					.filter((status): status is CapabilityStatus => Boolean(status));
				const status =
					children.find((entry) => entry.state === "error") ??
					children.find((entry) => entry.state === "needs-approval") ??
					children.find((entry) => entry.state === "connecting") ??
					children[0];
				if (status) statuses[name] = status;
			}
			result[bot.id] = statuses;
		}
		return result;
	};

	const libraryView = (): CapabilityItem[] =>
		Object.values(library()).map((item) => ({
			...item,
			...(item.env ? { env: { ...item.env } } : {}),
			...(item.headers ? { headers: { ...item.headers } } : {}),
			...(item.items ? { items: [...item.items] } : {}),
		}));

	async function loadMcpPlugin(): Promise<unknown> {
		if (!pluginPromise) {
			pluginPromise = (async () => {
				const loader = ctx.get("loader") as LoaderService | undefined;
				if (typeof loader?.import !== "function") throw new Error("This DSH cannot load MCP servers.");
				const exports = await loader.import(MCP_CLIENT);
				return loader.unwrapExports?.(exports) ?? (exports as { default?: unknown })?.default ?? exports;
			})();
		}
		return pluginPromise;
	}
	function secretFor(name: string, botId: string): string {
		const value = rt.canUseSecret(name, botId) ? rt.secretValue(name) : undefined;
		if (value === undefined) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`);
		return value;
	}
	function resolveValues(values: Record<string, string> | undefined, botId: string): Record<string, string> {
		const resolved: Record<string, string> = {};
		for (const [key, raw] of Object.entries(values ?? {})) {
			resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name: string) => secretFor(name, botId));
		}
		return resolved;
	}
	const resolveUrl = (url: string, botId: string): string =>
		String(url).replace(SECRET_REFERENCE, (_match, name: string) => encodeUrlComponent(secretFor(name, botId)));
	const resolveList = (list: string[] | undefined, botId: string): string[] =>
		(list ?? []).map((raw) =>
			String(raw).replace(SECRET_REFERENCE, (_match, name: string) => secretFor(name, botId)),
		);
	const configFor = (item: CapabilityItem, botId: string): Record<string, unknown> => {
		if (item.kind === "skill") return { name: item.name, description: item.description, content: item.content };
		if (item.transport === "stdio")
			return {
				transport: "stdio",
				serverName: item.name,
				command: item.command,
				args: resolveList(item.args, botId),
				env: resolveValues(item.env, botId),
				failOnStartupError: true,
			};
		return {
			transport: "streamable-http",
			serverName: item.name,
			url: resolveUrl(item.url ?? "", botId),
			headers: resolveValues(item.headers, botId),
			failOnStartupError: true,
		};
	};
	const disposeMount = async (mount: Mount | undefined): Promise<void> => {
		if (mount?.fiber)
			await Promise.resolve()
				.then(() => mount.fiber.dispose?.())
				.catch(() => undefined);
	};
	const mountOne = async (
		agent: AgentLike,
		bot: BotLike,
		agentMounts: Map<string, Mount>,
		name: string,
	): Promise<void> => {
		const sessionId = agent.session.id;
		const item = own(library(), name) as CapabilityItem;
		const drop = async (): Promise<void> => {
			await disposeMount(agentMounts.get(name));
			agentMounts.delete(name);
		};
		if (item.kind === "mcp" && item.transport === "stdio" && item.approved !== true) {
			await drop();
			statusSet(bot.id, name, sessionId, { state: "needs-approval" });
			return;
		}
		let config: Record<string, unknown>;
		try {
			config = configFor(item, bot.id);
		} catch (error) {
			await drop();
			statusSet(bot.id, name, sessionId, {
				state: "error",
				error: rt.redactSecrets((error as Error).message).slice(0, 300),
			});
			return;
		}
		const key = `${name}:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`;
		if (agentMounts.get(name)?.key === key) return;
		await drop();
		statusSet(bot.id, name, sessionId, { state: "connecting" });
		try {
			const plugin =
				item.kind === "skill"
					? {
							name: `ocean-crew-capability-skill-${name}`,
							inject: ["skills"],
							apply(c: Record<string, any>) {
								c.effect(() =>
									c.skills.register({
										name: config.name,
										description: config.description,
										source: "runtime",
										content: config.content,
									}),
								);
							},
						}
					: await loadMcpPlugin();
			if (stopped) return;
			const fiber = item.kind === "skill" ? agent.ctx.plugin(plugin) : agent.ctx.plugin(plugin, config);
			agentMounts.set(name, { key, fiber });
			await fiber.await?.();
			if (stopped || agents.get(sessionId)?.deref() !== agent) return;
			statusSet(bot.id, name, sessionId, { state: "ready" });
		} catch (error) {
			await drop();
			const cause = (error as { cause?: { message?: unknown } }).cause;
			const message = rt
				.redactSecrets(
					[error, cause]
						.filter(Boolean)
						.map((part) => String((part as { message?: unknown })?.message ?? part))
						.join(": ") || "Connection failed",
				)
				.slice(0, 300);
			statusSet(bot.id, name, sessionId, { state: "error", error: message });
		}
	};
	const reconcileAgent = async (agent: AgentLike, bot: BotLike | undefined): Promise<void> => {
		const sessionId = agent.session.id;
		const desired = bot ? expandCapabilityNames(bot.capabilities, library()) : new Set<string>();
		const agentMounts = mounts.get(agent) ?? new Map<string, Mount>();
		if (desired.size > 0) mounts.set(agent, agentMounts);
		if (bot) {
			for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
				if (!desired.has(name)) clearStatus(bot.id, name, sessionId);
			}
		} else {
			clearSession(sessionId);
		}
		for (const [name, mount] of agentMounts) {
			if (desired.has(name)) continue;
			await disposeMount(mount);
			agentMounts.delete(name);
		}
		await Promise.all([...desired].map((name) => mountOne(agent, bot as BotLike, agentMounts, name)));
		if (agentMounts.size === 0 && mounts.get(agent) === agentMounts) mounts.delete(agent);
	};
	const botOfSession = (sessionId: string): BotLike | undefined =>
		rt.isBotSession(sessionId) ? (rt.botOf(rt.selfOf(sessionId)) as BotLike | undefined) : undefined;
	// At most one run waits behind the running one; it reads the latest state when it starts.
	const reconcileOne = (agent: AgentLike): Promise<void> => {
		if (queued.has(agent)) return chains.get(agent) ?? Promise.resolve();
		queued.add(agent);
		const run = (chains.get(agent) ?? Promise.resolve())
			.then(async () => {
				queued.delete(agent);
				const sessionId = agent.session.id;
				if (stopped || agents.get(sessionId)?.deref() !== agent) return;
				await reconcileAgent(agent, botOfSession(sessionId));
			})
			.catch((error) => rt.warn("ocean-crew: capability reconcile for %s failed: %s", agent.session?.id, error));
		chains.set(agent, run);
		return run;
	};
	const loadInputs = async (): Promise<void> => {
		await rt.load();
		loadingSecrets += 1;
		try {
			await rt.loadSecrets();
		} finally {
			loadingSecrets -= 1;
		}
	};
	async function reconcile(): Promise<void> {
		if (stopped) return;
		await loadInputs();
		const runs: Array<Promise<void>> = [];
		for (const [sessionId, reference] of agents) {
			const agent = reference.deref();
			if (agent) {
				runs.push(reconcileOne(agent));
				continue;
			}
			agents.delete(sessionId);
			clearSession(sessionId);
		}
		await Promise.all(runs);
	}
	const scheduleReconcile = (): Promise<void> => {
		if (!scheduled) {
			scheduled = new Promise<void>((resolve) => {
				queueMicrotask(() => {
					scheduled = null;
					resolve(reconcile().catch((error) => rt.warn("ocean-crew: capability reconcile failed: %s", error)));
				});
			});
		}
		return scheduled;
	};
	// A run that outlasts the limit goes on in the background, and later requests for the
	// same Agent do not wait for it again.
	const stalled = new WeakSet<AgentLike>();
	const prepare = async (agent: AgentLike, sessionId: string): Promise<void> => {
		const run = loadInputs()
			.then(() => reconcileOne(agent))
			.then(
				() => true,
				(error) => {
					rt.warn("ocean-crew: capability mount for %s failed: %s", sessionId, error);
					return true;
				},
			);
		if (stalled.has(agent)) return;
		const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const completed = await Promise.race([
			run,
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		if (completed) return;
		stalled.add(agent);
		void run.then(() => stalled.delete(agent));
		rt.warn("ocean-crew: capability mount for %s did not finish within %dms; continuing", sessionId, timeoutMs);
	};
	async function ensureCapabilities(sessionId: string): Promise<void> {
		await rt.load();
		const bot = botOfSession(sessionId);
		if (!bot) return;
		if ((bot.capabilities ?? []).length === 0 && !mounts.get(agents.get(sessionId)?.deref() as AgentLike)?.size)
			return;
		let agent: AgentLike;
		try {
			agent = (await rt.resolveAgent(sessionId)) as AgentLike;
		} catch (error) {
			rt.warn(
				"ocean-crew: capability Agent for %s could not be resolved: %s",
				sessionId,
				rt.redactSecrets(String(error)),
			);
			return;
		}
		trackAgent(agent);
		await prepare(agent, sessionId);
	}
	const trackAgent = (agent: AgentLike | undefined): void => {
		const sessionId = agent?.session?.id;
		if (typeof sessionId !== "string" || !agent?.ctx) return;
		if (agents.get(sessionId)?.deref() === agent) return;
		agents.set(sessionId, new WeakRef(agent));
		agent.ctx.effect(
			() => () => {
				if (agents.get(sessionId)?.deref() === agent) agents.delete(sessionId);
				clearSession(sessionId);
				for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount);
				mounts.delete(agent);
			},
			`ocean-crew: capabilities ${sessionId}`,
		);
	};
	const trackBotAgents = async (bot: BotLike): Promise<void> => {
		const sessionIds = new Set<string>();
		try {
			const sessionId = rt.chatOf(bot.id);
			if (typeof sessionId === "string") sessionIds.add(sessionId);
		} catch (error) {
			rt.warn("ocean-crew: capability chat session for %s could not be read: %s", bot.id, error);
		}
		try {
			for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
				if (typeof sessionId === "string") sessionIds.add(sessionId);
			}
		} catch (error) {
			rt.warn("ocean-crew: capability group sessions for %s could not be read: %s", bot.id, error);
		}
		for (const sessionId of sessionIds) {
			try {
				trackAgent((await rt.resolveAgent(sessionId)) as AgentLike);
			} catch (error) {
				rt.warn("ocean-crew: capability Agent for %s could not be resolved: %s", sessionId, error);
			}
		}
	};

	async function capabilityEndpoint(endpoint: string, body: Record<string, any> = {}): Promise<unknown> {
		if (endpoint === "capability-save") return capabilitySave(body, { ui: true });
		if (endpoint === "capability-delete") return capabilityDelete(body.name, { ui: true });
		if (endpoint === "capability-approve") {
			await rt.load();
			writeCheck();
			const item = own(library(), String(body.name ?? ""));
			if (!item || item.kind !== "mcp" || item.transport !== "stdio")
				throw new Error(`No unapproved stdio MCP named ${body.name}.`);
			item.approved = true;
			item.updatedAt = Date.now();
			await rt.save();
			return item;
		}
		if (endpoint === "bot-capability") {
			await rt.load();
			writeCheck();
			const bot = rt.botOf(String(body.botId ?? ""));
			if (!bot) throw new Error("Unknown Bot");
			const name = String(body.name ?? "");
			if (!own(library(), name)) throw new Error(`No capability named ${name}.`);
			return setAttached(bot, name, body.attached === true);
		}
		throw new Error("Unknown capability operation.");
	}
	const secretsChanged = rt.secretsChanged as (() => void) | undefined;
	rt.secretsChanged = () => {
		secretsChanged?.();
		if (loadingSecrets === 0) void scheduleReconcile();
	};
	rt.capabilitiesStateSaved = () => {
		void scheduleReconcile();
	};
	// Creation waits for these listeners, so a new Agent's first request already has its
	// tools and skill catalog. agent/pre-step is too late: a step assembles its tools first.
	ctx.on("agent/created", async function prepareCapabilities({ agent }: { agent: AgentLike }) {
		trackAgent(agent);
		try {
			await rt.load();
			const bot = botOfSession(agent.session.id);
			if ((bot?.capabilities ?? []).length > 0) await prepare(agent, agent.session.id);
		} catch (error) {
			rt.warn("ocean-crew: capability load failed: %s", error);
		}
	});
	ctx.effect(() => {
		void rt
			.load()
			.then(async () => {
				for (const bot of Object.values(state.bots)) {
					if ((bot.capabilities ?? []).length > 0) await trackBotAgents(bot as BotLike);
				}
				await scheduleReconcile();
			})
			.catch((error) => rt.warn("ocean-crew: capability startup failed: %s", error));
		return async () => {
			stopped = true;
			const live = [...mounts.values()];
			mounts.clear();
			agents.clear();
			sessionStatuses.clear();
			await Promise.all(live.flatMap((agentMounts) => [...agentMounts.values()].map(disposeMount)));
		};
	}, "ocean-crew: capabilities");

	// The capability tools are model-visible contract: names, parameters and the texts

	// module's late-tool path (or directly when it is not installed, as in unit tests).
	const addTool = (definition: TeamTool): void => {
		if (typeof rt.addTeamTool === "function") rt.addTeamTool(definition);
		else rt.teamTools.push(definition);
	};
	const callerOf = (exec: Record<string, any>): string | undefined => rt.selfOf(exec.agent?.id);
	addTool(
		tool({
			name: "list_capabilities",
			description: "List shared MCP servers, skills, and packs, plus the capabilities attached to you.",
			parameters: {},
			execute: async (_args, exec) => {
				await rt.load();
				const self = callerOf(exec);
				const bot = rt.botOf(self);
				if (!bot) return "Only Bots on the team can use list_capabilities.";
				const items = Object.values(library());
				if (items.length === 0) return "No shared capabilities are saved yet.";
				const statuses = capabilityStatusesView()[bot.id] ?? {};
				const lines = items.map((item) => {
					const extra =
						item.kind === "pack"
							? `; includes ${(item.items ?? []).join(", ") || "nothing"}`
							: item.kind === "mcp" && item.transport === "stdio"
								? `; ${item.approved ? "allowed" : "needs user approval"}`
								: "";
					const itemStatus = statuses[item.name];
					const status = itemStatus
						? ` (${itemStatus.state}${itemStatus.error ? `: ${itemStatus.error}` : ""})`
						: "";
					const attached = bot.capabilities?.includes(item.name) ? `; attached to you${status}` : "";
					return `- ${item.name} (${item.kind})${item.description ? ` — ${item.description}` : ""}${extra}${attached}`;
				});
				return ["Shared capabilities:", ...lines].join("\n");
			},
		}),
	);
	addTool(
		tool({
			name: "save_capability",
			description: "Create or update a shared MCP server, skill, or pack. Changes apply from your next message.",
			parameters: {
				name: {
					type: "string",
					required: true,
					description: 'Lowercase letters, digits, and single hyphens, up to 32 characters; "github" is reserved',
				},
				kind: { type: "string", required: true, enum: ["mcp", "skill", "pack"] },
				description: { type: "string", description: "What this capability provides" },
				transport: {
					type: "string",
					enum: ["stdio", "streamable-http"],
					description: "How to reach an MCP server: a local command or an HTTP URL",
				},
				command: { type: "string", description: "Program that starts a local MCP server" },
				args: { type: "array", items: { type: "string" }, description: "Arguments for command" },
				env: {
					type: "object",
					additionalProperties: true,
					description:
						"Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value",
				},
				url: {
					type: "string",
					description:
						"MCP server URL; write $DSH_SECRET_<NAME> in the path or query to insert a saved secret, URL-encoded. Prefer headers for keys",
				},
				headers: {
					type: "object",
					additionalProperties: true,
					description: "HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value",
				},
				content: { type: "string", description: "Skill instructions" },
				items: {
					type: "array",
					items: { type: "string" },
					description: "MCP server and skill names in the pack",
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				const self = callerOf(exec);
				if (!rt.botOf(self)) return "Only Bots on the team can use save_capability.";
				try {
					const item = await capabilitySave(args, { botId: self });
					const approval =
						item.kind === "mcp" && item.transport === "stdio" && !item.approved
							? " The user must allow this MCP server in Ocean Crew settings before it can work."
							: "";
					return `Saved ${item.name}. Bots with it attached use the change from their next message.${approval}`;
				} catch (error) {
					return (error as Error).message;
				}
			},
		}),
	);
	addTool(
		tool({
			name: "delete_capability",
			description: "Remove a shared capability and detach it from every Bot and pack.",
			parameters: { name: { type: "string", required: true } },
			execute: async (args, exec) => {
				await rt.load();
				const self = callerOf(exec);
				if (!rt.botOf(self)) return "Only Bots on the team can use delete_capability.";
				try {
					await capabilityDelete(args.name, { botId: self });
					return `Deleted ${args.name}; it was removed from every Bot and pack. The change applies from their next message.`;
				} catch (error) {
					return (error as Error).message;
				}
			},
		}),
	);
	for (const [name, endpoint, verb] of [
		["attach_capability", "attach", "Attached"],
		["detach_capability", "detach", "Detached"],
	] as const) {
		addTool(
			tool({
				name,
				description: `${verb} a shared capability to yourself, or to another Bot if you are a Main Bot.`,
				parameters: {
					name: { type: "string", required: true, description: "Capability name from list_capabilities" },
					bot: { type: "string", description: "Optional Bot name; only a Main Bot may change another Bot" },
				},
				execute: async (args, exec) => {
					await rt.load();
					const self = callerOf(exec);
					if (!rt.botOf(self)) return `Only Bots on the team can use ${name}.`;
					try {
						const result = await changeAttachment(endpoint, args, self);
						const attached = own(library(), args.name);
						const members =
							attached?.kind === "pack"
								? (attached.items ?? [])
										.map((child) => own(library(), child))
										.filter((item): item is CapabilityItem => Boolean(item))
								: attached
									? [attached]
									: [];
						const approvals = members
							.filter((item) => item.kind === "mcp" && item.transport === "stdio" && item.approved !== true)
							.map((item) => ` The user must allow ${item.name} in Ocean Crew settings before it can work.`)
							.join("");
						return `${verb} ${args.name} ${args.bot ? `to ${result.bot}` : "to yourself"}. Changes apply from ${result.bot}'s next message.${endpoint === "attach" ? approvals : ""}`;
					} catch (error) {
						return (error as Error).message;
					}
				},
			}),
		);
	}

	Object.assign(rt, {
		capabilitySave,
		capabilityDelete,
		dropOrphanCapabilities,
		capabilityEndpoint,
		capabilityLibraryView: libraryView,
		capabilityStatusesView,
		reconcileCapabilities: reconcile,
		scheduleCapabilitiesReconcile: scheduleReconcile,
		ensureCapabilities,
		expandCapabilities: (names: readonly string[]) => expandCapabilityNames(names, library()),
		changeCapabilityAttachment: changeAttachment,
	});
}
