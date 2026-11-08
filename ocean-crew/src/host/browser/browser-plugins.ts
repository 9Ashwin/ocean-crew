// The whole team uses one browser plugin. Each Bot still gets its own profile
// directory, including the group Sessions where that Bot speaks.

import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Runtime } from "../core/runtime.ts";
import { findChrome } from "./locate.ts";
import { type BrowserToolSpec, mountBrowserPlugin } from "./mount.ts";
import * as refs from "./refs.ts";
import * as script from "./script.ts";
import { type SessionModelContext, sessionComplete } from "./session-model.ts";
import * as task from "./task.ts";

/** A browser plugin's tool definitions, as the mount receives them. */
export interface BrowserPlugin {
	id?: string;
	tools?: unknown[];
	toolDefs?: unknown[];
	[key: string]: unknown;
}

export const browserPlugins: Record<string, BrowserPlugin> = { refs, script, task };
export function appBrowserEndpoint(botId: string, downloadRoots?: string[]): Promise<string> {
	const send = process.send;
	if (typeof send !== "function") throw new Error("The app browser relay is unavailable.");
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			process.off("message", receive);
			reject(new Error("The app browser relay did not respond."));
		}, 10_000);
		const receive = (message: any): void => {
			if (message?.type !== "ocean-crew:browser-endpoint-response" || message.id !== id) return;
			clearTimeout(timeout);
			process.off("message", receive);
			if (typeof message.url === "string") resolve(message.url);
			else reject(new Error(message.error || "The app browser relay is unavailable."));
		};
		process.on("message", receive);
		send.call(process, { type: "ocean-crew:browser-endpoint", id, botId, downloadRoots }, (error: Error | null) => {
			if (error) receive({ type: "ocean-crew:browser-endpoint-response", id, error: error.message });
		});
	});
}

const NAMES = Object.keys(browserPlugins);
const GRANT_KINDS = new Set(["post", "upload", "download", "delete"]);

/** A browser action the Bot asks to take: kind, site host, and the label the user sees. */
export interface BrowserAction {
	kind: string;
	host: string;
	label: string;
	[key: string]: unknown;
}

export function defaultBrowserHeadless(
	platform: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function optionalString(config: Record<string, any>, key: string): string | undefined {
	const value = config[key];
	if (value !== undefined && typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

function grantAllows(bot: { browserGrants?: unknown }, action: BrowserAction): boolean {
	return (Array.isArray(bot.browserGrants) ? bot.browserGrants : []).some((grant: any) => {
		if (!grant || typeof grant.site !== "string" || !Array.isArray(grant.kinds)) return false;
		if (
			grant.until !== undefined &&
			(typeof grant.until !== "number" || !Number.isFinite(grant.until) || grant.until <= Date.now())
		)
			return false;
		const site = grant.site.toLowerCase();
		const host = action.host.toLowerCase();
		const siteMatches = site === "*" || host === site || host.endsWith(`.${site}`);
		return (
			GRANT_KINDS.has(action.kind) && siteMatches && (grant.kinds.includes("*") || grant.kinds.includes(action.kind))
		);
	});
}

// A handoff card answers into the Bot's own chat. A group turn has no card, so its
// hold keeps no call and the browser panel clears it without telling the Bot.
export function handoffHold(
	rt: Runtime,
	botId: string,
	{ sessionId, callId, ...hold }: Record<string, any>,
): Record<string, any> {
	const own = sessionId !== undefined && rt.chatOwners.get(sessionId) === botId;
	return own && callId !== undefined ? { ...hold, callId } : hold;
}

async function authorizeBrowserAction(rt: Runtime, exec: any, botId: string, action: BrowserAction): Promise<void> {
	await rt.load();
	const bot = rt.botOf(botId);
	if (bot === undefined) throw new Error("Unknown Bot");
	if (action.kind === "payment") {
		throw new Error(
			`This looks like a payment ("${action.label}" on ${action.host}). The user makes payments themselves: call browser_handoff with reason "payment" and stop. Nothing was done.`,
		);
	}
	if (!GRANT_KINDS.has(action.kind) || grantAllows(bot, action)) return;

	const approval = rt.ctx.get("approval") as any;
	const agent = exec.agent;
	if (approval === undefined || agent?.session === undefined) {
		throw new Error(`This action needs the user's approval, and there is no way to ask here, so nothing was done.`);
	}
	const verbs: Record<string, { en: string; zh: string }> = {
		post: { en: "post", zh: "发布内容" },
		upload: { en: "upload files", zh: "上传文件" },
		download: { en: "download a file", zh: "下载文件" },
		delete: { en: "delete something", zh: "删除内容" },
	};
	const verb = verbs[action.kind];
	const reason = `Let ${bot.name} ${verb.en} on ${action.host}: "${action.label}"?`;
	const displayReason = {
		en: reason,
		zh: `允许${bot.name}在 ${action.host} 上${verb.zh}“${action.label}”吗？`,
	};
	let outcome: string;
	try {
		outcome = await approval.request({
			agent,
			toolName: exec.name,
			...(exec.callId !== undefined ? { callId: exec.callId } : {}),
			reason,
			displayReason,
			...(exec.signal ? { signal: exec.signal } : {}),
		});
	} catch {
		throw new Error("The approval service was unavailable. Nothing was done.");
	}
	if (outcome === "allowed-once") return;
	if (outcome === "rejected") {
		throw new Error(
			`The user did not approve ${action.label} on ${action.host}. Do not try this action again unless the user asks. Nothing was done.`,
		);
	}
	if (outcome === "cancelled") throw new Error("The approval was cancelled. Nothing was done.");
	throw new Error("The approval could not be obtained. Nothing was done.");
}

export function install(rt: Runtime): void {
	const name = rt.config.browserPlugin;
	const injected = rt.config.browserPluginApi as BrowserPlugin | undefined;
	if (!name && !injected) return;
	const plugin = injected ?? browserPlugins[name as string];
	if (!plugin) throw new Error(`Unknown browser plugin "${name}". Choose ${NAMES.join(", ")}.`);
	const playwrightUrl = optionalString(rt.config as Record<string, any>, "playwrightUrl");
	// Browser plugins drive the installed Chrome; playwright-core ships no Chromium.
	const executablePath = findChrome(optionalString(rt.config as Record<string, any>, "browserExecutablePath"));
	const headless =
		typeof rt.config.browserHeadless === "boolean"
			? rt.config.browserHeadless
			: defaultBrowserHeadless(process.platform);
	const downloadRoot = join(rt.home, "browser-downloads");
	async function downloadRoots(botId: string): Promise<string[]> {
		await rt.load();
		const team = rt.teamFolder();
		const requested = rt.workDirOf({ botId });
		const working = requested !== undefined && (await rt.isFolder(requested)) ? requested : team;
		return [
			...new Set([working, team].filter((root): root is string => typeof root === "string" && isAbsolute(root))),
		];
	}
	const mounted: { drop?: (botId: string) => Promise<void> } = {};
	mountBrowserPlugin(rt.ctx, {
		api: mounted,
		toolDefs: (plugin.tools ?? plugin.toolDefs ?? []) as BrowserToolSpec[],
		register: (tool: unknown) => rt.teamTools.push(tool as never),
		defineTool,
		profileRoot: join(rt.home, "browser-profiles"),
		downloadRoot,
		downloadRoots,
		async uploadRoots(botId: string) {
			const roots = await downloadRoots(botId);
			return [...new Set([...roots, join(downloadRoot, botId)])];
		},
		headless,
		playwrightUrl,
		executablePath,
		connect: process.env.MINI_BOT_APP === "1" && typeof process.send === "function" ? appBrowserEndpoint : undefined,
		// `browser: false` removes the built-in panel and with it the channel that
		// stores a handoff hold; leaving the hooks out keeps the hold in the session.
		...(rt.browserChannel === undefined
			? {}
			: {
					getHold: (botId: string) => rt.browserChannel.holdOf(botId) ?? null,
					onHold: (botId: string, hold: any) =>
						rt.browserChannel.setHold(botId, hold && handoffHold(rt, botId, hold)),
					subscribeHolds: (listener: any) => rt.browserChannel.subscribeHolds?.(listener),
				}),
		authorize: (exec: any, botId: string, action: BrowserAction) => authorizeBrowserAction(rt, exec, botId, action),
		completeFor: rt.config.browserComplete
			? () => rt.config.browserComplete as (request: any) => Promise<any>
			: (exec: any) => sessionComplete(rt.ctx as unknown as SessionModelContext, exec, rt),
		async keyOf(exec: any) {
			await rt.load();
			const id = rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id);
			if (id === undefined || rt.botOf(id) === undefined) return undefined;
			return id;
		},
	});
	// A deleted Bot leaves no browser state behind: close its session and drop the profile dir.
	if (typeof rt.deleteBot === "function") {
		const originalDelete = rt.deleteBot.bind(rt);
		rt.deleteBot = async (id: string) => {
			const result = await originalDelete(id);
			await mounted.drop?.(id).catch(() => undefined);
			return result;
		};
	}
	rt.browserPlugin = plugin.id ?? name;
}
