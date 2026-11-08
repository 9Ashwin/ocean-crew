// Diagnostics: what went wrong on this host, kept where the user can see it and report it.
// DSH mounts no exporter for ctx.logger once it has started, so warnings would otherwise
// reach only stderr. Entries are kept in memory and in <home>/logs/diagnostics.jsonl, so a
// report written after a restart still has them. Every text is cleaned of saved keys,
// credential-like strings and the home folder before it is kept and again before it is
// shown, because the report is meant for a public issue.
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import type { DshContext, Runtime, Warn } from "./runtime.ts";

export const KEEP = 200;
const LOG_MAX_BYTES = 1 << 20;
const STACK_LINES = 8;
const TEXT_MAX = 2000;
export const REPORT_ENTRIES = 20;
export const ISSUES_URL = "https://github.com/9Ashwin/ocean-crew/issues/new";

/** One entry as it is kept, in memory and in the log file. */
export interface DiagnosticsEntry {
	time: number;
	level: string;
	source: string;
	text: string;
	code?: string;
	status?: number;
	bot?: string;
	where?: string;
	sessionId?: string;
	stack?: string;
	[key: string]: unknown;
}

/** What the About page sends for its browser half; every field is optional. */
export interface ClientFacts {
	surface?: string;
	language?: string;
	userAgent?: string;
}

export interface ClientError {
	time?: number;
	level?: string;
	text?: string;
	code?: string;
}

export interface ReportRequest {
	client?: ClientFacts;
	clientErrors?: ClientError[];
}

export interface ReportFacts {
	botVersion?: string;
	dshVersion?: string;
	os?: string;
	node?: string;
	team?: string;
	models?: string;
	readOnly?: string;
}

const quote = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Shapes of credentials that are not saved keys: provider keys, bearer tokens, and
// token or key parameters in addresses (the Web login address carries one).
const CREDENTIALS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bsk-[A-Za-z0-9_*.-]{6,}/g, "sk-[hidden]"],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "[hidden]"],
	[/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[hidden]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[hidden]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[hidden]"],
	[/\bAIza[A-Za-z0-9_-]{20,}/g, "[hidden]"],
	// JSON web tokens: three base64url parts, the first always starting eyJ.
	[/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[hidden]"],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]{8,}/gi, "$1 [hidden]"],
	[/([?&#](?:token|access_token|api_key|apikey|key|secret|password)=)[^&\s"']+/gi, "$1[hidden]"],
	[/(["']?(?:api[_-]?key|authorization|x-api-key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, "$1[hidden]"],
];

/** Hide credentials and the home folder in a text that may reach the log or a public issue. */
export function cleanText(
	text: unknown,
	{ redact = (value: string) => value, home = homedir() }: { redact?: (value: string) => string; home?: string } = {},
): string {
	let out = redact(String(text ?? ""));
	for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement);
	if (home && home.length > 1) {
		out = out.replace(new RegExp(quote(home), "g"), "~");
		// JSON and Windows paths spell the same folder with doubled or forward slashes.
		const slashes = home.replace(/\\/g, "/");
		if (slashes !== home) out = out.replace(new RegExp(quote(slashes), "g"), "~");
		const doubled = home.replace(/\\/g, "\\\\");
		if (doubled !== home) out = out.replace(new RegExp(quote(doubled), "g"), "~");
	}
	return out.length > TEXT_MAX ? `${out.slice(0, TEXT_MAX)}…` : out;
}

const errorText = (error: Error): string =>
	`${error.name && error.name !== "Error" ? `${error.name}: ` : ""}${error.message}`;

/** One log line, as the downloaded log and the report show it. */
export function entryLine(entry: DiagnosticsEntry): string {
	const where = [entry.bot, entry.where].filter(Boolean).join(" · ");
	const code = entry.code ? ` [${entry.code}${entry.status ? ` ${entry.status}` : ""}]` : "";
	return `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase()} ${entry.source}${where ? ` (${where})` : ""}${code} ${entry.text}`;
}

/** The Markdown block for an issue. `facts` come from this host, `client` from the browser that asked; `entries` are already cleaned. */
export function reportMarkdown({
	facts,
	client = {},
	entries = [],
	clientEntries = [],
}: {
	facts: ReportFacts;
	client?: ClientFacts;
	entries?: DiagnosticsEntry[];
	clientEntries?: DiagnosticsEntry[];
}): string {
	const row = (label: string, value: unknown): string | null =>
		value === undefined || value === null || value === ""
			? null
			: `| ${label} | ${String(value).replace(/\|/g, "\\|")} |`;
	const lines = [
		"| | |",
		"|---|---|",
		row("Ocean Crew", facts.botVersion),
		row("DSH", facts.dshVersion),
		row("Surface", client.surface),
		row("OS", facts.os),
		row("Node", facts.node),
		row("Browser", client.userAgent),
		row("Language", client.language),
		row("Team", facts.team),
		row("Models", facts.models),
		row("Read-only", facts.readOnly),
	].filter((line): line is string => line !== null);
	const recent = entries.slice(-REPORT_ENTRIES);
	const out = [...lines, ""];
	out.push(
		recent.length === 0
			? "No host errors recorded."
			: `Recent host errors (${recent.length} of ${entries.length}, oldest first):`,
	);
	if (recent.length > 0) out.push("```", ...recent.map(entryLine), "```");
	const stacks = recent.filter((entry) => entry.stack).slice(-3);
	for (const entry of stacks)
		out.push(
			"",
			`<details><summary>Stack: ${entry.text.slice(0, 80).replace(/</g, "&lt;")}</summary>`,
			"",
			"```",
			entry.stack as string,
			"```",
			"</details>",
		);
	if (clientEntries.length > 0) {
		out.push(
			"",
			`Recent browser errors (${Math.min(clientEntries.length, 10)}):`,
			"```",
			...clientEntries.slice(-10).map(entryLine),
			"```",
		);
	}
	return out.join("\n");
}

const ownVersion = (): string | undefined => {
	try {
		return JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")).version;
	} catch {
		return undefined;
	}
};

// DSH packages share one version; the LLM package is always beside the plugin.
export const dshVersion = (): string | undefined => {
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-llm")));
		for (let depth = 0; depth < 5; depth += 1, dir = dirname(dir)) {
			try {
				const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
				if (manifest.name === "@deepseek-ai/dsh-llm") return manifest.version;
			} catch {
				// Not a package directory.
			}
		}
	} catch {
		// This DSH cannot see the package manifest.
	}
	return undefined;
};

// The logger a host has before diagnostics install; kept so `createRuntime` can warn
// while the rest of the modules are still being installed.
export function createWarn(ctx: DshContext): Warn {
	return (template, ...args) => {
		const line = format(template, ...args).replaceAll("\r", "");
		try {
			ctx.logger?.warn?.("%s", line);
		} catch {
			// A logger that is gone must not turn a warn into a crash.
		}
		console.error(`[ocean-crew] ${line}`);
	};
}

export function install(rt: Runtime): void {
	const { ctx, home, config } = rt;
	const logPath = join(home, "logs", "diagnostics.jsonl");
	const toFile = config.diagnosticsFile !== false;
	let fresh: DiagnosticsEntry[] = [];
	let writing: Promise<void> = Promise.resolve();
	let fileFailed = false;
	let stopped = false;

	// The log is written in the background. A stop waits for what is queued and writes
	// nothing after it, so nothing changes in `home` once the plugin has stopped.
	ctx.effect(
		() => () => {
			stopped = true;
			return writing;
		},
		"ocean-crew: diagnostics log",
	);

	const clean = (text: unknown): string => cleanText(text, { redact: rt.redactSecrets });

	// new ones are kept apart until then.
	const earlier: Promise<DiagnosticsEntry[]> = toFile
		? readFile(logPath, "utf8").then(
				(text) =>
					text
						.split("\n")
						.filter(Boolean)
						.slice(-KEEP)
						.flatMap((line) => {
							try {
								const entry = JSON.parse(line);
								return typeof entry?.time === "number" && typeof entry.text === "string"
									? [entry as DiagnosticsEntry]
									: [];
							} catch {
								return [];
							}
						}),
				() => [],
			)
		: Promise.resolve([]);
	let cleared = 0;

	const append = (entry: DiagnosticsEntry): void => {
		if (!toFile || stopped) return;
		writing = writing
			.then(async () => {
				await mkdir(dirname(logPath), { recursive: true });
				const size = await stat(logPath).then(
					(info) => info.size,
					() => 0,
				);
				if (size > LOG_MAX_BYTES) await rename(logPath, `${logPath}.1`);
				await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
			})
			.catch((error: any) => {
				if (fileFailed) return;
				fileFailed = true;
				console.error(
					"[ocean-crew] diagnostics log not written:",
					error?.code ?? clean(error?.message ?? String(error)),
				);
			});
	};

	// `fields`: source ('host', 'turn', 'api'), level, code, status, bot, where, sessionId, stack.
	const note = ({
		level = "error",
		source = "host",
		text,
		stack,
		...fields
	}: {
		level?: string;
		source?: string;
		text: unknown;
		stack?: string;
		[key: string]: unknown;
	}): DiagnosticsEntry => {
		const entry: DiagnosticsEntry = { time: Date.now(), level, source, text: clean(text) };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined && value !== null && value !== "")
				entry[key] = typeof value === "string" ? clean(value) : value;
		}
		// Frames only: the first line repeats the message, which is already the text.
		const frames =
			typeof stack === "string"
				? stack
						.split("\n")
						.filter((line) => /^\s+at /.test(line))
						.slice(0, STACK_LINES)
						.map((line) => line.trim())
				: [];
		if (frames.length > 0) entry.stack = clean(frames.join("\n"));
		fresh.push(entry);
		if (fresh.length > KEEP) fresh = fresh.slice(-KEEP);
		append(entry);
		return entry;
	};

	const warn: Warn = (template, ...args) => {
		const error = args.find((arg) => arg instanceof Error) as Error | undefined;
		const line = clean(format(template, ...args.map((arg) => (arg instanceof Error ? errorText(arg) : arg))));
		const frames =
			typeof error?.stack === "string"
				? error.stack
						.split("\n")
						.filter((item) => /^\s+at /.test(item))
						.slice(0, STACK_LINES)
						.map((item) => item.trim())
				: [];
		ctx.logger.warn("%s", line);
		console.error(`[ocean-crew] ${line}${frames.length > 0 ? `\n${clean(frames.join("\n"))}` : ""}`);
		note({
			level: "warn",
			source: "host",
			text: line.replace(/^ocean-crew: /, ""),
			code:
				typeof (error as { code?: unknown })?.code === "string"
					? ((error as { code?: string }).code as string)
					: undefined,
			stack: error?.stack,
		});
	};

	const entries = async (): Promise<DiagnosticsEntry[]> => {
		const old = (await earlier).filter((entry) => entry.time > cleared);
		return [...old, ...fresh].slice(-KEEP).map((entry) => ({
			...entry,
			text: clean(entry.text),
			...(entry.stack ? { stack: clean(entry.stack) } : {}),
		}));
	};

	const facts = (): ReportFacts => {
		const bots = Object.values(rt.state.bots);
		const models = [
			...new Set(
				bots
					.map((bot) => bot.model ?? bot.appliedModel)
					.filter((model): model is string => typeof model === "string" && model !== ""),
			),
		];
		const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
		const groups = Object.keys(rt.state.rooms).length;
		return {
			botVersion: ownVersion(),
			dshVersion: dshVersion(),
			os: `${platform()} ${release()} ${arch()}`,
			node: process.version,
			team: `${count(bots.length, "Bot", "Bots")}, ${rt.state.mainBotIds.length} Main, ${count(groups, "group chat", "group chats")}`,
			models: models.length > 0 ? models.join(", ") : undefined,
			readOnly: rt.readOnly?.() ? "yes, another dsh holds the team" : undefined,
		};
	};

	const sanitizeClient = (client: ClientFacts | undefined): ClientFacts => {
		const pick = (value: unknown, max: number): string | undefined =>
			typeof value === "string" ? clean(value.slice(0, max)) : undefined;
		return {
			surface: pick(client?.surface, 40),
			language: pick(client?.language, 20),
			userAgent: pick(client?.userAgent, 200),
		};
	};
	const sanitizeClientEntries = (list: unknown): DiagnosticsEntry[] =>
		(Array.isArray(list) ? list : []).slice(-20).flatMap((item: ClientError) => {
			if (typeof item?.text !== "string" || typeof item.time !== "number") return [];
			return [
				{
					time: item.time,
					level: item.level === "warn" ? "warn" : "error",
					source: "browser",
					text: clean(item.text.slice(0, 500)),
					...(typeof item.code === "string" ? { code: clean(item.code.slice(0, 40)) } : {}),
				},
			];
		});

	async function report(
		body: ReportRequest = {},
	): Promise<{ facts: ReportFacts; entries: DiagnosticsEntry[]; total: number; markdown: string; issuesUrl: string }> {
		await rt.loadSecrets?.().catch(() => {});
		const list = await entries();
		const client = sanitizeClient(body.client);
		const clientEntries = sanitizeClientEntries(body.clientErrors);
		const hostFacts = facts();
		return {
			facts: hostFacts,
			entries: list.slice(-50).reverse(),
			total: list.length,
			markdown: reportMarkdown({ facts: hostFacts, client, entries: list, clientEntries }),
			issuesUrl: ISSUES_URL,
		};
	}

	async function logText(): Promise<string> {
		await rt.loadSecrets?.().catch(() => {});
		const list = await entries();
		return list
			.map((entry) =>
				entry.stack ? `${entryLine(entry)}\n${(entry.stack as string).replace(/^/gm, "    ")}` : entryLine(entry),
			)
			.join("\n");
	}

	async function clear(): Promise<void> {
		cleared = Date.now();
		fresh = [];
		if (!toFile || stopped) return;
		writing = writing.then(() => writeFile(logPath, "", "utf8")).catch(() => {});
		await writing;
	}

	Object.assign(rt, { warn, noteFailure: note, diagnostics: { report, logText, clear, entries } });
}
