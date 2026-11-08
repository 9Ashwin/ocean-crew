// Connectors: outside services every Bot can use. One engine mounts each connected
// service's MCP server on the plugin context through the local gateway (gateway.ts), so
// every Bot gets mcp__<id>__* tools while credentials stay Ocean Crew secrets that never
// reach the mcp-client config. OAuth sign-in is in oauth.ts, the service list in
// catalog.ts, mail in mail/.
//
// Three host pieces it calls are owned by

// time and degrade to a clear refusal when absent (never a second implementation):
// `loadSecrets`/`secretValue`/`secretEndpoint` (secrets), `redactSecrets` (diagnostics),
// and `deliver` (delivery). `rt.connectorIds` publishes the ids reserved from the
// capability namespace until capabilities.ts can read them.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { defineTool as defineDshTool } from "@deepseek-ai/dsh-tools";
import type { Runtime, TeamTool } from "../core/runtime.ts";
import { CONNECTOR_IDS } from "../work/capabilities.ts";
import {
	CATALOG,
	type ConnectorEntry,
	type CustomConnector,
	clientSecretOf,
	customId,
	entryOf,
	envSecretOf,
	keySecretOf,
	refreshSecretOf,
	tokenSecretOf,
} from "./catalog.ts";
import { type ConnectorGateway, createGateway, type GatewayUpstream } from "./gateway.ts";
import { install as installMail, type MailApi } from "./mail/index.ts";
import * as oauth from "./oauth.ts";

export const GITHUB = "github";
export const GITHUB_SECRET = "GITHUB_TOKEN";
const MCP_CLIENT = "@deepseek-ai/dsh-mcp-client";
const CHECK_TIMEOUT_MS = 15_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const SECRET_REF = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g;
const MAX_REQUESTS = 20;

type FetchFn = oauth.FetchFn;
type ToolExec = { agent?: { id?: string }; callId?: string; concludeTurn?: () => void };

/** The connector state kept in state.connectors.<id>. */
export interface StoredConnector {
	custom?: CustomConnector;
	account?: string;
	login?: string;
	connectedAt?: number;
	tokenExpiresAt?: number;
	readOnly?: boolean;
	offFor?: string[];
	client?: oauth.StoredClient;
	oauth?: { authorizationServerUrl: string; resource?: string; scope?: string };
}

/** One row of the connector view the window and the tools read. */
export interface ConnectorRow {
	id: string;
	name: string;
	category: string;
	about: string;
	auth: ConnectorEntry["auth"];
	state: string;
	error?: string;
	account: string | null;
	readOnly?: boolean;
	offFor: string[];
	tools: number;
	custom?: boolean;
	pending?: Record<string, unknown>;
}

export interface ConnectorsView {
	connectors: ConnectorRow[];
	mail: MailViewLike;
}

interface MailViewLike {
	accounts: unknown[];
	google: boolean;
	allowedRecipients?: string[];
	noDraftFor?: string[];
	pending?: Array<{ kind: string; url?: string; address?: string }>;
}

interface ConnectorStatus {
	state: string;
	error?: string;
}

interface PendingSignIn {
	discovery?: oauth.Discovery;
	kind?: "browser" | "device";
	listener?: Server;
	redirectUri?: string;
	codeVerifier?: string;
	expectedState?: string;
	clientInformation?: oauth.ClientInformation;
	row: Record<string, unknown>;
	timer?: ReturnType<typeof setTimeout>;
	device?: oauth.DeviceStart;
	interval?: number;
}

interface Mount {
	fp: string;
	fiber?: { await(): Promise<unknown>; dispose(): unknown };
}

interface ConnectorRequest {
	id: string;
	callId?: string;
	sessionId?: string;
	connectorId: string;
	name: string;
	purpose: string;
	status: string;
	askedAt: number;
	settledAt?: number;
}

interface GithubConfig {
	api?: string;
	url?: string;
	endpoints?: oauth.DeviceEndpoints;
}

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
	execute: (args: Record<string, any>, exec: ToolExec) => unknown | Promise<unknown>;
}

// The same bridge tools.ts uses for runtime.ts's loose TeamTool: one cast in one place.
const defineTeamTool = (options: ToolOptions): TeamTool =>
	defineDshTool({ ...options, output } as never) as unknown as TeamTool;

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

// Asks GitHub who the token belongs to. Any token GitHub accepts passes.
export async function signIn(
	token: string,
	{ api = "https://api.github.com", fetch: request = fetch }: { api?: string; fetch?: FetchFn } = {},
): Promise<{ login: string }> {
	let response: Response;
	try {
		response = await request(`${api.replace(/\/$/, "")}/user`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "ocean-crew",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
	} catch {
		throw new Error("Could not reach GitHub");
	}
	if (response.status === 401) throw new Error("GitHub did not accept this token");
	if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
	const user = (await response.json().catch(() => ({}))) as { login?: unknown };
	if (typeof user?.login !== "string") throw new Error("GitHub did not say who this token belongs to");
	return { login: user.login };
}

export function install(rt: Runtime): void {
	const { ctx, state } = rt;
	const savedConnectors = (): Record<string, StoredConnector> =>
		(state.connectors ?? {}) as Record<string, StoredConnector>;
	for (const entry of CATALOG) CONNECTOR_IDS.add(entry.id);
	const githubConfig = (): { enabled: boolean; options: (GithubConfig & { api: string }) | null } => {
		const value = (rt.config as unknown as { github?: boolean | GithubConfig }).github;
		return {
			enabled: value !== false,
			options:
				value === false ? null : { api: "https://api.github.com", ...(typeof value === "object" ? value : {}) },
		};
	};
	const options = githubConfig().options;
	const insecure = (url: unknown): boolean => !/^https:\/\//i.test(String(url));
	let stopped = false;
	let queue: Promise<void> = Promise.resolve();
	const mounts = new Map<string, Mount>();
	const statuses = new Map<string, ConnectorStatus>();
	const pendings = new Map<string, PendingSignIn>();
	const refreshes = new Map<string, Promise<boolean>>();
	const gateways: { gw: ConnectorGateway | null } = { gw: null };
	const pluginP: { p: Promise<unknown> | null } = { p: null };

	// Optional members owned by modules that land in parallel; a connector that needs one
	// says so plainly instead of pretending.
	const fn = (name: string): ((...args: any[]) => any) | undefined => {
		const value = (rt as unknown as Record<string, any>)[name];
		return typeof value === "function" ? value : undefined;
	};
	const loadSecrets = async (): Promise<void> => {
		await fn("loadSecrets")?.();
	};
	const secretValue = (name: string): string | undefined => {
		const value = fn("secretValue")?.(name);
		return typeof value === "string" ? value : undefined;
	};
	const secretEndpointMissing = (): Error =>
		new Error("Connector credentials need the Secrets module, which is not available in this build");
	const writeSecret = async (name: string, value: string, purpose: string): Promise<void> => {
		const endpoint = fn("secretEndpoint");
		if (endpoint === undefined) throw secretEndpointMissing();
		const kept = await (async () => {
			await loadSecrets();
			return secretValue(name) !== undefined;
		})();
		await endpoint("secret-set", { name, value, purpose, ...(kept ? {} : { scope: [] }) });
	};
	const deleteSecret = async (name: string): Promise<void> => {
		const endpoint = fn("secretEndpoint");
		if (endpoint === undefined) return;
		if (secretValue(name) !== undefined) await endpoint("secret-delete", { name }).catch(() => undefined);
	};
	const redact = (text: string): string => {
		const redactSecrets = fn("redactSecrets");
		if (redactSecrets !== undefined) return String(redactSecrets(text));
		// No diagnostics module yet: keep the obvious credential shapes out of errors.
		return text
			.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
			.replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, "[redacted]");
	};
	const reason = (error: unknown): string => {
		const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
		const text = redact(
			[error, cause]
				.filter(Boolean)
				.map((part) => errorMessage(part))
				.join(": ") || "error",
		);
		return text.slice(0, 300);
	};

	const entries = (): ConnectorEntry[] => {
		const list: ConnectorEntry[] = [...CATALOG.filter((entry) => entry.id !== "github" || options !== null)];
		for (const [id, saved] of Object.entries(savedConnectors())) {
			if (saved?.custom)
				list.push({
					id,
					name: saved.custom.name,
					category: "custom",
					about: saved.custom.url ?? saved.custom.command ?? "",
					auth: { kind: "custom" },
					custom: saved.custom,
				});
		}
		return list;
	};
	const entryFor = (id: string): ConnectorEntry | undefined => {
		const catalog = entryOf(id);
		// rt.config.github keeps its url/api overrides from the old single connector.
		if (catalog !== undefined && id === "github" && options?.url !== undefined) {
			return { ...catalog, remote: { url: options.url } };
		}
		if (catalog !== undefined) return catalog;
		const custom = savedConnectors()[id]?.custom;
		if (custom !== undefined)
			return {
				id,
				name: custom.name,
				category: "custom",
				about: custom.url ?? custom.command ?? "",
				auth: { kind: "custom" },
				custom,
			};
		return undefined;
	};
	const known = (id: unknown): ConnectorEntry => {
		const entry = entryFor(String(id ?? ""));
		if (entry === undefined || (entry.id === "github" && options === null)) throw new Error("No such connector");
		return entry;
	};
	const catalogClientId = (id: string): string | undefined => {
		const auth = entryFor(id)?.auth;
		return auth?.kind === "oauth" ? auth.client?.id : undefined;
	};

	// --- credentials ------------------------------------------------------

	const credentialOf = (id: string): Record<string, string> | undefined => {
		const entry = entryFor(id);
		if (entry === undefined) return undefined;
		if (entry.auth.kind === "none" || entry.auth.kind === "custom") return {};
		if (entry.auth.kind === "oauth") {
			const token = secretValue(tokenSecretOf(id));
			return token === undefined ? undefined : { Authorization: `Bearer ${token}` };
		}
		if (entry.auth.kind === "key") {
			const key = secretValue(keySecretOf(id));
			return key === undefined ? undefined : { key };
		}
		return {};
	};
	const hasCredential = (id: string): boolean => {
		const entry = entryFor(id);
		if (entry === undefined) return false;
		if (entry.custom !== undefined) return true;
		if (entry.auth.kind === "none") return savedConnectors()[id] !== undefined;
		return credentialOf(id) !== undefined;
	};

	// What the gateway sends upstream for a connector.
	const upstreamOf = (id: string): GatewayUpstream | undefined => {
		const entry = entryFor(id);
		if (entry === undefined || !hasCredential(id)) return undefined;
		let url = entry.custom?.url ?? entry.remote?.url;
		if (url === undefined) return undefined;
		const headers: Record<string, string> = { ...(entry.headers ?? {}) };
		const cred = credentialOf(id);
		if (entry.auth.kind === "oauth" && cred !== undefined) Object.assign(headers, cred);
		if (entry.auth.kind === "key" && cred !== undefined && typeof cred.key === "string") {
			if (entry.auth.header) headers[entry.auth.header] = `${entry.auth.prefix ?? ""}${cred.key}`;
			else if (entry.auth.query) {
				const parsed = new URL(url);
				parsed.searchParams.set(entry.auth.query, cred.key);
				url = String(parsed);
			}
		}
		if (entry.custom !== undefined) {
			for (const [name, raw] of Object.entries(entry.custom.headers ?? {})) {
				headers[name] = String(raw).replace(
					SECRET_REF,
					(_match, secretName: string) => secretValue(secretName) ?? "",
				);
			}
		}
		return { url, headers };
	};

	const gateway = async (): Promise<ConnectorGateway> => {
		gateways.gw ??= createGateway({
			credential: upstreamOf,
			readOnly: (id) => savedConnectors()[id]?.readOnly === true,
			onUnauthorized: (id) => refreshConnector(id),
			log: (...args) => rt.warn(...(args as [string, ...unknown[]])),
		});
		await gateways.gw.listen();
		return gateways.gw;
	};

	const loadMcpPlugin = async (): Promise<unknown> => {
		pluginP.p ??= (async () => {
			const loader = ctx.get?.("loader") as
				| { import?: (name: string) => Promise<unknown>; unwrapExports?: (mod: any) => unknown }
				| undefined;
			if (typeof loader?.import !== "function") throw new Error("This DSH cannot load connectors");
			const mod = await loader.import(MCP_CLIENT);
			return loader.unwrapExports?.(mod) ?? (mod as { default?: unknown })?.default ?? mod;
		})();
		return pluginP.p;
	};

	const resolveRefs = (value: string): string =>
		String(value).replace(SECRET_REF, (_match, name: string) => secretValue(name) ?? "");

	async function configFor(id: string): Promise<Record<string, unknown>> {
		const entry = entryFor(id);
		if (entry?.custom !== undefined && entry.custom.command !== undefined) {
			const env: Record<string, string> = {};
			for (const [key, raw] of Object.entries(entry.custom.env ?? {})) env[key] = resolveRefs(raw);
			return {
				transport: "stdio",
				serverName: id,
				command: entry.custom.command,
				args: entry.custom.args ?? [],
				env,
			};
		}
		const gw = await gateway();
		return { transport: "streamable-http", serverName: id, url: gw.urlFor(id), headers: gw.headers() };
	}

	// A mount fingerprint covers the config a change must re-mount for; access and refresh
	// tokens live in the gateway, so changing one never re-mounts.
	const fingerprint = async (id: string): Promise<string> => JSON.stringify(await configFor(id));

	const unmount = async (id: string): Promise<void> => {
		const mount = mounts.get(id);
		mounts.delete(id);
		if (mount?.fiber !== undefined)
			await Promise.resolve()
				.then(() => mount.fiber?.dispose())
				.catch(() => undefined);
	};

	async function mountOne(id: string): Promise<void> {
		const fp = await fingerprint(id);
		if (mounts.get(id)?.fp === fp) return;
		await unmount(id);
		statuses.set(id, { state: "connecting" });
		try {
			const plugin = await loadMcpPlugin();
			if (stopped) return;
			const config = { ...(await configFor(id)), failOnStartupError: true };
			const fiber = ctx.plugin(plugin, config) as Mount["fiber"];
			if (fiber === undefined) throw new Error("This DSH did not mount the connector");
			const mount: Mount = { fp, fiber };
			mounts.set(id, mount);
			await fiber.await();
			if (stopped || mounts.get(id) !== mount) return;
			statuses.delete(id);
			await settleRequests(id);
		} catch (error) {
			await unmount(id);
			mounts.set(id, { fp });
			statuses.set(id, { state: "error", error: reason(error) });
			rt.warn("ocean-crew: connector %s failed: %s", id, statuses.get(id)?.error);
		}
	}

	async function reconcile(): Promise<void> {
		for (const id of [...mounts.keys()]) {
			if (!hasCredential(id)) await unmount(id);
		}
		for (const entry of entries()) {
			if (entry.id === "mail" || !hasCredential(entry.id)) continue;
			await mountOne(entry.id);
		}
	}
	const sync = (force = false): Promise<void> => {
		queue = queue
			.then(async () => {
				if (force) for (const id of [...mounts.keys()]) await unmount(id);
				await reconcile();
			})
			.catch((error: unknown) => rt.warn("ocean-crew: connectors: %s", reason(error)));
		return queue;
	};

	// --- secrets ----------------------------------------------------------

	const dropSecrets = async (id: string): Promise<void> => {
		await loadSecrets();
		for (const name of [tokenSecretOf(id), refreshSecretOf(id), clientSecretOf(id), keySecretOf(id)]) {
			if (id !== "github" || name === GITHUB_SECRET || name !== tokenSecretOf(id)) await deleteSecret(name);
		}
	};
	const saveState = async (id: string, patch: StoredConnector): Promise<void> => {
		state.connectors = {
			...(state.connectors ?? {}),
			[id]: { ...savedConnectors()[id], ...patch },
		};
		await rt.save();
	};

	// --- OAuth sign-in ----------------------------------------------------

	const finishTokens = async (id: string, entry: ConnectorEntry, tokens: oauth.TokenSet): Promise<void> => {
		await writeSecret(tokenSecretOf(id), tokens.access_token, `${entry.name} connector`);
		if (typeof tokens.refresh_token === "string" && tokens.refresh_token !== "") {
			await writeSecret(refreshSecretOf(id), tokens.refresh_token, `${entry.name} connector`).catch(() => undefined);
		}
		const account = await readAccount(id, entry, tokens.access_token).catch(() => undefined);
		await saveState(id, {
			account,
			connectedAt: Date.now(),
			tokenExpiresAt:
				typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
					? Date.now() + tokens.expires_in * 1000
					: undefined,
		});
	};

	async function readAccount(id: string, entry: ConnectorEntry, token: string): Promise<string | undefined> {
		if (entry.whoami === undefined) return undefined;
		if (id === "github") return (await signIn(token, { api: options?.api })).login;
		const response = await fetch(entry.whoami.url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const wanted = body?.[entry.whoami.field];
		return typeof wanted === "string" ? wanted : undefined;
	}

	async function endPending(id: string, status?: ConnectorStatus): Promise<void> {
		const pending = pendings.get(id);
		pending !== undefined ? pendings.delete(id) : undefined;
		if (pending?.timer !== undefined) clearTimeout(pending.timer);
		if (pending?.listener !== undefined)
			await new Promise<void>((resolve) => pending.listener?.close(() => resolve())).catch(() => undefined);
		if (status !== undefined) statuses.set(id, status);
		else statuses.delete(id);
	}

	// The loopback server for the browser flow: fixed port first, else a random one.
	async function loopback(
		ready: (result: {
			code?: string | null;
			state?: string | null;
			iss?: string | null;
			error?: string | null;
			errorDescription?: string | null;
		}) => Promise<void>,
	): Promise<{ listener: Server; fixed: boolean; redirectUri: string }> {
		const listener = createServer((req, res) => {
			req.on("error", () => res.destroy());
			res.on("error", () => req.destroy());
			let url: URL;
			try {
				url = new URL(req.url ?? "/", "http://127.0.0.1");
			} catch {
				res.writeHead(400);
				res.end();
				return;
			}
			if (url.pathname !== "/callback") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				'<!doctype html><title>Signed in</title><p style="font-family:sans-serif;margin:3em;text-align:center">Signed in — you can close this tab and go back to Ocean Crew.</p>',
			);
			void ready({
				code: url.searchParams.get("code"),
				state: url.searchParams.get("state"),
				iss: url.searchParams.get("iss"),
				error: url.searchParams.get("error"),
				errorDescription: url.searchParams.get("error_description"),
			}).catch((error: unknown) => rt.warn("ocean-crew: connector sign-in callback failed: %s", reason(error)));
		});
		listener.on("error", (error) => {
			if (listener.listening)
				rt.warn(
					"ocean-crew: connector sign-in listener failed: %s",
					(error as NodeJS.ErrnoException).code ?? "error",
				);
		});
		const listen = (port: number): Promise<void> =>
			new Promise((resolve, reject) => {
				const onError = (error: Error): void => {
					listener.off("listening", onOk);
					reject(error);
				};
				const onOk = (): void => {
					listener.off("error", onError);
					resolve();
				};
				listener.once("error", onError);
				listener.once("listening", onOk);
				listener.listen(port, "127.0.0.1");
			});
		try {
			await listen(oauth.FIXED_CALLBACK_PORT);
			return {
				listener,
				fixed: true,
				redirectUri: `http://127.0.0.1:${oauth.FIXED_CALLBACK_PORT}/callback`,
			};
		} catch {
			await listen(0);
			const port = (listener.address() as { port: number }).port;
			return { listener, fixed: false, redirectUri: `http://127.0.0.1:${port}/callback` };
		}
	}

	async function startBrowserFlow(id: string, entry: ConnectorEntry, pending: PendingSignIn): Promise<void> {
		const { listener, fixed, redirectUri } = await loopback((result) => completeBrowser(id, result));
		const saved = savedConnectors()[id];
		const persist = async (client: oauth.StoredClient): Promise<void> => {
			const { clientSecret, ...rest } = client;
			if (clientSecret !== undefined) await writeSecret(clientSecretOf(id), clientSecret, `${entry.name} connector`);
			await saveState(id, { client: rest });
		};
		const resolved = await oauth.resolveClient(
			{ auth: entry.auth.kind === "oauth" ? entry.auth : {} },
			pending.discovery as oauth.Discovery,
			redirectUri,
			fixed,
			saved?.client === undefined ? undefined : { ...saved.client, clientSecret: secretValue(clientSecretOf(id)) },
			{ persist },
		);
		if (resolved === null) {
			pendings.set(id, { ...pending, listener, redirectUri });
			statuses.set(id, { state: "needs-client" });
			return;
		}
		// Refresh needs to know which client signed in; DCR already persisted its result.
		if (resolved.via !== "dcr")
			await saveState(id, { client: { via: resolved.via, clientId: resolved.clientInformation.client_id } });
		const stateParam = randomBytes(16).toString("base64url");
		const { url, codeVerifier } = await oauth.beginBrowser(
			pending.discovery as oauth.Discovery,
			resolved.clientInformation,
			redirectUri,
			{ state: stateParam },
		);
		pendings.set(id, {
			...pending,
			kind: "browser",
			listener,
			redirectUri,
			codeVerifier,
			expectedState: stateParam,
			clientInformation: resolved.clientInformation,
			row: { kind: "browser", url },
			timer: setTimeout(() => void expire(id), SIGN_IN_TIMEOUT_MS),
		});
		statuses.set(id, { state: "connecting" });
	}

	async function expire(id: string): Promise<void> {
		await endPending(id, { state: "off", error: "Sign-in timed out" });
	}

	async function completeBrowser(
		id: string,
		result: {
			code?: string | null;
			state?: string | null;
			iss?: string | null;
			error?: string | null;
			errorDescription?: string | null;
		},
	): Promise<void> {
		const pending = pendings.get(id);
		if (pending === undefined || pending.kind !== "browser") return;
		try {
			if (result.error !== null && result.error !== undefined)
				throw new Error(result.errorDescription ?? result.error);
			if (result.state !== pending.expectedState)
				throw new Error("The sign-in answer did not match this attempt (state mismatch). Try again.");
			const entry = entryFor(id) as ConnectorEntry;
			const tokens = await oauth.exchange(
				pending.discovery as oauth.Discovery,
				pending.clientInformation as oauth.ClientInformation,
				{
					code: result.code ?? "",
					codeVerifier: pending.codeVerifier ?? "",
					redirectUri: pending.redirectUri ?? "",
					iss: result.iss ?? undefined,
				},
			);
			await endPending(id);
			await finishTokens(id, entry, tokens);
			await sync(true);
		} catch (error) {
			await endPending(id, { state: "error", error: reason(error) });
		}
	}

	async function startDeviceFlow(id: string, entry: ConnectorEntry, pending: PendingSignIn): Promise<void> {
		const clientId = entry.auth.kind === "oauth" ? (entry.auth.client?.id ?? "") : "";
		const scopes = entry.auth.kind === "oauth" ? (entry.auth.scopes ?? []) : [];
		const device = await oauth.deviceBegin(clientId, scopes.join(" "), { endpoints: options?.endpoints });
		const poll = async (): Promise<void> => {
			const current = pendings.get(id);
			if (current === undefined || current.kind !== "device" || stopped) return;
			const started = current.device as oauth.DeviceStart;
			if (Date.now() >= started.expiresAt) {
				await expire(id);
				return;
			}
			try {
				const step = await oauth.devicePoll(clientId, started, { endpoints: options?.endpoints });
				if (step.state === "done") {
					await endPending(id);
					await writeSecret(GITHUB_SECRET, step.token, "GitHub connector");
					const account = await readAccount(id, entry, step.token).catch(() => undefined);
					await saveState(id, { account, connectedAt: Date.now() });
					await sync(true);
					return;
				}
				if (step.state === "error") {
					await endPending(id, { state: "error", error: reason(step.error) });
					return;
				}
				if (step.state === "slow_down") current.interval = (current.interval ?? 5) + 5;
			} catch (error) {
				await endPending(id, { state: "error", error: reason(error) });
				return;
			}
			current.timer = setTimeout(() => void poll(), (current.interval ?? 5) * 1000);
		};
		pendings.set(id, {
			...pending,
			kind: "device",
			device,
			interval: device.interval,
			row: {
				kind: "device",
				userCode: device.userCode,
				verificationUri: device.verificationUri,
				expiresAt: device.expiresAt,
			},
			timer: setTimeout(() => void poll(), device.interval * 1000),
		});
	}

	async function beginSignIn(id: unknown): Promise<void> {
		const entry = known(id);
		if (entry.auth.kind !== "oauth") throw new Error("This connector does not sign in");
		const readOnly = rt.readOnly();
		if (readOnly !== undefined) throw new Error(readOnly);
		await loadSecrets();
		if (pendings.has(entry.id)) await endPending(entry.id);
		statuses.set(entry.id, { state: "connecting" });
		try {
			// GitHub's own flow: device code through github.com, no discovery.
			if (entry.auth.kind === "oauth" && entry.auth.client?.deviceFlow === true) {
				await startDeviceFlow(entry.id, entry, { row: {} });
				return;
			}
			const remote = entry.remote?.url;
			if (remote === undefined) throw new Error("This connector has no server address");
			if (insecure(remote)) throw new Error("Connector addresses must start with https://");
			const discovery = await oauth.discover(remote);
			if (discovery.metadata === undefined) throw new Error("This service does not publish OAuth sign-in metadata");
			state.connectors = {
				...(state.connectors ?? {}),
				[entry.id]: {
					...savedConnectors()[entry.id],
					oauth: {
						authorizationServerUrl: discovery.authorizationServerUrl,
						resource: discovery.resource,
						scope: discovery.scope,
					},
				},
			};
			await rt.save();
			await startBrowserFlow(entry.id, entry, { discovery, row: {} });
		} catch (error) {
			await endPending(entry.id);
			statuses.set(entry.id, { state: "error", error: reason(error) });
		}
	}

	// One refresh per connector at a time; read-only windows never write.
	function refreshConnector(id: string): Promise<boolean> {
		const existing = refreshes.get(id);
		if (existing !== undefined) return existing;
		const job = (async (): Promise<boolean> => {
			const saved = savedConnectors()[id];
			const readOnly = rt.readOnly();
			if (readOnly !== undefined) {
				await loadSecrets();
				return false;
			}
			const refresh = secretValue(refreshSecretOf(id));
			let path = saved?.client?.via ?? "inferred";
			if (refresh === undefined || saved?.oauth === undefined) {
				statuses.set(id, { state: "needs-sign-in" });
				rt.warn(
					"ocean-crew: connector %s token refresh failed (client: %s; missing refresh token or OAuth metadata)",
					id,
					path,
				);
				return false;
			}
			try {
				const discovery = await oauth.rediscover(saved.oauth);
				// Refresh with the client that signed in: catalog → the current catalog id,
				// CIMD → the published document id, DCR/manual → the stored id (+ secret).
				// Rows signed in before clients were persisted have no `client`: fall back to
				// CIMD when the AS supports it, otherwise ask the user to sign in again.
				const via = saved.client?.via;
				const clientId =
					via === "catalog"
						? catalogClientId(id)
						: via === "cimd"
							? oauth.CIMD_CLIENT_ID
							: (saved.client?.clientId ??
								(discovery.metadata?.client_id_metadata_document_supported === true
									? oauth.CIMD_CLIENT_ID
									: undefined));
				const clientVia = via ?? (saved.client?.clientId ? "manual" : "cimd");
				if (via === undefined && clientId !== undefined) path = `inferred/${clientVia}`;
				if (clientId === undefined) {
					statuses.set(id, { state: "needs-sign-in" });
					rt.warn("ocean-crew: connector %s token refresh failed (client: %s; no OAuth client)", id, path);
					return false;
				}
				const secret = secretValue(clientSecretOf(id));
				const client: oauth.ClientInformation = {
					client_id: clientId,
					...(secret !== undefined ? { client_secret: secret } : {}),
				};
				const tokens = await oauth.refreshTokens(discovery, client, refresh, { scope: saved.oauth.scope });
				const purpose = `${entryFor(id)?.name ?? id} connector`;
				await writeSecret(tokenSecretOf(id), tokens.access_token, purpose);
				if (
					typeof tokens.refresh_token === "string" &&
					tokens.refresh_token !== "" &&
					tokens.refresh_token !== refresh
				) {
					// Rotation: the old refresh token stays if this write fails.
					await writeSecret(refreshSecretOf(id), tokens.refresh_token, purpose).catch(() => undefined);
				}
				await saveState(id, {
					client: { ...saved.client, via: clientVia, clientId },
					tokenExpiresAt:
						typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
							? Date.now() + tokens.expires_in * 1000
							: undefined,
				});
				statuses.delete(id);
				rt.warn("ocean-crew: connector %s token refresh succeeded (client: %s)", id, path);
				return true;
			} catch (error) {
				if (oauth.invalidGrant(error)) statuses.set(id, { state: "needs-sign-in", error: "Sign in again" });
				else statuses.set(id, { state: "error", error: reason(error) });
				rt.warn(
					"ocean-crew: connector %s token refresh failed (client: %s; %s)",
					id,
					path,
					oauth.invalidGrant(error) ? "invalid_grant" : "refresh error",
				);
				return false;
			}
		})().finally(() => refreshes.delete(id));
		refreshes.set(id, job);
		return job;
	}

	// --- request cards (request_connector) ---------------------------------

	const connectorRequests = (): Record<string, ConnectorRequest[]> => {
		const existing = state.connectorRequests as Record<string, ConnectorRequest[]> | undefined;
		if (existing !== undefined) return existing;
		const created: Record<string, ConnectorRequest[]> = {};
		state.connectorRequests = created;
		return created;
	};
	const requestsOf = (botId: string): ConnectorRequest[] => {
		const requests = connectorRequests();
		if (!Object.hasOwn(requests, botId) && rt.botOf(botId) === undefined) return [];
		let list = requests[botId];
		if (list === undefined) {
			list = [];
			requests[botId] = list;
		}
		return list;
	};
	const settleRequests = async (id: string): Promise<void> => {
		const notes: Array<[string, string]> = [];
		for (const [botId, list] of Object.entries(connectorRequests())) {
			for (const request of list) {
				if (request.status !== "pending" || request.connectorId !== id) continue;
				request.status = "connected";
				request.settledAt = Date.now();
				const entry = entryFor(id);
				notes.push([
					botId,
					`The user connected ${entry?.name ?? id}. Its tools are available as mcp__${id}__* now. Carry on with what you needed it for.`,
				]);
			}
		}
		if (notes.length === 0) return;
		await rt.save();
		const deliver = fn("deliver");
		if (deliver === undefined) return;
		for (const [botId, text] of notes) {
			await deliver({ toId: botId, role: "connector", text }).catch((error: unknown) =>
				rt.warn("ocean-crew: connector note to %s failed: %s", botId, error),
			);
		}
	};

	const offFor = (id: string): string[] => savedConnectors()[id]?.offFor ?? [];
	const mailHasAccounts = (): boolean => mailApi.hasAccounts();

	rt.teamTools.push(
		defineTeamTool({
			name: "list_connectors",
			description:
				"List the connectors the team can use: name, what it offers, whether it is connected, and whether you may use it. Connect one for yourself with request_connector.",
			parameters: {},
			async execute(_args: Record<string, any>, exec: ToolExec) {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				const bot = rt.botOf(self);
				if (!bot) return "Only Bots on the team can use list_connectors.";
				const rows = entries().filter((entry) => entry.id !== "mail" || mailHasAccounts());
				if (rows.length === 0) return "No connectors are set up.";
				const lines = rows.map((entry) => {
					const connected =
						entry.id === "mail"
							? mailHasAccounts()
							: (statuses.get(entry.id)?.state === undefined && mounts.has(entry.id)) || hasCredential(entry.id);
					const usable = !offFor(entry.id).includes(bot.id);
					return `- ${entry.name} (${entry.id}) — ${entry.about} — ${connected ? "connected" : "not connected"}${usable ? "" : "; turned off for you"}`;
				});
				return ["Connectors:", ...lines].join("\n");
			},
		}),
	);

	rt.teamTools.push(
		defineTeamTool({
			name: "request_connector",
			description:
				"Ask the user to connect an outside service through a card in your own chat, when you need a service that is not connected. The card shows a Connect button; your turn ends and a note arrives when the user connects or dismisses it. If the connector is already connected, this just tells you its tool prefix.",
			parameters: {
				id: { type: "string", required: true, description: "Connector id from list_connectors" },
				purpose: {
					type: "string",
					required: true,
					description: "One short line for the user: what you need it for",
				},
			},
			async execute(args: Record<string, any>, exec: ToolExec) {
				await rt.load();
				const id = String(args.id ?? "").trim();
				const entry = id === "mail" ? entryOf("mail") : entryFor(id);
				if (entry === undefined) return `No connector named ${id}.`;
				const agentId = exec.agent?.id;
				const bot = rt.botOf(rt.selfOf(agentId));
				if (bot === undefined) return "Only Bots on the team can use request_connector.";
				const connected = id === "mail" ? mailHasAccounts() : hasCredential(id);
				const signIn = statuses.get(id)?.state === "needs-sign-in";
				if (connected && !signIn && !offFor(id).includes(bot.id))
					return `${entry.name} is already connected; use its tools (mcp__${id}__*).`;
				if (offFor(id).includes(bot.id))
					return `${entry.name} is turned off for you. The user can turn it on in your details.`;
				if (agentId !== undefined && rt.groupOwners.has(agentId)) {
					return "Connector cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_connector there.";
				}
				if (agentId === undefined || !rt.chatOwners.has(agentId))
					return "Connector cards only work in your current own chat.";
				const readOnly = rt.readOnly();
				if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`;
				const list = requestsOf(bot.id);
				const now = Date.now();
				for (const request of list) {
					if (request.status === "pending" && request.connectorId === id) {
						request.status = "canceled";
						request.settledAt = now;
					}
				}
				list.push({
					id: randomUUID(),
					...(exec.callId ? { callId: exec.callId } : {}),
					sessionId: agentId,
					connectorId: id,
					name: entry.name,
					purpose: String(args.purpose ?? "")
						.trim()
						.slice(0, 300),
					status: "pending",
					askedAt: now,
				});
				while (list.length > MAX_REQUESTS) {
					const at = list.findIndex((entry) => entry.status !== "pending");
					list.splice(at === -1 ? 0 : at, 1);
				}
				await rt.save();
				exec.concludeTurn?.();
				return `The card asking the user to connect ${entry.name} is on screen. A note arrives when the user connects or dismisses it.`;
			},
		}),
	);

	// --- import -------------------------------------------------------------

	const importFiles = (): Array<{ source: string; key: string; path: string }> => {
		const home = homedir();
		const appData = platform() === "win32" ? (process.env.APPDATA ?? join(home, "AppData", "Roaming")) : null;
		return [
			{
				source: "claude",
				key: "mcpServers",
				path:
					platform() === "darwin"
						? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
						: platform() === "win32"
							? join(appData ?? "", "Claude", "claude_desktop_config.json")
							: join(home, ".config", "Claude", "claude_desktop_config.json"),
			},
			{ source: "cursor", key: "mcpServers", path: join(home, ".cursor", "mcp.json") },
			{
				source: "vscode",
				key: "servers",
				path:
					platform() === "darwin"
						? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
						: platform() === "win32"
							? join(appData ?? "", "Code", "User", "mcp.json")
							: join(home, ".config", "Code", "User", "mcp.json"),
			},
		];
	};
	interface ImportedEntry {
		source: string;
		name: string;
		url?: string;
		command?: string;
		args?: string[];
		envNames: string[];
		headersNames: string[];
	}
	const importScan = async (): Promise<ImportedEntry[]> => {
		const found: ImportedEntry[] = [];
		for (const file of importFiles()) {
			let parsed: any;
			try {
				parsed = JSON.parse(await readFile(file.path, "utf8"));
			} catch {
				continue;
			}
			const servers = parsed?.[file.key];
			if (servers === null || typeof servers !== "object" || Array.isArray(servers)) continue;
			for (const [name, spec] of Object.entries(servers as Record<string, any>)) {
				if (spec === null || typeof spec !== "object") continue;
				const url =
					typeof spec.url === "string"
						? spec.url
						: typeof spec.serverUrl === "string"
							? spec.serverUrl
							: undefined;
				const command = typeof spec.command === "string" ? spec.command : undefined;
				if (url === undefined && command === undefined) continue;
				found.push({
					source: file.source,
					name,
					...(url !== undefined
						? { url }
						: {
								command,
								args: Array.isArray(spec.args)
									? spec.args.filter((arg: unknown) => typeof arg === "string")
									: [],
							}),
					envNames: Object.keys(spec.env ?? {}),
					headersNames: Object.keys(spec.headers ?? {}),
				});
			}
		}
		return found;
	};
	const importPick = async (items: unknown): Promise<Array<{ name: string; spec: any }>> => {
		const scanned = await importScan();
		const wanted = new Set(
			(Array.isArray(items) ? items : []).map((item: any) => `${item?.source ?? ""}:${item?.name ?? ""}`),
		);
		const picked: Array<{ name: string; spec: any }> = [];
		for (const file of importFiles()) {
			let parsed: any;
			try {
				parsed = JSON.parse(await readFile(file.path, "utf8"));
			} catch {
				continue;
			}
			const servers = parsed?.[file.key] ?? {};
			for (const [name, spec] of Object.entries(servers as Record<string, any>)) {
				if (!wanted.has(`${file.source}:${name}`) || spec === null || typeof spec !== "object") continue;
				if (scanned.some((entry) => entry.source === file.source && entry.name === name))
					picked.push({ name, spec });
			}
		}
		return picked;
	};

	// --- view & endpoints ---------------------------------------------------

	const rowFor = (entry: ConnectorEntry): ConnectorRow => {
		const saved = savedConnectors()[entry.id];
		const status = statuses.get(entry.id);
		const connected = hasCredential(entry.id);
		const remote = entry.custom === undefined || entry.custom.url !== undefined;
		const viewState =
			status?.state ?? (connected && mounts.has(entry.id) ? "ready" : connected ? "connecting" : "off");
		const pending = pendings.get(entry.id);
		return {
			id: entry.id,
			name: entry.name,
			category: entry.category,
			about: entry.about,
			auth: entry.auth,
			state: viewState,
			...(status?.error !== undefined ? { error: status.error } : {}),
			account: saved?.account ?? (entry.id === "github" ? (saved?.login ?? null) : null),
			...(remote && connected && (entry.auth.kind === "oauth" || entry.auth.kind === "key")
				? { readOnly: saved?.readOnly === true }
				: {}),
			offFor: saved?.offFor ?? [],
			tools: 0,
			...(entry.custom !== undefined ? { custom: true } : {}),
			...(pending !== undefined ? { pending: pending.row } : {}),
		};
	};

	const connectorsView = (): ConnectorsView => ({
		connectors: entries()
			.filter((entry) => entry.id !== "mail")
			.map(rowFor),
		mail: mailApi.mailView(),
	});

	const endpoints: Record<string, (body: Record<string, any>) => Promise<unknown>> = {
		async "connector-connect"(body) {
			const entry = known(body.id);
			if (entry.id === "github" && options === null) throw new Error("No such connector");
			if (entry.auth.kind === "none") {
				await saveState(entry.id, { connectedAt: Date.now() });
				await sync();
				return connectorsView();
			}
			if (entry.auth.kind === "key") {
				const key = typeof body.key === "string" ? body.key.trim() : "";
				if (key === "") throw new Error("Paste a key first");
				const remote = entry.remote?.url;
				if (remote !== undefined && insecure(remote))
					throw new Error("Connector addresses must start with https://");
				await writeSecret(keySecretOf(entry.id), key, `${entry.name} connector`);
				await saveState(entry.id, { connectedAt: Date.now() });
				await sync();
				return connectorsView();
			}
			const token = typeof body.token === "string" ? body.token.trim() : "";
			if (token !== "") {
				const remote = entry.remote?.url;
				if (remote !== undefined && insecure(remote))
					throw new Error("Connector addresses must start with https://");
				if (entry.id === "github" && options?.api !== undefined && insecure(options.api))
					throw new Error("GitHub addresses must start with https://");
				await loadSecrets();
				let account: string | undefined;
				if (entry.id === "github") account = (await signIn(token, { api: options?.api })).login;
				else if (entry.whoami !== undefined) account = await readAccount(entry.id, entry, token);
				await writeSecret(tokenSecretOf(entry.id), token, `${entry.name} connector`);
				await saveState(entry.id, {
					account,
					...(entry.id === "github" ? { login: account } : {}),
					connectedAt: Date.now(),
				});
				await sync();
				return connectorsView();
			}
			if (entry.id === "github" && (entry.auth.kind === "oauth" ? (entry.auth.client?.id ?? "") : "") === "")
				throw new Error("Paste a token first");
			await beginSignIn(entry.id);
			return connectorsView();
		},
		async "connector-disconnect"(body) {
			const entry = known(body.id);
			await endPending(entry.id);
			await dropSecrets(entry.id);
			if (savedConnectors()[entry.id] !== undefined) {
				const remaining = { ...savedConnectors() };
				delete remaining[entry.id];
				state.connectors = remaining;
				await rt.save();
			}
			gateways.gw?.forget(entry.id);
			await sync();
			return connectorsView();
		},
		async "connector-retry"(body) {
			const entry = known(body.id);
			statuses.delete(entry.id);
			await loadSecrets();
			await sync(true);
			return connectorsView();
		},
		async "connector-cancel"(body) {
			const entry = known(body.id);
			await endPending(entry.id, { state: hasCredential(entry.id) ? "ready" : "off" });
			return connectorsView();
		},
		async "connector-sign-in-code"(body) {
			const entry = known(body.id);
			const pending = pendings.get(entry.id);
			if (pending === undefined || pending.kind !== "browser") throw new Error("No sign-in is waiting");
			const input = String(body.input ?? body.code ?? "").trim();
			if (input === "") throw new Error("Paste the address or the code");
			let code = input;
			let stateParam: string | null = null;
			let iss: string | undefined;
			if (/^https?:\/\//i.test(input)) {
				const url = new URL(input);
				code = url.searchParams.get("code") ?? "";
				stateParam = url.searchParams.get("state");
				iss = url.searchParams.get("iss") ?? undefined;
				if (stateParam !== pending.expectedState)
					throw new Error(
						"This address is not from this sign-in attempt (state mismatch). Copy the whole address again.",
					);
			}
			if (code === "") throw new Error("The address has no code");
			await completeBrowser(entry.id, { code, state: pending.expectedState, iss });
			return connectorsView();
		},
		async "connector-client"(body) {
			const entry = known(body.id);
			const clientId = String(body.clientId ?? "").trim();
			if (clientId === "") throw new Error("Enter the client ID");
			const clientSecret =
				typeof body.clientSecret === "string" && body.clientSecret.trim() !== ""
					? body.clientSecret.trim()
					: undefined;
			if (clientSecret !== undefined)
				await writeSecret(clientSecretOf(entry.id), clientSecret, `${entry.name} connector`);
			await saveState(entry.id, { client: { via: "manual", clientId } });
			const pending = pendings.get(entry.id);
			if (pending !== undefined && pending.discovery !== undefined) {
				await startBrowserFlow(entry.id, entry, pending);
			}
			return connectorsView();
		},
		async "connector-set"(body) {
			const entry = known(body.id);
			const patch: StoredConnector = {};
			if (body.readOnly !== undefined) patch.readOnly = body.readOnly === true;
			if (Array.isArray(body.offFor))
				patch.offFor = [...new Set(body.offFor.filter((id: unknown) => rt.botOf(String(id)) !== undefined))];
			await saveState(entry.id, patch);
			fn("reapplyToolMasks")?.();
			return connectorsView();
		},
		async "connector-add"(body) {
			const name = String(body.name ?? "").trim();
			if (name === "") throw new Error("Name the connector");
			const url = typeof body.url === "string" ? body.url.trim() : undefined;
			const command = typeof body.command === "string" ? body.command.trim() : undefined;
			if (url !== undefined && insecure(url) && !/^http:\/\/(localhost|127\.)/i.test(url))
				throw new Error("Connector addresses must start with https://");
			if (url === undefined && command === undefined) throw new Error("Enter an address or a command");
			const taken = new Set(Object.keys(savedConnectors()));
			const id = customId(name, taken);
			CONNECTOR_IDS.add(id);
			const custom: CustomConnector =
				url !== undefined
					? {
							name,
							url,
							headers:
								body.headers && typeof body.headers === "object"
									? (body.headers as Record<string, string>)
									: {},
						}
					: {
							name,
							command: command as string,
							args: Array.isArray(body.args) ? body.args.map(String) : [],
							env: body.env && typeof body.env === "object" ? (body.env as Record<string, string>) : {},
						};
			await saveState(id, { custom, connectedAt: Date.now() });
			await sync(true);
			return connectorsView();
		},
		async "connector-remove"(body) {
			const entry = known(body.id);
			if (entry.custom === undefined) throw new Error("Only added connectors can be removed");
			await endpoints["connector-disconnect"]({ id: entry.id });
			return connectorsView();
		},
		async "connector-import-scan"() {
			return importScan();
		},
		async "connector-import"(body) {
			const picked = await importPick(body.items);
			const created: string[] = [];
			for (const { name, spec } of picked) {
				const taken = new Set(Object.keys(savedConnectors()));
				const id = customId(name, taken);
				CONNECTOR_IDS.add(id);
				const custom: CustomConnector = { name };
				if (typeof spec.url === "string" || typeof spec.serverUrl === "string") {
					custom.url = spec.url ?? spec.serverUrl;
					custom.headers = {};
					for (const [header, raw] of Object.entries(spec.headers ?? {})) {
						const secretName = envSecretOf(id, `HEAD_${header}`);
						await writeSecret(secretName, String(raw), `${name} connector`);
						custom.headers[header] = `$DSH_SECRET_${secretName}`;
					}
				} else if (typeof spec.command === "string") {
					custom.command = spec.command;
					custom.args = Array.isArray(spec.args) ? spec.args.map(String) : [];
					custom.env = {};
					for (const [envName, raw] of Object.entries(spec.env ?? {})) {
						const secretName = envSecretOf(id, envName);
						await writeSecret(secretName, String(raw), `${name} connector`);
						custom.env[envName] = `$DSH_SECRET_${secretName}`;
					}
				} else continue;
				await saveState(id, { custom, connectedAt: Date.now() });
				created.push(id);
			}
			await sync(true);
			return { view: connectorsView(), created };
		},
		async "connector-request-cancel"(body) {
			const found = (() => {
				for (const [botId, list] of Object.entries(connectorRequests())) {
					const request = list.find((entry) => entry.id === String(body.requestId ?? ""));
					if (request !== undefined) return { botId, request };
				}
				return undefined;
			})();
			if (found === undefined) throw new Error("This request is gone");
			if (found.request.status !== "pending") throw new Error("This request was already answered");
			found.request.status = "canceled";
			found.request.settledAt = Date.now();
			await rt.save();
			const deliver = fn("deliver");
			if (deliver !== undefined)
				await deliver({
					toId: found.botId,
					role: "connector",
					text: `The user dismissed your request to connect ${entryFor(found.request.connectorId)?.name ?? found.request.connectorId}. Carry on without it, or tell the user what you cannot do without it.`,
				}).catch(() => undefined);
			return true;
		},
	};

	const mailApi: MailApi = installMail(rt, {
		offFor,
		secrets: { writeSecret, value: (name) => secretValue(name) },
		reason,
	});
	rt.mailView = mailApi.mailView;

	const connectorEndpoint = async (endpoint: string, body: Record<string, any>): Promise<unknown> => {
		await loadSecrets();
		if (endpoint.startsWith("mail-")) return mailApi.endpoint(endpoint, body);
		const wanted = endpoints[endpoint];
		if (wanted === undefined) throw new Error(`Unknown endpoint ${endpoint}`);
		return wanted(body ?? {});
	};

	ctx.on("tools/change", () => {
		fn("reapplyToolMasks")?.();
	});

	ctx.effect(() => {
		stopped = false;
		void rt
			.load()
			.then(() => loadSecrets())
			.then(() => sync());
		return () => {
			stopped = true;
			for (const pending of pendings.values()) if (pending.timer !== undefined) clearTimeout(pending.timer);
			for (const pending of pendings.values()) pending.listener?.close();
			pendings.clear();
			const closing = [...mounts.values()].map((mount) =>
				Promise.resolve()
					.then(() => mount.fiber?.dispose())
					.catch(() => undefined),
			);
			mounts.clear();
			const gw = gateways.gw;
			gateways.gw = null;
			return Promise.all([...closing, gw?.close(), mailApi.dispose()]);
		};
	}, "ocean-crew: connectors");

	Object.assign(rt, {
		connectorsView,
		connectorEndpoint,
		connectorOffFor: (botId: string): string[] => {
			const prefixes: string[] = [];
			for (const entry of entries()) {
				if (!offFor(entry.id).includes(botId)) continue;
				if (entry.id === "mail") prefixes.push("mail_");
				else prefixes.push(`mcp__${entry.id}__`);
			}
			return prefixes;
		},
		connectorSettleRequests: settleRequests,
		secretsChanged: (): void => {
			void sync();
		},
		connectorsInternals: { mounts, statuses, pendings, gateways, refreshConnector, upstreamOf },
	});
}
