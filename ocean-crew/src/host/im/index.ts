// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a Ocean Crew group.
// The platform adapters (im/platforms/) own the wire; this module owns pairing,
// routing, cards and the send queues. Only the dsh holding the team lock connects.
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IM_PLATFORMS, imPlatform } from "../../shared/im-platforms.ts";
import { viewCardText } from "../chat/parts.ts";
import { replaceFile } from "../core/files.ts";
import { adapters as adapterRegistry } from "./platforms/index.ts";
import { startStatusReaction } from "./reaction.ts";
import { failClass, nextAction } from "./supervisor.ts";

const RECONCILE_MS = 15_000;
const RUNTIME_SAVE_MS = 400;
const RETRY_MS = 5_000;
const SEND_TIMEOUT_MS = 60_000;
const QUEUE_LIMIT = 100;
const TYPING_MS = 4_000;
// A reaction left on a message no longer ends on its own; drop it after this long.
const REACTION_MAX_MS = 15 * 60_000;
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/;

// The registry is read as a map the tests (and a future adapter) can extend by platform id.
const adapters: Record<string, any> = adapterRegistry as any;

const secretField = (key: any) => key.replace(/[A-Z]/g, (char: any) => `_${char}`).toUpperCase();

export function install(rt: any) {
	const { ctx } = rt;

	// works through its own record type. One cast states that gap.
	const state: any = rt.state as any;
	const imDir = join(rt.home, "im");
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
				answered: zh() ? "已答" : "answered",
				numbers: zh() ? "回复编号" : "reply with the number",
				numbersMulti: zh() ? "回复编号，多选用空格隔开" : "reply with the numbers, separated by spaces",
				allow: zh() ? "允许一次" : "Allow once",
				reject: zh() ? "拒绝" : "Reject",
			} as Record<string, string>
		)[key];
		return line ?? key;
	};

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

	const enqueue = (conn: any, chatKey: any, job: any) => {
		const runner = runners.get(conn.id);
		if (runner === undefined) return;
		let queue = runner.queues.get(chatKey);
		if (queue === undefined) {
			queue = { jobs: [] };
			runner.queues.set(chatKey, queue);
		}
		if (queue.jobs.length >= QUEUE_LIMIT) {
			// Never drop the in-flight head: the successful send shifts its own job.
			queue.jobs.splice(queue.sending === queue.jobs[0] ? 1 : 0, 1);
			rt.warn("ocean-crew: im send queue for %s/%s is full; dropped the oldest message", conn.id, chatKey);
		}
		queue.jobs.push(job);
		if (queue.jobs.length === 1) void drain(conn, chatKey);
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
	const dropSend = (conn: any, how: any, error: any) => {
		const message = rt.redactSecrets(String(error?.message ?? error)).slice(0, 300);
		const reference = referenceId();
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
	const drain = async (conn: any, chatKey: any) => {
		const runner = runners.get(conn.id);
		const queue = runner?.queues.get(chatKey);
		// A reserved slot has no handle until connect() lands; start() re-kicks
		// anything queued in the meantime.
		if (runner?.handle === undefined || queue === undefined) return;
		while (queue.jobs.length > 0) {
			const job = queue.jobs[0];
			queue.sending = job;
			try {
				const sent = await withSendTimeout(runner.handle.send(job.chat, job));
				job.after?.(sent);
				queue.jobs.shift();
				if (statuses.get(conn.id)?.messageError === true) {
					setStatus(conn.id, { state: "ready", error: undefined, referenceId: undefined, messageError: false });
				}
			} catch (error: any) {
				const how: any = failClass(error);
				if (how === "retry") {
					const wait = Number(error?.retryAfter) > 0 ? error.retryAfter * 1000 : RETRY_MS;
					queue.retry = setTimeout(() => {
						void drain(conn, chatKey);
					}, wait);
					queue.retry.unref?.();
					return;
				}
				queue.jobs.shift();
				dropSend(conn, how, error);
			} finally {
				queue.sending = undefined;
			}
		}
	};
	const sendText = (conn: any, chat: any, body: any, buttons?: any, after?: any) =>
		enqueue(conn, chat.key, { chat, text: body, buttons, after });
	const sendTo = (conn: any, chatKey: any, chat: any, body: any, buttons?: any, after?: any) =>
		enqueue(conn, chatKey, { chat, text: body, buttons, after });

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
		const sessionId = target.botId ?? target.roomId;
		const content: any[] = [];
		if (body !== "") content.push({ type: "text", text: body });
		for (const image of msg.images ?? [])
			content.push({ type: "image", mediaType: image.mediaType, data: image.data });
		const env = await envFor(conn);
		for (const file of msg.files ?? []) {
			try {
				const receiptId = await env.uploadFile(rt.botOf(sessionId) ? rt.chatOf(sessionId) : sessionId, file);
				content.push({ type: "file", receiptId });
			} catch {
				await sendText(conn, msg.chat, text("noFile"));
			}
		}
		if (content.length === 0) return;
		const requestId = `im:${conn.platform}:${randomUUID()}`;
		await rt.sendUser({ sessionId, content, requestId });
		// A room message is answered by member Bot turns under their own sessions, so
		// no single session end can settle its mark; only direct chats are marked.
		if (target.botId !== undefined) beginReaction(conn, msg, sessionId, requestId);
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

	const sendCard = async (conn: any, cardKey: any, targets: any, body: any, buttons?: any) => {
		for (const { chatKey, chat } of targets) {
			sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body, buttons, (sent: any) => {
				void markCard(conn.id, cardKey, chatKey, sent?.messageId, body);
			});
		}
		// A card a chat never got (queued behind a failure) is still recorded below.
		for (const { chatKey } of targets) await markCard(conn.id, cardKey, chatKey, undefined, body);
	};

	const diffCards = async () => {
		if (rt.readOnly() !== undefined) return;
		for (const conn of Object.values(connections())) {
			const runner = runners.get(conn.id);
			if (runner === undefined) continue;
			const data = await cardsOf(conn.id);
			// Questions: one card per open question id, sent to the Bot's chats.
			for (const [sessionId, question] of Object.entries((state.questions ?? {}) as Record<string, any>)) {
				const cardKey = `q:${question.id}`;
				if (data.cards[cardKey] !== undefined) continue;
				const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId;
				const bot = rt.botOf(botId);
				if (bot === undefined) continue;
				const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined;
				await sendCard(conn, cardKey, listeners(conn, { botId }), cardText.question(bot.name, question), buttons);
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
						listeners(conn, { botId }),
						text("secretAsk", { bot: bot.name, name: request.name }),
					);
				}
			}
			// Views awaiting a reply: text form only.
			for (const [sessionId, view] of Object.entries((state.views ?? {}) as Record<string, any>)) {
				const cardKey = `v:${view.id}`;
				if (data.cards[cardKey] !== undefined) continue;
				const botId = rt.chatOwners.get(sessionId);
				const bot = rt.botOf(botId);
				if (bot === undefined) continue;
				const form = viewCardText({ title: view.title, view: view.view });
				await sendCard(
					conn,
					cardKey,
					listeners(conn, { botId }),
					`${text("viewShow", { bot: bot.name })}${form !== "" ? `\n${form}` : view.title ? `\n${view.title}` : ""}`,
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

	const busyOf = (target: any) => {
		if (target?.botId !== undefined) return rt.live.get(rt.chatOf(target.botId))?.turn !== undefined;
		if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0;
		return false;
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
			for (const chatKey of runner.queues.keys()) void drain(conn, chatKey);
			if (typeof runner.handle?.typing === "function") {
				runner.typing = setInterval(() => {
					for (const { chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
						if (target !== undefined && busyOf(target))
							void runner.handle
								.typing({ key: chat.key ?? chat, kind: chat.kind, title: chat.title })
								.catch?.(() => {});
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
			if (conn === undefined) throw new Error("No such IM bot");
			const platform = imPlatform(conn.platform);
			if (platform === undefined) throw new Error("No such platform");
			if (body.botId !== undefined) {
				const bot = rt.botOf(String(body.botId));
				if (bot === undefined) throw new Error("Choose a Bot first");
				conn.botId = bot.id;
			}
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
			conn.paired = (conn.paired ?? []).filter((entry: any) => entry.id !== String(body.senderId ?? ""));
			await rt.save();
			return true;
		},
		async "im-chat"(body: any) {
			const conn = connections()[String(body.id ?? "")];
			if (conn === undefined) throw new Error("No such IM bot");
			const chat = conn.chats?.[String(body.chatKey ?? "")];
			if (chat === undefined) throw new Error("No such chat");
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
	const imViaView = () => {
		for (const sessionId of imVia.keys()) if (!rt.chatOwners.has(sessionId)) imVia.delete(sessionId);
		return Object.fromEntries([...imVia.entries()].map(([sessionId, seqs]) => [sessionId, { ...seqs }]));
	};

	// ----------------------------------------------------------------- outbound
	ctx.on("session/event", (session: any, event: any) => {
		if (event.type === "user/message") {
			// The turn that carries this message has started; a queued message must not
			// be settled by the end of the turn it waited behind.
			const rpcId = event.data?.source?.rpcId;
			if (typeof rpcId === "string")
				for (const held of pendingReactions.values()) if (held.requestId === rpcId) held.started = true;
		}
		if (event.type === "turn/end") {
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
		}
		for (const item of rt.displayItems(session.id, [event])) {
			if (item.kind !== "bot" && item.kind !== "view") continue;
			const body =
				item.kind === "bot"
					? item.text
					: viewCardText({ title: item.title, view: item.view }) || (item.title ?? "");
			for (const conn of Object.values(connections())) {
				if (!runners.has(conn.id)) continue;
				for (const { chatKey, chat } of listeners(conn, { botId }))
					sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body);
			}
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
		for (const conn of Object.values(connections())) {
			if (!runners.has(conn.id)) continue;
			for (const { chatKey, chat } of listeners(conn, { roomId: room.id }))
				sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body);
		}
	});

	rt.onApproval((kind: any, data: any) => {
		if (kind === "open") {
			void (async () => {
				for (const conn of Object.values(connections())) {
					const runner = runners.get(conn.id);
					if (runner === undefined) continue;
					const bot = rt.botOf(data.botId);
					const targets =
						data.roomId !== undefined
							? listeners(conn, { roomId: data.roomId })
							: listeners(conn, { botId: data.botId });
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

	Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint });
}
