// Secrets: keys the user types into a card for a Bot. A value lives only in
// secrets.json (mode 600) and in this process; Bots use it as $DSH_SECRET_<NAME> in
// their shell, tool results lose it before they are saved, and every model request has
// it replaced by [secret:<NAME>] before it leaves.
//
// The request/answer flow, the redaction rules and the file handling are the
// The module publishes the same runtime members: secretsView,
// secretValue, canUseSecret, secretEndpoint, forgetBotSecrets, loadSecrets and
// redactSecrets; the request_secret and list_secrets tools are registered here, as the

import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { TeamState } from "../../shared/state.ts";
import { replaceFile } from "../core/files.ts";
import type { Runtime, TeamTool } from "../core/runtime.ts";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const ENV_PREFIX = "DSH_SECRET_";
// A short value (a PIN, a short password) would also hit ordinary words if it were
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where it
// stands alone: no letter or digit right before or after it.
export const MIN_VALUE = 4;
export const WHOLE_VALUE = 8;
export const MAX_VALUE = 16384;
const MAX_REQUESTS = 20;
const USED_SAVE_MS = 5000;

export const envName = (name: string): string => `${ENV_PREFIX}${name}`;

/** The scope a saved value may be used by: every Bot, or a list of Bot ids. */
export type SecretScope = "all" | string[];

export interface StoredSecret {
	name: string;
	value: string;
	purpose: string;
	scope: SecretScope;
	requestedBy: string | null;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
}

/** One pending or settled card a Bot asked for. */
export interface SecretRequest {
	id: string;
	callId?: string;
	sessionId?: string;
	name: string;
	purpose: string;
	kind: "fill" | "allow";
	status: "pending" | "saved" | "allowed" | "canceled";
	scope?: SecretScope;
	askedAt: number;
	settledAt?: number;
}

/** What a card for a saved key shows: never the value. */
export interface SecretView {
	name: string;
	purpose: string;
	scope: SecretScope;
	requestedBy: string | null;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
}

export const canUse = (secret: { scope?: SecretScope } | undefined, botId?: string): boolean =>
	secret !== undefined &&
	botId !== undefined &&
	(secret.scope === "all" || (Array.isArray(secret.scope) && secret.scope.includes(botId)));

export function normalizeName(raw: unknown): string {
	return String(raw ?? "")
		.trim()
		.replace(/^\$(env:)?/i, "")
		.replace(/^DSH_SECRET_/i, "")
		.replace(/[\s-]+/g, "_")
		.toUpperCase();
}

// encodeURIComponent leaves ' as is, but new URL() turns it into %27 in a query, so the
// URL sent out would hold a form the redactor does not know. Encoding these characters
// too keeps the sent URL equal to the text the redactor looks for.
export const encodeUrlComponent = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);

// One function that replaces every known value in a string, longest first so a value
// that contains another is replaced whole. JSON-escaped and URL-encoded forms are
// covered too.
export function redactor(entries: ReadonlyArray<{ name: string; value: string }>): (text: string) => string {
	const pairs: Array<[string, string, boolean]> = [];
	for (const { name, value } of entries) {
		if (typeof value !== "string" || value.length < MIN_VALUE) continue;
		const label = `[secret:${name}]`;
		const short = value.length < WHOLE_VALUE;
		pairs.push([value, label, short]);
		const escaped = JSON.stringify(value).slice(1, -1);
		if (escaped !== value) pairs.push([escaped, label, short]);
		// encodeURIComponent throws on a lone surrogate; such a value cannot sit in a URL anyway.
		const encoded = value.isWellFormed() ? encodeUrlComponent(value) : value;
		if (encoded !== value && encoded !== escaped) pairs.push([encoded, label, short]);
	}
	pairs.sort((a, b) => b[0].length - a[0].length);
	if (pairs.length === 0) return (text) => text;
	// One pass, so a label already written is never matched again.
	const labels = new Map<string, string>();
	for (const [value, label] of pairs) if (!labels.has(value)) labels.set(value, label);
	const quote = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		pairs
			.map(([value, , short]) => (short ? `(?<![\\p{L}\\p{N}])${quote(value)}(?![\\p{L}\\p{N}])` : quote(value)))
			.join("|"),
		"gu",
	);
	return (text) => {
		if (typeof text !== "string" || !pairs.some(([value]) => text.includes(value))) return text;
		return text.replace(pattern, (match) => labels.get(match) ?? match);
	};
}

// Returns the same reference when nothing changed, so callers can tell cheaply.
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const replaced = redactDeep(item, redact);
			if (replaced !== item) changed = true;
			return replaced;
		});
		return (changed ? next : value) as T;
	}
	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const replaced = redactDeep(item, redact);
			if (replaced !== item) changed = true;
			next[key] = replaced;
		}
		return (changed ? next : value) as T;
	}
	return value;
}

const output = {
	schema: { type: "string" },
	render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
		{ type: "text", text: String(value) },
	],
};

interface ToolExecution {
	agent?: { id?: string; session?: { header?: { id?: string } } };
	callId?: string;
	concludeTurn?: () => void;
	[key: string]: any;
}

interface ToolOptions {
	name: string;
	description: string;
	parameters: Record<string, any>;
	execute(args: Record<string, any>, exec: ToolExecution): unknown | Promise<unknown>;
}

// The DSH package compiles the author schema into the served JSON schema; runtime.ts's
// TeamTool bridge is loose, so the one cast lives here.
const tool = (options: ToolOptions): TeamTool => defineTool({ ...options, output } as never) as unknown as TeamTool;

interface ShellEnvContributor {
	name: string;
	variables: Record<string, { description: string }>;
	resolve: (execution: unknown) => Record<string, string>;
}

interface ShellEnvService {
	register(contributor: ShellEnvContributor): unknown;
}

export function install(rt: Runtime): void {
	const { ctx, home, state } = rt;
	const path = join(home, "secrets.json");

	const secrets = new Map<string, StoredSecret>();
	let loaded: Promise<void> | null = null;
	let writing: Promise<void> = Promise.resolve();
	let redact: (text: string) => string = (text) => text;
	let refreshEnv: () => void = () => {};
	let blocked: string | undefined;
	let loadedReadOnly = false;

	// Reading the pending cards never creates the table; only a Bot asking creates it

	const storedRequests = (): Record<string, SecretRequest[]> =>
		((state as unknown as TeamState).secretRequests ?? {}) as Record<string, SecretRequest[]>;

	const changed = (): void => {
		redact = redactor([...secrets.values()]);
		refreshEnv();
		rt.secretsChanged?.();
	};

	// Error messages from JSON.parse quote the file, so only the code or name is logged.
	const reason = (error: unknown): string => {
		const code = (error as { code?: unknown } | undefined)?.code;
		if (typeof code === "string") return code;
		const name = (error as { name?: unknown } | undefined)?.name;
		return typeof name === "string" ? name : "error";
	};

	// While another dsh holds the team, that host writes secrets.json, so a reading host
	// reads it again each time; a copy read then is also read again after taking over,
	// before this host saves anything.
	const loadSecrets = (): Promise<void> => {
		if (loaded !== null && (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined)) loaded = null;
		loaded ??= readSecrets();
		return loaded;
	};
	// Synchronous on purpose: a shell resolves its environment without an await, so the
	// map must be full before the first resolve after a start reads it.
	const readSecrets = async (): Promise<void> => {
		loadedReadOnly = rt.readOnly() !== undefined;
		let contents: string;
		try {
			contents = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") {
				blocked = undefined;
				secrets.clear();
			} else {
				blocked = reason(error);
				rt.warn("ocean-crew: unreadable secrets file %s (%s)", path, blocked);
			}
			changed();
			return;
		}
		let parsed: { secrets?: unknown } | null;
		try {
			parsed = JSON.parse(contents) as { secrets?: unknown } | null;
		} catch {
			parsed = null;
		}
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.secrets)) {
			// A file that is not a secrets file is kept aside, like a broken state.json, then
			// the store goes on with an empty one.
			const backup = `${path}.broken-${Date.now()}`;
			try {
				copyFileSync(path, backup);
				blocked = undefined;
				secrets.clear();
				rt.warn("ocean-crew: unreadable secrets file %s; backed up as %s", path, backup);
			} catch (error) {
				blocked = reason(error);
				rt.warn("ocean-crew: unreadable secrets file %s; backup failed: %s", path, error);
			}
			changed();
			return;
		}
		blocked = undefined;
		secrets.clear();
		for (const raw of parsed.secrets) {
			const entry = (raw ?? {}) as Partial<StoredSecret>;
			if (!SECRET_NAME.test(entry.name ?? "") || typeof entry.value !== "string") continue;
			const name = entry.name as string;
			secrets.set(name, {
				name,
				value: entry.value,
				purpose: typeof entry.purpose === "string" ? entry.purpose : "",
				scope:
					entry.scope === "all"
						? "all"
						: Array.isArray(entry.scope)
							? entry.scope.filter((id): id is string => typeof id === "string")
							: "all",
				requestedBy: typeof entry.requestedBy === "string" ? entry.requestedBy : null,
				createdAt: Number(entry.createdAt) || Date.now(),
				updatedAt: Number(entry.updatedAt) || Date.now(),
				...(Number.isFinite(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
			});
		}
		if (!loadedReadOnly)
			try {
				chmodSync(path, 0o600);
			} catch {
				// The file stays readable; a mode that cannot change is not an error here.
			}
		changed();
	};

	// Resolves once secrets.json holds the current map; rejects when the write failed.
	const persist = (): Promise<void> => {
		if (blocked !== undefined)
			return Promise.reject(
				new Error(
					`The secrets file ${path} could not be read (${blocked}). Ocean Crew does not change it; fix or move the file and reload.`,
				),
			);
		const readOnly = rt.readOnly();
		if (readOnly !== undefined) return Promise.reject(new Error(readOnly));
		const snapshot = JSON.stringify({ version: 1, secrets: [...secrets.values()] }, null, 2);
		const job = writing.then(async () => {
			await mkdir(home, { recursive: true });
			const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
			try {
				await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
				await chmod(temp, 0o600);
				await replaceFile(temp, path);
			} catch (error) {
				await unlink(temp).catch(() => undefined);
				throw error;
			}
		});
		writing = job.catch((error) => rt.warn("ocean-crew: secrets write failed (%s)", reason(error)));
		return job;
	};

	let usedTimer: ReturnType<typeof setTimeout> | null = null;
	const noteUsed = (): void => {
		if (usedTimer !== null) return;
		usedTimer = setTimeout(() => {
			usedTimer = null;
			if (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined) return;
			void persist()
				.then(() => rt.save())
				.catch(() => undefined);
		}, USED_SAVE_MS);
		usedTimer.unref?.();
	};

	// A Bot's pending secret cards, keyed by its id. A key that is not a real Bot (and
	// never an inherited name like "__proto__", which a plain assignment would not even
	// set as a key) gets a throwaway list instead of a stored one.
	const requestsOf = (botId: string): SecretRequest[] => {
		if (rt.botOf(botId) === undefined) {
			const known = storedRequests();
			if (!Object.hasOwn(known, botId)) return [];
			if (known[botId] === undefined) known[botId] = [];
			return known[botId];
		}
		const team = state as unknown as TeamState;
		team.secretRequests ??= {};
		const requests = team.secretRequests as Record<string, SecretRequest[]>;
		if (requests[botId] === undefined) requests[botId] = [];
		return requests[botId];
	};
	const findRequest = (id: unknown): { botId: string; request: SecretRequest } | undefined => {
		for (const [botId, list] of Object.entries(storedRequests())) {
			const request = list.find((entry) => entry.id === id);
			if (request !== undefined) return { botId, request };
		}
		return undefined;
	};
	const trimRequests = (list: SecretRequest[]): void => {
		while (list.length > MAX_REQUESTS) {
			const settled = list.findIndex((entry) => entry.status !== "pending");
			list.splice(settled === -1 ? 0 : settled, 1);
		}
	};

	const scopeText = (scope: SecretScope): string => {
		if (scope === "all") return "every Bot";
		const names = scope.map((id) => rt.botOf(id)?.name).filter((name): name is string => Boolean(name));
		return names.length === 0 ? "no Bot" : names.join(", ");
	};
	const usage = (name: string): string => `$${envName(name)} in bash, or $env:${envName(name)} in PowerShell`;

	const tell = async (botId: string, text: string): Promise<void> => {
		if (rt.botOf(botId) === undefined) return;
		await rt
			.deliver({ toId: botId, role: "secret", text })
			.catch((error: unknown) => rt.warn("ocean-crew: secret note to %s failed: %s", botId, error));
	};
	const savedNote = (name: string, lead: string): string =>
		[
			`${lead} Use it as ${usage(name)}.`,
			"You cannot see the value. Never print, echo, or log it, and never ask the user to paste it into the chat. Carry on with what you needed it for.",
		].join(" ");

	function settle(_botId: string, request: SecretRequest, status: SecretRequest["status"]): void {
		request.status = status;
		request.settledAt = Date.now();
		if (status === "saved" || status === "allowed") request.scope = secrets.get(request.name)?.scope ?? "all";
	}

	// After any change to `name`, every pending card for it either resolves (its Bot can
	// use the key now) or shows the form that still applies.
	function reconcile(name: string, notes: Array<[string, string]>, except?: SecretRequest): void {
		const secret = secrets.get(name);
		for (const [botId, list] of Object.entries(storedRequests())) {
			for (const request of list) {
				if (request.status !== "pending" || request.name !== name || request === except) continue;
				if (canUse(secret, botId)) {
					settle(botId, request, "saved");
					notes.push([botId, savedNote(name, `The user saved ${name}, and you may use it now.`)]);
				} else {
					request.kind = secret ? "allow" : "fill";
				}
			}
		}
	}

	async function commit(notes: Array<[string, string]>): Promise<void> {
		changed();
		await persist();
		await rt.save();
		for (const [botId, text] of notes) await tell(botId, text);
	}

	const cleanValue = (raw: unknown): string => {
		if (typeof raw !== "string") throw new Error("Type the key first");
		const value = raw.trim();
		if (value.length < MIN_VALUE) throw new Error(`A key must have at least ${MIN_VALUE} characters`);
		if (value.length > MAX_VALUE) throw new Error(`A key can have at most ${MAX_VALUE} characters`);
		return value;
	};
	const cleanScope = (raw: unknown): SecretScope => {
		if (raw === "all") return "all";
		if (!Array.isArray(raw)) throw new Error("Choose every Bot or a list of Bots");
		return [...new Set(raw.filter((id): id is string => typeof id === "string" && rt.botOf(id) !== undefined))];
	};
	const pendingRequest = (id: unknown): { botId: string; request: SecretRequest } => {
		const found = findRequest(String(id ?? ""));
		if (found === undefined) throw new Error("This request is gone");
		if (found.request.status !== "pending") throw new Error("This request was already answered");
		return found;
	};

	const secretView = (secret: StoredSecret): SecretView => ({
		name: secret.name,
		purpose: secret.purpose,
		scope: secret.scope,
		requestedBy: secret.requestedBy,
		createdAt: secret.createdAt,
		updatedAt: secret.updatedAt,
		...(secret.lastUsedAt !== undefined ? { lastUsedAt: secret.lastUsedAt } : {}),
	});
	const secretsView = (): SecretView[] =>
		[...secrets.values()].sort((a, b) => a.name.localeCompare(b.name)).map(secretView);

	type Body = Record<string, any>;
	const endpoints: Record<string, (body: Body) => Promise<unknown>> = {
		// From a card (requestId) or from the settings page (name).
		"secret-set": async (body) => {
			const value = cleanValue(body.value);
			const now = Date.now();
			const notes: Array<[string, string]> = [];
			if (body.requestId !== undefined) {
				const { botId, request } = pendingRequest(body.requestId);
				const existing = secrets.get(request.name);
				let scope: SecretScope;
				if (existing === undefined || request.kind === "fill") scope = body.scope === "bot" ? [botId] : "all";
				else scope = existing.scope === "all" ? "all" : [...new Set([...existing.scope, botId])];
				secrets.set(request.name, {
					name: request.name,
					value,
					purpose: existing?.purpose || request.purpose,
					scope,
					requestedBy: existing?.requestedBy ?? botId,
					createdAt: existing?.createdAt ?? now,
					updatedAt: now,
					...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
				});
				settle(botId, request, "saved");
				notes.push([botId, savedNote(request.name, `The user saved ${request.name} for ${scopeText(scope)}.`)]);
				reconcile(request.name, notes, request);
				await commit(notes);
				return secretView(secrets.get(request.name) as StoredSecret);
			}
			const name = normalizeName(body.name);
			if (!SECRET_NAME.test(name))
				throw new Error("A name uses capitals, digits, and underscores, and starts with a letter");
			const existing = secrets.get(name);
			secrets.set(name, {
				name,
				value,
				purpose:
					typeof body.purpose === "string" && body.purpose.trim() !== ""
						? body.purpose.trim().slice(0, 300)
						: (existing?.purpose ?? ""),
				scope: body.scope !== undefined ? cleanScope(body.scope) : (existing?.scope ?? "all"),
				requestedBy: existing?.requestedBy ?? null,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
			});
			reconcile(name, notes);
			await commit(notes);
			return secretView(secrets.get(name) as StoredSecret);
		},
		"secret-allow": async (body) => {
			const { botId, request } = pendingRequest(body.requestId);
			const secret = secrets.get(request.name);
			if (secret === undefined) throw new Error(`${request.name} is not saved yet`);
			if (!canUse(secret, botId)) {
				const current = secret.scope === "all" ? [] : secret.scope;
				secret.scope = [...new Set([...current, botId])];
			}
			secret.updatedAt = Date.now();
			settle(botId, request, "allowed");
			const notes: Array<[string, string]> = [
				[botId, savedNote(request.name, `The user let you use ${request.name}.`)],
			];
			reconcile(request.name, notes, request);
			await commit(notes);
			return secretView(secret);
		},
		"secret-cancel": async (body) => {
			const { botId, request } = pendingRequest(body.requestId);
			settle(botId, request, "canceled");
			await rt.save();
			await tell(
				botId,
				`The user canceled your request for ${request.name}. Do not ask for it again unless the user brings it up; carry on without it, or tell the user what you cannot do without it.`,
			);
			return true;
		},
		"secret-update": async (body) => {
			const secret = secrets.get(normalizeName(body.name));
			if (secret === undefined) throw new Error("No such key");
			if (body.scope !== undefined) secret.scope = cleanScope(body.scope);
			if (typeof body.purpose === "string") secret.purpose = body.purpose.trim().slice(0, 300);
			secret.updatedAt = Date.now();
			const notes: Array<[string, string]> = [];
			reconcile(secret.name, notes);
			await commit(notes);
			return secretView(secret);
		},
		"secret-delete": async (body) => {
			const name = normalizeName(body.name);
			if (!secrets.delete(name)) throw new Error("No such key");
			const notes: Array<[string, string]> = [];
			reconcile(name, notes);
			await commit(notes);
			return true;
		},
	};

	async function secretEndpoint(endpoint: string, body?: Body): Promise<unknown> {
		await loadSecrets();
		return endpoints[endpoint](body ?? {});
	}

	// A deleted Bot leaves every list it was on, and its cards go with it.
	async function forgetBotSecrets(botId: string): Promise<void> {
		await loadSecrets();
		const requests = (state as unknown as TeamState).secretRequests;
		if (requests !== undefined) delete requests[botId];
		let touched = false;
		for (const secret of secrets.values()) {
			if (Array.isArray(secret.scope) && secret.scope.includes(botId)) {
				secret.scope = secret.scope.filter((id) => id !== botId);
				touched = true;
			}
		}
		if (touched) {
			changed();
			await persist().catch(() => undefined);
		}
	}

	const callerOf = (exec: ToolExecution): string | undefined =>
		rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id);

	const addTool = (definition: TeamTool): void => {
		if (typeof rt.addTeamTool === "function") rt.addTeamTool(definition);
		else rt.teamTools.push(definition);
	};

	addTool(
		tool({
			name: "request_secret",
			description:
				"Ask the user for a key, token, or password through a secure card in your own chat. The user types it into the card; you never see the value. It reaches your shell as an environment variable. When the key is already saved for you, this only tells you its variable. Showing a card ends your turn; a note arrives when the user saves or cancels.",
			parameters: {
				name: {
					type: "string",
					required: true,
					description: "Key name in capitals, digits, and underscores, e.g. GITHUB_TOKEN",
				},
				purpose: {
					type: "string",
					required: true,
					description: "One short line for the user: what you need it for",
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				await loadSecrets();
				const id = exec.agent?.id;
				const bot = rt.botOf(callerOf(exec));
				if (bot === undefined) return "Only Bots on the team can use request_secret.";
				const name = normalizeName(args.name);
				if (!SECRET_NAME.test(name))
					return "Name the key with capitals, digits, and underscores, starting with a letter (for example GITHUB_TOKEN).";
				const secret = secrets.get(name);
				if (canUse(secret, bot.id))
					return `${name} is already saved and you may use it: ${usage(name)}. You cannot see the value; never print it.`;
				if (rt.groupOwners.has(id ?? ""))
					return "Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.";
				if (!rt.chatOwners.has(id ?? "")) return "Secret cards only work in your current own chat.";
				const readOnly = rt.readOnly();
				if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`;
				const list = requestsOf(bot.id);
				const now = Date.now();
				for (const request of list) {
					if (request.status === "pending" && request.name === name) {
						request.status = "canceled";
						request.settledAt = now;
					}
				}
				list.push({
					id: randomUUID(),
					...(exec.callId ? { callId: exec.callId } : {}),
					sessionId: id,
					name,
					purpose: String(args.purpose ?? "")
						.trim()
						.slice(0, 300),
					kind: secret ? "allow" : "fill",
					status: "pending",
					askedAt: now,
				});
				trimRequests(list);
				await rt.save();
				exec.concludeTurn?.();
				return secret
					? `The card asking the user to let you use ${name} is on screen. A note arrives when the user answers; you will not see the value.`
					: `The card asking the user for ${name} is on screen. A note arrives when the user saves or cancels; you will not see the value.`;
			},
		}),
	);

	addTool(
		tool({
			name: "list_secrets",
			description:
				"List the keys the user saved for the team: name, purpose, which Bots may use them, and whether you may. Values are never shown.",
			parameters: {},
			execute: async (_args, exec) => {
				await rt.load();
				await loadSecrets();
				const self = callerOf(exec);
				if (rt.botOf(self) === undefined) return "Only Bots on the team can use list_secrets.";
				if (secrets.size === 0) return "No keys are saved yet. Ask for one with request_secret.";
				return [
					"Saved keys (values are never shown):",
					...secretsView().map(
						(secret) =>
							`- ${secret.name}${secret.purpose ? ` — ${secret.purpose}` : ""} — for ${scopeText(secret.scope)} — ${canUse(secrets.get(secret.name), self) ? `you may use it as $${envName(secret.name)}` : "you may not use it; ask with request_secret"}`,
					),
				].join("\n");
			},
		}),
	);

	// Tool results lose the values before the registry renders and saves them. Every
	// field is redacted — a wrapper further out in the pipeline still sees a whole
	// result (its `content`, `meta`, and `additionalContexts` too), and the registry
	// re-renders a changed success result from its redacted value.
	ctx.on("tools/execute", async (_exec: unknown, next: () => Promise<unknown>) => {
		const result = await next();
		if (secrets.size === 0 || result === null || typeof result !== "object") return result;
		return redactDeep(result, redact);
	});

	// is replaced before the request leaves. `next` cannot take new options, so the
	// request starts over; it then carries no value and passes through here.
	// A value that is part of its own label would be replaced again on every pass, so a
	// request this listener rewrote passes straight through.
	const rewritten = new WeakSet<object>();
	ctx.on("llm/stream", (options: Record<string, any>, next: () => unknown) => {
		if (secrets.size === 0 || rewritten.has(options.messages)) return next();
		const messages = redactDeep(options.messages, redact);
		const system = redactDeep(options.system, redact);
		if (messages === options.messages && system === options.system) return next();
		const fresh = [...(messages ?? [])];
		rewritten.add(fresh);
		rt.carryUsageTag?.(options.messages, fresh);
		return (ctx.llm as unknown as { stream(options: Record<string, any>): unknown }).stream({
			...options,
			messages: fresh,
			...(system !== undefined ? { system } : {}),
		});
	});

	const resolveEnv = (execution: any): Record<string, string> => {
		const botId = rt.selfOf(execution?.agent?.session?.header?.id ?? execution?.agent?.id);
		if (rt.botOf(botId) === undefined) return {};
		const command = typeof execution.arguments?.command === "string" ? execution.arguments.command : "";
		const values: Record<string, string> = {};
		let used = false;
		for (const secret of secrets.values()) {
			if (!canUse(secret, botId)) continue;
			values[envName(secret.name)] = secret.value;
			if (command.includes(envName(secret.name))) {
				secret.lastUsedAt = Date.now();
				used = true;
			}
		}
		if (used) noteUsed();
		return values;
	};

	// Keys must be declared up front, so the contribution is registered again whenever
	// the set of names (or a purpose, which describes the key) changes.
	const attachShellEnv = (sub: {
		shellEnv?: ShellEnvService;
		effect?: (execute: () => unknown, label?: string) => void;
	}): void => {
		let unregister: unknown = null;
		let declared = "";
		refreshEnv = () => {
			const list = [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name));
			const key = list.map((secret) => `${secret.name}\u0000${secret.purpose}`).join("\n");
			if (key === declared) return;
			(unregister as (() => void) | null)?.();
			unregister = null;
			declared = key;
			if (list.length === 0) return;
			try {
				unregister = sub.shellEnv?.register({
					name: "ocean-crew-secrets",
					variables: Object.fromEntries(
						list.map((secret) => [
							envName(secret.name),
							{
								description: `Ocean Crew secret ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ""}`,
							},
						]),
					),
					resolve: resolveEnv,
				});
			} catch (error) {
				declared = "";
				rt.warn("ocean-crew: secrets not offered to the shell: %s", (error as Error)?.message ?? error);
			}
		};
		refreshEnv();
		sub.effect?.(
			() => () => {
				(unregister as (() => void) | null)?.();
				unregister = null;
				declared = "";
				refreshEnv = () => {};
			},
			"ocean-crew: secrets shell env",
		);
	};
	if (typeof ctx.inject === "function") ctx.inject(["shellEnv"], attachShellEnv);
	else if (ctx.get("shellEnv") !== undefined)
		attachShellEnv({
			shellEnv: ctx.get("shellEnv") as ShellEnvService,
			effect: (execute, label) => ctx.effect(execute, label),
		});

	ctx.effect(() => {
		void loadSecrets();
		return () => {
			if (usedTimer !== null) clearTimeout(usedTimer);
		};
	}, "ocean-crew: load secrets");

	Object.assign(rt, {
		secretsView,
		secretValue: (name: string) => secrets.get(name)?.value,
		canUseSecret: (name: string, botId: string) => canUse(secrets.get(name), botId),
		secretEndpoint,
		forgetBotSecrets,
		loadSecrets,
		redactSecrets: (text: string) => redact(text),
	});
}
