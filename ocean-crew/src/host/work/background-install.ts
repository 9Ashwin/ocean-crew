// Wiring for the background view: the tool pipeline feeds it, a timer asks it what is stuck, and
// the window reads it through one endpoint. A stuck run is announced to the chat once — the point
// is to tell the user their Bot is going in circles, not to fill the chat with the same warning.
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";
import { type BackgroundEntry, backgroundOf } from "./background.ts";

/** How often the stuck check runs; the thresholds are minutes, so seconds are enough. */
const CHECK_MS = 60_000;

export function install(rt: Runtime): void {
	const background = backgroundOf({
		ownerOf: (sessionId) => {
			const botId = rt.chatOwners.get(sessionId);
			if (botId !== undefined) return rt.botOf(botId)?.name ?? botId;
			const room = rt.roomOf(sessionId);
			return room === undefined ? undefined : room.name;
		},
		isTeamSession: (sessionId) => rt.isBotSession(sessionId),
		doingOf: (sessionId) => {
			// `workView` is per Bot: the Session's Bot is what the panel names, so its own chat wins.
			const botId = rt.chatOwners.get(sessionId);
			const doing = botId === undefined ? undefined : (rt.workView?.() as any)?.[botId];
			if (doing?.tool === undefined) return undefined;
			return {
				tool: String(doing.tool),
				since: Number(doing.since ?? Date.now()),
				...(doing.note ? { note: String(doing.note) } : {}),
			};
		},
		workOf: (sessionId) => {
			const id = rt.workOf?.({ role: "request", exchangeId: sessionId } as any) as string | undefined;
			return id === undefined ? undefined : { id };
		},
	});
	Object.assign(rt, {
		backgroundView: () => background.view(),
		backgroundNotice: (entry: BackgroundEntry) =>
			background.takeAnnouncements().find((held) => held.sessionId === entry.sessionId),
	});

	rt.ctx.on("tools/pre-execute", async (exec: any, next: () => Promise<any>): Promise<any> => {
		const sessionId = exec.agent?.session?.id;
		if (typeof sessionId === "string") background.noteCall(sessionId, String(exec.name ?? ""), exec.arguments);
		return next();
	});
	rt.ctx.on("tools/post-execute", async (exec: any, result: any, next: () => Promise<any>): Promise<any> => {
		const sessionId = exec.agent?.session?.id;
		if (typeof sessionId === "string") background.noteProgress(sessionId);
		return next();
	});
	listenGlobal(rt.ctx, "session/event", (session: any, event: any) => {
		const sessionId = session?.id;
		if (typeof sessionId !== "string") return;
		if (event?.type === "turn/start") background.noteTurn(sessionId, true);
		if (event?.type === "turn/end") background.noteTurn(sessionId, false);
	});

	// One timer, cleared with the plugin. A stuck run is told to the user through the IM path the
	// host already owns; without a chat there is nothing to tell, and the panel still shows it.
	const timer = setInterval(() => {
		let announce: string[] = [];
		try {
			announce = background.takeAnnouncements().map((entry) => {
				const doing = entry.doing === undefined ? "" : ` (${entry.doing})`;
				return `${entry.owner} 可能卡住了${doing}：${entry.stuckWhy ?? ""}`;
			});
		} catch (error: any) {
			rt.warn("ocean-crew: background check failed: %s", error?.message ?? error);
		}
		for (const line of announce) void rt.notifyStuck?.(line);
	}, CHECK_MS);
	rt.ctx.effect?.(() => () => clearInterval(timer), "ocean-crew: background check");

	rt.backgroundEndpoint = async (endpoint: string): Promise<any> => {
		if (endpoint !== "background")
			throw Object.assign(new Error(`Unknown endpoint ${endpoint}`), { code: "bot/not-found" });
		return background.view();
	};
}
