// WeChat iLink: a QR login creates the connection — get_bot_qrcode, then a
// get_qrcode_status long poll until the owner confirms on their phone; the
// reply carries bot_token, ilink_bot_id, ilink_user_id and the base URL. From
// then msg/notifystart opens the session and a getupdates long poll delivers
// messages (the get_updates_buf cursor, the seen message ids and the latest
// context_token per user live in the connection runtime so they survive
// restarts); sends go out through sendmessage with that user's context_token,
// ~1800-char text chunks. Typing uses the getconfig ticket and that
// context_token. Voice items arrive with a transcript; images download from
// the CDN and decrypt with their AES key. A platform refusal is permanent and
// a send whose outcome is unknown is never retried blindly.
// from dsh-im (MIT, see NOTICE).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const QR_BASE = "https://ilinkai.weixin.qq.com/";
const BOT_TYPE = "3";
const TEXT_LIMIT = 1800;
// The pause between two bubbles of one reply.
const BUBBLE_GAP_MS = 450;
const POLL_TIMEOUT_MS = 35_000;
const POLL_GRACE_MS = 15_000;
const ILINK_APP_ID = "bot";
// The iLink client version, packed as 0x00MMNNPP: 2.4.6 is what the reference
// client (dsh-im 5.10.0, the source of this port) identifies itself as.
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
// The server answers this on getupdates when the bot session is not open; the
// account has to scan a new QR code.
const SESSION_EXPIRED = -14;
// Waits between attempts to open the session, from the reference client.
const START_RETRY_DELAYS_MS = [250, 1_000, 3_000];
// A chunk keeps one client_id across attempts. Only a fetch that never got an
// HTTP answer at all is retried: any other outcome may already have reached
// the server, so it is reported as unknown instead of being sent again.
const SEND_RETRY_DELAYS_MS = [400, 1_200];
const SEND_TIMEOUT_MS = 15_000;
// Poll failures: min(2000 * 2^(n-1), 10000) ms, and three in a row stop the
// connection with an error instead of retrying the same failure forever.
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const SEEN_LIMIT = 1_000;
const CONTEXT_TOKEN_LIMIT = 1_000;
const LOGIN_LIFETIME_MS = 5 * 60_000;

/** An iLink failure with the shape the host's supervisor reads. */
interface WeixinError extends Error {
	stopped?: boolean;
	permanent?: boolean;
	unknown?: boolean;
	timeout?: boolean;
	network?: boolean;
	retryAfter?: number;
	status?: number;
	cause?: unknown;
}

/** One stored context_token: the conversation capability for a user, in order. */
interface ContextEntry {
	token: string;
	seq: string | null;
	messageTimeMs: number | null;
	receivedAt: number | null;
}

// iLink answers with the bare host (no trailing slash), and the request URL is
// built by appending a path: normalize to exactly one slash either way.
const withSlash = (value: unknown): string => `${String(value).replace(/\/+$/, "")}/`;
// A server-supplied host (QR redirect, confirmed base URL) may come without a
// scheme; the connection URL is built by appending a path to it.
const serverBase = (value: unknown, fallback: unknown): string => {
	const raw = String(value ?? "").trim();
	if (raw === "") return withSlash(fallback);
	return withSlash(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
};
const qrBase = (env: any): string => withSlash(env.config?.qr ?? env.config?.api ?? QR_BASE);
const base = (env: any, fields: any): string => withSlash(fields.baseUrl || env.config?.api || QR_BASE);
const baseInfo = (): Record<string, string> => ({ channel_version: "ocean-crew" });
// iLink identifies the calling client by these two headers on every request.
const clientHeaders = (): Record<string, string> => ({
	"iLink-App-Id": ILINK_APP_ID,
	"iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
});
// X-WECHAT-UIN is base64 of a random uint32. The protocol reference and the
// reference client both mint a new value per request rather than keeping one.
const randomUin = (): string => Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");

const fail = (reason: unknown, opts: Record<string, unknown> = {}): WeixinError =>
	Object.assign(new Error(String(reason)), opts) as WeixinError;
const stoppedError = (): WeixinError => fail("stopped", { stopped: true });
const refusal = (reason: unknown): WeixinError => fail(reason, { permanent: true });
const uncertain = (reason: unknown, cause?: unknown): WeixinError =>
	fail(reason, { unknown: true, ...(cause === undefined ? {} : { cause }) });

// iLink omits ret on a successful getupdates answer, so the answer itself has to
// prove it came from iLink: a bad proxy or a stale endpoint can answer 200 with
// anything, and that must not read as an idle successful poll.
const isUpdatesAnswer = (answer: any): boolean =>
	answer !== null &&
	typeof answer === "object" &&
	(Array.isArray(answer.msgs) || typeof answer.get_updates_buf === "string" || typeof answer.sync_buf === "string");
const isObject = (value: unknown): value is Record<string, any> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
// The provider status is `ret` on bot calls and `errcode` on the notification
// calls; a missing field means success, like iLink's own omissions.
const providerCode = (answer: any): number | string | undefined => {
	if (!isObject(answer)) return undefined;
	for (const field of ["ret", "errcode"]) {
		const value = answer[field];
		if (value === undefined || value === null) continue;
		const code = Number(value);
		return Number.isFinite(code) ? code : String(value);
	}
	return undefined;
};
const rejection = (answer: any): number | string | undefined => {
	const code = providerCode(answer);
	return code === undefined || code === 0 ? undefined : code;
};
const isExpired = (code: number | string): boolean => Number(code) === SESSION_EXPIRED;
// A 429 carries the wait in Retry-After, in seconds or as an HTTP date.
const retryAfterSeconds = (value: unknown): number => {
	if (value === null || value === undefined || value === "") return 1;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const at = Date.parse(String(value));
	return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1_000)) : 1;
};
const sequence = (value: unknown): string | null => {
	const text = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
	return /^\d+$/.test(text) ? BigInt(text).toString() : null;
};
const timestamp = (value: unknown): number | null => {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
};
const sha256 = (value: unknown): string =>
	createHash("sha256")
		.update(String(value ?? ""))
		.digest("hex");
const backoffMs = (failures: number): number => Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal?.aborted === true) return resolve();
		const timer = setTimeout(finish, ms);
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});

/** What a login flow holds between `loginStart` and `loginWait`. */
interface LoginHeld {
	qrcode: string;
	baseUrl: string;
	expiresAt: number;
}

const logins = new Map<string, LoginHeld>();

/** The iLink adapter the host registers; the host passes env with runtime/log/fetch. */
const weixin = {
	id: "weixin",

	// ---- QR login (im-login-start / im-login-wait drive these) --------------
	async loginStart(env: any): Promise<{ loginId: string; qr: string; expiresAt: number }> {
		const response = await env.fetch(`${qrBase(env)}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
			method: "POST",
			headers: { ...clientHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ local_token_list: [] }),
			signal: AbortSignal.timeout(10_000),
		});
		const body = await response.json().catch(() => ({}));
		if (body.qrcode === undefined) {
			const code = rejection(body);
			if (code !== undefined) throw refusal(`WeChat refused the QR code (${body.errmsg ?? code})`);
			throw fail(body.errmsg ?? "WeChat did not return a code");
		}
		const loginId = `wx_${randomBytes(8).toString("hex")}`;
		const expiresAt = Date.now() + LOGIN_LIFETIME_MS;
		logins.set(loginId, { qrcode: String(body.qrcode), baseUrl: qrBase(env), expiresAt });
		for (const [id, held] of logins) if (held.expiresAt < Date.now()) logins.delete(id);
		return { loginId, qr: String(body.qrcode_img_content ?? body.qrcode), expiresAt };
	},

	// The status poll walks the login through waiting → scanned → confirmed. The
	// host has no verification-code input, so the states that ask for one are
	// reported as terminal failures (the settings page shows the error and
	// offers a new code) rather than leaving the poll on "waiting" forever.
	async loginWait(loginId: string, env: any): Promise<any> {
		const id = String(loginId);
		const held = logins.get(id);
		if (held === undefined || held.expiresAt < Date.now()) {
			logins.delete(id);
			return { status: "expired" };
		}
		const response = await env
			.fetch(`${held.baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(held.qrcode)}`, {
				headers: clientHeaders(),
				signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
			})
			.catch(() => undefined);
		let body: any = {};
		try {
			body = await response.json();
		} catch {
			body = {};
		}
		if (!isObject(body)) body = {};
		const status = String(body.status ?? "wait");
		if (status === "expired" || status === "invalid") {
			logins.delete(id);
			return { status: "expired" };
		}
		if (status === "scaned_but_redirect") {
			// The account is served by another iLink host now: keep this login on the
			// host the server named and poll there on the next call.
			held.baseUrl = serverBase(body.redirect_host, held.baseUrl);
			return { status: "scanned" };
		}
		if (status === "scaned") return { status: "scanned" };
		if (status === "need_verifycode") {
			logins.delete(id);
			throw refusal("WeChat asks for a verification code; scan a new code to retry");
		}
		if (status === "verify_code_blocked") {
			logins.delete(id);
			throw refusal("WeChat blocked the verification; scan a new code to retry");
		}
		if (status === "binded_redirect") {
			logins.delete(id);
			throw refusal("This WeChat account is already bound; restore that bot instead of scanning again");
		}
		if (status !== "confirmed") return { status: "waiting" };
		logins.delete(id);
		const token = String(body.bot_token ?? "").trim();
		const accountId = String(body.ilink_bot_id ?? "").trim();
		if (token === "" || accountId === "")
			throw refusal("WeChat confirmed the scan but returned no bot credentials; scan a new code");
		return {
			status: "done",
			connection: {
				settings: { baseUrl: serverBase(body.baseurl, held.baseUrl) },
				secrets: { token },
				account: { id: accountId, name: "WeChat" },
			},
			owner: { id: String(body.ilink_user_id ?? ""), name: String(body.ilink_user_id ?? "") },
		};
	},

	// The credentials are proven by opening the session with msg/notifystart:
	// unlike a getupdates probe this never consumes a pending message batch.
	// iLink omits ret on success; a non-zero ret or errcode is the platform's
	// answer — -14 means the session is gone and the account needs a new scan.
	async check(fields: any, env: any): Promise<{ account: { id: string; name: string } }> {
		await notifyStart(env, base(env, fields), fields.token);
		return { account: { id: String(fields.ilinkBotId ?? ""), name: "WeChat" } };
	},

	// -------------------------------------------------------------------------
	connect(fields: any, env: any, handlers: any): any {
		const token = String(fields.token ?? "");
		const credential = sha256(token);
		let stopped = false;
		let running = false;
		let generation = 0;
		const lifecycle = new AbortController();
		const wait: (ms: number, signal?: AbortSignal) => Promise<void> =
			typeof env.sleep === "function" ? env.sleep : sleep;

		const runtime = (): any => env.runtime.get();
		const setRuntime = (patch: any): void => env.runtime.set(patch);

		// ------------------------------------------------------------ seen ids
		// Delivered message ids survive a restart: iLink can re-deliver a batch
		// after a reconnect, and the same message must not reach the Bot twice.
		const seen = new Set<string>(
			Array.isArray(runtime().seenMessageIds)
				? runtime().seenMessageIds.filter((id: unknown): id is string => typeof id === "string")
				: [],
		);
		while (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
		let seenChanged = false;
		const messageKey = (msg: any): string => {
			if (msg?.message_id !== undefined && msg.message_id !== null && String(msg.message_id) !== "")
				return String(msg.message_id);
			if (msg?.client_id !== undefined && msg.client_id !== null && String(msg.client_id) !== "")
				return String(msg.client_id);
			return "";
		};
		const markSeen = (id: string): void => {
			if (id === "" || seen.has(id)) return;
			seen.add(id);
			while (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
			seenChanged = true;
		};

		// ------------------------------------------------------ context tokens
		// Context tokens belong to one bot login: a new bot token invalidates all
		// of them, so the runtime records the token's hash and the map is cleared
		// when the hash changes. Entries are kept in least-recently-used order and
		// replaced only by a message that is not older (seq, then timestamp).
		const contextEntry = (value: unknown): ContextEntry | undefined => {
			if (typeof value === "string") return { token: value, seq: null, messageTimeMs: null, receivedAt: null };
			if (!isObject(value) || typeof value.token !== "string" || value.token === "") return undefined;
			return {
				token: value.token,
				seq: sequence(value.seq),
				messageTimeMs: timestamp(value.messageTimeMs),
				receivedAt: timestamp(value.receivedAt),
			};
		};
		const contextUsers = (): Record<string, ContextEntry> => {
			const held = runtime().contextTokens;
			if (!isObject(held) || held.credentialHash !== credential || !isObject(held.users)) return {};
			const users: Record<string, ContextEntry> = {};
			for (const [userId, value] of Object.entries(held.users)) {
				const entry = contextEntry(value);
				if (entry !== undefined) users[userId] = entry;
			}
			return users;
		};
		const contextTokenFor = (userId: string): string | undefined => contextUsers()[userId]?.token;
		const bindContext = (): void => {
			const held = runtime().contextTokens;
			if (isObject(held) && held.credentialHash === credential) return;
			setRuntime({ contextTokens: { credentialHash: credential, users: {} } });
		};
		const rememberContext = (userId: string, value: unknown, msg: any): void => {
			if (userId === "" || typeof value !== "string" || value === "") return;
			const users = contextUsers();
			const previous = users[userId];
			const next: ContextEntry = {
				token: value,
				seq: sequence(msg?.seq),
				messageTimeMs: timestamp(msg?.create_time_ms ?? msg?.message_time_ms),
				receivedAt: Date.now(),
			};
			// A late/duplicate batch must not replace a newer conversation
			// capability; without either ordering field the newest token wins.
			if (previous !== undefined) {
				if (previous.seq !== null && next.seq !== null && BigInt(next.seq) <= BigInt(previous.seq)) return;
				if (
					previous.messageTimeMs !== null &&
					next.messageTimeMs !== null &&
					next.messageTimeMs < previous.messageTimeMs
				)
					return;
				delete users[userId];
			}
			users[userId] = next;
			const keys = Object.keys(users);
			for (const old of keys.slice(0, Math.max(0, keys.length - CONTEXT_TOKEN_LIMIT))) delete users[old];
			setRuntime({ contextTokens: { credentialHash: credential, users } });
		};

		// ------------------------------------------------------------- delivery
		const deliver = async (msg: any): Promise<void> => {
			const userId = String(msg.from_user_id ?? "");
			if (userId === "") return;
			rememberContext(userId, msg.context_token, msg);
			const images: Array<{ mediaType: string; data: string }> = [];
			const files: Array<{ name: string; data?: Buffer }> = [];
			const texts: string[] = [];
			for (const item of msg.item_list ?? []) {
				if (item.type === 1 && item.text_item?.text !== undefined) {
					texts.push(withQuoted(String(item.text_item.text), item.ref_msg));
				}
				// Voice items carry their transcript in voice_item.text.
				else if (item.type === 3 && item.voice_item?.text !== undefined) texts.push(String(item.voice_item.text));
				else if (item.type === 2 && item.image_item?.media !== undefined) {
					const bytes = await image(item.image_item.media, env).catch(() => undefined);
					if (bytes !== undefined) images.push({ mediaType: "image/jpeg", data: bytes.toString("base64") });
				} else if (item.type === 4 && item.file_item !== undefined) {
					const bytes = await mediaBytes(item.file_item, env).catch(() => undefined);
					files.push({ name: String(item.file_item.file_name ?? "file"), ...(bytes ? { data: bytes } : {}) });
				} else if (item.type === 5 && item.video_item !== undefined) {
					const bytes = await mediaBytes(item.video_item, env).catch(() => undefined);
					const name = String(
						item.video_item.file_name ?? `video-${String(msg.client_id ?? msg.message_id ?? "clip")}.mp4`,
					);
					files.push({ name, ...(bytes ? { data: bytes } : {}) });
					texts.push("[Video]");
				}
			}
			await handlers.onMessage({
				chat: { key: userId, kind: "direct", title: "" },
				sender: { id: userId, name: userId },
				text: texts.join("\n").trim(),
				images,
				files,
				mentioned: false,
				messageId: String(msg.client_id ?? msg.message_id ?? ""),
			});
		};

		// A batch is delivered first and only then marked seen and followed by the
		// cursor: a crash in the middle replays the batch (deduplicated above)
		// instead of skipping the messages that were not delivered yet.
		const deliverBatch = async (messages: any[]): Promise<void> => {
			for (const msg of messages) {
				const key = messageKey(msg);
				if (key !== "" && seen.has(key)) continue;
				try {
					await deliver(msg);
					markSeen(key);
				} catch (error: any) {
					env.log?.warn?.("ocean-crew im: weixin message failed: %s", error?.message ?? error);
				}
			}
		};
		const flushRuntime = (cursor: unknown): void => {
			const patch: Record<string, unknown> = {};
			if (seenChanged) {
				patch.seenMessageIds = [...seen];
				seenChanged = false;
			}
			const current = typeof runtime().cursor === "string" ? runtime().cursor : "";
			if (typeof cursor === "string" && cursor !== current) patch.cursor = cursor;
			if (Object.keys(patch).length > 0) setRuntime(patch);
		};

		// ------------------------------------------------------------------ poll
		// Long-poll timeout is an idle batch, not a failure. Any other failure is
		// retried with exponential backoff; three in a row stop the connection
		// with an error, and -14 asks for a new QR scan at once.
		const poll = async (): Promise<void> => {
			if (running || stopped) return;
			running = true;
			const gen = generation;
			let failures = 0;
			try {
				while (!stopped && generation === gen) {
					let answer: any;
					try {
						answer = await request(
							env,
							base(env, fields),
							token,
							"getupdates",
							{ get_updates_buf: typeof runtime().cursor === "string" ? runtime().cursor : "" },
							POLL_TIMEOUT_MS + POLL_GRACE_MS,
							{ requireJson: true, signal: lifecycle.signal },
						);
					} catch (error: any) {
						if (stopped || generation !== gen || error?.stopped === true) return;
						if (error?.timeout === true) {
							handlers.onStatus({ state: "ready" });
							continue;
						}
						failures += 1;
						const message = String(error?.message ?? error);
						env.log?.warn?.(
							"ocean-crew im: weixin poll failed (%d/%d): %s",
							failures,
							MAX_CONSECUTIVE_FAILURES,
							message,
						);
						if (error?.permanent === true || failures >= MAX_CONSECUTIVE_FAILURES) {
							env.log?.warn?.("ocean-crew im: weixin poll stopped: %s", message);
							handlers.onStatus({ state: "error", error: message });
							return;
						}
						handlers.onStatus({ state: "connecting" });
						await wait(backoffMs(failures), lifecycle.signal);
						continue;
					}
					const code = providerCode(answer);
					if (code !== undefined && code !== 0) {
						const expired = isExpired(code);
						const message = expired
							? "WeChat session expired; scan the QR code again"
							: `WeChat answered ${code}`;
						env.log?.warn?.("ocean-crew im: weixin getupdates answered %s", code);
						if (expired || Number(code) === 401 || Number(code) === 403) {
							handlers.onStatus({ state: "error", error: message });
							return;
						}
						failures += 1;
						if (failures >= MAX_CONSECUTIVE_FAILURES) {
							handlers.onStatus({ state: "error", error: message });
							return;
						}
						handlers.onStatus({ state: "connecting" });
						await wait(backoffMs(failures), lifecycle.signal);
						continue;
					}
					if (code === undefined && !isUpdatesAnswer(answer)) {
						failures += 1;
						env.log?.warn?.("ocean-crew im: weixin getupdates answered an unreadable response");
						if (failures >= MAX_CONSECUTIVE_FAILURES) {
							handlers.onStatus({ state: "error", error: "WeChat answered an unreadable response" });
							return;
						}
						handlers.onStatus({ state: "connecting" });
						await wait(backoffMs(failures), lifecycle.signal);
						continue;
					}
					failures = 0;
					handlers.onStatus({ state: "ready" });
					await deliverBatch(Array.isArray(answer.msgs) ? answer.msgs : []);
					if (stopped || generation !== gen) return;
					flushRuntime(answer.get_updates_buf);
				}
			} finally {
				running = false;
			}
		};

		// The session has to be opened before getupdates carries anything. A
		// transient failure is retried; a refused or expired session is shown once
		// and polling never starts, instead of looping on the same error.
		const startSession = async (): Promise<void> => {
			for (let attempt = 0; ; attempt += 1) {
				if (stopped) return;
				try {
					await notifyStart(env, base(env, fields), token, { signal: lifecycle.signal });
					break;
				} catch (error: any) {
					if (stopped || error?.stopped === true) return;
					const delay = START_RETRY_DELAYS_MS[attempt];
					if (error?.permanent === true || delay === undefined) {
						env.log?.warn?.("ocean-crew im: weixin could not start the session: %s", error?.message ?? error);
						handlers.onStatus({ state: "error", error: String(error?.message ?? error) });
						return;
					}
					env.log?.warn?.("ocean-crew im: weixin session start failed, retrying: %s", error?.message ?? error);
					await wait(delay, lifecycle.signal);
				}
			}
			if (!stopped) void poll();
		};

		bindContext();
		handlers.onStatus({ state: "connecting" });
		void startSession();

		// Every chat the adapter currently shows as typing, so a stop is only sent when
		// there was something to stop.
		const typingShown = new Set<string>();
		const typingTickets = new Map<string, { ticket: string; at: number }>();
		let typingWarned = false;
		const TICKET_TTL_MS = 10 * 60_000;
		const typingTicket = async (chatKey: string): Promise<string> => {
			const held = typingTickets.get(chatKey);
			if (held !== undefined && Date.now() - held.at < TICKET_TTL_MS) return held.ticket;
			const contextToken = contextTokenFor(chatKey);
			const config = await request(
				env,
				base(env, fields),
				token,
				"getconfig",
				{ ilink_user_id: chatKey, ...(contextToken ? { context_token: contextToken } : {}) },
				8_000,
				{ signal: lifecycle.signal },
			).catch(() => undefined);
			const ticket = String(config?.typing_ticket ?? "");
			if (ticket !== "") typingTickets.set(chatKey, { ticket, at: Date.now() });
			else if (!typingWarned) {
				typingWarned = true;
				env.log?.warn?.("ocean-crew im: weixin sent no typing ticket; the chat will not show typing");
			}
			return ticket;
		};
		const sendTyping = async (chatKey: string, ticket: string, status: number, contextToken?: string) => {
			await request(
				env,
				base(env, fields),
				token,
				"sendtyping",
				{
					ilink_user_id: chatKey,
					typing_ticket: ticket,
					status,
					...(contextToken ? { context_token: contextToken } : {}),
				},
				8_000,
				{ signal: lifecycle.signal },
			).catch(() => {});
		};

		return {
			send: async (chat: any, { text, media }: any = {}) => {
				const chatKey = String(chat.key);
				const chunks = chunk(String(text ?? ""), TEXT_LIMIT);
				const mediaItems = Array.isArray(media) ? media : [];
				if (chunks.length === 0 && mediaItems.length === 0) return {};
				const contextToken = contextTokenFor(chatKey);
				let messageId: string | undefined;
				for (const [index, chunkText] of chunks.entries()) {
					// A short pause between bubbles reads as someone typing; back-to-back
					// bubbles read as a paste. The last one sends without waiting.
					if (index > 0) await new Promise((resolve) => setTimeout(resolve, BUBBLE_GAP_MS));
					const clientId = `ocean-crew-${randomBytes(8).toString("hex")}`;
					const message = {
						from_user_id: "",
						to_user_id: chatKey,
						client_id: clientId,
						message_type: 2,
						message_state: 2,
						item_list: [{ type: 1, text_item: { text: chunkText } }],
						...(contextToken ? { context_token: contextToken } : {}),
					};
					for (let attempt = 0; ; attempt += 1) {
						try {
							const answer = await request(
								env,
								base(env, fields),
								token,
								"sendmessage",
								{ msg: message },
								SEND_TIMEOUT_MS,
								{
									send: true,
									signal: lifecycle.signal,
								},
							);
							const code = rejection(answer);
							if (code !== undefined) throw refusal(`WeChat refused the reply (${answer.errmsg ?? code})`);
							break;
						} catch (error: any) {
							if (error?.stopped === true) throw error;
							const delay = SEND_RETRY_DELAYS_MS[attempt];
							// Only a connection-level failure is certainly not delivered:
							// retry that chunk with the same client_id. Timeouts, unreadable
							// answers and server errors may have reached iLink, so they are
							// reported as unknown and never repeated here.
							if (error?.network === true && delay !== undefined && !stopped) {
								env.log?.warn?.("ocean-crew im: weixin send failed, retrying: %s", error?.message ?? error);
								await wait(delay, lifecycle.signal);
								continue;
							}
							if (error?.network === true)
								throw uncertain(`WeChat did not answer the reply (${error.message})`, error);
							if (error?.timeout === true) throw uncertain("WeChat did not confirm the reply in time", error);
							throw error;
						}
					}
					messageId = clientId;
				}
				for (const item of mediaItems) {
					const bytes = Buffer.from(item.data);
					const fileKey = randomBytes(16).toString("hex");
					const aesKey = randomBytes(16);
					const padded = Math.ceil((bytes.length + 1) / 16) * 16;
					const image = item.kind === "image";
					const answer = await request(
						env,
						base(env, fields),
						token,
						"getuploadurl",
						{
							filekey: fileKey,
							media_type: image ? 1 : 3,
							to_user_id: chatKey,
							rawsize: bytes.length,
							rawfilemd5: createHash("md5").update(bytes).digest("hex"),
							filesize: padded,
							no_need_thumb: true,
							aeskey: aesKey.toString("hex"),
						},
						SEND_TIMEOUT_MS,
						{ signal: lifecycle.signal },
					);
					const refused = rejection(answer);
					if (refused !== undefined) throw refusal(`WeChat refused the upload (${answer?.errmsg ?? refused})`);
					const downloadParam = await uploadCdn(env, uploadUrlOf(answer, fileKey), bytes, aesKey);
					const mediaInfo = {
						encrypt_query_param: downloadParam,
						aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
						encrypt_type: 1,
					};
					const clientId = `ocean-crew-${randomBytes(8).toString("hex")}`;
					const message = {
						from_user_id: "",
						to_user_id: chatKey,
						client_id: clientId,
						message_type: 2,
						message_state: 2,
						item_list: image
							? [{ type: 2, image_item: { media: mediaInfo, mid_size: padded } }]
							: [
									{
										type: 4,
										file_item: {
											media: mediaInfo,
											file_name: String(item.name ?? "file"),
											len: String(bytes.length),
										},
									},
								],
						...(contextToken ? { context_token: contextToken } : {}),
					};
					try {
						const sent = await request(
							env,
							base(env, fields),
							token,
							"sendmessage",
							{ msg: message },
							SEND_TIMEOUT_MS,
							{
								send: true,
								signal: lifecycle.signal,
							},
						);
						const code = rejection(sent);
						if (code !== undefined) throw refusal(`WeChat refused the file (${sent.errmsg ?? code})`);
					} catch (error: any) {
						if (error?.network === true)
							throw uncertain(`WeChat did not answer the file send (${error.message})`, error);
						if (error?.timeout === true) throw uncertain("WeChat did not confirm the file send in time", error);
						throw error;
					}
					messageId = clientId;
				}
				return { messageId };
			},
			// The host ticks this while a turn runs, so the ticket is cached: `getconfig` is a
			// second round trip that would otherwise run on every tick.
			typing: async (chat: any) => {
				const chatKey = String(chat.key);
				const ticket = await typingTicket(chatKey);
				if (ticket === "") return;
				const contextToken = contextTokenFor(chatKey);
				await sendTyping(chatKey, ticket, 1, contextToken);
				typingShown.add(chatKey);
			},
			// A chat that stops being busy stops showing "typing"; iLink also expires it,
			// but saying so is what makes the indicator end when the answer does.
			stopTyping: async (chat: any) => {
				const chatKey = String(chat.key);
				if (!typingShown.delete(chatKey)) return;
				const ticket = await typingTicket(chatKey);
				if (ticket === "") return;
				await sendTyping(chatKey, ticket, 2, contextTokenFor(chatKey));
			},
			stop: () => {
				stopped = true;
				generation += 1;
				// A long poll must not outlive the adapter: abort it instead of waiting
				// for the server to time out in ~50 s.
				lifecycle.abort(stoppedError());
			},
		};
	},
};

// Visible length: a limit counts what the reader sees, so an emoji costs one, not two.
const width = (text: string): number => [...text].length;

// A cut in the middle of a fenced block would leave the first bubble with an unclosed
// fence and the next with a bare body. The cut closes the fence and reopens it with the
// same language, so each bubble renders on its own.
const FENCE = /^\s*(?:```|~~~)(.*)$/;
// The fence written around a cut: a plain ``` line, kept out of a template literal so the
// source stays readable.
const CLOSE = "```";
// Whether any line of a multi-line block opens or closes a fence.
const FENCE_ANY = /^\s*(?:```|~~~)/m;
const OPEN = "```";
const fenceState = (text: string): { open: boolean; lang: string } => {
	let open = false;
	let lang = "";
	for (const line of text.split("\n")) {
		const found = FENCE.exec(line);
		if (found === null) continue;
		if (!open) lang = found[1].trim();
		open = !open;
	}
	return { open, lang };
};

/**
 * Split one block that is longer than the limit into bubbles that each render alone.
 *
 * A cut inside a fenced block would leave one bubble with an unclosed fence and the next
 * with a bare body, so the cut closes the fence and reopens it with the same language.
 * The state is carried in `inside` and the reopening fence is added when the bubble is
 * emitted — never counted as a fence of the content, which is what would make the
 * synthetic opener read as the closer.
 */
const cut = (text: string, limit: number): string[] => {
	const out: string[] = [];
	let rest = text;
	let inside = false;
	let lang = "";
	while (width(rest) > limit) {
		const opening = inside ? `${OPEN}${lang}\n` : "";
		// A bubble may need to close a fence that its own body opens, not only one it
		// entered with, so the four characters are reserved whenever the block has any
		// fence left in it.
		const closing = inside || FENCE_ANY.test(rest) ? 4 : 0;
		const budget = Math.max(1, limit - width(opening) - closing);
		const chars = [...rest];
		const slice = chars.slice(0, budget).join("");
		let at = budget;
		const newline = slice.lastIndexOf("\n");
		if (newline > budget / 2) at = width(slice.slice(0, newline));
		else {
			const space = slice.lastIndexOf(" ");
			if (space > budget / 2) at = width(slice.slice(0, space));
		}
		const body = chars.slice(0, at).join("");
		rest = chars.slice(at).join("").replace(/^\s+/, "");
		// Only the content's own fences move the state.
		let state: boolean = inside;
		for (const line of body.split("\n")) {
			const found = FENCE.exec(line);
			if (found === null) continue;
			if (!state) lang = found[1].trim();
			state = !state;
		}
		out.push(`${opening}${body}${state ? `\n${CLOSE}` : ""}`);
		inside = state;
	}
	if (rest !== "") out.push(`${inside ? `${OPEN}${lang}\n` : ""}${rest}`);
	return out;
};

// A short, chat-like block is sent as one bubble per line, the way a person texts,
// instead of one wall of text. Long prose, headings, lists and tables stay whole so a
// structure is never torn apart, and a fenced block is never split.
const CHATTY_MAX = 48;
const chattyLine = (line: string): boolean => {
	const text = line.trim();
	if (text === "" || line.startsWith(" ") || line.startsWith("\t")) return false;
	if (text.length > CHATTY_MAX) return false;
	if (/^[>\-*【#|]/.test(text)) return false;
	if (/^\*\*[^*]+\*\*$/.test(text)) return false;
	if (/^\d+\.\s/.test(text)) return false;
	return true;
};
const isHeading = (line: string): boolean => {
	const text = line.trim();
	return text.endsWith(":") || text.endsWith("：") || (text.length <= 24 && text.startsWith("#"));
};
const chatty = (block: string): boolean => {
	const lines = block.split("\n").filter((line) => line.trim() !== "");
	if (lines.length < 2 || lines.length > 6) return false;
	if (isHeading(lines[0])) return false;
	return lines.every(chattyLine);
};
// Blocks split at blank lines, fences kept whole.
const blocks = (text: string): string[] => {
	const out: string[] = [];
	let current: string[] = [];
	let fenced = false;
	const flush = (): void => {
		const block = current.join("\n").trim();
		if (block !== "") out.push(block);
		current = [];
	};
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (/^\s*(?:```|~~~)/.test(line)) {
			if (!fenced) flush();
			current.push(line);
			fenced = !fenced;
			if (!fenced) flush();
			continue;
		}
		if (fenced) {
			current.push(line);
			continue;
		}
		if (line.trim() === "") flush();
		else current.push(line);
	}
	flush();
	return out;
};
/**
 * One reply as the sequence of chat bubbles WeChat receives. Exported for the test that
 * pins the split: short chat-like lines become separate bubbles, everything else stays
 * whole, and a fenced block is never torn.
 */
export const chunk = (text: unknown, limit: number): string[] => {
	const whole = String(text ?? "").trimEnd();
	if (whole.trim() === "") return [];
	if (width(whole) <= limit) {
		// A short cascade of chat lines becomes a few bubbles; anything else stays one.
		if (!chatty(whole)) return [whole];
		return whole
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	}
	const out: string[] = [];
	let current = "";
	for (const block of blocks(whole)) {
		const candidate = current === "" ? block : `${current}\n\n${block}`;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		if (current !== "") out.push(current);
		if (block.length <= limit) {
			current = block;
			continue;
		}
		out.push(...cut(block, limit));
		current = "";
	}
	if (current !== "") out.push(current);
	return out.filter((piece) => piece !== "");
};

// iLink only carries getupdates for an opened session: before msg/notifystart
// the server keeps answering {"errcode":-14,"errmsg":"session timeout"}.
async function notifyStart(
	env: any,
	baseUrl: string,
	token: unknown,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<any> {
	const answer = await request(env, baseUrl, token, "msg/notifystart", {}, 10_000, { requireJson: true, signal });
	const code = rejection(answer);
	if (code === undefined) return answer;
	const reason = isExpired(code)
		? "WeChat session expired; scan the QR code again"
		: `WeChat did not start the session (${code})`;
	throw refusal(reason);
}

async function request(
	env: any,
	baseUrl: string,
	token: unknown,
	endpoint: string,
	body: Record<string, unknown>,
	timeoutMs = POLL_TIMEOUT_MS,
	{ requireJson = false, send = false, signal }: { requireJson?: boolean; send?: boolean; signal?: AbortSignal } = {},
): Promise<any> {
	if (signal?.aborted === true) throw stoppedError();
	const controller = new AbortController();
	let timedOut = false;
	const link = (): void => controller.abort();
	signal?.addEventListener("abort", link, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	let response: any;
	try {
		response = await env.fetch(`${baseUrl}ilink/bot/${endpoint}`, {
			method: "POST",
			headers: {
				...clientHeaders(),
				"content-type": "application/json",
				"X-WECHAT-UIN": randomUin(),
				...(token ? { authorization: `Bearer ${token}`, AuthorizationType: "ilink_bot_token" } : {}),
			},
			body: JSON.stringify({ ...body, base_info: baseInfo() }),
			signal: controller.signal,
		});
		if (signal?.aborted) throw stoppedError();
	} catch (error: any) {
		if (signal?.aborted) throw stoppedError();
		if (error?.stopped === true) throw error;
		// fetch reports "fetch failed" and hides ENOTFOUND, ECONNRESET and the like in
		// cause; surface it in the message and keep the chain for diagnosis.
		const cause = error?.cause?.code ?? error?.cause?.message;
		if (
			timedOut ||
			error?.name === "AbortError" ||
			error?.name === "TimeoutError" ||
			/timeout|aborted/i.test(String(error?.message))
		) {
			throw fail("WeChat did not answer in time", { timeout: true, cause: error });
		}
		throw fail(String(cause ?? error?.message ?? error), { network: true, timeout: false, cause: error });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", link);
	}
	const text = await response.text().catch(() => "");
	if (signal?.aborted) throw stoppedError();
	let parsed: unknown;
	try {
		parsed = text === "" ? {} : JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const json = isObject(parsed) ? parsed : undefined;
	const code = providerCode(json);
	if (response.status === 429 || code === 429) {
		throw fail("WeChat rate limited the request", {
			retryAfter: retryAfterSeconds(response.headers.get("retry-after")),
			status: response.status,
		});
	}
	if (response.status === 401 || response.status === 403) throw refusal("WeChat refused the token");
	if (!response.ok) {
		const error = fail(`WeChat answered ${response.status}`, { status: response.status });
		if (send) {
			if (response.status >= 400 && response.status < 500) error.permanent = true;
			else error.unknown = true;
		}
		throw error;
	}
	// A 200 that is not a JSON object cannot prove the call succeeded: for a
	// send the outcome is unknown, for a read it is a retryable failure. A caller
	// that reads fields (getupdates, the session handshake) needs a real object;
	// anyone else keeps the old empty answer on a malformed body.
	if (json === undefined) {
		if (send) throw uncertain("WeChat answered an unreadable response", undefined);
		if (requireJson) throw fail("WeChat answered an unreadable response", { status: response.status });
		return {};
	}
	return json;
}

// Inbound images: the CDN URL plus a base64 AES-128 key (ECB, PKCS7).
const CDN_HOST = "novac2c.cdn.weixin.qq.com";
const CDN_BASE = `https://${CDN_HOST}/c2c`;
const uploadUrlOf = (answer: any, fileKey: string): string => {
	const full = String(answer?.upload_full_url ?? "");
	if (full !== "") {
		let url: URL;
		try {
			url = new URL(full);
		} catch {
			throw refusal("WeChat returned an invalid upload address");
		}
		if (
			url.protocol !== "https:" ||
			url.hostname !== CDN_HOST ||
			(url.port && url.port !== "443") ||
			url.pathname !== "/c2c/upload"
		)
			throw refusal("WeChat returned an untrusted upload address");
		url.username = "";
		url.password = "";
		url.hash = "";
		return url.toString();
	}
	const param = String(answer?.upload_param ?? "");
	if (param === "") throw refusal("WeChat returned no upload address");
	const url = new URL(`${CDN_BASE}/upload`);
	url.searchParams.set("encrypted_query_param", param);
	url.searchParams.set("filekey", fileKey);
	return url.toString();
};
// The body is the AES-128-ECB ciphertext; iLink answers with the parameter a later
// message names instead of the file itself.
const uploadCdn = async (env: any, url: string, bytes: Buffer, key: Buffer): Promise<string> => {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
	const response: any = await (env.fetch as any)(url, {
		method: "POST",
		headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
		body,
	});
	if (response?.status === 413) throw refusal("WeChat refused the upload: the file is too large");
	if (!response?.ok) throw fail(`WeChat refused the upload (${response?.status})`);
	const param = String(response?.headers?.get?.("x-encrypted-param") ?? "");
	if (param === "") throw refusal("WeChat returned no download parameter for the upload");
	return param;
};
const AES_KEY = /^[0-9a-f]{32}$/i;
// The AES key of an attachment: iLink gives it either as a hex field on the item or
// base64 inside `media.aes_key` (the pairing of the two encodings the reference client
// handles). Anything else is not a key.
function attachmentKey(holder: any): Buffer | undefined {
	const direct = String(holder?.aeskey ?? "");
	if (AES_KEY.test(direct)) return Buffer.from(direct, "hex");
	const media = holder?.media ?? holder;
	const decoded = Buffer.from(String(media?.aes_key ?? ""), "base64").toString("utf8");
	if (AES_KEY.test(decoded)) return Buffer.from(decoded, "hex");
	return undefined;
}
async function mediaBytes(holder: any, env: any): Promise<Buffer | undefined> {
	const media = holder?.media ?? holder;
	const url = String(media?.full_url ?? media?.url ?? "");
	if (url === "") return undefined;
	const response = await env.fetch(url);
	if (!response.ok) return undefined;
	const encrypted = Buffer.from(await response.arrayBuffer());
	const key = attachmentKey(holder);
	if (key === undefined) return encrypted;
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
const image = (media: any, env: any): Promise<Buffer | undefined> => mediaBytes(media, env);

// A reply quotes the message it answers. The model needs that context as part of the
// text, since the platform carries it as a nested item rather than a field: a quoted
// image, video, file or voice is named by its title, a quoted text is inlined.
const QUOTED_MEDIA = new Set([2, 3, 4, 5]);
const quotedText = (item: any): string => {
	if (item === undefined || item === null) return "";
	if (item.type === 1) return String(item.text_item?.text ?? "").trim();
	if (item.type === 3) return String(item.voice_item?.text ?? "").trim();
	return "";
};
const withQuoted = (text: string, ref: any): string => {
	const inner = ref?.message_item;
	if (inner === undefined || inner === null) return text;
	const title = String(ref?.title ?? "").trim();
	if (QUOTED_MEDIA.has(Number(inner.type))) {
		return `${title === "" ? "[引用媒体]" : `[引用媒体: ${title}]`}\n${text}`.trim();
	}
	const quoted = quotedText(inner);
	const parts = [title, quoted].filter((part) => part !== "");
	if (parts.length === 0) return text;
	return `[引用: ${parts.join(" | ")}]\n${text}`.trim();
};

export default weixin;
export { withQuoted };
