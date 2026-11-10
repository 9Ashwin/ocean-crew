// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a Ocean Crew group.
// The platform adapters (im/platforms/) own the wire; this module owns pairing,
// routing, cards and the send queues. Only the dsh holding the team lock connects.
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IM_PLATFORMS, imPlatform } from "../../shared/im-platforms.ts";
import { viewCardText } from "../chat/parts.ts";
import { failureLine, turnFailure } from "../chat/turns.ts";
import { listenGlobal } from "../core/events.ts";
import { replaceFile } from "../core/files.ts";
import { isPass } from "../groups/log.ts";
import { noticeGate } from "../work/notice-gate.ts";
import { runLog } from "../work/schedule-runs.ts";
import { reportLines } from "../work/stop-all-install.ts";
import { adapters as adapterRegistry } from "./platforms/index.ts";
import { isSupportedImageType } from "./platforms/media-type.ts";
import { startStatusReaction } from "./reaction.ts";
import { reactionKey } from "./reaction-keys.ts";
import { failClass, nextAction } from "./supervisor.ts";

const RECONCILE_MS = 15_000;
const RUNTIME_SAVE_MS = 400;
// How many undelivered texts one chat keeps, and how long a send may stay unconfirmed
// before it is reported as unknown rather than retried forever.
const OUTBOX_LIMIT = 50;
const RETRY_MS = 5_000;
const SEND_TIMEOUT_MS = 60_000;
const QUEUE_LIMIT = 100;
// The largest file an answer may carry out. The bytes are copied under the plugin home
// before the record is written, so a crash cannot leave a message naming a file that is
// gone; the copy is dropped once the send has an outcome.
const MEDIA_LIMIT = 25 * 1024 * 1024;
const TYPING_MS = 4_000;
// The first "typing" pulse does not wait for the four-second tick: a chat should see the
// Bot is working as soon as its message is handed over, not once the turn may already be
// over.
const TYPING_FIRST_MS = 250;
// A reaction left on a message no longer ends on its own; drop it after this long.
const REACTION_MAX_MS = 15 * 60_000;
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/;
// What a file handed to a chat may look like: an image when its extension says so, a
// file otherwise, and a media type for the platforms that want one.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MIME_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	zip: "application/zip",
};

// The registry is read as a map the tests (and a future adapter) can extend by platform id.
const adapters: Record<string, any> = adapterRegistry as any;

const secretField = (key: any) => key.replace(/[A-Z]/g, (char: any) => `_${char}`).toUpperCase();

// The admission reasons the host uses when it cannot take an image as an image.
const IMAGE_REFUSAL_REASONS = new Set([
	"MODEL_DOES_NOT_SUPPORT_IMAGES",
	"IMAGE_TOO_LARGE",
	"IMAGES_TOO_LARGE",
	"IMAGE_TOO_MANY_PIXELS",
	"TOO_MANY_IMAGES",
	"IMAGE_TYPE_MISMATCH",
]);
const isImageRefusal = (error: any): boolean => {
	if (error?.code !== "session/attachment-invalid" && error?.code !== "attachment-error") return false;
	const reason = error?.details?.reason;
	if (reason === undefined) return true;
	return IMAGE_REFUSAL_REASONS.has(String(reason));
};

export function install(rt: any) {
	const { ctx } = rt;

	// works through its own record type. One cast states that gap.
	const state: any = rt.state as any;
	const imDir = join(rt.home, "im");
	const mediaDir = join(imDir, "media");
	// The health check and the per-message timeout; the plugin config may shorten
	// them, which the unit tests use to see the supervisor work without fake timers.
	const reconcileMs = Number(rt.config?.imReconcileMs) > 0 ? Number(rt.config.imReconcileMs) : RECONCILE_MS;
	const sendTimeoutMs = Number(rt.config?.imSendTimeoutMs) > 0 ? Number(rt.config.imSendTimeoutMs) : SEND_TIMEOUT_MS;
	const zh = () => String(rt.uiLanguage?.() ?? "").startsWith("Chinese");
	const text = (key: any, values: any = {}) => {
		const line: string | undefined = (
			{
				requested: zh()
					? "已向 Ocean Crew 发出连接请求，请在电脑上的 Ocean Crew 设置 → IM 里允许。"
					: "A connection request was sent to Ocean Crew; allow it in Settings → IM on the computer.",
				unbound: zh()
					? "这个 IM 机器人还没绑定 Bot，请在 Ocean Crew 设置 → IM 里选一个。"
					: "This IM bot is not bound to a Bot yet; pick one in Ocean Crew Settings → IM.",
				unboundGroup: zh()
					? "这个群还没绑定，请在 Ocean Crew 设置 → IM 里给它选一个群或 Bot。"
					: "This group is not bound yet; pick a group or a Bot for it in Ocean Crew Settings → IM.",
				connected: zh()
					? `已连接，现在可以和 ${values.target} 说话了。`
					: `Connected — you can talk to ${values.target} now.`,
				stopped: zh() ? "已停下。" : "Stopped.",
				idle: zh() ? "现在没有在做的活。" : "Nothing is running.",
				stale: zh() ? "这张卡已经答过了。" : "This card was already answered.",
				noFile: zh()
					? "这个文件发不过去，请在电脑上发。"
					: "This file cannot be sent here; send it on the computer.",
				greeting: zh() ? `你好，我是 ${values.name}。` : `Hello, I am ${values.name}.`,
				question: zh() ? `${values.bot} 问你：` : `${values.bot} asks: `,
				approval: zh() ? `${values.bot} 请你审批：` : `${values.bot} asks for approval: `,
				secretAsk: zh()
					? `${values.bot} 要密钥 ${values.name}，请在电脑或手机 App 上填。`
					: `${values.bot} needs the key ${values.name} — fill it on the computer or the phone app.`,
				viewShow: zh()
					? `${values.bot} 发了一个卡片，请在电脑或手机 App 上回复。`
					: `${values.bot} shared a card — answer it on the computer or the phone app.`,
				viewPick: zh()
					? `${values.bot} 发了一个卡片，点下面的按钮就能回答。`
					: `${values.bot} shared a card — press a button below to answer.`,
				answered: zh() ? "已答" : "answered",
				scheduledFailed: zh()
					? `${values.bot} 的定时任务这次没跑成：${values.reason}。修好后它会继续跑。`
					: `${values.bot}'s scheduled task did not run: ${values.reason}. It resumes once that is fixed.`,
				cmdHelpBody: zh() ? "可以用的命令" : "Commands",
				cmdStatus: zh()
					? `${values.bot}：模型 ${values.model}；${values.running ? "正在工作" : "空闲"}；已开 ${values.parts} 段会话。`
					: `${values.bot}: model ${values.model}; ${values.running ? "working" : "idle"}; ${values.parts} conversation part(s).`,
				cmdStopped: zh() ? "已停止当前回合。" : "Stopped the running turn.",
				cmdNothingRunning: zh() ? "现在没有在运行的任务。" : "Nothing is running.",
				cmdNewStarted: zh()
					? "已开始一段新会话，之前的上下文留在了上一段。"
					: "Started a fresh conversation; the earlier context stays in the previous part.",
				cmdNewBusy: zh()
					? "Bot 正在工作，先 /stop 或等它结束。"
					: "The Bot is working; /stop first or wait for it to finish.",
				cmdGroupOnly: zh()
					? "这个命令只能在和 Bot 的私聊里用。"
					: "This command only works in a direct chat with the Bot.",
				submit: zh() ? "提交" : "Send",
				cancel: zh() ? "取消" : "Cancel",
				yes: zh() ? "是" : "Yes",
				no: zh() ? "否" : "No",
				pickMany: zh() ? "可多选" : "Choose one or more",
				menuBody: zh() ? `${values.bot} 的操作：下面是常用动作。` : `${values.bot} actions — pick one below.`,
				stop: zh() ? "停止" : "Stop",
				newPart: zh() ? "开新会话" : "New conversation",
				status: zh() ? "状态" : "Status",
				help: zh() ? "帮助" : "Help",
				cmdUnknown: zh()
					? `没有这个命令：${values.name}。发 /help 看看。`
					: `No such command: ${values.name}. Send /help.`,
				imageAsFile: zh()
					? `图片没能直接给模型看（可能是当前模型不支持看图或文件过大），已作为 ${values.count} 个文件附上，可以用工具打开。`
					: `The image could not be shown to the model (the model may not read images, or the file was too large); it is attached as ${values.count} file(s) for your tools to open.`,
				numbers: zh() ? "回复编号" : "reply with the number",
				numbersMulti: zh() ? "回复编号，多选用空格隔开" : "reply with the numbers, separated by spaces",
				allow: zh() ? "允许一次" : "Allow once",
				reject: zh() ? "拒绝" : "Reject",
			} as Record<string, string>
		)[key];
		return line ?? key;
	};

	// ---------------------------------------------------------------- outbox
	// Undelivered texts, per connection and chat, persisted beside the runtime file so a
	// restart or a crash does not lose a reply the user is waiting for. Card sends keep
	// their own persisted record (`cards`); this holds the plain texts and their state.
	//
	// A record is `{ id, chatKey, chat, state, attempts, body, buttons? }`. `body` and
	// `buttons` are what the adapter needs; `state` is one of:
	//   queued    - never attempted, or the platform refused without accepting it
	//   sending   - an attempt was made and its outcome is not known yet (crash during send)
	//   unknown   - the platform may have accepted it; never resent automatically
	// A record is removed once the adapter resolves the send.
	const outboxes = new Map(); // conn id → { data: { chats: { [chatKey]: records[] } }, timer }
	const outboxPath = (id: any) => join(imDir, `${id}.outbox.json`);
	const outboxOf = async (id: any) => {
		let held = outboxes.get(id);
		if (held !== undefined) return held;
		let data: any;
		let unreadable: any;
		try {
			data = JSON.parse(await readFile(outboxPath(id), "utf8"));
		} catch (error: any) {
			// No file yet is the normal first start for a connection. Anything else means
			// records exist but cannot be trusted: keep them for inspection and say so,
			// instead of silently replacing them with an empty set.
			if (error?.code !== "ENOENT") unreadable = error;
		}
		if (unreadable !== undefined) {
			const kept = `${outboxPath(id)}.corrupt-${Date.now()}`;
			await rename(outboxPath(id), kept).catch(() => {});
			rt.warn(
				"ocean-crew: im outbox %s is unreadable (%s); kept it at %s and started empty",
				id,
				String(unreadable?.message ?? unreadable),
				kept,
			);
		}
		held = {
			data: {
				chats:
					data?.chats !== null && typeof data?.chats === "object" && !Array.isArray(data.chats) ? data.chats : {},
			},
			timer: undefined,
		};
		outboxes.set(id, held);
		return held;
	};
	// One write at a time per connection: two messages accepted together share the same
	// temp path, and letting the writes interleave makes the loser fail for no reason.
	const outboxWrites = new Map<any, Promise<unknown>>();
	const writeOutbox = async (id: any): Promise<void> => {
		const run = async () => {
			const held = outboxes.get(id);
			if (held === undefined) return;
			if (rt.readOnly() !== undefined) {
				throw Object.assign(new Error(`this host cannot write the im outbox: ${rt.readOnly()}`), {
					code: "bot/read-only",
				});
			}
			try {
				await mkdir(imDir, { recursive: true });
			} catch (error: any) {
				// Two connections writing at once can race the recursive mkdir on Linux;
				// the directory existing is exactly the outcome this needs.
				if (error?.code !== "EEXIST") throw error;
			}
			const temp = join(imDir, `${id}.outbox.${process.pid}.tmp`);
			try {
				await writeFile(temp, JSON.stringify(held.data), { encoding: "utf8", mode: 0o600 });
				await chmod(temp, 0o600);
				await replaceFile(temp, outboxPath(id));
			} catch (error: any) {
				await rm(temp, { force: true }).catch(() => {});
				throw error;
			}
		};
		const previous = outboxWrites.get(id) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(run);
		outboxWrites.set(id, next);
		try {
			await next;
		} finally {
			if (outboxWrites.get(id) === next) outboxWrites.delete(id);
		}
	};
	// One outgoing attachment on disk: the record in the outbox names this file, so a
	// restart after the crash can still send exactly what the Bot handed over.
	const mediaPath = (name: string): string => {
		const safe = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(-80) || "file";
		return join(mediaDir, `${randomUUID()}-${safe}`);
	};
	const saveMedia = async (kind: "image" | "file", name: string, data: Uint8Array): Promise<any> => {
		if (data.byteLength > MEDIA_LIMIT) throw new Error(`the file is larger than ${MEDIA_LIMIT} bytes`);
		await mkdir(mediaDir, { recursive: true });
		const path = mediaPath(name);
		await writeFile(path, data, { mode: 0o600 });
		return { kind, name, path };
	};
	const dropMedia = (held: any): Promise<void> =>
		held?.path === undefined ? Promise.resolve() : rm(held.path, { force: true }).catch(() => {});

	// Records for one chat, in send order; a chat with none is absent.
	const outboxRecords = async (id: any, chatKey: any): Promise<any[]> => {
		const held = await outboxOf(id);
		const list = held.data.chats[chatKey];
		return Array.isArray(list) ? list : [];
	};
	const outboxAdd = async (id: any, chatKey: any, record: any) => {
		const held = await outboxOf(id);
		const list = Array.isArray(held.data.chats[chatKey]) ? held.data.chats[chatKey] : [];
		list.push(record);
		// Over the bound, a message that was never attempted goes first: an `unknown` one
		// is evidence the user may need to see and a `sending` one is still in flight, so
		// neither is evicted the way a stale queued text can be.
		while (list.length > OUTBOX_LIMIT) {
			const at = list.findIndex((entry: any) => entry.state === "queued" || entry.state === "failed");
			if (at === -1) break;
			list.splice(at, 1);
		}
		held.data.chats[chatKey] = list;
		// The record is durable before the caller may act on it.
		await writeOutbox(id);
	};
	const outboxUpdate = async (id: any, chatKey: any, recordId: any, patch: any) => {
		const held = await outboxOf(id);
		const list = held.data.chats[chatKey];
		if (!Array.isArray(list)) return;
		const record = list.find((entry: any) => entry.id === recordId);
		if (record === undefined) return;
		Object.assign(record, patch);
		await writeOutbox(id);
	};
	const outboxRemove = async (id: any, chatKey: any, recordId: any) => {
		const held = await outboxOf(id);
		const list = held.data.chats[chatKey];
		if (!Array.isArray(list)) return;
		const at = list.findIndex((entry: any) => entry.id === recordId);
		if (at === -1) return;
		list.splice(at, 1);
		if (list.length === 0) delete held.data.chats[chatKey];
		await writeOutbox(id);
	};
	ctx.effect(
		() => () => {
			for (const held of outboxes.values()) clearTimeout(held.timer);
			outboxes.clear();
		},
		"ocean-crew: im outbox",
	);

	// ---------------------------------------------------------------- runtime file
	const runtimes = new Map(); // id → { data: {runtime, cards, open}, timer }
	const runtimeOf = async (id: any) => {
		let held = runtimes.get(id);
		if (held !== undefined) return held;
		let data: any;
		try {
			data = JSON.parse(await readFile(join(imDir, `${id}.json`), "utf8"));
		} catch {
			data = undefined;
		}
		held = {
			data: {
				runtime: data?.runtime !== null && typeof data?.runtime === "object" ? data.runtime : {},
				cards: data?.cards !== null && typeof data?.cards === "object" ? data.cards : {},
			},
			timer: undefined,
		};
		runtimes.set(id, held);
		return held;
	};
	const scheduleWrite = (id: any) => {
		const held = runtimes.get(id);
		if (held === undefined || held.timer !== undefined) return;
		held.timer = setTimeout(() => {
			held.timer = undefined;
			void writeRuntime(id).catch((error) => rt.warn("ocean-crew: im runtime %s not saved: %s", id, error));
		}, RUNTIME_SAVE_MS);
		held.timer.unref?.();
	};
	const writeRuntime = async (id: any) => {
		const held = runtimes.get(id);
		if (held === undefined || rt.readOnly() !== undefined) return;
		await mkdir(imDir, { recursive: true });
		const temp = join(imDir, `${id}.${process.pid}.tmp`);
		try {
			await writeFile(temp, JSON.stringify(held.data), { encoding: "utf8", mode: 0o600 });
			await chmod(temp, 0o600);
			await replaceFile(temp, join(imDir, `${id}.json`));
		} catch (error: any) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
	};
	const runtimeEnv = async (id: any) => {
		const held = await runtimeOf(id);
		return {
			get: () => held.data.runtime,
			set: (patch: any) => {
				Object.assign(held.data.runtime, patch);
				scheduleWrite(id);
			},
		};
	};
	// Sent cards: cardKey → [{ chatKey, messageId, answer? }]. Persisted so a restart
	// does not send a card twice; an `answer` marks it settled from this side.
	const cardsOf = async (id: any) => (await runtimeOf(id)).data;
	const markCard = async (id: any, cardKey: any, chatKey: any, messageId: any, body: any) => {
		const data = await cardsOf(id);
		const entries = data.cards[cardKey] ?? [];
		const held = entries.find((entry: any) => entry.chatKey === chatKey);
		if (held !== undefined) {
			held.messageId = messageId ?? held.messageId;
			held.text = body ?? held.text;
		} else {
			entries.push({ chatKey, messageId, text: body });
		}
		data.cards[cardKey] = entries;
		scheduleWrite(id);
	};
	const settleCard = async (id: any, cardKey: any, answer: any) => {
		const data = await cardsOf(id);
		const entries = data.cards[cardKey];
		if (entries === undefined) return;
		for (const entry of entries) entry.answer ??= answer;
		scheduleWrite(id);
	};

	// ------------------------------------------------------------- connections
	// A binding change makes an older route unsafe: bump the generation so a recorded
	// request no longer resolves to this connection.
	const touchBinding = (conn: any) => {
		conn.revision = Number(conn.revision ?? 0) + 1;
	};
	const connections = (): Record<string, any> => {
		state.im ??= { connections: {} };
		state.im.connections ??= {};
		return state.im.connections;
	};
	const adaptersFor = () => Object.keys(adapters);
	const hasSecrets = (conn: any) =>
		Object.values(conn.secrets ?? {}).every((name) => rt.secretValue(name) !== undefined);
	const fieldsOf = (conn: any) => {
		const fields: Record<string, any> = { ...conn.settings };
		for (const [key, name] of Object.entries(conn.secrets ?? {})) fields[key] = rt.secretValue(name);
		return fields;
	};
	const envFor = async (conn: any, runtime?: any) => ({
		fetch: globalThis.fetch,
		WebSocket: globalThis.WebSocket,
		config: rt.config.im?.[conn.platform],
		runtime: runtime ?? (await runtimeEnv(conn.id)),
		log: { warn: (template: any, ...args: any[]) => rt.warn(template, ...args) },
		uploadFile: async (sessionId: any, file: any) => {
			const uploads = ctx.get?.("fileUploads");
			if (typeof uploads?.uploadStream !== "function") throw new Error("no upload service");
			const data =
				file.data?.[Symbol.asyncIterator] !== undefined
					? file.data
					: (async function* () {
							yield file.data;
						})();
			const value = await uploads.uploadStream({ sessionId, data, name: file.name });
			return value.receiptId;
		},
	});

	// ------------------------------------------------------------------ send out
	/** @type {Map<string, {handle:any, queues:Map<string, {jobs:any[], retry?:any, sending?:any}>, statuses:Map}>} */
	const runners = new Map();
	const statuses = new Map();
	const referenceId = () => `MF-${randomBytes(4).toString("hex")}`;
	const setStatus = (id: any, patch: any) => {
		const next = { ...statuses.get(id), ...patch, at: Date.now() };
		// Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
		if (typeof next.error === "string" && next.error !== "") next.error = rt.redactSecrets(next.error);
		statuses.set(id, next);
		return next;
	};
	// Where a piece of work came from: the connection and chat of the IM message that
	// started it. It is recorded per request and bound to the turn that request started,
	// so a later message from another chat cannot steal an earlier turn's replies. A turn
	// that started in the window has no record and sends nothing to IM.
	//
	// It is persisted in `state.im.origins` on purpose: resolving the target from the
	// "current" event instead is what makes a background result land in whichever chat
	// spoke last.
	type ImOrigin = {
		connId: string;
		chatKey: string;
		ownerKey: string;
		messageId?: string;
		actor?: string;
		/** The connection's binding generation when the request arrived. */
		revision: number;
		at: number;
	};
	const origins = (): Record<string, ImOrigin> => {
		// `im` is optional in the saved state; a team made before IM existed gets one here.
		state.im ??= { connections: {} };
		const held = state.im as Record<string, any>;
		held.connections ??= {};
		if (held.origins === null || typeof held.origins !== "object" || Array.isArray(held.origins)) held.origins = {};
		return held.origins as Record<string, ImOrigin>;
	};
	const noteOrigin = (
		requestId: string,
		conn: any,
		chat: any,
		ownerKey: string,
		messageId?: string,
		actor?: string,
	) => {
		const all = origins();
		// Immutable: a record answers one request, and a later request writes its own.
		all[requestId] = {
			connId: conn.id,
			chatKey: chat.key,
			ownerKey,
			revision: Number(conn.revision ?? 0),
			at: Date.now(),
			...(typeof messageId === "string" && messageId !== "" ? { messageId } : {}),
			...(typeof actor === "string" && actor !== "" ? { actor } : {}),
		};
		// The origin is part of the team state, so another window sees the same routing.
		void rt.save().catch((error: any) => rt.warn("ocean-crew: im origin not saved: %s", error));
	};
	const originOf = (requestId: string | undefined) => {
		if (requestId === undefined || requestId === "") return undefined;
		const held = origins()[requestId];
		// A request older than a day is no longer something a reply belongs to.
		if (held === undefined || Date.now() - held.at > 24 * 60 * 60_000) return undefined;
		return held;
	};

	// Which request a session's turn belongs to. A turn that started in the window is
	// bound to "" so it cannot fall back to an earlier IM request.
	const turnOrigins = new Map<string, string>();
	const sessionOrigins = new Map<string, string>();
	// DSH's user/message carries the message, not the turn it belongs to: the turn is on
	// the turn/start event that opens it. The current turn is remembered from there, and a
	// message that arrives before its turn/start is bound when the start lands.
	const currentTurns = new Map<string, number>();
	const waitingTurns = new Map<string, string>();
	let sawSessionEvent = false;
	// Latest request that addressed each Bot or group, for lines that carry no request.
	const ownerOrigins = new Map<string, string>();
	const turnKey = (sessionId: string, turn: number) => `${sessionId}:${turn}`;
	const bindTurn = (sessionId: string, turn: unknown, requestId: string) => {
		if (typeof turn === "number" && Number.isInteger(turn)) turnOrigins.set(turnKey(sessionId, turn), requestId);
	};
	// The request an outbound event belongs to. A turn with no binding does not guess:
	// after a restart an old turn is not something to send to the last chat that spoke.
	// The turn an event belongs to, when the event names it or when the Session's current
	// turn was told by turn/start.
	const turnOf = (sessionId: string, event: any): number | undefined => {
		const named = event?.data?.turn;
		if (typeof named === "number" && Number.isInteger(named)) return named;
		return currentTurns.get(sessionId);
	};
	const requestFor = (sessionId: string, event: any): string | undefined => {
		const turn = turnOf(sessionId, event);
		if (turn !== undefined) {
			const bound = turnOrigins.get(turnKey(sessionId, turn));
			return bound === undefined || bound === "" ? undefined : bound;
		}
		return sessionOrigins.get(sessionId);
	};

	// The last text a window turn produced, held until the turn ends so one answer goes
	// out instead of every step. Only used when `imDeliverAnswers` is on.
	const windowAnswers = new Map<string, string>();
	// A scheduled run that failed is the one thing a user cannot see from the window: the
	// turn has no answer to push, and the failure card only exists on the desktop. The record
	// says what happened; the notice tells them once, and again only if the reason changes.
	const failureCodesSent = new Map<string, string>();
	// The notice a failed scheduled run sends: the chat that last talked to the Bot, in the
	// words a person reads, never the raw failure payload.
	const notifyFailure = async (ownerId: string | undefined, record: any): Promise<void> => {
		const owner = ownerId ?? [...rt.chatOwners.entries()].find(([, bot]) => bot !== undefined)?.[1];
		if (owner === undefined) return;
		const bot = rt.botOf(owner);
		if (bot === undefined) return;
		const targets = replyTargets(ownerOrigins.get(owner), `bot:${owner}`);
		if (targets.length === 0) {
			rt.warn("ocean-crew: scheduled task of %s failed and has no chat to report to", owner);
			return;
		}
		const body = text("scheduledFailed", {
			bot: bot.name,
			reason: String(record.reason ?? record.code ?? "an error"),
		});
		// A task that cannot run is a blocked decision, not a chatty update: it goes out even
		// in quiet hours, and the same failure is not repeated before it is fixed.
		await gate.offer(
			{
				kind: "pending",
				noticeId: `schedule-failure:${owner}:${record.code ?? record.reason ?? "error"}`,
				items: [{ itemId: record.taskId, kind: "failure", title: body, since: record.startedAt }],
			},
			async () => {
				for (const { conn, chatKey, chat } of targets)
					await sendTo(
						conn,
						chatKey,
						{ key: chatKey, kind: chat.kind, title: chat.title },
						body,
						undefined,
						undefined,
						undefined,
						{ card: true, ...(bot.name === undefined ? {} : { title: bot.name }) },
					);
			},
		);
	};

	const recordScheduledRun = (
		sessionId: string,
		run: { taskId?: string; ownerId?: string; startedAt: number },
		event: any,
	): void => {
		if (run.taskId === undefined) return;
		const reason: any = event.data?.reason;
		const failed = reason?.kind === "error";
		const silent = notifyAnswers.get(sessionId) === undefined;
		const code = failed ? String(turnFailure(reason.error)?.code ?? "error").slice(0, 60) : undefined;
		const record = {
			taskId: run.taskId,
			sessionId,
			...(run.ownerId === undefined ? {} : { ownerId: run.ownerId }),
			startedAt: run.startedAt,
			finishedAt: Date.now(),
			outcome: (failed ? "failed" : silent ? "silent" : "answered") as "failed" | "silent" | "answered",
			...(failed ? { reason: failureLine(turnFailure(reason.error)).slice(0, 200) } : {}),
			...(code === undefined ? {} : { code }),
		};
		void alertRuns.append(record).catch((error: any) => {
			rt.warn("ocean-crew: schedule run not recorded: %s", error?.message ?? error);
		});
		if (!failed) {
			// A later success clears the dedupe, so a recurrence is news again.
			if (run.ownerId !== undefined) failureCodesSent.delete(run.ownerId);
			return;
		}
		if (run.ownerId !== undefined && failureCodesSent.get(run.ownerId) === code) return;
		if (run.ownerId !== undefined && code !== undefined) failureCodesSent.set(run.ownerId, code);
		void notifyFailure(run.ownerId, record);
	};

	// A turn a scheduled reminder started: its answer is pushed to the chat that last
	// talked to this Bot, so a reminder the user set up reaches them in IM.
	const scheduledTurns = new Set<string>();
	// The run in flight for a scheduled turn: the task it came from and when it started, so
	// the record can say "ran and failed" rather than leaving the task looking untouched.
	const scheduledRuns = new Map<string, { taskId?: string; ownerId?: string; startedAt: number }>();
	const alertRuns = runLog(rt.home);
	// Every unsolicited message passes one gate, so dedupe, quiet hours and the user's
	// preferences are decided in one place instead of per path.
	const gate = noticeGate({
		home: rt.home,
		preferences: () => ({
			noChange: rt.config?.imNotify === false ? "silent" : "all_clear",
			...(rt.config?.imSuggestions === true
				? { suggestions: { minValue: 0.5, minGapMs: 6 * 60 * 60_000, rejectionCooldownMs: 24 * 60 * 60_000 } }
				: {}),
		}),
		warn: (message: string, error: unknown) => rt.warn(message, error),
	});
	const notifyAnswers = new Map<string, string>();
	const spokenAnswers = new Map<string, string>();

	const targetsOf = (conn: any) => {
		const out: any[] = [];
		for (const [chatKey, chat] of Object.entries((conn.chats ?? {}) as Record<string, any>)) {
			const target = chat.target ?? (chat.kind === "direct" ? { botId: conn.botId } : undefined);
			out.push({ chatKey, chat, target });
		}
		return out;
	};
	// Chats of this connection that listen to a Bot's own chat or a group.
	const listeners = (conn: any, match: any) =>
		targetsOf(conn).filter(({ target }) => {
			if (match.botId !== undefined) return target?.botId === match.botId && rt.botOf(target.botId) !== undefined;
			if (match.roomId !== undefined)
				return target?.roomId === match.roomId && rt.roomOf(target.roomId) !== undefined;
			return false;
		});

	// The chats one Bot's reply reaches. Default: the chat the request came from, on the
	// connection it came from. `mirror: "all"` on that connection keeps the old behaviour
	// of every chat that listens to the Bot. No request means the turn started in the
	// window, and the window is not mirrored into IM.
	const matchOf = (ownerKey: string): { botId?: string; roomId?: string } =>
		rt.roomOf(ownerKey) !== undefined ? { roomId: ownerKey } : { botId: ownerKey };
	const replyTargets = (
		requestId: string | undefined,
		ownerKey: string,
	): Array<{ conn: any; chatKey: string; chat: any }> => {
		const record = originOf(requestId);
		const keyOf = (owner: string) => (rt.roomOf(owner) !== undefined ? `room:${owner}` : `bot:${owner}`);
		if (record === undefined || keyOf(record.ownerKey) !== ownerKey) return [];
		const conn = connections()[record.connId];
		if (conn === undefined || !runners.has(conn.id)) return [];
		// A binding change (new target, unpair, removal) invalidates the older route: a
		// reply must not go to a chat that no longer listens to this Bot.
		if (Number(conn.revision ?? 0) !== record.revision) return [];
		const chat = conn.chats?.[record.chatKey];
		if (chat === undefined) return [];
		const target = chat.target ?? (chat.kind === "direct" ? { botId: conn.botId } : undefined);
		if (target === undefined) return [];
		const resolved = target.botId !== undefined ? `bot:${target.botId}` : `room:${target.roomId}`;
		if (
			resolved !== (rt.roomOf(record.ownerKey) !== undefined ? `room:${record.ownerKey}` : `bot:${record.ownerKey}`)
		)
			return [];
		if (target.botId !== undefined && rt.botOf(target.botId) === undefined) return [];
		if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined) return [];
		if (conn.mirror === "all") {
			return listeners(conn, matchOf(record.ownerKey)).map(({ chatKey, chat: held }) => ({
				conn,
				chatKey,
				chat: held,
			}));
		}
		return [{ conn, chatKey: record.chatKey, chat }];
	};

	// A job waits in the in-memory queue and, written first, in the outbox: a crash
	// between the two leaves a record that the next start resends, never a silent loss.
	// Accepting a message therefore means its queued record is already on disk; a message
	// whose record cannot be written is not accepted, because nothing would bring it back.
	const enqueue = async (conn: any, chatKey: any, job: any): Promise<boolean> => {
		const runner = runners.get(conn.id);
		if (runner === undefined) return false;
		// A host that does not own the team must not dispatch: the owner would send too.
		if (rt.writerMode() === "readonly") {
			rt.warn("ocean-crew: im send for %s refused: %s", conn.id, rt.readOnly());
			return false;
		}
		const record = {
			id: randomUUID(),
			...(job.outboxId === undefined ? {} : { id: job.outboxId }),
			chat: job.chat,
			state: "queued",
			attempts: 0,
			body: job.text,
			...(job.buttons === undefined ? {} : { buttons: job.buttons }),
			...(job.media === undefined ? {} : { media: job.media }),
		};
		job.outboxId = record.id;
		let queue = runner.queues.get(chatKey);
		if (queue === undefined) {
			queue = { jobs: [] };
			runner.queues.set(chatKey, queue);
		}
		if (queue.jobs.length >= QUEUE_LIMIT) {
			// Never drop the in-flight head: the successful send shifts its own job.
			const at = queue.sending === queue.jobs[0] ? 1 : 0;
			const [dropped] = queue.jobs.splice(at, 1);
			if (dropped?.outboxId !== undefined) await outboxRemove(conn.id, chatKey, dropped.outboxId).catch(() => {});
			rt.warn("ocean-crew: im send queue for %s/%s is full; dropped the oldest message", conn.id, chatKey);
		}
		if (job.restored !== true) {
			try {
				await outboxAdd(conn.id, chatKey, record);
			} catch (error: any) {
				rt.warn("ocean-crew: im message for %s not accepted: %s", conn.id, error);
				setStatus(conn.id, {
					state: "error",
					error: `This message could not be queued for sending: ${rt.redactSecrets(String(error?.message ?? error)).slice(0, 200)}`,
				});
				return false;
			}
		}
		queue.jobs.push(job);
		void drain(conn, chatKey);
		return true;
	};
	// A platform send that never settles must not block this chat forever: the
	// message is dropped as unknown after the timeout and the queue moves on.
	const withSendTimeout = (sending: any) => {
		if (!(sendTimeoutMs > 0)) return sending;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(Object.assign(new Error(`send timed out after ${sendTimeoutMs}ms`), { unknown: true }));
			}, sendTimeoutMs);
			timer.unref?.();
			sending.then(
				(value: any) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: any) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	};
	const dropSend = (conn: any, how: any, error: any, notify = false) => {
		const message = rt.redactSecrets(String(error?.message ?? error)).slice(0, 300);
		const reference = referenceId();
		if (notify)
			rt.warn(
				"ocean-crew: an IM notification for %s was not delivered; the platform may require the chat to message the Bot first",
				conn.id,
			);
		if (how === "permanent") {
			// The connection may be fine; mark the message failure so the supervisor
			// does not restart the link, and clear it on the next successful send.
			setStatus(conn.id, { state: "error", error: message, referenceId: reference, messageError: true });
			rt.warn("ocean-crew: im send for %s failed (%s): %s", conn.id, reference, message);
			return;
		}
		// Unknown: one message is gone, but the connection itself must not look broken.
		setStatus(conn.id, { referenceId: reference, error: message });
		rt.warn("ocean-crew: im send for %s dropped (%s): %s", conn.id, reference, message);
	};
	// One drain loop per chat. Enqueue cannot start a second one: with a durable write in
	// front of the queue, two messages can be accepted while the first is still being
	// persisted, and a "queue length is one" check would miss that case.
	const drain = async (conn: any, chatKey: any): Promise<void> => {
		const queue = runners.get(conn.id)?.queues.get(chatKey);
		if (queue === undefined || queue.active === true) return;
		queue.active = true;
		try {
			await drainLoop(conn, chatKey);
		} finally {
			queue.active = false;
		}
		// A message accepted while the loop was finishing still has to be sent, but a
		// pending retry or a connection without a handle has its own wake-up.
		if (queue.jobs.length > 0 && queue.retry === undefined && runners.get(conn.id)?.handle !== undefined) {
			void drain(conn, chatKey);
		}
	};
	const drainLoop = async (conn: any, chatKey: any) => {
		const runner = runners.get(conn.id);
		const queue = runner?.queues.get(chatKey);
		// A reserved slot has no handle until connect() lands; start() re-kicks
		// anything queued in the meantime.
		if (runner?.handle === undefined || queue === undefined) return;
		while (queue.jobs.length > 0) {
			const job = queue.jobs[0];
			queue.sending = job;
			if (job.outboxId !== undefined) {
				// Written before the attempt, and awaited: a crash after this point leaves a
				// record the next start reports as unknown instead of resending blindly.
				try {
					await outboxUpdate(conn.id, chatKey, job.outboxId, { state: "sending" });
				} catch (error: any) {
					// The attempt cannot be recorded, so it must not start: sending anyway is
					// how a message the platform accepted goes missing with no trace.
					rt.warn("ocean-crew: im send for %s not attempted: %s", conn.id, error);
					queue.retry = setTimeout(() => {
						queue.retry = undefined;
						void drain(conn, chatKey);
					}, RETRY_MS);
					queue.retry.unref?.();
					return;
				}
			}
			try {
				let media: any[] | undefined;
				if (Array.isArray(job.media) && job.media.length > 0) {
					media = [];
					for (const held of job.media) {
						try {
							media.push({
								kind: held.kind,
								name: held.name,
								...(held.mime === undefined ? {} : { mime: held.mime }),
								...(held.voice === true ? { voice: true } : {}),
								data: await readFile(held.path),
							});
						} catch (error: any) {
							// The copy is missing (another host cleaned it): the file is lost, and
							// the text still goes rather than the whole job failing.
							rt.warn("ocean-crew: im media for %s is gone: %s", conn.id, error?.message ?? error);
						}
					}
				}
				// The adapter addresses the chat by `chat.key`; a job restored from the outbox
				// or built from a stored chat entry may only know the key the queue uses.
				const chat = job.chat?.key === undefined ? { ...job.chat, key: chatKey } : job.chat;
				const sent = await withSendTimeout(runner.handle.send(chat, media === undefined ? job : { ...job, media }));
				for (const held of job.media ?? []) await dropMedia(held);
				job.after?.(sent);
				queue.jobs.shift();
				if (job.outboxId !== undefined) {
					void outboxRemove(conn.id, chatKey, job.outboxId).catch((error) =>
						rt.warn("ocean-crew: im outbox for %s not cleaned up: %s", conn.id, error),
					);
				}
				if (statuses.get(conn.id)?.messageError === true) {
					setStatus(conn.id, { state: "ready", error: undefined, referenceId: undefined, messageError: false });
				}
			} catch (error: any) {
				const how: any = failClass(error);
				if (how === "retry") {
					// The platform refused without accepting it: the record stays queued.
					if (job.outboxId !== undefined)
						await outboxUpdate(conn.id, chatKey, job.outboxId, { state: "queued" }).catch(() => {});
					const wait = Number(error?.retryAfter) > 0 ? error.retryAfter * 1000 : RETRY_MS;
					queue.retry = setTimeout(() => {
						void drain(conn, chatKey);
					}, wait);
					queue.retry.unref?.();
					return;
				}
				queue.jobs.shift();
				for (const held of job.media ?? []) await dropMedia(held);
				// Nothing is resent automatically here: a permanent refusal and an unknown
				// outcome both leave a record the user can see instead.
				if (job.outboxId !== undefined)
					await outboxUpdate(conn.id, chatKey, job.outboxId, {
						state: how === "permanent" ? "failed" : "unknown",
						error: rt.redactSecrets(String(error?.message ?? error)).slice(0, 300),
					}).catch(() => {});
				dropSend(conn, how, error, job.notify === true);
			} finally {
				queue.sending = undefined;
			}
		}
	};
	const sendMedia = async (conn: any, chatKey: any, chat: any, items: any[], note?: string): Promise<boolean> => {
		const saved: any[] = [];
		for (const item of items)
			saved.push({
				...(await saveMedia(item.kind, item.name, item.data)),
				...(item.mime === undefined ? {} : { mime: item.mime }),
				...(item.voice === true ? { voice: true } : {}),
			});
		// The record is written before the queue is touched, like a text: a body that
		// cannot be queued is refused instead of silently lost.
		const accepted = await enqueue(conn, chatKey, { chat, text: note ?? "", media: saved });
		if (!accepted) for (const held of saved) await dropMedia(held);
		return accepted;
	};
	const sendText = async (conn: any, chat: any, body: any, buttons?: any, after?: any) =>
		await enqueue(conn, chat.key, { chat, text: body, buttons, after });
	const sendTo = async (
		conn: any,
		chatKey: any,
		chat: any,
		body: any,
		buttons?: any,
		after?: any,
		replyTo?: string,
		look?: { card?: boolean; title?: string; form?: any; notify?: boolean },
	) =>
		await enqueue(conn, chatKey, {
			chat,
			text: body,
			buttons,
			after,
			...(replyTo ? { replyTo } : {}),
			...(look?.card === true ? { card: true } : {}),
			...(look?.title === undefined ? {} : { title: look.title }),
			...(look?.form === undefined ? {} : { form: look.form }),
			...(look?.notify === true ? { notify: true } : {}),
		});

	// Status reactions mark the message that asked for the work while its turn runs
	// and settle to the outcome when the turn ends (dsh-im's status-reaction
	// lifecycle; see NOTICE). Best effort: a platform or app without reaction
	// support simply gets no marks, and a failed reaction never holds up a reply.
	const pendingReactions = new Map(); // `${conn.id}:${chatKey}` → { reaction, sessionId, requestId, started, timer }
	const reactionsOn = rt.config?.imReactions !== false;
	const finishReaction = (key: any, outcome: any) => {
		const held = pendingReactions.get(key);
		if (held === undefined) return;
		pendingReactions.delete(key);
		clearTimeout(held.timer);
		if (outcome === "success") void held.reaction.success();
		else if (outcome === "error") void held.reaction.error();
		else void held.reaction.clear();
	};
	const beginReaction = (conn: any, msg: any, sessionId: any, requestId: any) => {
		if (!reactionsOn || typeof msg.messageId !== "string" || msg.messageId === "") return;
		const handle = runners.get(conn.id)?.handle;
		if (typeof handle?.addReaction !== "function" || typeof handle?.removeReaction !== "function") return;
		const key = `${conn.id}:${msg.chat.key}`;
		// A newer message in the same chat supersedes the mark of an older one.
		finishReaction(key, "clear");
		const reaction = startStatusReaction({
			add: (emoji: any) => handle.addReaction(msg.chat, msg.messageId, emoji),
			remove: (reactionId: any) => handle.removeReaction(msg.chat, msg.messageId, reactionId),
			warn: (error: any) => rt.warn("ocean-crew im: status reaction failed: %s", error?.message ?? error),
		});
		if (reaction === undefined) return;
		const timer = setTimeout(() => finishReaction(key, "clear"), REACTION_MAX_MS);
		timer.unref?.();
		pendingReactions.set(key, { reaction, sessionId, requestId, started: false, timer });
	};

	// ----------------------------------------------------------------- inbound
	const paired = (conn: any, senderId: any) => (conn.paired ?? []).some((entry: any) => entry.id === senderId);
	const requested = (conn: any, msg: any) => {
		if ((conn.requests ?? []).some((entry: any) => entry.id === msg.sender.id)) return false;
		conn.requests = [
			...(conn.requests ?? []),
			{ id: msg.sender.id, name: msg.sender.name, chatKey: msg.chat.key, chatKind: msg.chat.kind, at: Date.now() },
		];
		return true;
	};

	const targetName = (_conn: any, target: any) => {
		if (target?.botId !== undefined) return rt.botOf(target.botId)?.name;
		if (target?.roomId !== undefined) return rt.roomOf(target.roomId)?.name;
		return undefined;
	};
	const resolveTarget = (conn: any, chat: any) => {
		const target = chat.target ?? (chat.kind === "direct" ? { botId: conn.botId } : undefined);
		if (target?.botId !== undefined && rt.botOf(target.botId) !== undefined) return target;
		if (target?.roomId !== undefined && rt.roomOf(target.roomId) !== undefined) return target;
		return undefined;
	};

	// One card this chat was sent and has not answered yet. A button names its own
	// card, so it must never fall through to a newer card of the same kind.
	const openCard = (conn: any, chatKey: any, cardKey: any) => {
		const entries = runtimes.get(conn.id)?.data?.cards[cardKey];
		const entry = entries?.find((item: any) => item.chatKey === chatKey && item.answer === undefined);
		return entry === undefined ? undefined : { cardKey, entry };
	};
	const questionById = (id: any): { sessionId: string; question: any } | undefined => {
		for (const [sessionId, question] of Object.entries((state.questions ?? {}) as Record<string, any>)) {
			if (question.id === id) return { sessionId, question };
		}
		return undefined;
	};
	const answerQuestionCard = async (conn: any, chat: any, cardKey: any, labels: any) => {
		const held = openCard(conn, chat.key, cardKey);
		if (held === undefined) return false;
		const found = questionById(held.cardKey.slice(2));
		if (found === undefined) {
			await sendCardReply(conn, chat, text("stale"));
			return true;
		}
		const valid = labels.filter((label: any) =>
			(found.question.options ?? []).some((option: any) => option.label === label),
		);
		if (valid.length === 0) return false;
		try {
			await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid });
			await settleCard(conn.id, held.cardKey, valid.join(", "));
			await settledEdits(conn);
		} catch (error: any) {
			if (error?.code === "bot/stale") {
				await settleCard(conn.id, held.cardKey, text("answered"));
				await sendCardReply(conn, chat, text("stale"));
				await settledEdits(conn);
				return true;
			}
			throw error;
		}
		return true;
	};
	const viewValues = (node: any, choice: any, form: any): any => {
		if (node === undefined) return undefined;
		if (choice === "cancel") return node.type === "form" ? { canceled: true } : undefined;
		if (form !== undefined && typeof form === "object") {
			if (node.type === "options") {
				const key = Object.keys(form).find((name) => name.startsWith("sel:"));
				const raw = key === undefined ? undefined : (form as any)[key];
				const picked = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
					(label: unknown): label is string => typeof label === "string" && label !== "",
				);
				return picked.length === 0 ? undefined : { selected: picked };
			}
			if (node.type === "form") {
				const fields: Record<string, string> = {};
				for (const [name, raw] of Object.entries(form)) {
					const match = /^f:([^:]+):(.+)$/.exec(name);
					if (match === null || match[1] !== node.id) continue;
					fields[match[2]] = String(raw ?? "");
				}
				return Object.keys(fields).length === 0 ? undefined : { fields };
			}
		}
		if (node.type === "confirm" && (choice === "yes" || choice === "no")) return { confirmed: choice === "yes" };
		if (node.type === "options" && /^o\d+$/.test(String(choice))) {
			const label = node.options?.[Number(String(choice).slice(1))]?.label;
			return typeof label === "string" ? { selected: [label] } : undefined;
		}
		return undefined;
	};
	const answerViewCard = async (conn: any, chat: any, cardKey: any, nodeId: any, choice: any, form?: any) => {
		const held = openCard(conn, chat.key, cardKey);
		if (held === undefined) return false;
		const viewId = held.cardKey.slice(2);
		const found = Object.entries((state.views ?? {}) as Record<string, any>).find(
			([, pending]: [string, any]) => pending.id === viewId,
		);
		if (found === undefined) {
			await sendCardReply(conn, chat, text("stale"));
			return true;
		}
		const [sessionId, pending] = found;
		const nodes: any[] = [];
		const walk = (value: any) => {
			if (value === null || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const child of value) walk(child);
				return;
			}
			if (["options", "confirm", "form"].includes(String(value.type))) nodes.push(value);
			for (const child of Object.values(value)) walk(child);
		};
		walk(pending.view);
		const node = nodes.find((entry: any) => entry.id === nodeId);
		const values = viewValues(node, choice, form);
		if (values === undefined) return false;
		try {
			await rt.answerView(sessionId, viewId, nodeId, values);
			await settleCard(conn.id, held.cardKey, text("answered"));
			await settledEdits(conn);
		} catch (error: any) {
			if (error?.code === "bot/stale") {
				await settleCard(conn.id, held.cardKey, text("answered"));
				await sendCardReply(conn, chat, text("stale"));
				await settledEdits(conn);
				return true;
			}
			throw error;
		}
		return true;
	};
	const answerApprovalCard = async (conn: any, chat: any, cardKey: any, choice: any) => {
		const held = openCard(conn, chat.key, cardKey);
		if (held === undefined) return false;
		try {
			rt.answerApproval(held.cardKey.slice(2), choice);
			await settleCard(conn.id, held.cardKey, choice === "allow" ? text("allow") : text("reject"));
			await settledEdits(conn);
		} catch (error: any) {
			if (error?.code === "bot/stale") {
				await sendCardReply(conn, chat, text("stale"));
				return true;
			}
			throw error;
		}
		return true;
	};
	const sendCardReply = async (conn: any, chat: any, body: any) =>
		sendText(conn, { key: chat.key, kind: chat.kind, title: chat.title }, body);

	// The chat's newest still-open card, questions and approvals together: a bare
	// number answers whatever arrived last, not always a question.
	const newestOpenCard = (conn: any, chatKey: any) => {
		const data = runtimes.get(conn.id)?.data;
		if (data === undefined) return undefined;
		for (const [cardKey, entries] of Object.entries(data.cards as Record<string, any>).reverse()) {
			if (!cardKey.startsWith("q:") && !cardKey.startsWith("a:")) continue;
			const entry = entries.find((item: any) => item.chatKey === chatKey && item.answer === undefined);
			if (entry !== undefined) return { cardKey, entry };
		}
		return undefined;
	};

	const onMessage = (conn: any) => async (msg: any) => {
		if (!paired(conn, msg.sender.id)) {
			if (msg.chat.kind === "group" && !msg.mentioned) return;
			if (!requested(conn, msg)) return;
			await rt.save();
			await sendText(conn, msg.chat, text("requested"));
			return;
		}
		conn.chats ??= {};
		// A routine that listens for this conversation's words starts before the message is
		// answered: it is the user's own text that triggered it, and a reply is not required.
		for (const routine of (rt as any).routineMessages?.(String(msg.text ?? ""), msg.chat.key) ?? []) {
			const bot = rt.botOf(routine.botId);
			void (rt as any).fireRoutine?.(routine, {
				summary: `${bot?.name ?? routine.botId} 监听的关键词：${routine.trigger.words.join(" / ")} · ${String(msg.text ?? "").slice(0, 120)}`,
				at: Date.now(),
			});
		}
		if (msg.chat.kind === "group" && !msg.mentioned) return;
		if (conn.chats[msg.chat.key] === undefined) {
			conn.chats[msg.chat.key] = { kind: msg.chat.kind, title: msg.chat.title, at: Date.now() };
			await rt.save();
		}
		const body = String(msg.text ?? "").trim();
		const chat = conn.chats[msg.chat.key];
		const target = resolveTarget(conn, chat);
		if (/^\/start(?:@\S+)?\s*$/.test(body)) {
			const name = target === undefined ? undefined : targetName(conn, target);
			await sendText(
				conn,
				msg.chat,
				name === undefined
					? text(msg.chat.kind === "group" ? "unboundGroup" : "unbound")
					: text("greeting", { name }),
			);
			return;
		}
		// "/stop all" is the team-wide stop: every turn, every group round and every result still
		// owed. It answers with the report, because a bare "stopped" would hide the work that is
		// still running and the calls that already went out.
		if (/^\/stop(?:@\S+)?\s+all\s*$/i.test(body)) {
			const report: any = await (rt as any).stopAll?.("all");
			await sendText(conn, msg.chat, reportLines(report, text).join("\n"));
			return;
		}
		if (/^\/stop(?:@\S+)?\s*$/.test(body)) {
			if (target === undefined) {
				await sendText(conn, msg.chat, text(msg.chat.kind === "group" ? "unboundGroup" : "unbound"));
				return;
			}
			const stopped =
				target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId);
			await sendText(conn, msg.chat, text(stopped ? "stopped" : "idle"));
			return;
		}
		if (NUMBERS.test(body)) {
			const picked = body.trim().split(/\s+/).map(Number);
			const held = newestOpenCard(conn, msg.chat.key);
			// Anything that does not clearly answer the newest open card — a stale
			// source, an out-of-range pick, several picks on a single choice — is a
			// normal message for the Bot, never swallowed and never 'stale'.
			if (held?.cardKey.startsWith("q:")) {
				const found = questionById(held.cardKey.slice(2));
				if (found !== undefined) {
					const options = found.question.options ?? [];
					const inRange =
						picked.length > 0 &&
						(found.question.multiSelect === true || picked.length === 1) &&
						picked.every((index) => options[index - 1] !== undefined);
					if (
						inRange &&
						(await answerQuestionCard(
							conn,
							msg.chat,
							held.cardKey,
							picked.map((index) => options[index - 1].label),
						))
					)
						return;
				}
			} else if (
				held?.cardKey.startsWith("a:") &&
				picked.length === 1 &&
				(picked[0] === 1 || picked[0] === 2) &&
				rt.approvalsView().some((entry: any) => `a:${entry.id}` === held.cardKey)
			) {
				if (await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? "allow" : "reject")) return;
			}
		}
		if (target === undefined) {
			await sendText(conn, msg.chat, text(msg.chat.kind === "group" ? "unboundGroup" : "unbound"));
			return;
		}
		// A slash command is answered here, never queued into the Bot's Session: it is a
		// request about the chat, not work for the model.
		if (await runCommand(conn, msg, target)) return;
		const sessionId = target.botId ?? target.roomId;
		const env = await envFor(conn);
		const upload = async (file: any): Promise<string | undefined> => {
			try {
				return await env.uploadFile(rt.botOf(sessionId) ? rt.chatOf(sessionId) : sessionId, file);
			} catch {
				await sendText(conn, msg.chat, text("noFile"));
				return undefined;
			}
		};
		const content: any[] = [];
		const labels: string[] = [];
		if (body !== "") labels.push(body);
		// An image only reaches the model as an image when its bytes are a type the host
		// accepts; anything else is a file, with a label saying what it is, so the model
		// still knows something arrived and can open it with its tools.
		const inline: any[] = [];
		const asFiles: any[] = [];
		const images = Array.isArray(msg.images) ? msg.images : [];
		for (const [index, image] of images.entries()) {
			const bytes = Buffer.from(String(image.data ?? ""), "base64");
			const mediaType = String(image.mediaType ?? "");
			if (!isSupportedImageType(mediaType) || bytes.byteLength === 0) {
				asFiles.push({
					name: `image-${index + 1}.${mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "bin"}`,
					data: bytes,
				});
				labels.push(`[Image ${index + 1} arrived as a file: ${mediaType || "unknown type"}]`);
				continue;
			}
			inline.push({
				type: "image",
				mediaType,
				data: image.data,
				...(image.name === undefined ? {} : { name: image.name }),
			});
		}
		for (const label of labels) content.push({ type: "text", text: label });
		content.push(...inline);
		for (const file of [...(Array.isArray(msg.files) ? msg.files : []), ...asFiles]) {
			const receiptId = await upload(file);
			if (receiptId !== undefined) content.push({ type: "file", receiptId });
		}
		if (content.length === 0) return;
		const requestId = `im:${conn.platform}:${randomUUID()}`;
		noteOrigin(requestId, conn, msg.chat, sessionId, msg.messageId, msg.sender?.id);
		ownerOrigins.set(sessionId, requestId);
		sessionOrigins.set(sessionId, requestId);
		try {
			await rt.sendUser({ sessionId, content, requestId });
		} catch (error: any) {
			if (inline.length === 0 || !isImageRefusal(error)) throw error;
			// The host refuses the images (a model without vision, a size limit): the turn
			// still starts without them, and they are handed over as files to read instead.
			rt.warn("ocean-crew: im image not accepted by the host (%s); passing it as a file", error?.message ?? error);
			const fallback: any[] = content.filter((part: any) => part.type !== "image");
			const noted: string[] = [];
			for (const image of inline) {
				const receiptId = await upload({
					name: `image-${noted.length + 1}.${String(image.mediaType).split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`,
					data: Buffer.from(String(image.data ?? ""), "base64"),
				});
				if (receiptId !== undefined) {
					fallback.push({ type: "file", receiptId });
					noted.push(receiptId);
				}
			}
			fallback.push({
				type: "text",
				text: text("imageAsFile", { count: noted.length }) as string,
			});
			await rt.sendUser({ sessionId, content: fallback, requestId });
		}
		// The chat sees the Bot working before the model's first token, not on a later tick.
		kickTyping(conn, msg.chat);
		// A room message is answered by member Bot turns under their own sessions, so
		// no single session end can settle its mark; only direct chats are marked.
		if (target.botId !== undefined) beginReaction(conn, msg, sessionId, requestId);
	};

	const commandWord = (msg: any): string | undefined => {
		if ((Array.isArray(msg.images) && msg.images.length > 0) || (Array.isArray(msg.files) && msg.files.length > 0))
			return undefined;
		const text = String(msg.text ?? "").trim();
		if (!text.startsWith("/")) return undefined;
		const word = (text.split(/\s+/)[0] ?? "").slice(1).toLowerCase();
		return word === "" ? undefined : word;
	};
	// One command per line: a card renders the command name in bold, a plain message
	// keeps a dot-separated line, so neither reads as a paragraph.
	const helpBody = (card: boolean): string => {
		const rows: Array<[string, string]> = [
			["/status", zh() ? "查看这个 Bot 的状态" : "this Bot's state"],
			["/stop", zh() ? "停止正在进行的回合" : "stop the running turn"],
			["/stop all", zh() ? "停掉整个团队的工作" : "stop all the team's work"],
			["/new", zh() ? "开一段新会话" : "start a fresh conversation"],
			["/menu", zh() ? "打开操作卡片" : "show the actions card"],
			["/help", zh() ? "显示这份帮助" : "this list"],
		];
		const title = text("cmdHelpBody");
		if (card) return [`**${title}**`, "", ...rows.map(([name, what]) => `- \`${name}\` · ${what}`)].join("\n");
		// One message, not one bubble per command: a platform that splits chatty lines would
		// otherwise turn this list into half a dozen messages.
		return `${title}：${rows.map(([name, what]) => `${name} ${what}`).join("；")}`;
	};

	const statusLine = async (bot: any): Promise<string> => {
		const model = (await rt.desiredModel?.(bot)) ?? bot.model ?? "?";
		const parts = Array.isArray(bot.segments) ? bot.segments.length : 0;
		const running = rt.live.get(rt.chatOf(bot.id))?.turn !== undefined;
		return text("cmdStatus", { bot: bot.name, model, running, parts });
	};
	const runCommand = async (conn: any, msg: any, target: any): Promise<boolean> => {
		const name = commandWord(msg);
		if (name === undefined) return false;
		const botId = target?.botId;
		const reply = async (body: string, buttons?: any[], look?: { title?: string; card?: boolean }) =>
			await sendTo(
				conn,
				msg.chat.key,
				msg.chat,
				body,
				buttons,
				undefined,
				typeof msg.messageId === "string" ? msg.messageId : undefined,
				look,
			);
		const cards = imPlatform(conn.platform)?.buttons === true;
		if (botId === undefined) {
			if (name === "help") {
				await reply(helpBody(cards), undefined, cards ? { card: true, title: text("help") } : undefined);
				return true;
			}
			if (name === "menu" || name === "status") {
				await reply(text("cmdGroupOnly"));
				return true;
			}
			if (name === "stop" || name === "new") {
				await reply(text("cmdGroupOnly"));
				return true;
			}
			return true;
		}
		const bot = rt.botOf(botId);
		if (bot === undefined) return true;
		if (name === "help") {
			await reply(helpBody(cards), undefined, cards ? { card: true, title: bot.name } : undefined);
			return true;
		}
		if (name === "menu") {
			const buttons =
				imPlatform(conn.platform)?.buttons === true
					? [
							{ data: "c:stop", label: text("stop") },
							{ data: "c:new", label: text("newPart") },
							{ data: "c:status", label: text("status") },
							{ data: "c:help", label: text("help") },
						]
					: undefined;
			await reply(text("menuBody", { bot: bot.name }), buttons, { title: bot.name });
			return true;
		}
		if (name === "status") {
			await reply(await statusLine(bot));
			return true;
		}
		if (name === "new") {
			try {
				await rt.newPart?.(rt.chatOf(bot.id));
				await reply(text("cmdNewStarted"));
			} catch (error: any) {
				await reply(error?.code === "bot/busy" ? text("cmdNewBusy") : text("cmdNewBusy"));
			}
			return true;
		}
		await reply(text("cmdUnknown", { name }));
		return true;
	};

	const onAction = (conn: any) => async (action: any) => {
		if (!paired(conn, action.sender.id)) return;
		const data = String(action.data ?? "");
		const chat = { key: action.chat.key, kind: action.chat.kind, title: action.chat.title };
		// Button data is `<kind>:<id>:<choice>`; the id is everything between the
		// first and the last colon, so an id with a colon in it still parses.
		const cut = data.lastIndexOf(":");
		const cardKey = data.slice(0, cut);
		const choice = data.slice(cut + 1);
		if (data.startsWith("c:") && data.length > 2) {
			const name = data.slice(2);
			const chat = { key: action.chat.key, kind: action.chat.kind, title: action.chat.title };
			const held = resolveTarget(conn, conn.chats?.[action.chat.key]);
			const bot = held?.botId === undefined ? undefined : rt.botOf(held.botId);
			if (name === "status" && bot !== undefined) {
				await sendCardReply(conn, chat, await statusLine(bot));
			} else if (name === "help") {
				// A button press on the actions card: the same list the /help command sends.
				await sendCardReply(conn, chat, helpBody(true));
			} else if (name === "stop" && bot !== undefined) {
				const stopped = await rt.stopChat(bot.id);
				await sendCardReply(conn, chat, text(stopped ? "stopped" : "idle"));
			} else if (name === "new" && bot !== undefined) {
				try {
					await rt.newPart?.(rt.chatOf(bot.id));
					await sendCardReply(conn, chat, text("cmdNewStarted"));
				} catch {
					await sendCardReply(conn, chat, text("cmdNewBusy"));
				}
			} else {
				await sendCardReply(conn, chat, text("cmdGroupOnly"));
			}
			return;
		}
		if (data.startsWith("q:") && cut > 2) {
			const found = questionById(cardKey.slice(2));
			const label = found?.question.options?.[Number(choice)]?.label;
			if (label === undefined) {
				await sendCardReply(conn, chat, text("stale"));
				return;
			}
			if (!(await answerQuestionCard(conn, chat, cardKey, [label]))) await sendCardReply(conn, chat, text("stale"));
			return;
		}
		if (data.startsWith("a:") && cut > 2) {
			if (choice === "allow" || choice === "reject") {
				if (!(await answerApprovalCard(conn, chat, cardKey, choice)))
					await sendCardReply(conn, chat, text("stale"));
			}
			return;
		}
		if (data.startsWith("v:") && cut > 4) {
			const rest = data.slice(2);
			const inner = rest.lastIndexOf(":");
			const viewId = rest.slice(0, inner).split(":")[0];
			const nodeId = rest.slice(viewId.length + 1, inner);
			if (!(await answerViewCard(conn, chat, `v:${viewId}`, nodeId, choice, action.form)))
				await sendCardReply(conn, chat, text("stale"));
		}
	};

	// ------------------------------------------------------------------ cards
	const cardText = {
		question: (bot: any, question: any) => {
			const options = (question.options ?? [])
				.map(
					(option: any, index: any) =>
						`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
				)
				.join("\n");
			const hint = question.multiSelect === true ? text("numbersMulti") : text("numbers");
			return `${text("question", { bot })}${question.question}${question.detail ? `\n${question.detail}` : ""}\n${options}\n(${hint})`;
		},
		approval: (bot: any, entry: any) =>
			`${text("approval", { bot })}${entry.tool}${entry.reason ? ` — ${entry.reason}` : ""}${entry.detail?.text ? `\n${entry.detail.text}` : ""}${entry.detail?.code ? `\n${entry.detail.code}` : ""}`,
	};
	const cardButtons = {
		question: (question: any) =>
			question.multiSelect === true
				? undefined
				: (question.options ?? []).map((option: any, index: any) => ({
						data: `q:${question.id}:${index}`,
						label: option.label,
					})),
		approval: (id: any) => [
			{ data: `a:${id}:allow`, label: text("allow") },
			{ data: `a:${id}:reject`, label: text("reject") },
		],
	};

	// What a view's card offers: buttons for one choice, a form when several answers or
	// typed fields are needed. The submit button carries the same `v:<view>:<node>:<choice>`
	// data the buttons use, so the action handler stays one path.
	const viewCardSpec = (viewId: string, view: any): { buttons?: any[]; form?: any } => {
		const nodes: any[] = [];
		const walk = (value: any) => {
			if (value === null || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const child of value) walk(child);
				return;
			}
			if ((["options", "confirm", "form"] as string[]).includes(String(value.type)) && typeof value.id === "string")
				nodes.push(value);
			for (const child of Object.values(value)) walk(child);
		};
		walk(view);
		const node = nodes.find((entry: any) =>
			entry.type === "options"
				? Array.isArray(entry.options) && entry.options.length > 0
				: entry.type === "form"
					? Array.isArray(entry.fields) && entry.fields.some((field: any) => typeof field?.id === "string")
					: true,
		);
		if (node === undefined) return {};
		if (node.type === "confirm")
			return {
				buttons: [
					{ data: `v:${viewId}:${node.id}:yes`, label: String(node.confirmLabel ?? text("yes")) },
					{ data: `v:${viewId}:${node.id}:no`, label: String(node.cancelLabel ?? text("no")) },
				],
			};
		if (node.type === "options") {
			const labels = (node.options ?? [])
				.slice(0, 8)
				.map((option: any) => String(option?.label ?? ""))
				.filter((label: string) => label !== "");
			if (node.multi !== true)
				return {
					buttons: labels.slice(0, 4).map((label: string, index: number) => ({
						data: `v:${viewId}:${node.id}:o${index}`,
						label: label.slice(0, 20),
					})),
				};
			if (labels.length === 0) return {};
			return {
				form: {
					fields: [{ kind: "multi", name: `sel:${node.id}`, label: text("pickMany"), options: labels }],
					submit: { data: `v:${viewId}:${node.id}:submit`, label: text("submit") },
				},
			};
		}
		const fields = (node.fields ?? [])
			.filter((field: any) => typeof field?.id === "string" && field.readOnly !== true)
			.slice(0, 8)
			.map((field: any) => ({
				kind: "text",
				name: `f:${node.id}:${field.id}`,
				label: String(field.label ?? field.id),
				multiline: field.multiline === true,
				...(typeof field.value === "string" ? { initial: field.value } : {}),
			}));
		if (fields.length === 0) return {};
		return {
			form: {
				fields,
				submit: {
					data: `v:${viewId}:${node.id}:submit`,
					label: String(node.submitLabel ?? text("submit")),
				},
				cancel: {
					data: `v:${viewId}:${node.id}:cancel`,
					label: String(node.cancelLabel ?? text("cancel")),
				},
			},
		};
	};
	const sendCard = async (conn: any, cardKey: any, targets: any, body: any, buttons?: any, look?: any) => {
		for (const { chatKey, chat } of targets) {
			sendTo(
				conn,
				chatKey,
				{ key: chatKey, kind: chat.kind, title: chat.title },
				body,
				buttons,
				(sent: any) => {
					void markCard(conn.id, cardKey, chatKey, sent?.messageId, body);
				},
				undefined,
				look,
			);
		}
		// A card a chat never got (queued behind a failure) is still recorded below.
		for (const { chatKey } of targets) await markCard(conn.id, cardKey, chatKey, undefined, body);
	};

	const roomOfSession = (sessionId: string): any => {
		const own = rt.roomOf(sessionId);
		if (own !== undefined) return own;
		const owner = rt.groupOwners.get(sessionId);
		return owner === undefined ? undefined : rt.roomOf(owner.roomId);
	};

	const diffCards = async () => {
		if (rt.readOnly() !== undefined) return;
		for (const conn of Object.values(connections())) {
			const runner = runners.get(conn.id);
			if (runner === undefined) continue;
			const data = await cardsOf(conn.id);
			// Questions: one card per open question id, sent to the Bot's chats, or to the
			// group chat when the question was raised in one.
			for (const [sessionId, question] of Object.entries((state.questions ?? {}) as Record<string, any>)) {
				const cardKey = `q:${question.id}`;
				if (data.cards[cardKey] !== undefined) continue;
				const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId;
				const bot = rt.botOf(botId);
				const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined;
				if (bot === undefined) {
					const room = roomOfSession(sessionId);
					if (room === undefined) continue;
					await sendCard(
						conn,
						cardKey,
						replyTargets(ownerOrigins.get(room.id), `room:${room.id}`),
						cardText.question(room.name ?? "this group chat", question),
						buttons,
					);
					continue;
				}
				await sendCard(
					conn,
					cardKey,
					replyTargets(sessionOrigins.get(sessionId), `bot:${botId}`),
					cardText.question(bot.name, question),
					buttons,
				);
			}
			// Secret requests: text only — the key is typed on the computer or phone.
			for (const [botId, list] of Object.entries((state.secretRequests ?? {}) as Record<string, any[]>)) {
				const bot = rt.botOf(botId);
				if (bot === undefined) continue;
				for (const request of list) {
					const cardKey = `s:${request.id}`;
					if (request.status !== "pending" || data.cards[cardKey] !== undefined) continue;
					await sendCard(
						conn,
						cardKey,
						replyTargets(ownerOrigins.get(botId), `bot:${botId}`),
						text("secretAsk", { bot: bot.name, name: request.name }),
					);
				}
			}
			// Views awaiting a reply: a card, with buttons when the blueprint can be
			// answered by pressing one. A view from a group chat goes there.
			for (const [sessionId, view] of Object.entries((state.views ?? {}) as Record<string, any>)) {
				const cardKey = `v:${view.id}`;
				if (data.cards[cardKey] !== undefined) continue;
				const botId = rt.chatOwners.get(sessionId);
				const bot = rt.botOf(botId);
				const rendered = viewCardText({ title: view.title, view: view.view });
				const spec = imPlatform(conn.platform)?.buttons === true ? viewCardSpec(view.id, view.view) : {};
				const buttons = spec.buttons;
				const look = { card: true, ...(spec.form === undefined ? {} : { form: spec.form }) };
				const body = (name: string) =>
					`${text(buttons === undefined && spec.form === undefined ? "viewShow" : "viewPick", { bot: name })}${rendered !== "" ? `\n${rendered}` : view.title ? `\n${view.title}` : ""}`;
				if (bot === undefined) {
					const room = roomOfSession(sessionId);
					if (room === undefined) continue;
					await sendCard(
						conn,
						cardKey,
						replyTargets(ownerOrigins.get(room.id), `room:${room.id}`),
						body(room.name ?? "this group chat"),
						buttons,
						{ ...look, title: room.name },
					);
					continue;
				}
				await sendCard(
					conn,
					cardKey,
					replyTargets(sessionOrigins.get(sessionId), `bot:${botId}`),
					body(bot.name),
					buttons,
					{
						...look,
						title: bot.name,
					},
				);
			}
		}
	};

	// Buttons drop and the answer shows wherever the card was settled.
	const settledEdits = async (conn: any) => {
		const runner = runners.get(conn.id);
		const data = runtimes.get(conn.id)?.data;
		if (runner?.handle.edit === undefined || data === undefined) return;
		for (const entries of Object.values(data.cards as Record<string, any[]>)) {
			for (const entry of entries) {
				if (entry.answer === undefined || entry.messageId === undefined || entry.edited === true) continue;
				const chat = conn.chats?.[entry.chatKey];
				if (chat === undefined) continue;
				entry.edited = true;
				const body = entry.text !== undefined ? `${entry.text}\n— ${entry.answer}` : `(${text("answered")})`;
				runner.handle
					.edit({ key: entry.chatKey, kind: chat.kind, title: chat.title }, entry.messageId, { text: body })
					.catch(() => {});
				scheduleWrite(conn.id);
			}
		}
	};
	// A card answered on the computer leaves the state; its IM copy settles too.
	const settleGone = async () => {
		for (const conn of Object.values(connections())) {
			const data = runtimes.get(conn.id)?.data;
			if (data === undefined) continue;
			let touched = false;
			const openIds = new Set(
				Object.values((state.questions ?? {}) as Record<string, any>).map((question: any) => `q:${question.id}`),
			);
			const openSecret = new Set(
				Object.values((state.secretRequests ?? {}) as Record<string, any[]>)
					.flat()
					.filter((entry: any) => entry.status === "pending")
					.map((entry: any) => `s:${entry.id}`),
			);
			const openViews = new Set(
				Object.values((state.views ?? {}) as Record<string, any>).map((view: any) => `v:${view.id}`),
			);
			const openCard = (cardKey: any) =>
				cardKey.startsWith("q:")
					? openIds.has(cardKey)
					: cardKey.startsWith("a:")
						? rt.approvalsView().some((entry: any) => `a:${entry.id}` === cardKey)
						: cardKey.startsWith("s:")
							? openSecret.has(cardKey)
							: cardKey.startsWith("v:")
								? openViews.has(cardKey)
								: false;
			for (const [cardKey, entries] of Object.entries(data.cards as Record<string, any>)) {
				if (openCard(cardKey)) continue;
				for (const entry of entries) {
					if (entry.answer === undefined) {
						entry.answer = text("answered");
						touched = true;
					}
				}
			}
			if (touched) {
				scheduleWrite(conn.id);
				await settledEdits(conn);
			}
			// A card whose source is gone stays only until its copies are settled and
			// edited where the platform can edit; keeping it forever grows the file.
			const editable = runners.get(conn.id)?.handle?.edit !== undefined;
			let pruned = false;
			for (const [cardKey, entries] of Object.entries(data.cards as Record<string, any>)) {
				if (openCard(cardKey)) continue;
				const droppable =
					entries.length === 0 ||
					entries.every(
						(entry: any) =>
							entry.answer !== undefined &&
							(entry.edited === true ||
								entry.messageId === undefined ||
								!editable ||
								conn.chats?.[entry.chatKey] === undefined),
					);
				if (droppable) {
					delete data.cards[cardKey];
					pruned = true;
				}
			}
			if (pruned) scheduleWrite(conn.id);
		}
	};

	// ---------------------------------------------------------------- lifecycle
	// `state.im.connections` is replaced wholesale when a save is adopted, so anything
	// bound at connect time looks the connection up again by id instead of keeping it.
	const fresh = (id: any) => connections()[id];
	const onStatus = (id: any) => (next: any) => {
		const patch: any = { state: next.state, error: next.error, messageError: false };
		// A successful connect ends the retry ladder; the supervisor restarts it on error.
		if (next.state === "ready") {
			patch.attempts = 0;
			patch.nextRetryAt = 0;
		}
		setStatus(id, patch);
		const conn = fresh(id);
		if (
			conn !== undefined &&
			next.account !== undefined &&
			(conn.account?.id !== next.account.id || conn.account?.name !== next.account.name)
		) {
			conn.account = next.account;
			void rt.save().catch(() => {});
		}
	};

	// A pending first pulse per connection and chat, so a message that lands while one is
	// waiting does not stack timers.
	const typingKicks = new Map<string, any>();
	const typingPulse = (conn: any, chat: any, busy: boolean) => {
		const handle = runners.get(conn.id)?.handle;
		if (handle === undefined || typeof handle.typing !== "function") return;
		const key = { key: chat.key, kind: chat.kind, title: chat.title };
		void (busy ? handle.typing?.(key) : handle.stopTyping?.(key))?.catch?.(() => {});
	};
	const kickTyping = (conn: any, chat: any) => {
		if (typeof runners.get(conn.id)?.handle?.typing !== "function") return;
		const id = `${conn.id}:${chat.key}`;
		clearTimeout(typingKicks.get(id));
		const timer = setTimeout(() => {
			typingKicks.delete(id);
			typingPulse(conn, chat, true);
		}, TYPING_FIRST_MS);
		timer.unref?.();
		typingKicks.set(id, timer);
	};
	const stopTypingNow = (botId: string) => {
		for (const conn of Object.values(connections()) as any[]) {
			if (runners.get(conn.id)?.handle === undefined) continue;
			for (const { chatKey, chat } of listeners(conn, { botId })) {
				clearTimeout(typingKicks.get(`${conn.id}:${chatKey}`));
				typingKicks.delete(`${conn.id}:${chatKey}`);
				typingPulse(conn, { ...chat, key: chatKey }, false);
			}
		}
	};

	const busyOf = (target: any) => {
		if (target?.botId !== undefined) return rt.live.get(rt.chatOf(target.botId))?.turn !== undefined;
		if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0;
		return false;
	};

	// Records a previous process left behind. A `queued` one never reached the platform and
	// is sent again; a `sending` one may have been accepted, so it is reported as unknown
	// and never resent; `failed` and `unknown` already settled and stay for the user to see
	// until the connection's next successful send clears them.
	const restoreOutbox = async (conn: any, runner: any): Promise<void> => {
		let held: any;
		try {
			held = await outboxOf(conn.id);
		} catch (error) {
			rt.warn("ocean-crew: im outbox %s unreadable: %s", conn.id, error);
			return;
		}
		let restored = 0;
		for (const [chatKey, list] of Object.entries((held.data.chats ?? {}) as Record<string, any[]>)) {
			if (!Array.isArray(list)) continue;
			// The record carries the chat it was meant for, so a restart before any new
			// message still knows where to send; `conn.chats` is only filled by inbound
			// traffic and is empty on a fresh start.
			for (const record of list) {
				if (record.state === "sending") {
					await outboxUpdate(conn.id, chatKey, record.id, {
						state: "unknown",
						error: "The send was interrupted before the platform answered",
					}).catch(() => {});
					continue;
				}
				if (record.state !== "queued") continue;
				let queue = runner.queues.get(chatKey);
				if (queue === undefined) {
					queue = { jobs: [] };
					runner.queues.set(chatKey, queue);
				}
				queue.jobs.push({
					chat: record.chat ?? { key: chatKey, kind: "direct", title: chatKey },
					text: record.body,
					...(record.buttons === undefined ? {} : { buttons: record.buttons }),
					outboxId: record.id,
					restored: true,
				});
				restored += 1;
			}
		}
		if (restored > 0) rt.warn("ocean-crew: im outbox for %s resumed %d unsent message(s)", conn.id, restored);
	};

	const start = async (conn: any) => {
		const adapter = adapters[conn.platform];
		if (adapter === undefined || runners.has(conn.id)) return;
		const platform = imPlatform(conn.platform);
		if ((platform as any)?.ws === true && globalThis.WebSocket === undefined) {
			setStatus(conn.id, { state: "error", error: "This dsh runs on a Node without WebSocket" });
			return;
		}
		// The slot is reserved before the async work: a concurrent sync cannot
		// start a second adapter for the same connection.
		const runner: any = { handle: undefined, queues: new Map(), typing: undefined };
		runners.set(conn.id, runner);
		setStatus(conn.id, { state: "connecting", error: undefined });
		try {
			const env = await envFor(conn);
			const handle = adapter.connect(fieldsOf(conn), env, {
				onMessage: (msg: any) => {
					const current = fresh(conn.id);
					return current === undefined
						? undefined
						: onMessage(current)(msg).catch((error) => rt.warn("ocean-crew: im message failed: %s", error));
				},
				onAction: (action: any) => {
					const current = fresh(conn.id);
					return current === undefined
						? undefined
						: onAction(current)(action).catch((error) => rt.warn("ocean-crew: im action failed: %s", error));
				},
				onStatus: onStatus(conn.id),
			});
			// A stop() during connect took the slot back: undo the just-started
			// adapter instead of leaving it running unreachable.
			if (runners.get(conn.id) !== runner) {
				void Promise.resolve(handle?.stop?.()).catch(() => {});
				return;
			}
			runner.handle = handle;
			await restoreOutbox(conn, runner);
			for (const chatKey of runner.queues.keys()) void drain(conn, chatKey);
			if (typeof runner.handle?.typing === "function") {
				runner.typing = setInterval(() => {
					for (const { chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
						typingPulse(conn, { ...chat, key: chat.key ?? chat }, target !== undefined && busyOf(target));
					}
				}, TYPING_MS);
				runner.typing.unref?.();
			}
			await diffCards();
		} catch (error: any) {
			runners.delete(conn.id);
			setStatus(conn.id, { state: "error", error: String(error?.message ?? error).slice(0, 300) });
		}
	};
	const stop = async (id: any) => {
		const runner = runners.get(id);
		runners.delete(id);
		if (runner?.typing !== undefined) clearInterval(runner.typing);
		for (const [key, timer] of typingKicks) {
			if (!key.startsWith(`${id}:`)) continue;
			clearTimeout(timer);
			typingKicks.delete(key);
		}
		for (const queue of runner?.queues.values() ?? []) clearTimeout(queue.retry);
		await Promise.resolve(runner?.handle?.stop?.()).catch(() => {});
		if (statuses.get(id)?.state !== "error") setStatus(id, { state: "off" });
	};

	let stopped = false;
	const desiredOf = (conn: any) =>
		stopped !== true &&
		adapters[conn.platform] !== undefined &&
		conn.enabled !== false &&
		rt.readOnly() === undefined &&
		hasSecrets(conn);

	// Syncs run one behind the other: endpoints, onSaved and the interval can all
	// fire while a sync is still starting an adapter, and they must see its
	// reserved slots rather than start a second adapter. Each connection gets one
	// decision per sync from supervisor.js: start, stop, restart or none.
	let syncing = Promise.resolve();
	const sync = () => {
		const run = syncing.then(async () => {
			const conns = connections();
			const now = Date.now();
			for (const conn of Object.values(conns)) {
				const desired = desiredOf(conn);
				const current = statuses.get(conn.id) ?? {};
				const decision: any = nextAction(now, {
					desired,
					running: runners.has(conn.id),
					state: current.state ?? "off",
					messageError: current.messageError === true,
					attempts: current.attempts ?? 0,
					nextRetryAt: current.nextRetryAt ?? 0,
				});
				if (decision.attempts !== (current.attempts ?? 0) || decision.nextRetryAt !== (current.nextRetryAt ?? 0)) {
					setStatus(conn.id, { attempts: decision.attempts, nextRetryAt: decision.nextRetryAt });
				}
				if (decision.action === "stop") await stop(conn.id);
				else if (decision.action === "restart") {
					await stop(conn.id);
					await start(conn);
				} else if (decision.action === "start") await start(conn);
			}
			for (const id of [...runners.keys()]) if (conns[id] === undefined) await stop(id);
			for (const id of [...statuses.keys()]) if (conns[id] === undefined) statuses.delete(id);
			for (const conn of Object.values(conns)) {
				if (conn.enabled === false || !runners.has(conn.id)) {
					if (statuses.get(conn.id)?.state !== "error") setStatus(conn.id, { state: "off" });
				}
			}
		});
		syncing = run.catch(() => {});
		return run;
	};

	// ---------------------------------------------------------------- endpoints
	const secretName = (conn: any, key: any) =>
		`IM_${conn.platform.toUpperCase()}_${conn.id.slice(3, 9).toUpperCase()}_${secretField(key)}`;
	const cleanFields = (platform: any, fields: any, base: any = {}) => {
		const given: any = fields !== null && typeof fields === "object" ? fields : {};
		const out: Record<string, any> = {};
		for (const field of platform.fields) {
			const value = given[field.key];
			if (field.options !== undefined) {
				out[field.key] = field.options.some(([id]: [string, any]) => id === value)
					? value
					: value === undefined && base[field.key] !== undefined
						? base[field.key]
						: field.options[0][0];
			} else if (typeof value === "string" && value.trim() !== "") {
				out[field.key] = value.trim();
			} else if (!field.secret) {
				if (value !== undefined && typeof value !== "string") throw new Error(`${field.label} must be text`);
				out[field.key] = value === undefined && base[field.key] !== undefined ? base[field.key] : "";
			}
			// Missing secret fields are allowed only on update, where the saved one stays.
		}
		return out;
	};

	const saveSecrets = async (conn: any, platform: any, fields: any) => {
		for (const field of platform.fields) {
			if (!field.secret || fields[field.key] === undefined) continue;
			const name = conn.secrets[field.key] ?? secretName(conn, field.key);
			await rt.secretEndpoint("secret-set", {
				name,
				value: fields[field.key],
				purpose: `${platform.name} IM bot`,
				scope: [],
			});
			conn.secrets[field.key] = name;
		}
	};

	const viewOf = (conn: any) => ({
		id: conn.id,
		platform: conn.platform,
		account: conn.account ?? null,
		botId: conn.botId ?? null,
		settings: conn.settings ?? {},
		secrets: Object.keys(conn.secrets ?? {}),
		enabled: conn.enabled !== false,
		paired: conn.paired ?? [],
		requests: conn.requests ?? [],
		chats: Object.fromEntries(
			Object.entries((conn.chats ?? {}) as Record<string, any>).map(([key, chat]: [string, any]) => [
				key,
				{ ...chat },
			]),
		),
		createdAt: conn.createdAt,
	});

	const endpoints: Record<string, (body: any) => Promise<any>> = {
		async "im-add"(body: any) {
			const platform = imPlatform(String(body.platform ?? ""));
			if (platform === undefined || adapters[platform.id] === undefined)
				throw new Error("This platform is not available yet");
			const bot = rt.botOf(String(body.botId ?? ""));
			if (bot === undefined) throw new Error("Choose a Bot first");
			if (platform.login === "qr") throw new Error("This platform signs in by scanning a code; not available yet");
			const fields = cleanFields(platform, body.fields);
			for (const field of platform.fields) {
				if (!field.options && (fields[field.key] === undefined || String(fields[field.key]).trim() === ""))
					throw new Error(`${field.label} is required`);
			}
			const env = await envFor(
				{ id: "im_check", platform: platform.id, settings: fields, secrets: {} },
				{ get: () => ({}), set: () => {} },
			);
			const { account } = await adapters[platform.id].check(fields, env);
			const conn = {
				id: `im_${randomBytes(4).toString("hex")}`,
				platform: platform.id,
				account,
				botId: bot.id,
				settings: Object.fromEntries(
					platform.fields.filter((field) => !field.secret).map((field) => [field.key, fields[field.key]]),
				),
				secrets: {},
				enabled: true,
				paired: [],
				requests: [],
				chats: {},
				// The default is that a reply answers the chat it came from.
				mirror: body.mirror === "all" ? "all" : "source",
				createdAt: Date.now(),
			};
			await saveSecrets(conn, platform, fields);
			connections()[conn.id] = conn;
			await rt.save();
			await sync();
			return viewOf(conn);
		},
		async "im-update"(body: any) {
			const conn = connections()[String(body.id ?? "")];
			if (conn !== undefined && (body.mirror === "source" || body.mirror === "all")) conn.mirror = body.mirror;
			if (conn === undefined) throw new Error("No such IM bot");
			const platform = imPlatform(conn.platform);
			if (platform === undefined) throw new Error("No such platform");
			if (body.botId !== undefined) {
				const bot = rt.botOf(String(body.botId));
				if (bot === undefined) throw new Error("Choose a Bot first");
				conn.botId = bot.id;
			}
			if (body.botId !== undefined || body.enabled !== undefined) touchBinding(conn);
			if (body.enabled !== undefined) conn.enabled = body.enabled === true;
			if (body.fields !== undefined) {
				const fields = cleanFields(platform, body.fields, conn.settings);
				const env = await envFor(conn);
				const check: Record<string, any> = { ...fields };
				for (const field of platform.fields) {
					if (field.secret && check[field.key] === undefined)
						check[field.key] = rt.secretValue(conn.secrets[field.key]);
				}
				const { account } = await adapters[conn.platform].check(check, env);
				conn.account = account;
				await saveSecrets(conn, platform, fields);
				for (const field of platform.fields) {
					if (!field.secret && fields[field.key] !== undefined) conn.settings[field.key] = fields[field.key];
				}
			}
			await rt.save();
			// New settings invalidate the old failure: try again at once instead of
			// waiting out the previous backoff.
			setStatus(conn.id, { state: "off", error: undefined, attempts: 0, nextRetryAt: 0 });
			if (runners.has(conn.id)) await stop(conn.id);
			await sync();
			return viewOf(conn);
		},
		async "im-remove"(body: any) {
			const id = String(body.id ?? "");
			const conn = connections()[id];
			if (conn === undefined) throw new Error("No such IM bot");
			await stop(id);
			for (const name of Object.values(conn.secrets ?? {})) {
				await rt.secretEndpoint("secret-delete", { name }).catch(() => {});
			}
			delete connections()[id];
			runtimes.delete(id);
			await rm(join(imDir, `${id}.json`), { force: true }).catch(() => {});
			await rt.save();
			return true;
		},
		async "im-pair"(body: any) {
			const conn = connections()[String(body.id ?? "")];
			if (conn === undefined) throw new Error("No such IM bot");
			const at = (conn.requests ?? []).findIndex((entry: any) => entry.id === String(body.senderId ?? ""));
			if (at === -1) throw new Error("This request is gone");
			const [request] = conn.requests.splice(at, 1);
			if (body.allow === true) {
				touchBinding(conn);
				conn.paired = [...(conn.paired ?? []), { id: request.id, name: request.name, at: Date.now() }];
				conn.chats ??= {};
				conn.chats[request.chatKey] ??= { kind: request.chatKind, title: request.name, at: Date.now() };
				await rt.save();
				const chat = conn.chats[request.chatKey];
				const target = resolveTarget(conn, chat);
				const name = target === undefined ? undefined : targetName(conn, target);
				await sendTo(
					conn,
					request.chatKey,
					{ key: request.chatKey, kind: request.chatKind, title: chat.title },
					name === undefined
						? text(request.chatKind === "group" ? "unboundGroup" : "unbound")
						: text("connected", { target: name }),
				);
			} else {
				await rt.save();
			}
			return true;
		},
		async "im-unpair"(body: any) {
			const conn = connections()[String(body.id ?? "")];
			if (conn === undefined) throw new Error("No such IM bot");
			touchBinding(conn);
			conn.paired = (conn.paired ?? []).filter((entry: any) => entry.id !== String(body.senderId ?? ""));
			await rt.save();
			return true;
		},
		async "im-chat"(body: any) {
			const conn = connections()[String(body.id ?? "")];
			if (conn === undefined) throw new Error("No such IM bot");
			const chat = conn.chats?.[String(body.chatKey ?? "")];
			if (chat === undefined) throw new Error("No such chat");
			touchBinding(conn);
			if (body.remove === true) {
				delete conn.chats[String(body.chatKey ?? "")];
			} else if (body.target === null) {
				delete chat.target;
			} else if (body.target !== undefined) {
				const target = body.target;
				if (target.botId !== undefined && rt.botOf(target.botId) === undefined)
					throw new Error("Choose a Bot or a group");
				if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined)
					throw new Error("Choose a Bot or a group");
				chat.target =
					target.botId !== undefined ? { botId: String(target.botId) } : { roomId: String(target.roomId) };
			}
			await rt.save();
			return true;
		},
		async "im-retry"(body: any) {
			const conn = connections()[String(body.id ?? "")];
			if (conn === undefined) throw new Error("No such IM bot");
			// Manual retry: forget the wait and the failure marks, then reconnect now.
			setStatus(conn.id, {
				state: "off",
				error: undefined,
				attempts: 0,
				nextRetryAt: 0,
				referenceId: undefined,
				messageError: false,
			});
			if (runners.has(conn.id)) await stop(conn.id);
			await sync();
			return true;
		},
		async "im-login-start"(body: any) {
			const platform = imPlatform(String(body.platform ?? ""));
			const adapter = platform === undefined ? undefined : adapters[platform.id];
			if (platform === undefined || typeof (adapter as any)?.loginStart !== "function")
				throw new Error("This platform has no QR login");
			const bot = rt.botOf(String(body.botId ?? ""));
			if (bot === undefined) throw new Error("Choose a Bot first");
			const env = await envFor(
				{ id: "im_login", platform: platform.id, settings: {}, secrets: {} },
				{ get: () => ({}), set: () => {} },
			);
			const login = await (adapter as any).loginStart(env);
			return { loginId: login.loginId, qr: login.qr, expiresAt: login.expiresAt, botId: bot.id };
		},
		async "im-login-wait"(body: any) {
			const platform = imPlatform(String(body.platform ?? "weixin"));
			const adapter = platform === undefined ? undefined : adapters[platform.id];
			if (platform === undefined || typeof (adapter as any)?.loginWait !== "function")
				throw new Error("This platform has no QR login");
			const bot = rt.botOf(String(body.botId ?? ""));
			if (bot === undefined) throw new Error("Choose a Bot first");
			const env = await envFor(
				{ id: "im_login", platform: platform.id, settings: {}, secrets: {} },
				{ get: () => ({}), set: () => {} },
			);
			const login = await (adapter as any).loginWait(String(body.loginId ?? ""), env);
			if (login.status !== "done") return { status: login.status };
			// Confirmed: create the connection with the platform credentials the
			// login returned, paired with the scanning owner — no review needed.
			const conn: any = {
				id: `im_${randomBytes(4).toString("hex")}`,
				platform: platform.id,
				account: login.connection.account,
				botId: bot.id,
				settings: login.connection.settings ?? {},
				secrets: {},
				enabled: true,
				paired: login.owner === undefined ? [] : [{ id: login.owner.id, name: login.owner.name, at: Date.now() }],
				requests: [],
				chats:
					login.owner === undefined
						? {}
						: { [login.owner.id]: { kind: "direct", title: login.owner.name, at: Date.now() } },
				createdAt: Date.now(),
			};
			for (const [key, value] of Object.entries((login.connection.secrets ?? {}) as Record<string, any>)) {
				const name = secretName(conn, key);
				await rt.secretEndpoint("secret-set", { name, value, purpose: `${platform.name} IM bot`, scope: [] });
				conn.secrets[key] = name;
			}
			connections()[conn.id] = conn;
			await rt.save();
			await sync();
			return { status: "done", id: conn.id };
		},
	};

	const imEndpoint = async (endpoint: any, body: any) => {
		const result = await endpoints[endpoint]?.(body ?? {});
		if (result === undefined) throw new Error(`Unknown endpoint ${endpoint}`);
		void sync();
		void diffCards();
		return result;
	};

	// ------------------------------------------------------------------ im via
	// IM-originated user messages, keyed by session and event seq, so the client
	// can tag a message with the platform it came from. A Session's entries go
	// when it stops being the chat's current part.
	const imVia = new Map();
	// seq → the request that brought that message in, per session. The window tags a message by
	// seq; a chat platform needs the message id the request came from, so both are kept.
	const seqOrigins = new Map<string, Record<number, string>>();
	// One mark per chat message: the companion may change its mind, but the platform must not be
	// asked twice for the same emoji on the same message.
	const markedOnPlatform = new Set<string>();
	const imViaView = () => {
		for (const sessionId of imVia.keys()) if (!rt.chatOwners.has(sessionId)) imVia.delete(sessionId);
		return Object.fromEntries([...imVia.entries()].map(([sessionId, seqs]) => [sessionId, { ...seqs }]));
	};

	// The companion's mark on the user's message, in the chat where the message was sent. Best
	// effort by design: a platform that has no key for this emoji, or that refuses it, simply gets
	// no mark, and the window still shows it. Nothing here may delay an answer.
	const reactOnIm = async (sessionId: string, seq: number | string, emoji: string): Promise<boolean> => {
		const requestId = seqOrigins.get(sessionId)?.[Number(seq)];
		if (requestId === undefined) return false;
		const origin = originOf(requestId);
		const messageId = String(origin?.messageId ?? "");
		if (origin === undefined || messageId === "") return false;
		const mark = `${origin.connId}:${messageId}:${emoji}`;
		if (markedOnPlatform.has(mark)) return false;
		const conn = connections()[origin.connId];
		if (conn === undefined) return false;
		const runner = runners.get(origin.connId);
		const handle = runner?.handle ?? runner;
		if (typeof handle?.addReaction !== "function") return false;
		const key = reactionKey(emoji);
		if (key === undefined) return false;
		markedOnPlatform.add(mark);
		if (markedOnPlatform.size > 500) markedOnPlatform.clear();
		try {
			await handle.addReaction({ key: origin.chatKey }, messageId, key);
			return true;
		} catch (error: any) {
			// A refused mark is not worth a retry or a user-visible error, but it is worth a log.
			rt.warn("ocean-crew im: reaction %s on %s refused: %s", key, messageId, error?.message ?? error);
			return false;
		}
	};

	// ----------------------------------------------------------------- outbound
	listenGlobal(ctx, "session/event", (session: any, event: any) => {
		if (!sawSessionEvent) {
			sawSessionEvent = true;
			rt.warn("ocean-crew: im now receives DSH session events");
		}
		if (event.type === "user/message") {
			// The turn that carries this message has started; a queued message must not
			// be settled by the end of the turn it waited behind.
			const rpcId = event.data?.source?.rpcId;
			if (typeof rpcId === "string")
				for (const held of pendingReactions.values()) if (held.requestId === rpcId) held.started = true;
		}
		if (event.type === "turn/end") {
			const run = scheduledRuns.get(session.id);
			scheduledRuns.delete(session.id);
			scheduledTurns.delete(session.id);
			if (run !== undefined) recordScheduledRun(session.id, run, event);
			const spoken = spokenAnswers.get(session.id);
			spokenAnswers.delete(session.id);
			if (spoken !== undefined) {
				const voiceBotId = rt.chatOwners.get(session.id);
				if (voiceBotId !== undefined) {
					for (const { conn, chatKey, chat } of replyTargets(ownerOrigins.get(voiceBotId), `bot:${voiceBotId}`)) {
						if (chat.kind !== "direct" || typeof rt.speak !== "function") continue;
						const settingsView: any = (rt as Record<string, any>).ttsSettingsView?.();
						const spokenFormat = conn.platform === "feishu" ? "opus" : "mp3";
						const voiceCompanion = (rt as Record<string, any>).companionOf?.(voiceBotId);
						void (async () => {
							try {
								const audio = await rt.speak(
									spoken.replace(/[*_`#>]+/g, ""),
									spokenFormat,
									voiceCompanion?.voiceId,
								);
								await sendMedia(
									conn,
									chatKey,
									{ key: chatKey, kind: chat.kind, title: chat.title },
									[
										{
											kind: "file",
											name: audio.name,
											data: audio.bytes,
											voice: settingsView?.voiceItem === true,
										},
									],
									"",
								);
							} catch (error: any) {
								// The words were held back for the audio; a failed speech must not
								// swallow the answer, so they go out as the text they were.
								rt.warn("ocean-crew: im spoken answer failed: %s", error?.message ?? error);
								await sendTo(
									conn,
									chatKey,
									{ key: chatKey, kind: chat.kind, title: chat.title },
									spoken,
									undefined,
									undefined,
									undefined,
									{
										card: true,
										...(rt.botOf(voiceBotId)?.name === undefined
											? {}
											: { title: rt.botOf(voiceBotId)?.name }),
									},
								);
							}
						})();
					}
				}
			}
			const notify = notifyAnswers.get(session.id);
			notifyAnswers.delete(session.id);
			if (notify !== undefined && notify.trim() !== "") {
				const owner = rt.chatOwners.get(session.id);
				const bot = rt.botOf(owner);
				if (owner !== undefined && bot !== undefined) {
					const targets = replyTargets(ownerOrigins.get(owner), `bot:${owner}`);
					if (targets.length === 0) {
						rt.warn(
							"ocean-crew: im reminder answer for %s has no chat to go to; a chat must talk to the Bot first",
							session.id,
						);
					}
					// A reminder's answer is a result the user asked for: quiet hours may defer it,
					// but the policy is the one place that decides, and a delivery is a receipt.
					void gate.offer(
						{
							kind: "requested_result",
							noticeId: `reminder:${session.id}:${notify.length}:${notify.slice(0, 40)}`,
						},
						async () => {
							for (const { conn, chatKey, chat } of targets)
								await sendTo(
									conn,
									chatKey,
									{ key: chatKey, kind: chat.kind, title: chat.title },
									notify,
									undefined,
									undefined,
									undefined,
									{
										card: true,
										title: bot.name,
									},
								);
						},
					);
				}
			}
			const held = windowAnswers.get(session.id);
			if (held !== undefined) {
				windowAnswers.delete(session.id);
				if (held.trim() !== "") {
					const owner = rt.chatOwners.get(session.id);
					if (owner !== undefined)
						for (const conn of Object.values(connections())) {
							if (!runners.has(conn.id) || conn.mirror !== "all") continue;
							for (const { chatKey, chat } of listeners(conn, { botId: owner }))
								sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, held);
						}
				}
			}
			// An aborted or interrupted turn gets no verdict: the processing mark is
			// removed and the message stays unmarked, the way dsh-im clears it.
			const kind = event.data?.reason?.kind;
			const outcome =
				kind === "error"
					? "error"
					: kind === "aborted" || kind === "interrupted" || kind === "blocked"
						? "clear"
						: "success";
			for (const [key, held] of pendingReactions)
				if (held.sessionId === session.id && held.started) finishReaction(key, outcome);
		}
		const botId = rt.chatOwners.get(session.id);
		if (botId === undefined) {
			imVia.delete(session.id);
			return;
		}
		const rpcId = event.type === "user/message" ? event.data?.source?.rpcId : undefined;
		if (typeof rpcId === "string" && rpcId.startsWith("im:") && Number.isInteger(event.seq)) {
			imVia.set(session.id, { ...imVia.get(session.id), [event.seq]: rpcId.split(":")[1] });
			const held = seqOrigins.get(session.id) ?? {};
			held[event.seq] = rpcId;
			// A Session keeps only the marks it may still be asked about.
			const keys = Object.keys(held)
				.map(Number)
				.sort((a, b) => a - b);
			for (const old of keys.slice(0, Math.max(0, keys.length - 50))) delete held[old];
			seqOrigins.set(session.id, held);
			// The companion may have stored its mark before this listener ran. Whichever listener
			// runs first, the mark reaches the chat; the platform side dedupes a second attempt.
			const stored = ((rt.state as any)?.companionReactions ?? {})[session.id]?.[String(event.seq)];
			if (typeof stored === "string" && stored !== "") void reactOnIm(session.id, event.seq, stored);
		}
		// Which request this turn belongs to: the rpc id DSH echoes on the user message.
		// A turn from the window clears the session's request so it cannot inherit an
		// older IM route.
		if (event.type === "turn/start") {
			const turn = event.data?.turn;
			if (typeof turn === "number" && Number.isInteger(turn)) {
				currentTurns.set(session.id, turn);
				const waiting = waitingTurns.get(session.id);
				if (waiting !== undefined) {
					waitingTurns.delete(session.id);
					bindTurn(session.id, turn, waiting);
				}
			}
		}
		if (event.type === "turn/end") {
			currentTurns.delete(session.id);
			const owner = rt.chatOwners.get(session.id);
			if (owner !== undefined) stopTypingNow(owner);
		}
		if (event.type === "user/message" && event.data?.source?.kind === "schedule") {
			scheduledTurns.add(session.id);
			const source: any = event.data?.source ?? {};
			const taskId = source.taskId ?? source.scheduleId ?? source.id;
			scheduledRuns.set(session.id, {
				...(typeof taskId === "string" && taskId !== "" ? { taskId } : {}),
				...(rt.chatOwners.get(session.id) === undefined ? {} : { ownerId: rt.chatOwners.get(session.id) }),
				startedAt: Date.now(),
			});
		}
		if (event.type === "user/message" && event.data?.source?.kind === "user") {
			const turn = turnOf(session.id, event);
			const wanted = typeof rpcId === "string" && rpcId.startsWith("im:") ? rpcId : "";
			if (typeof rpcId === "string" && rpcId.startsWith("im:")) sessionOrigins.set(session.id, rpcId);
			else sessionOrigins.delete(session.id);
			if (turn === undefined) {
				// The start event has not arrived yet: keep the id and bind it when it does.
				waitingTurns.set(session.id, wanted);
			} else {
				bindTurn(session.id, turn, wanted);
			}
		}
		const requestId = requestFor(session.id, event);
		const targets = replyTargets(requestId, `bot:${botId}`);
		if (targets.length === 0) {
			// A Bot that owes IM an answer and has no route for this turn is a routing
			// failure, not a window turn: record why, without the answer's text.
			if (event.type === "assistant/message" && ownerOrigins.has(botId))
				rt.warn(
					"ocean-crew: im answer for %s not routed (%s)",
					session.id,
					requestId === undefined ? "no turn binding" : "origin no longer resolves",
				);
			// A turn that started in the window answers the window. A scheduled reminder's
			// answer is pushed to the chat that last talked to the Bot; an ordinary window
			// turn reaches IM only when the user asked for that (`imDeliverAnswers`), and
			// then as one final answer rather than every step.
			if (event.type === "assistant/message") {
				const scheduled = scheduledTurns.has(session.id);
				for (const item of rt.displayItems(session.id, [event])) {
					if (item.kind !== "bot" || item.text.trim() === "") continue;
					// "[PASS]" is the Bot agreeing there is nothing new: a routine that found
					// nothing stays quiet instead of saying so every time.
					if (scheduled && isPass(item.text)) continue;
					if (scheduled && rt.config?.imNotify !== false) notifyAnswers.set(session.id, item.text);
					if (rt.config?.imDeliverAnswers === true) windowAnswers.set(session.id, item.text);
				}
			}
			return;
		}
		const voiceSettings = (rt as Record<string, any>).ttsSettingsView?.();
		// Speaking an answer is a choice the user makes in Settings → Voice. It is off by
		// default: a companion that also spoke every reply sent the same words twice, once as
		// text and once as audio.
		const voiceAuto = voiceSettings?.enabled !== false && voiceSettings?.autoReply === true;
		const speakable = (text: string): boolean => text.trim() !== "" && text.length <= 300 && !text.includes("```");
		if (event.type === "assistant/message" && voiceAuto) {
			for (const item of rt.displayItems(session.id, [event]))
				if (item.kind === "bot" && speakable(item.text)) spokenAnswers.set(session.id, item.text);
		}
		const spokenHere = voiceAuto && spokenAnswers.get(session.id);
		for (const item of rt.displayItems(session.id, [event])) {
			if (item.kind !== "bot" && item.kind !== "view") continue;
			const body =
				item.kind === "bot"
					? item.text
					: viewCardText({ title: item.title, view: item.view }) || (item.title ?? "");
			// The answer being spoken now is held back: it goes out as audio, and only as text
			// if the speech cannot be made. A view card is always text, because it is not prose.
			if (item.kind === "bot" && spokenHere !== undefined && item.text === spokenHere) continue;
			const replyTo = originOf(requestId)?.messageId;
			const title = rt.botOf(botId)?.name;
			for (const { conn, chatKey, chat } of targets)
				sendTo(
					conn,
					chatKey,
					{ key: chatKey, kind: chat.kind, title: chat.title },
					body,
					undefined,
					undefined,
					replyTo,
					{ card: true, ...(title === undefined ? {} : { title }) },
				);
		}
	});

	rt.onRoomLine((room: any, line: any) => {
		if (
			line.botId === undefined ||
			line.kind !== undefined ||
			typeof line.text !== "string" ||
			line.text.trim() === ""
		)
			return;
		const body = `**${line.who}**: ${line.text}`;
		// A group's lines go to the group chat the work came from; a group with no IM
		// origin sends nothing, and a stale binding sends nothing either.
		const targets = replyTargets(ownerOrigins.get(room.id), `room:${room.id}`);
		for (const { conn, chatKey, chat } of targets)
			sendTo(
				conn,
				chatKey,
				{ key: chatKey, kind: chat.kind, title: chat.title },
				body,
				undefined,
				undefined,
				undefined,
				{
					card: true,
					title: room.name,
				},
			);
	});

	rt.onApproval((kind: any, data: any) => {
		if (kind === "open") {
			void (async () => {
				for (const conn of Object.values(connections())) {
					const runner = runners.get(conn.id);
					if (runner === undefined) continue;
					const bot = rt.botOf(data.botId);
					// An approval goes to the chat whose request triggered it; an approval raised
					// in the window stays in the window.
					const targets =
						data.roomId !== undefined
							? replyTargets(ownerOrigins.get(String(data.roomId)), `room:${data.roomId}`)
							: replyTargets(ownerOrigins.get(String(data.botId)), `bot:${data.botId}`);
					const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.approval(data.id) : undefined;
					await sendCard(conn, `a:${data.id}`, targets, cardText.approval(bot?.name ?? "?", data), buttons);
				}
			})().catch((error) => rt.warn("ocean-crew: im approval card failed: %s", error));
			return;
		}
		void (async () => {
			for (const conn of Object.values(connections())) {
				await settleCard(
					conn.id,
					`a:${data.id}`,
					data.outcome === "allowed-once"
						? text("allow")
						: data.outcome === "rejected"
							? text("reject")
							: text("answered"),
				);
				await settledEdits(conn);
			}
		})().catch(() => {});
	});

	rt.onSaved(() => {
		void diffCards()
			.then(settleGone)
			.catch(() => {});
		void sync().catch(() => {});
	});

	let interval: any;
	ctx.effect(() => {
		interval = setInterval(() => {
			void rt
				.refresh()
				.then(() => sync())
				.catch(() => {});
		}, reconcileMs);
		interval.unref?.();
		void rt
			.load()
			.then(() => sync())
			.catch(() => {});
		return () => {
			stopped = true;
			clearInterval(interval);
			return Promise.all([...runners.keys()].map(stop)).then(async () => {
				for (const held of runtimes.values()) if (held.timer !== undefined) clearTimeout(held.timer);
				for (const key of pendingReactions.keys()) finishReaction(key, "clear");
				await Promise.all([...runtimes.keys()].map(writeRuntime)).catch(() => {});
			});
		};
	}, "ocean-crew: im");

	const imView = () => ({
		connections: Object.values(connections()).map(viewOf),
		platforms: IM_PLATFORMS.filter((platform) => adaptersFor().includes(platform.id)).map((platform) => platform.id),
	});
	const imStatusView = () =>
		Object.fromEntries(
			[...statuses.entries()].map(([id, status]) => [
				id,
				{
					state: status.state ?? "off",
					...(status.error !== undefined ? { error: status.error } : {}),
					attempts: status.attempts ?? 0,
					...(status.nextRetryAt > 0 ? { nextRetryAt: status.nextRetryAt } : {}),
					...(status.referenceId !== undefined ? { referenceId: status.referenceId } : {}),
					at: status.at,
				},
			]),
		);

	// The owner a Session speaks for: the group chat it belongs to, or the Bot whose own
	// chat it is. Both kinds have their own IM origins, and only those decide where a
	// file goes.
	const ownerOfSession = (sessionId: string): string | undefined => {
		const room = rt.roomOf(sessionId);
		if (room !== undefined) return room.id;
		const member = rt.groupOwners.get(sessionId);
		if (member !== undefined) return member.roomId;
		return rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId;
	};

	// Hand a file to the chats the current request came from. Nothing is broadcast: the
	// origin record of the turn decides the targets, exactly as a text answer does.
	const imSendFile = async (
		sessionId: string,
		file: { path: string; note?: string; name?: string; voice?: boolean },
	): Promise<{ sent: number; reason?: string }> => {
		const owner = ownerOfSession(sessionId);
		if (owner === undefined) return { sent: 0, reason: "this conversation is not linked to an IM chat" };
		const requestId = ownerOrigins.get(owner);
		const targets = replyTargets(requestId, rt.roomOf(owner) !== undefined ? `room:${owner}` : `bot:${owner}`);
		if (targets.length === 0) return { sent: 0, reason: "this conversation is not linked to an IM chat" };
		let data: Buffer;
		try {
			data = await readFile(String(file.path ?? ""));
		} catch {
			throw Object.assign(new Error(`Cannot read ${String(file.path ?? "")}.`), { code: "bot/not-found" });
		}
		if (data.byteLength > MEDIA_LIMIT) {
			throw Object.assign(new Error(`The file is larger than ${MEDIA_LIMIT} bytes.`), { code: "bot/invalid" });
		}
		const name =
			String(file.name ?? file.path ?? "file")
				.split(/[\\/]/)
				.pop() || "file";
		const kind = IMAGE_EXT.test(name) ? "image" : "file";
		const mime = MIME_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
		let sent = 0;
		for (const target of targets) {
			if (
				await sendMedia(
					target.conn,
					target.chatKey,
					// The adapter reads the chat's key from the message it is given; a stored
					// chat entry is keyed by chatKey and does not carry it back.
					{ ...target.chat, key: target.chatKey },
					[{ kind, name, mime, data, ...(file.voice === true ? { voice: true } : {}) }],
					String(file.note ?? ""),
				)
			)
				sent += 1;
		}
		return { sent };
	};

	// Which audio container the chat behind this request can draw a voice message from:
	// Feishu only from opus, WeChat's own bubble from mp3 (and its client ignores bot
	// voice bubbles, so plain audio is a file there). Unknown chats get no preference.
	const imVoicePlan = (sessionId: string): { platform?: string; format?: string } => {
		const owner = ownerOfSession(sessionId);
		if (owner === undefined) return {};
		const requestId = ownerOrigins.get(owner);
		const targets = replyTargets(requestId, rt.roomOf(owner) !== undefined ? `room:${owner}` : `bot:${owner}`);
		const platform = targets[0]?.conn?.platform;
		if (platform === "feishu") return { platform, format: "opus" };
		if (platform === "weixin") return { platform, format: "mp3" };
		return { platform };
	};

	Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint, imSendFile, imVoicePlan, reactOnIm });
}
