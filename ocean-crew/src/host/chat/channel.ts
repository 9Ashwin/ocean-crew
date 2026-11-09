// Channel: the `POST /api/bot` connection the desktop shell uses. A buffered JSON request
// names one endpoint in a closed set and always receives HTTP 200 carrying either
// `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`. The code is
// the machine field the client branches on; the message is text a user may read.
//
// The channel itself answers the roster, session, group, card and preference endpoints the
// shell needs to draw and drive a team. Endpoints owned by another host module are wired
// dynamically: each answers from the runtime member its module publishes and keeps
// `bot/unavailable` (naming the missing member) until that module is installed, so one
// channel serves every combination of installed and missing modules. There is no fake
// success and no silent omission. A second host without the team lock still answers READS,
// and every other endpoint keeps its `bot/read-only` refusal.
//

// - `run-stats` reads DSH's own session projection;

// - `view-reply` needs the parts/cards module to publish `validateViewAnswer` and `viewReply`;
//   until then it refuses with `bot/unavailable` rather than queueing an unvalidated answer.

//   for the optional member, which this build treats as "the module has not landed".
// - `folderEndpoint` receives the request signal, so a folder pick is abortable as before.
// - `browser-*`: a host without the browser module refuses `bot/unavailable`; a host whose

//   default branch did; an unknown suffix is still the module's call.
// - `archivesView`, `capabilityLibraryView`, `secretsView`, `imView`, the
//   live views and the activity/work views are optional runtime callers: when their module
//   is absent the field keeps its honest empty value, and only an endpoint that needs the
//   module refuses with `bot/unavailable`.

import { randomUUID } from "node:crypto";
import type { MessageSource } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ApiResponse, ErrorCode } from "../../shared/api.ts";
import type { Bot, Room, TeamQuestion } from "../../shared/state.ts";
import { COLORS, EXTRA_COLORS, REPLY_KIND, ROUTE } from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";

const LANGUAGES: Record<string, string> = { zh: "Chinese (简体中文)", en: "English" };
const RUN_STATS = ["sessionStats", "tokenUsage", "contextPressure"] as const;

/** The read endpoints a host without the team lock still answers (docs/contracts.md). */
export const READS: ReadonlySet<string> = new Set([
	"state",
	"models",
	"efforts",
	"providers",
	"provider-models",
	"earlier",
	"chat",
	"run-stats",
	"room-progress",
	"exchange",
	"exchange-text",
	"file-text",
	"usage",
	"companion-view",
	"schedules",
	"memory-view",
	"diagnostics",
	"diagnostics-log",
	"diagnostics-clear",
	"update-check",
	"update-install",
	"dsh-update-install",
	"repo-stars",
	"approval-answer",
	"thinking",
	"avatar-library",
]);

/** The endpoints the channel itself answers. Every other known name is deferred or unknown. */
export const CHANNEL_ENDPOINTS: readonly string[] = [
	"state",
	"models",
	"efforts",
	"set-prefs",
	"exchange",
	"exchange-text",
	"file-text",
	"room-progress",
	"create-bot",
	"update-bot",
	"duplicate-bot",
	"delete-bot",
	"set-main",
	"set-flags",
	"resume",
	"create-room",
	"update-room",
	"delete-room",
	"send",
	"answer-question",
	"dismiss-question",
	"dismiss-view",
	"run-stats",
	"stop-member-work",
	"stop-room-work",
];

/**
 * Endpoints another host module answers: wired dynamically. Each answers from the runtime
 * member its module publishes and stays `bot/unavailable` until that module is installed,
 * so one channel serves every combination of installed and missing modules.
 */
export const MODULE_ENDPOINTS: readonly string[] = [
	"providers",
	"provider-key",
	"provider-add",
	"provider-models",
	"provider-remove",

	"thinking",
	"earlier",
	"chat",
	"bot-new-part",
	"bot-open-part",

	"usage",
	// folders and archives (folders.ts answers them)
	"folders",
	"folder-pick",
	"folder-list",
	"team-workspace",
	"private-release",
	"reset-team",

	"avatar-library",
	"avatar-import",
	"avatar-delete",

	"add-agent",
	"agent-session",
	"agent-adopt",
	"agent-archive",
	"agent-rename",
	"remove-agent",

	"approval-answer",

	"goal-draft",
	"goal-control",
	"room-budget",

	"companion-view",
	"companion-set",

	"tts-settings",
	"tts-set",
	"tts-voices",
	"tts-test",

	"secret-set",
	"secret-allow",
	"secret-cancel",
	"secret-update",
	"secret-delete",

	"connector-connect",
	"connector-disconnect",
	"connector-retry",
	"connector-sign-in-code",
	"connector-cancel",
	"connector-client",
	"connector-set",
	"connector-add",
	"connector-remove",
	"connector-import-scan",
	"connector-import",
	"connector-request-cancel",
	"mail-account-add",
	"mail-account-remove",
	"mail-rule-set",
	"mail-send-answer",
	"mail-sign-in-code",

	"capability-save",
	"capability-delete",
	"capability-approve",
	"bot-capability",

	"schedules",
	"schedule-create",
	"schedule-delete",
	"memory-view",
	"memory-ask",
	"memory-forget",
	"memory-history",
	"memory-restore",
	"learning-answer",

	"view-reply",
	"btw-delete",
	"side-new",
	"side-ask",
	"side-cancel",
	"side-close",

	"update-check",
	"update-install",
	"dsh-update-install",
	"repo-stars",
	"diagnostics",
	"diagnostics-log",
	"diagnostics-clear",
];

// Endpoint families whose module answers the whole group through one `*Endpoint` member.
const SECRET_ENDPOINTS: readonly string[] = [
	"secret-set",
	"secret-allow",
	"secret-cancel",
	"secret-update",
	"secret-delete",
];
const CONNECTOR_MAIL_ENDPOINTS: readonly string[] = [
	"connector-connect",
	"connector-disconnect",
	"connector-retry",
	"connector-sign-in-code",
	"connector-cancel",
	"connector-client",
	"connector-set",
	"connector-add",
	"connector-remove",
	"connector-import-scan",
	"connector-import",
	"connector-request-cancel",
	"mail-account-add",
	"mail-account-remove",
	"mail-rule-set",
	"mail-send-answer",
	"mail-sign-in-code",
];
const CAPABILITY_ENDPOINTS: readonly string[] = [
	"capability-save",
	"capability-delete",
	"capability-approve",
	"bot-capability",
];
const SCHEDULE_ENDPOINTS: readonly string[] = ["schedules", "schedule-create", "schedule-delete"];
const MEMORY_ENDPOINTS: readonly string[] = [
	"memory-view",
	"memory-ask",
	"memory-forget",
	"memory-history",
	"memory-restore",
];

/** IM endpoints, one `imEndpoint(endpoint, body)` module call each. */
export const IM_ENDPOINTS: readonly string[] = [
	"im-add",
	"im-update",
	"im-remove",
	"im-pair",
	"im-unpair",
	"im-chat",
	"im-retry",
	"im-login-start",
	"im-login-wait",
];

/** Every IM endpoint; each refuses by missing member until its module loads. */
export const SERVICE_ENDPOINTS: readonly string[] = [...IM_ENDPOINTS];

/**
 * Endpoints still only placeholders. Every known endpoint is wired in `endpoints` and
 * refuses from `missingMember` until its module publishes the member; the export stays so a
 * module can register its surface here first.
 */
export const UNAVAILABLE_ENDPOINTS: ReadonlyMap<string, string> = new Map();

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "bot/invalid" });
const unavailable = (what: string): Error =>
	Object.assign(new Error(`${what} is not available in this build yet.`), { code: "bot/unavailable" });
const stale = (message: string): Error => Object.assign(new Error(message), { code: "bot/stale" });
/** An endpoint whose host module has not been installed. */
const missingMember = (endpoint: string, member: string): Error =>
	Object.assign(new Error(`${endpoint}: the ${member} host member is not installed in this build.`), {
		code: "bot/unavailable",
	});

// Programming and file-system errors are Ocean Crew's own faults and are logged with their
// stack; every other error is a refusal whose message is meant for the user.
const isInternal = (error: unknown): boolean => {
	const code = (error as { code?: unknown } | undefined)?.code;
	return (
		error instanceof TypeError ||
		error instanceof ReferenceError ||
		error instanceof RangeError ||
		error instanceof SyntaxError ||
		(typeof code === "string" && /^E[A-Z_]+$/.test(code))
	);
};

/** The machine code a thrown error maps to (docs/contracts.md - `bot/` error codes). */
export function errorCode(error: unknown): ErrorCode {
	const code = (error as { code?: unknown } | undefined)?.code;
	if (typeof code === "string" && code.startsWith("bot/")) return code as ErrorCode;
	return isInternal(error) ? "bot/internal" : "bot/refused";
}

const ok = <T>(value: T): ApiResponse<T> => ({ ok: true, value });
const fail = (message: string, code: ErrorCode = "bot/error"): ApiResponse<never> => ({
	ok: false,
	error: { code, message, details: {} },
});

type Payload = Record<string, any>;

const own = <T>(table: Record<string, T> | null | undefined, key: string): T | undefined =>
	table != null && Object.hasOwn(table, key) ? table[key] : undefined;

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state = rt.state;
	let uiLocale: string | undefined;

	// The DSH interface language of the last browser that asked for the team.
	const uiLanguage = (): string | undefined =>
		uiLocale === undefined ? undefined : (LANGUAGES[uiLocale.split("-")[0].toLowerCase()] ?? uiLocale);

	/** An optional cross-module function; undefined until its module is installed. */
	const fn = (name: string): ((...args: any[]) => any) | undefined => {
		const value = (rt as Record<string, any>)[name];
		return typeof value === "function" ? value : undefined;
	};
	const sync = (name: string, ...args: unknown[]): any => fn(name)?.(...args);
	const call = async (name: string, ...args: unknown[]): Promise<any> => {
		const wanted = fn(name);
		if (wanted === undefined) throw unavailable(`The ${name} host module`);
		return await wanted(...args);
	};
	const record = async (name: string, ...args: unknown[]): Promise<void> => {
		const wanted = fn(name);
		if (wanted === undefined) return;
		await wanted(...args);
	};
	/** A member an endpoint needs; a missing one refuses the endpoint, not the host. */
	const member = (endpoint: string, name: string): ((...args: any[]) => any) => {
		const found = fn(name);
		if (found === undefined) throw missingMember(endpoint, name);
		return found;
	};
	const callMember = async (endpoint: string, name: string, ...args: unknown[]): Promise<any> =>
		await member(endpoint, name)(...args);

	const liveMap = (): Map<string, any> | undefined => (rt as Record<string, any>).live as Map<string, any> | undefined;
	/** The diagnostics object; it publishes `report`, `logText` and `clear` together. */
	const diagnosticsService = (endpoint: string, method: string): Record<string, (...args: any[]) => any> => {
		const service = (rt as Record<string, any>).diagnostics as Record<string, any> | undefined;
		if (typeof service?.[method] !== "function") throw missingMember(endpoint, `diagnostics.${method}`);
		return service as Record<string, (...args: any[]) => any>;
	};
	const botOf = (id: string | undefined): Bot | undefined => (id === undefined ? undefined : fn("botOf")?.(id));
	const roomOf = (id: string | undefined): Room | undefined => (id === undefined ? undefined : fn("roomOf")?.(id));
	const chatOf = (id: string): string => fn("chatOf")?.(id) ?? id;
	const selfOf = (id?: string): string | undefined => fn("selfOf")?.(id);
	const sessionOfRoom = (room: Room): string => fn("sessionOfRoom")?.(room) ?? room.sessionId ?? room.id;
	const pastOwner = (ref: string): { botId?: string; roomId?: string } | undefined =>
		((rt as Record<string, any>).pastOwners as Map<string, { botId?: string; roomId?: string }> | undefined)?.get(
			ref,
		);
	const roomProgress = (): Map<string, any> | undefined =>
		(rt as Record<string, any>).roomProgress as Map<string, any> | undefined;
	const prefs = (): Record<string, any> => state.prefs as unknown as Record<string, any>;

	const load = async (): Promise<void> => {
		const wanted = fn("load");
		if (wanted !== undefined) await wanted();
	};
	const save = async (): Promise<void> => {
		const wanted = fn("save");
		if (wanted !== undefined) await wanted();
	};

	// Models come from DSH, not state.json, so a provider added in Harness settings changes
	// the answer without a new revision; the serialized pair is what `state` compares.
	const modelsKey = (): string => {
		const catalog = sync("cachedCatalog");
		const entries: any[] = Array.isArray(catalog) ? catalog : [];
		const refs = entries.map(
			(entry) =>
				`${entry?.ref ?? ""}${entry?.needsKey === true ? "!" : ""}${
					entry?.reasoning ? `:${JSON.stringify(entry.reasoning)}` : ""
				}`,
		);
		return `${refs.join(",")}|${sync("cachedDefault") ?? ""}`;
	};

	// Fields with no change counter of their own: the serialized answer is the detector, so
	// an unchanged poll gets the key back instead of the fields again. The key carries a
	// per-run prefix so a window that outlives this host cannot match a stale key.
	const liveRun = randomUUID();
	let liveSeq = 0;
	let liveCache: { key: string; value: Record<string, unknown>; json: string } | undefined;
	const live = (): Record<string, unknown> => ({
		activity: sync("activityView") ?? {},
		work: {
			bots: sync("workView") ?? {},
			rooms: sync("roomWorkView") ?? {},
			approvals: sync("approvalsView") ?? [],
			waiting: sync("waitingView") ?? {},
			turns: sync("turnsView") ?? {},
			steered: sync("steeredView") ?? {},
			tasks: sync("tasksView") ?? [],
		},
		memoryNews: sync("memoryNews") ?? {},
		memoryReviews: sync("memoryReviews") ?? {},
		memoryReviewStates: sync("memoryReviewStates") ?? {},
		learning: sync("learningView") ?? {},
		learningSettled: sync("learningSettledView") ?? {},
		connectors: sync("connectorsView") ?? {},
		capabilityStatuses: sync("capabilityStatusesView") ?? {},
		imStatus: sync("imStatusView") ?? {},
		imVia: sync("imViaView") ?? {},
		computerLive: sync("computerLive") ?? {},
	});
	const liveAnswer = (): { key: string; value: Record<string, unknown> } => {
		const value = live();
		const json = JSON.stringify(value);
		if (liveCache?.json === json) return liveCache;
		liveCache = { key: `${liveRun}:${++liveSeq}`, value, json };
		return liveCache;
	};

	// What the browser renders. a field

	const view = (): Record<string, unknown> => {
		const companions = sync("companionMap") ?? {};
		const bots = Object.values(state.bots).map((bot) => {
			const { segments, kickoff, ...rest } = bot;
			return {
				...rest,
				sessionId: chatOf(bot.id),
				parts: (segments ?? []).map((segment) => segment.sessionId),
				...(kickoff ? { waiting: true } : {}),
				...(companions[bot.id] === undefined ? {} : { companion: companions[bot.id] }),
			};
		});
		const rooms = Object.values(state.rooms).map((room) => {
			const { log, sessions, segments, parts: ownParts, ...rest } = room;
			// The log is rendered as `preview`; the read marks and the pause flag stay internal.
			const roomView: Record<string, unknown> = { ...rest };
			delete roomView.seen;
			delete roomView.paused;
			const parts = [
				...Object.values(sessions ?? {}),
				...Object.values(segments ?? {})
					.flat()
					.map((segment) => segment.sessionId),
				...(ownParts ?? []).map((segment) => segment.sessionId),
			];
			const last = (Array.isArray(log) ? log : []).filter((line) => line.kind === undefined).at(-1);
			return {
				...roomView,
				sessionId: sessionOfRoom(room),
				ownParts: (ownParts ?? []).map((segment) => segment.sessionId),
				parts,
				...(last ? { preview: last.who === "User" ? last.text : `${String(last.who)}：${last.text ?? ""}` } : {}),
			};
		});
		return {
			revision: state.revision,
			workspaceId: state.workspaceId ?? null,
			// `mainBotId` is the first Main Bot, the sidebar's tile; the list keeps the order.
			mainBotId: state.mainBotIds[0] ?? null,
			mainBotIds: state.mainBotIds,
			bots,
			rooms,
			// Deleted private Bots whose folder, memory and chats stay closed to the others.
			privateArchives: sync("archivesView") ?? [],
			exchangeTurns: state.exchangeTurns,
			questions: state.questions,
			views: state.views,
			closedCards: state.closedCards,
			// Aside answers and side chats of each Bot's current part, once parts is installed.
			btwCards: sync("btwView") ?? {},
			sideChats: sync("sideView") ?? {},
			agents: Object.values(state.agents),
			// Key names and who may use them; the values never leave the host.
			secrets: sync("secretsView") ?? [],
			capabilities: sync("capabilityLibraryView") ?? [],
			secretRequests: state.secretRequests ?? {},
			connectorRequests: state.connectorRequests ?? {},
			mailRequests: state.mailRequests ?? {},
			colors: [...COLORS, ...EXTRA_COLORS],
			models: sync("cachedCatalog") ?? [],
			defaultModel: sync("cachedDefault") ?? null,
			permissions: sync("permissionCatalog") ?? null,
			modelsKey: modelsKey(),
			prefs: state.prefs,
			// False when config.memory turns memory off: no Memory row or panel.
			memory: (rt as Record<string, any>).memoryEnabled !== false,
			// Set while another dsh host holds the team: why this one cannot change it.
			readOnly: sync("readOnly") ?? null,
			im: sync("imView") ?? { connections: [], platforms: [] },
			computer: sync("computerView") ?? { enabled: false },
		};
	};

	// either resolves to its current part. The request id lands on the message's source.
	async function sendUser({
		sessionId: ref,
		content,
		requestId = randomUUID(),
	}: {
		sessionId: string;
		content: unknown[];
		requestId?: string;
	}): Promise<void> {
		const past = pastOwner(ref);
		const room = roomOf(ref);
		const bot = botOf(ref);
		const sessionId =
			bot !== undefined
				? chatOf(ref)
				: room !== undefined
					? sessionOfRoom(room)
					: past?.roomId === undefined && past?.botId !== undefined
						? chatOf(past.botId)
						: past?.roomId !== undefined
							? sessionOfRoom(roomOf(past.roomId) as Room)
							: ref;
		await record("ensureCapabilities", sessionId);
		const controller = ctx.sessionController as
			| { prompt?: (request: unknown, signal?: AbortSignal) => Promise<unknown> }
			| undefined;
		if (typeof controller?.prompt !== "function") throw unavailable("Sending a message");
		await controller.prompt({ requestId, sessionId, mode: "queue", content }, AbortSignal.timeout(30_000));
	}

	// The user's answer to an `ask_user` card. The card is claimed before queueing, so a
	// second answer is refused; a failed queue puts it back.
	function answerReply(
		question: TeamQuestion,
		answer: unknown,
	): { text: string; source: Record<string, unknown> } | undefined {
		const record = question as unknown as Record<string, any>;
		const options: any[] = Array.isArray(record.options) ? record.options : [];
		const labels = new Set(options.map((option) => option?.label).filter((label) => typeof label === "string"));
		const given = (answer ?? {}) as { selected?: unknown; custom?: unknown };
		const picked = (Array.isArray(given.selected) ? given.selected : []).filter(
			(label): label is string => typeof label === "string" && labels.has(label),
		);
		const selected = record.multiSelect === true ? [...new Set(picked)] : picked.slice(0, 1);
		const custom = typeof given.custom === "string" ? given.custom.trim() : "";
		if (selected.length === 0 && custom === "") return undefined;
		const callId = typeof record.callId === "string" ? record.callId : question.id;
		const asked = {
			id: question.id,
			question: record.question ?? record.title,
			...(record.detail ? { detail: record.detail } : {}),
			options: record.options,
			multiSelect: record.multiSelect === true,
		};
		const givenAnswer = { id: question.id, selected, ...(custom !== "" ? { custom } : {}) };
		return {
			text: JSON.stringify({
				kind: "answer_to_pending_question",
				tool: "ask_user",
				callId,
				questions: [asked],
				answers: [givenAnswer],
			}),
			source: { kind: REPLY_KIND, callId, outcome: "answered" },
		};
	}

	async function answerQuestion(sessionRef: string, questionId: string, answer: unknown): Promise<boolean> {
		const past = pastOwner(sessionRef);
		const sessionId =
			botOf(sessionRef) !== undefined
				? chatOf(sessionRef)
				: past?.roomId === undefined && past?.botId !== undefined
					? chatOf(past.botId)
					: sessionRef;
		const question = own(state.questions, sessionId);
		if (question === undefined || question.id !== questionId) throw stale("This question is no longer open");
		const reply = answerReply(question, answer);
		if (reply === undefined) throw invalid("Nothing to send");
		// Claim the question before queueing so a second answer is refused.
		delete state.questions[sessionId];
		try {
			await record("ensureCapabilities", sessionId);
			const agent = await call("resolveAgent", sessionId);
			// DSH source kinds are merge-extensible per producer. Until the card layer owns

			// shape and the cast states the invariant.
			const source = reply.source as unknown as MessageSource;
			agent.followup(createUserMessage({ content: [{ type: "text", text: reply.text }], source }));
			const sessions = ctx.sessions as { flush?: (session: unknown) => Promise<unknown> } | undefined;
			await sessions?.flush?.(agent.session);
		} catch (error) {
			state.questions[sessionId] ??= question;
			throw error;
		}
		await save();
		return true;
	}

	// An answer to an interactive view: validated by the view layer, claimed before the
	// follow-up is queued so a second answer is refused, and put back when queueing fails.
	async function answerView(sessionRef: string, viewId: unknown, action: unknown, values: unknown): Promise<boolean> {
		const validate = member("view-reply", "validateViewAnswer");
		const build = member("view-reply", "viewReply");
		await load();
		const past = pastOwner(sessionRef);
		const sessionId =
			botOf(sessionRef) !== undefined
				? chatOf(sessionRef)
				: past?.roomId === undefined && past?.botId !== undefined
					? chatOf(past.botId)
					: sessionRef;
		const pending = own(state.views, sessionId);
		if (pending === undefined || pending.id !== viewId) throw stale("This view is no longer open");
		const checked = validate(pending.view, action, values);
		if (checked !== undefined && checked.error !== undefined) throw invalid(checked.error);
		const reply = build(pending, action, values);
		if (reply === undefined) throw invalid("Nothing to send");
		// Claim the view before queueing so a second answer is refused.
		delete state.views[sessionId];
		try {
			await record("ensureCapabilities", sessionId);
			const agent = await call("resolveAgent", sessionId);
			const source = reply.source as unknown as MessageSource;
			agent.followup(createUserMessage({ content: [{ type: "text", text: reply.text }], source }));
			const sessions = ctx.sessions as { flush?: (session: unknown) => Promise<unknown> } | undefined;
			await sessions?.flush?.(agent.session);
		} catch (error) {
			state.views[sessionId] ??= pending;
			throw error;
		}
		await save();
		return true;
	}

	const setPrefs = async (body: Payload): Promise<void> => {
		const current = prefs();
		if (body.theme !== undefined) {
			if (typeof body.theme !== "string" || !/^[a-z][\w-]{0,31}$/.test(body.theme)) throw invalid("Unknown theme");
			current.theme = body.theme;
		}
		if (body.accent !== undefined) {
			if (body.accent === null || body.accent === "") delete current.accent;
			else if (/^#[0-9a-f]{6}$/i.test(body.accent)) current.accent = body.accent;
			else throw invalid("Accent must be a #rrggbb color");
		}
		if (body.motion !== undefined) {
			if (body.motion === null || body.motion === "normal") delete current.motion;
			else if (body.motion === "quiet" || body.motion === "lively") current.motion = body.motion;
			else throw invalid("Motion must be quiet, normal or lively");
		}
		if (body.layout !== undefined) {
			if (body.layout === null || body.layout === "bubble") delete current.layout;
			else if (body.layout === "flat") current.layout = body.layout;
			else throw invalid("Layout must be bubble or flat");
		}
		if (body.width !== undefined) {
			if (body.width === null || body.width === 80) delete current.width;
			else if (Number.isInteger(body.width) && body.width >= 50 && body.width <= 100) current.width = body.width;
			else throw invalid("Width must be a whole percent from 50 to 100");
		}
		if (body.flatWidth !== undefined) {
			if (body.flatWidth === null || body.flatWidth === 100) delete current.flatWidth;
			else if (Number.isInteger(body.flatWidth) && body.flatWidth >= 50 && body.flatWidth <= 100)
				current.flatWidth = body.flatWidth;
			else throw invalid("Flat text width must be a whole percent from 50 to 100");
		}
		if (body.defaultBotModel !== undefined) {
			// The saved ref is one the catalog served at save time; a create re-checks it.
			if (body.defaultBotModel === null || body.defaultBotModel === "") delete current.defaultBotModel;
			else {
				if (fn("isLocalAgentRef")?.(body.defaultBotModel) === true) {
					throw invalid(
						"A local agent cannot be the default model: a new Bot chooses to run on one when it is created",
					);
				}
				const resolve = fn("resolveModel");
				if (resolve === undefined) throw unavailable("Choosing a default model");
				current.defaultBotModel = await resolve(body.defaultBotModel);
			}
		}
		if (body.thinking !== undefined) {
			// A value this version does not know is ignored, not refused: the toggle may grow.
			if (body.thinking === true) current.thinking = true;
			else if (body.thinking === false || body.thinking === null) delete current.thinking;
		}
		if (body.enterToSend !== undefined) {
			if (body.enterToSend === false) current.enterToSend = false;
			else if (body.enterToSend === true || body.enterToSend === null) delete current.enterToSend;
		}
		await save();
	};

	const endpoints: Record<string, (body: Payload, signal?: AbortSignal) => Promise<ApiResponse<unknown>>> = {
		async state(body) {
			if (typeof body.locale === "string" && /^[a-z]{2,3}(-[\w-]+)?$/i.test(body.locale)) uiLocale = body.locale;
			if (sync("readOnly") === undefined) {
				await record("bootstrap");
			}
			await record("catalog");
			await record("loadSecrets");
			const answer = liveAnswer();
			if (body.since === state.revision && (body.models === undefined || body.models === modelsKey())) {
				if (body.live === answer.key) {
					return ok({ revision: state.revision, unchanged: true, liveKey: answer.key });
				}
				return ok({ revision: state.revision, unchanged: true, liveKey: answer.key, ...answer.value });
			}
			return ok({ ...view(), liveKey: answer.key, ...answer.value });
		},
		async models() {
			await call("catalog", { fresh: true });
			return ok({ modelsKey: modelsKey() });
		},
		async efforts(body) {
			const efforts = await call("reasoningOf", String(body.ref ?? ""));
			return ok(efforts ?? { efforts: [] });
		},
		async "set-prefs"(body) {
			await load();
			await setPrefs(body);
			return ok(state.prefs);
		},
		async exchange(body) {
			await load();
			const pair = new Set([body.a, body.b]);
			return ok(state.exchanges.filter((entry) => pair.has(entry.from) && pair.has(entry.to)));
		},
		async "exchange-text"(body) {
			await load();
			const entry = state.exchanges.find((item) => item.id === body.id);
			if (entry === undefined) return fail("This message is no longer kept", "bot/stale");
			if (fn("exchangeText") === undefined) throw unavailable("Reading a kept message");
			return ok(await call("exchangeText", entry));
		},
		async "file-text"(body) {
			if (typeof body.file?.attachmentId !== "string") return fail("No file named", "bot/invalid");
			if (fn("fileText") === undefined) throw unavailable("Reading a file");
			const read = await call("fileText", body.file);
			return read === undefined ? fail("This file cannot be read here", "bot/unavailable") : ok(read);
		},
		async "room-progress"(body) {
			// Any part id of the group's own Session means the group itself.
			const room = roomOf(body.roomId) ?? roomOf(pastOwner(body.roomId)?.roomId);
			const progress = roomProgress();
			const wanted = room?.id ?? body.roomId;
			const rows = [...(progress ?? new Map<string, any>()).entries()]
				.filter(([, entry]) => entry?.roomId === wanted)
				.map(([callId, entry]) => ({
					callId,
					replies: entry.replies,
					speaking: (entry.slots ?? [])
						.filter((slot: any) => slot.status === "speaking")
						.map((slot: any) => slot.id),
				}));
			return ok(rows);
		},
		async "create-bot"(body) {
			await record("bootstrap");
			const bot = await call("createBot", {
				name: body.name,
				role: body.role,
				color: body.color,
				instructions: body.instructions,
				brief: body.brief,
				avatar: body.avatar,
				model: body.model,
				effort: body.effort,
				workDir: body.workDir,
			});
			return ok(bot);
		},
		async "update-bot"(body) {
			await load();
			return ok(await call("updateBot", body.id, body));
		},
		async "duplicate-bot"(body) {
			await load();
			return ok(await call("duplicateBot", body.id));
		},
		async "delete-bot"(body) {
			await load();
			await call("deleteBot", body.id);
			return ok(view());
		},
		async "set-main"(body) {
			await load();
			await call("setMain", body.id, body.main !== false, {
				primary: body.primary === true,
				replace: typeof body.replace === "string" ? body.replace : undefined,
			});
			return ok(view());
		},
		async "set-flags"(body) {
			await load();
			return ok(await call("setFlags", body.id, body));
		},
		async resume(body) {
			await load();
			const bot = botOf(String(body.botId ?? ""));
			if (bot === undefined) return fail("Unknown Bot", "bot/not-found");
			await call("resumeBot", bot);
			return ok(true);
		},
		async "create-room"(body) {
			await load();
			const room = await call("createRoom", {
				members: Array.isArray(body.members) ? body.members : [],
				name: body.name,
				...(typeof body.admin === "string" ? { admin: body.admin } : {}),
			});
			if (body.greet === true) {
				const greet = fn("greetRoom");
				if (greet !== undefined) {
					await greet(room.id).catch((error: unknown) =>
						rt.warn("ocean-crew: greeting in %s failed: %s", room.name, error),
					);
				}
			}
			return ok(room);
		},
		async "update-room"(body) {
			await load();
			const { room, changes } = await call("updateRoom", body.id, {
				name: body.name,
				notice: body.notice,
				mode: body.mode,
				admin: body.admin,
				members: Array.isArray(body.members) ? body.members : undefined,
				add: Array.isArray(body.add) ? body.add : undefined,
				remove: Array.isArray(body.remove) ? body.remove : undefined,
				workDir: body.workDir,
				permission: body.permission,
			});
			const rooms = view().rooms as Array<Record<string, unknown>>;
			return ok({ room: rooms.find((entry) => entry.id === room.id), changes });
		},
		async "delete-room"(body) {
			await load();
			await call("deleteRoom", body.id);
			return ok(view());
		},
		async send(body) {
			const text = String(body.text ?? "").trim();
			if (text === "" || typeof body.sessionId !== "string") return fail("Nothing to send", "bot/invalid");
			await load();
			await sendUser({ sessionId: body.sessionId, content: [{ type: "text", text }] });
			return ok(true);
		},
		async "answer-question"(body) {
			if (typeof body.sessionId !== "string") return fail("Nothing to send", "bot/invalid");
			await load();
			return ok(await answerQuestion(body.sessionId, body.questionId, body.answer));
		},
		async "dismiss-question"(body) {
			await load();
			const sessionId = String(body.sessionId ?? "");
			const question = own(state.questions, sessionId);
			if (question !== undefined) {
				sync("closeCard", sessionId, question, "dismissed");
				delete state.questions[sessionId];
				await save();
			}
			return ok(true);
		},
		async "dismiss-view"(body) {
			await load();
			const sessionId = String(body.sessionId ?? "");
			const pending = own(state.views, sessionId);
			if (pending !== undefined) {
				sync("closeCard", sessionId, pending, "dismissed");
				delete state.views[sessionId];
				await save();
			}
			return ok(true);
		},
		async "run-stats"(body) {
			await load();
			const bot = botOf(String(body.botId ?? ""));
			if (bot === undefined) return fail("Unknown Bot", "bot/not-found");
			const projections = ctx.get?.("sessionProjections") as
				| { snapshot?: (session: unknown, names: readonly string[]) => { values?: unknown } }
				| undefined;
			if (typeof projections?.snapshot !== "function") return ok(null);
			const agent = await call("resolveAgent", chatOf(bot.id));
			return ok(projections.snapshot(agent.session, RUN_STATS).values);
		},
		async "stop-member-work"(body) {
			const roomId = String(body.roomId ?? "");
			try {
				return ok(await call("stopMemberWork", roomId, String(body.botId ?? "")));
			} finally {
				sync("goalUserStopped", roomId);
			}
		},
		async "stop-room-work"(body) {
			const roomId = String(body.roomId ?? "");
			try {
				return ok(await call("stopRoomWork", roomId));
			} finally {
				sync("goalUserStopped", roomId);
			}
		},

		// --- Module wiring -----------------------------------------------------
		// Each branch calls the runtime member its module publishes; the module landing is
		// the only change needed for the endpoint to answer, and a missing one refuses only
		// this endpoint through `missingMember`.
		async providers() {
			return ok(await callMember("providers", "providersView"));
		},
		async "provider-key"(body) {
			const providersView = member("provider-key", "providersView");
			if (body.value === null) await callMember("provider-key", "clearProviderKey", String(body.provider ?? ""));
			else await callMember("provider-key", "setProviderKey", String(body.provider ?? ""), body.value);
			return ok(await providersView());
		},
		async "provider-add"(body) {
			return ok(await callMember("provider-add", "addProvider", body));
		},
		async "provider-models"(body) {
			return ok(await callMember("provider-models", "discoverModels", body));
		},
		async "provider-remove"(body) {
			return ok(await callMember("provider-remove", "removeProvider", String(body.provider ?? "")));
		},
		// A Turn's exact thinking time, from the timed stream in its events; `ms` omitted
		// when the stream carries no reasoning records.
		async thinking(body) {
			const thinkingOf = member("thinking", "thinkingOf");
			const sessionId = String(body.sessionId ?? "");
			const turn = Number(body.turn);
			if (!Number.isFinite(turn) || selfOf(sessionId) === undefined) return ok(null);
			await load();
			const ms = await thinkingOf(sessionId, turn);
			return ok(ms === undefined ? {} : { ms });
		},
		async earlier(body) {
			await load();
			return ok(await callMember("earlier", "earlierPage", String(body.sessionId ?? ""), body.cursor ?? undefined));
		},
		async chat(body) {
			await load();
			return ok(await callMember("chat", "chatPage", String(body.botId ?? ""), body.cursor ?? undefined));
		},
		async "bot-new-part"(body) {
			await load();
			const bot = botOf(String(body.botId ?? ""));
			if (bot === undefined) return fail("Unknown Bot", "bot/not-found");
			return ok(await callMember("bot-new-part", "newPart", chatOf(bot.id)));
		},
		async "bot-open-part"(body) {
			await load();
			const bot = botOf(String(body.botId ?? ""));
			if (bot === undefined) return fail("Unknown Bot", "bot/not-found");
			return ok(await callMember("bot-open-part", "switchPart", bot.id, String(body.sessionId ?? "")));
		},
		async usage(body) {
			await load();
			return ok(
				await callMember("usage", "usageView", {
					timeZone: typeof body.timeZone === "string" ? body.timeZone.slice(0, 64) : undefined,
				}),
			);
		},
		async folders(body, signal) {
			await load();
			return ok(await callMember("folders", "folderEndpoint", "folders", body, signal));
		},
		async "folder-pick"(body, signal) {
			await load();
			return ok(await callMember("folder-pick", "folderEndpoint", "folder-pick", body, signal));
		},
		async "folder-list"(body, signal) {
			await load();
			return ok(await callMember("folder-list", "folderEndpoint", "folder-list", body, signal));
		},
		async "team-workspace"(body) {
			await load();
			return ok({ team: await callMember("team-workspace", "setTeamWorkspace", String(body.path ?? "")) });
		},
		async "reset-team"() {
			return ok(await callMember("reset-team", "resetTeam"));
		},
		async "private-release"(body) {
			await load();
			await callMember("private-release", "releaseArchive", String(body.id ?? ""));
			return ok(view());
		},
		// The avatar library: photos the user imported once, kept beside the team.
		async "avatar-library"(body) {
			await load();
			return ok(await callMember("avatar-library", "avatarLibraryView", { offset: body.offset, limit: body.limit }));
		},
		async "avatar-import"(body) {
			await load();
			return ok(
				await callMember("avatar-import", "avatarLibraryImport", Array.isArray(body.items) ? body.items : []),
			);
		},
		async "avatar-delete"(body) {
			await load();
			return ok(await callMember("avatar-delete", "avatarLibraryDelete", String(body.id ?? "")));
		},
		// The team's one DSH Agent.
		async "add-agent"() {
			await load();
			return ok(await callMember("add-agent", "addAgent"));
		},
		async "agent-session"(body) {
			await load();
			return ok({
				sessionId: await callMember("agent-session", "createAgentSession", body.agentId, body.workspaceId),
			});
		},
		async "agent-adopt"(body) {
			await load();
			return ok({
				sessionId: await callMember("agent-adopt", "adoptAgentSession", body.agentId, body.sessionId),
			});
		},
		async "agent-archive"(body) {
			await load();
			await callMember("agent-archive", "archiveAgentSession", body.agentId, body.sessionId);
			return ok(true);
		},
		async "agent-rename"(body) {
			await load();
			await callMember("agent-rename", "renameAgentSession", body.agentId, body.sessionId, body.title);
			return ok(true);
		},
		async "remove-agent"(body) {
			await load();
			await callMember("remove-agent", "removeAgent", body.agentId);
			return ok(view());
		},
		async "approval-answer"(body) {
			member("approval-answer", "answerApproval")(body.id, body.choice);
			return ok(true);
		},
		async "goal-draft"(body) {
			await load();
			const result = await callMember("goal-draft", "goalDraft", String(body.roomId ?? ""), body.text);
			return result?.error !== undefined ? fail(result.error, result.code ?? "bot/refused") : ok(view());
		},
		async "room-budget"(body) {
			const roomId = String(body.roomId ?? "");
			const changing =
				body.clear === true ||
				(body.members !== undefined && body.members !== null) ||
				(body.summary !== undefined && body.summary !== null);
			if (changing) await callMember("room-budget", "setGroupBudget", roomId, body);
			const view = await callMember("room-budget", "groupBudgetView", roomId);
			if (view === undefined) return fail("No such group chat", "bot/not-found");
			return ok(view);
		},
		async "goal-control"(body) {
			await load();
			const result = await callMember("goal-control", "goalControl", String(body.roomId ?? ""), body);
			return result?.error !== undefined ? fail(result.error, result.code ?? "bot/refused") : ok(view());
		},
		async "view-reply"(body) {
			if (typeof body.sessionId !== "string") return fail("Nothing to send", "bot/invalid");
			try {
				await answerView(body.sessionId, body.viewId, body.action, body.values);
			} catch (error: any) {
				// The endpoint's own codes survive: a missing module is unavailable, a refused
				// queue is refused; anything else is the caller's payload.
				return fail(String(error?.message ?? error), errorCode(error));
			}
			return ok(true);
		},
		async "btw-delete"(body) {
			if (
				typeof body.sessionId !== "string" ||
				body.sessionId === "" ||
				typeof body.cardId !== "string" ||
				body.cardId === ""
			) {
				return fail("Nothing to delete", "bot/invalid");
			}
			await load();
			return ok(await callMember("btw-delete", "btwDelete", { sessionId: body.sessionId, cardId: body.cardId }));
		},
		// Side chats: each question is an aside on a fresh snapshot of this Bot's private
		// chat; Nothing is written into the Session.
		async "side-new"(body) {
			if (typeof body.sessionId !== "string" || body.sessionId === "") return fail("Nothing to open", "bot/invalid");
			await load();
			return ok(await callMember("side-new", "sideNew", { sessionId: body.sessionId }));
		},
		async "side-ask"(body) {
			if (typeof body.sessionId !== "string" || body.sessionId === "") return fail("Nothing to ask", "bot/invalid");
			if (body.chatId !== undefined && typeof body.chatId !== "string") return fail("Nothing to ask", "bot/invalid");
			if (String(body.text ?? "").trim() === "") return fail("Write a question.", "bot/invalid");
			await load();
			return ok(
				await callMember("side-ask", "sideAsk", {
					sessionId: body.sessionId,
					chatId: body.chatId,
					recent: body.recent === true,
					text: String(body.text),
				}),
			);
		},
		async "side-cancel"(body) {
			if (
				typeof body.chatId !== "string" ||
				body.chatId === "" ||
				typeof body.entryId !== "string" ||
				body.entryId === ""
			) {
				return fail("Nothing to cancel", "bot/invalid");
			}
			await load();
			return ok(await callMember("side-cancel", "sideCancel", { chatId: body.chatId, entryId: body.entryId }));
		},
		async "side-close"(body) {
			if (typeof body.chatId !== "string" || body.chatId === "") return fail("Nothing to close", "bot/invalid");
			await load();
			return ok(await callMember("side-close", "sideClose", { chatId: body.chatId }));
		},
		async "learning-answer"(body) {
			await load();
			return ok(await callMember("learning-answer", "learningEndpoint", "learning-answer", body));
		},
		async "update-check"(body) {
			const fresh = body.fresh === true;
			const updateCheck = member("update-check", "updateCheck");
			const dshUpdateCheck = fn("dshUpdateCheck");
			return ok({
				...(await updateCheck({ fresh })),
				dsh: (dshUpdateCheck === undefined ? undefined : await dshUpdateCheck({ fresh })) ?? null,
			});
		},
		async "update-install"() {
			return ok(member("update-install", "updateStart")());
		},
		async "dsh-update-install"() {
			return ok(member("dsh-update-install", "dshUpdateStart")());
		},
		async "repo-stars"() {
			return ok(await callMember("repo-stars", "repoStars"));
		},
		async "companion-view"() {
			return ok(await callMember("companion-view", "companionView"));
		},
		async "companion-set"(body) {
			const botId = String((body as Record<string, unknown>)?.botId ?? "");
			if (botId === "") throw Object.assign(new Error("Choose a Bot first"), { code: "bot/invalid" });
			const patch =
				(body as Record<string, unknown>)?.patch !== null &&
				typeof (body as Record<string, unknown>)?.patch === "object"
					? (body as Record<string, any>).patch
					: {};
			return ok(await callMember("companion-set", "companionSet", botId, patch));
		},
		async "tts-settings"() {
			return ok(await callMember("tts-settings", "ttsSettingsView"));
		},
		async "tts-set"(body) {
			const patch =
				body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
			return ok(await callMember("tts-set", "ttsSettingsSet", patch));
		},
		async "tts-voices"() {
			return ok(await callMember("tts-voices", "ttsVoices"));
		},
		async "tts-test"() {
			return ok(await callMember("tts-test", "ttsTest"));
		},
		async diagnostics(body) {
			const service = diagnosticsService("diagnostics", "report");
			await load();
			return ok(await service.report(body));
		},
		async "diagnostics-log"() {
			return ok(await diagnosticsService("diagnostics-log", "logText").logText());
		},
		async "diagnostics-clear"() {
			await diagnosticsService("diagnostics-clear", "clear").clear();
			return ok(true);
		},

		// --- IM wiring ---------------------------------------------------------
	};

	// Groups whose whole family is one pass-through member. The endpoint name and the body

	for (const [endpoint, memberName] of [
		...SECRET_ENDPOINTS.map((name) => [name, "secretEndpoint"] as const),
		...CONNECTOR_MAIL_ENDPOINTS.map((name) => [name, "connectorEndpoint"] as const),
		...CAPABILITY_ENDPOINTS.map((name) => [name, "capabilityEndpoint"] as const),
		...SCHEDULE_ENDPOINTS.map((name) => [name, "scheduleEndpoint"] as const),
		...MEMORY_ENDPOINTS.map((name) => [name, "memoryEndpoint"] as const),
	] as ReadonlyArray<readonly [string, string]>) {
		endpoints[endpoint] = async (body) => {
			await load();
			return ok(await callMember(endpoint, memberName, endpoint, body));
		};
	}
	for (const endpoint of IM_ENDPOINTS) {
		endpoints[endpoint] = async (body) => {
			await load();
			return ok(await member(endpoint, "imEndpoint")(endpoint, body));
		};
	}

	const handle = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ApiResponse<unknown>> => {
		try {
			const body = (payload ?? {}) as Payload;
			await record("refresh");
			const readOnly = sync("readOnly") as string | undefined;
			// A reading host keeps the read surface; every write endpoint names the other host.
			if (readOnly !== undefined && !READS.has(endpoint)) return fail(readOnly, "bot/read-only");
			const handler = endpoints[endpoint];
			if (handler !== undefined) return await handler(body, signal);
			const module = UNAVAILABLE_ENDPOINTS.get(endpoint);
			if (module !== undefined) {
				return fail(`${endpoint}: the ${module} module is not installed in this build.`, "bot/unavailable");
			}
			return fail(`Unknown endpoint ${endpoint}`, "bot/not-found");
		} catch (error) {
			const code = errorCode(error);
			const message = error instanceof Error ? error.message : String(error);
			if (code === "bot/internal") {
				const failure = error as { code?: unknown; stack?: unknown };
				sync("noteFailure", {
					source: "api",
					text: `${endpoint}: ${message}`,
					code: failure.code ?? (error as { name?: unknown })?.name,
					stack: failure.stack,
				});
			}
			return fail(message, code);
		}
	};

	// The buffered route on the shared /api channel; the browser authenticates with its
	// session cookie and always reads HTTP 200, the envelope says what happened.
	const route = {
		path: ROUTE,
		methods: ["POST"],
		requestBody: "buffered" as const,
		async fetch(request: Request): Promise<Response> {
			let body: { endpoint?: unknown; payload?: unknown } = {};
			try {
				body = (await request.json()) as { endpoint?: unknown; payload?: unknown };
			} catch {
				body = {};
			}
			const result = await handle(String(body?.endpoint ?? ""), body?.payload, request.signal);
			return new Response(JSON.stringify(result), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	};

	ctx.effect(() => {
		const connection = ctx.connection ?? (ctx.get?.("connection") as typeof ctx.connection | undefined);
		if (connection === undefined || typeof connection.fetch?.register !== "function") {
			rt.warn("ocean-crew: /api/bot not registered: the connection service is missing");
			return undefined;
		}
		return connection.fetch.register(route);
	}, "ocean-crew: api route");

	ctx.effect(() => {
		// Registered after the route, so this disposer runs before the state lock is released.
		const wanted = fn("load");
		if (wanted !== undefined) {
			void wanted().catch((error: unknown) => rt.warn("ocean-crew: state not loaded: %s", error));
		}
		return undefined;
	}, "ocean-crew: load state");

	Object.assign(rt, { sendUser, answerQuestion, answerView, uiLanguage });
}
