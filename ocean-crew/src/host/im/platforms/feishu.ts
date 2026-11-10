// Feishu / Lark through the official @larksuiteoapi/node-sdk: its WSClient owns
// the pbbp2 long connection (handshake, heartbeat, liveness, reconnect with
// backoff) and its Client owns the OpenAPI calls. This adapter maps those
// events onto the Ocean Crew IM contract: a p2p chat is direct, a group message
// counts when the bot's open_id is in its mentions; text goes out in 4000-char
// chunks with the last chunk an interactive card when buttons are given, edited
// by PATCH; images and files are fetched from messageResource.
import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { emojiText } from "../emoji-text.ts";
import { chunkMarkdown, toPlain } from "../format.ts";
import { imageMediaTypeOf } from "./media-type.ts";

const TEXT_LIMIT = 4000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_S = 30;
const BOT_INFO_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SEEN_MESSAGES = 1000;
const MENTION = /@_user_\d+/g;
// Feishu answers a refused request with HTTP 200 and a non-zero business code.
// Authentication, parameter and IM request codes stay refused on a retry;
// 230020 is rate limiting and 230049 means the send result is unknown.
const TRANSIENT_CODES = new Set([230020, 230049]);
const UNKNOWN_RESULT_CODE = 230049;
const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ECONNREFUSED",
	"ERR_NETWORK",
	"ERR_SOCKET_CONNECTION_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
]);

/** A Feishu failure with the classifications the host's supervisor reads. */
interface FeishuError extends Error {
	platformCode?: number;
	permanent?: boolean;
	unknown?: boolean;
	retryAfter?: number;
}

const scrubText = (text: unknown, secret: unknown): string => {
	const value = String(text ?? "");
	return (secret === "" ? value : value.replaceAll(String(secret), "***")).slice(0, 300) || "error";
};
const reason = (error: any): string => String(error?.message ?? error ?? "").slice(0, 300) || "error";
const fieldsOf = (fields: any): { appId: string; appSecret: string } => ({
	appId: String(fields?.appId ?? "").trim(),
	appSecret: String(fields?.appSecret ?? "").trim(),
});
const domainOf = (lark: any, fields: any): number =>
	String(fields?.domain ?? "feishu") === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
const parseJson = (text: unknown): any => {
	try {
		return JSON.parse(String(text ?? "{}"));
	} catch {
		return {};
	}
};
const withoutMentions = (text: unknown): string =>
	String(text ?? "")
		.replace(MENTION, "")
		.trim();

const withDeadline = (promise: Promise<any>, ms: number, onTimeout: () => void): Promise<any> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			onTimeout();
			resolve(undefined);
		}, ms);
		timer.unref?.();
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const isPermanentCode = (code: number): boolean =>
	!TRANSIENT_CODES.has(code) &&
	((code >= 10000 && code < 20000) || code >= 99991000 || (code >= 230000 && code < 240000));

const businessError = (what: string, body: any, scrub: (text: unknown) => string): FeishuError => {
	const code = Number(body?.code);
	const error = new Error(
		scrub(`${what} failed: ${String(body?.msg ?? "unknown error")} (code ${code})`),
	) as FeishuError;
	error.platformCode = code;
	if (code === UNKNOWN_RESULT_CODE) error.unknown = true;
	else if (isPermanentCode(code)) error.permanent = true;
	return error;
};

const isNetworkError = (cause: any): boolean => {
	if (cause?.response !== undefined) return false;
	if (cause?.isAxiosError === true) return true;
	if (NETWORK_CODES.has(String(cause?.code ?? ""))) return true;
	return cause?.name === "TimeoutError" || cause?.name === "AbortError";
};

const retryAfterSeconds = (cause: any): number | undefined => {
	const headers = cause?.response?.headers;
	const value = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const transportError = (what: string, cause: any, scrub: (text: unknown) => string): FeishuError => {
	const status = Number(cause?.response?.status);
	const body = cause?.response?.data;
	const code = Number(body?.code);
	const detail = body?.msg ?? cause?.message ?? String(cause ?? "unknown error");
	const error = new Error(
		scrub(`${what} failed: ${detail}${Number.isFinite(code) && code !== 0 ? ` (code ${code})` : ""}`),
	) as FeishuError;
	// The platform code is kept whichever branch below decides the failure class: callers
	// such as the reply fallback need to tell one Feishu code from another.
	if (Number.isFinite(code) && code !== 0) error.platformCode = code;
	if (Number.isFinite(status)) {
		if (status === 429) {
			const after = retryAfterSeconds(cause);
			if (after !== undefined) error.retryAfter = after;
		} else if (status >= 400 && status < 500) {
			error.permanent = true;
		}
	} else if (Number.isFinite(code) && code !== 0) {
		if (code === UNKNOWN_RESULT_CODE) error.unknown = true;
		else if (isPermanentCode(code)) error.permanent = true;
	} else if (isNetworkError(cause)) {
		error.unknown = true;
	}
	return error;
};

// One SDK call: a thrown transport error is classified, a returned non-zero
// business code is turned into a thrown error with the platform message.
const call = async (what: string, operation: () => Promise<any>, scrub: (text: unknown) => string): Promise<any> => {
	let body: any;
	try {
		body = await operation();
	} catch (error: any) {
		throw transportError(what, error, scrub);
	}
	if (body?.code !== undefined && Number(body.code) !== 0) throw businessError(what, body, scrub);
	return body;
};

const botInfo = async (client: any, scrub: (text: unknown) => string): Promise<{ id: string; name: string }> => {
	const body = await call(
		"Feishu bot info",
		() => client.request({ method: "GET", url: "/open-apis/bot/v3/info" }),
		scrub,
	);
	const bot = body?.bot ?? body ?? {};
	return { id: String(bot.open_id ?? bot.app_id ?? ""), name: String(bot.app_name ?? "") };
};

const contentLength = (headers: any): number | undefined => {
	const value = typeof headers?.get === "function" ? headers.get("content-length") : headers?.["content-length"];
	const length = Number(value);
	return Number.isFinite(length) && length >= 0 ? length : undefined;
};

const messageResource = async (
	client: any,
	messageId: string,
	fileKey: string,
	type: string,
	limit?: number,
): Promise<Buffer> => {
	const response = await client.im.messageResource.get({
		path: { message_id: messageId, file_key: fileKey },
		params: { type },
	});
	const declared = contentLength(response?.headers);
	if (limit !== undefined && declared !== undefined && declared > limit)
		throw new Error(`resource is larger than ${limit} bytes`);
	const stream = response?.getReadableStream?.();
	if (stream === undefined || stream === null) throw new Error("Feishu returned no resource stream");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += data.length;
		if (limit !== undefined && size > limit) throw new Error(`resource is larger than ${limit} bytes`);
		chunks.push(data);
	}
	return Buffer.concat(chunks);
};

// Feishu sends a post (and forwarded history) as paragraphs of typed elements. Rendering
// the element tags keeps what the sender meant: a mention keeps its name, a code block
// keeps its fence, and a line break stays a line break. Dropping them loses structure
// that the model needs to answer.
const postPayload = (content: any): any => {
	if (content === null || typeof content !== "object") return undefined;
	// A post may arrive wrapped, and its body may sit under one locale key per language.
	if (content.post !== undefined && typeof content.post === "object") return content.post;
	if (Array.isArray(content.content)) return content;
	for (const [key, value] of Object.entries(content)) {
		if (/^[a-z]{2}_[a-z]{2}$/i.test(key) && value !== null && typeof value === "object") return value;
	}
	return content;
};

const renderPostElement = (element: any): string => {
	if (element === null || typeof element !== "object") return "";
	const tag = String(element.tag ?? element.type ?? "");
	switch (tag) {
		case "text":
			return String(element.text ?? "");
		case "a":
		case "link": {
			const label = String(element.text ?? "").trim();
			const href = String(element.href ?? element.url ?? "");
			if (href === "") return label;
			return label === "" ? href : `[${label}](${href})`;
		}
		case "at":
			// @all is the platform's everyone marker; a person keeps the name it was given.
			return `@${String(element.user_name ?? element.user_id ?? "all")}`;
		case "emotion":
		case "emoji":
			return `:${String(element.emoji_type ?? element.emoji_key ?? "")}:`;
		case "br":
			return "\n";
		case "hr":
		case "divider":
			return "\n---\n";
		case "code_block":
		case "pre": {
			const language = String(element.language ?? "").replace(/[^\w+#.-]/g, "");
			const code = String(element.text ?? element.content ?? "");
			return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
		}
		case "img":
		case "image":
			return "[Image]";
		case "media":
		case "file":
		case "audio":
		case "video": {
			const name = String(element.file_name ?? element.file_key ?? "").trim();
			return name === "" ? "[Attachment]" : `[Attachment: ${name}]`;
		}
		default:
			for (const key of ["text", "title", "content", "children", "elements"]) {
				const value = element[key];
				if (Array.isArray(value)) return value.map(renderPostElement).join("");
				if (typeof value === "string" && value !== "") return value;
			}
			return "";
	}
};

const postText = (content: any): string => {
	const payload = postPayload(content);
	if (payload === undefined || payload === null) return "";
	const lines: string[] = [];
	const title = withoutMentions(String(payload.title ?? ""));
	if (title !== "") lines.push(title);
	for (const paragraph of Array.isArray(payload.content) ? payload.content : []) {
		if (!Array.isArray(paragraph)) continue;
		const text = paragraph.map(renderPostElement).join("");
		for (const line of withoutMentions(text).split("\n")) if (line.trim() !== "") lines.push(line.trimEnd());
	}
	return lines.join("\n");
};

// Every image inside a post, in reading order, so the files can be fetched.
const postImageKeys = (content: any): string[] => {
	const payload = postPayload(content);
	const keys: string[] = [];
	for (const paragraph of Array.isArray(payload?.content) ? payload.content : []) {
		if (!Array.isArray(paragraph)) continue;
		for (const element of paragraph) {
			const tag = String(element?.tag ?? element?.type ?? "");
			if (tag !== "img" && tag !== "image") continue;
			const key = String(element?.image_key ?? element?.imageKey ?? "");
			if (key !== "") keys.push(key);
		}
	}
	return keys;
};

const firstText = (payload: any, keys: string[], depth = 0): string => {
	if (payload === null || typeof payload !== "object" || depth > 4) return "";
	for (const key of keys) {
		const value = payload[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
		// Feishu wraps a card title as {title: {tag, content}} rather than a bare string.
		if (value !== null && typeof value === "object" && typeof value.content === "string") {
			if (value.content.trim() !== "") return value.content.trim();
		}
	}
	for (const value of Object.values(payload)) {
		if (value !== null && typeof value === "object") {
			const found = firstText(value, keys, depth + 1);
			if (found !== "") return found;
		}
	}
	return "";
};

// A forwarded conversation arrives as a title plus entries; the first few carry the
// context the user is pointing at, and a silent drop loses the whole message.
const mergeForwardText = (content: any): string => {
	const lines: string[] = [];
	const title = firstText(content, ["title", "summary", "preview"]);
	if (title !== "") lines.push(title);
	const entries: any[] = [];
	for (const key of ["messages", "items", "message_list", "records", "content"]) {
		const value = content?.[key];
		if (Array.isArray(value)) entries.push(...value);
	}
	for (const entry of entries.slice(0, 8)) {
		if (entry === null || typeof entry !== "object") {
			const text = String(entry ?? "").trim();
			if (text !== "") lines.push(`- ${text}`);
			continue;
		}
		const sender = firstText(entry, ["sender_name", "user_name", "sender", "name"]);
		const type = String(entry.message_type ?? entry.msg_type ?? "");
		const body =
			type === "post"
				? postText(entry.content ?? entry)
				: firstText(entry, ["text", "summary", "preview", "content", "title"]);
		if (body !== "") lines.push(`- ${sender === "" ? body : `${sender}: ${body}`}`);
	}
	return lines.join("\n");
};

const mergeForwardImages = (content: any): Array<{ messageId: string; imageKey: string }> => {
	const entries: any[] = [];
	for (const key of ["messages", "items", "message_list", "records", "content"]) {
		const value = content?.[key];
		if (Array.isArray(value)) entries.push(...value);
	}
	const parts: Array<{ messageId: string; imageKey: string }> = [];
	for (const entry of entries.slice(0, 8)) {
		if (entry === null || typeof entry !== "object") continue;
		const messageId = String(entry.message_id ?? entry.messageId ?? "");
		if (messageId === "") continue;
		const type = String(entry.message_type ?? entry.msg_type ?? "");
		const parsed = typeof entry.content === "string" ? parseJson(entry.content) : (entry.content ?? {});
		if (type === "image") {
			const key = String(parsed?.image_key ?? "");
			if (key !== "") parts.push({ messageId, imageKey: key });
			continue;
		}
		if (type === "post") {
			for (const key of postImageKeys(parsed)) parts.push({ messageId, imageKey: key });
		}
	}
	return parts.slice(0, 4);
};

const shareChatText = (content: any): string => {
	const name = firstText(content, ["chat_name", "name", "title"]);
	const id = String(content?.chat_id ?? content?.open_chat_id ?? content?.share_chat_id ?? "");
	const lines = [name === "" ? "Shared chat" : `Shared chat: ${name}`];
	if (id !== "") lines.push(`Chat ID: ${id}`);
	return lines.join("\n");
};

// A card carries its title, a few text lines and its buttons; rendering those is what
// lets the model answer a question that arrived as a card.
const interactiveText = (content: any): string => {
	const card = content?.card !== undefined && typeof content.card === "object" ? content.card : content;
	const lines: string[] = [];
	const actions: string[] = [];
	const title = firstText(card, ["title", "summary", "subtitle"]);
	if (title !== "") lines.push(title);
	const walk = (node: any, depth: number): void => {
		if (node === null || typeof node !== "object" || depth > 5) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, depth + 1);
			return;
		}
		if (node.tag === "button" || node.tag === "action") {
			const label = String(node.text?.content ?? node.text ?? "").trim();
			if (label !== "") actions.push(label);
			for (const action of Array.isArray(node.actions) ? node.actions : []) walk(action, depth + 1);
			return;
		}
		for (const key of ["elements", "body", "content", "children"]) {
			if (node[key] !== undefined) walk(node[key], depth + 1);
		}
		const text = typeof node.content === "string" ? node.content : typeof node.text === "string" ? node.text : "";
		if (text.trim() !== "") lines.push(text.trim());
	};
	walk(card, 0);
	const body = lines.filter((line, index) => index === 0 || line !== title).slice(0, 12);
	if (actions.length > 0) body.push(`Actions: ${actions.join(", ")}`);
	return body.join("\n");
};

// A reply as Feishu renders Markdown, so **bold**, lists, links and `code` show as
// themselves instead of as punctuation. Feishu's md renderer drops what follows a fenced
// code block inside one element, so the reply is split at real fences: prose in one row,
// each fenced block in its own.
const POST_ROWS = (content: string): Array<Array<{ tag: string; text: string }>> => {
	const rows: Array<Array<{ tag: string; text: string }>> = [];
	let current: string[] = [];
	let fenced = false;
	const flush = (): void => {
		if (current.length === 0) return;
		const text = current.join("\n");
		if (text.trim() !== "") rows.push([{ tag: "md", text }]);
		current = [];
	};
	for (const line of content.split("\n")) {
		const fence = /^\s*(?:```|~~~)/.test(line);
		if (fence && !fenced) flush();
		current.push(line);
		if (fence) {
			fenced = !fenced;
			if (!fenced) flush();
		}
	}
	flush();
	return rows.length > 0 ? rows : [[{ tag: "md", text: content }]];
};
const post = (content: string): string => JSON.stringify({ zh_cn: { content: POST_ROWS(content) } });
// A post whose only element is a markdown block reads as a code-like block on some
// Feishu clients, so plain prose goes out as a text message; markdown-shaped prose is
// rendered by the platform. The shapes are what the reference platform client uses.
const MARKDOWN_HINT =
	/(^#{1,6}\s)|(^\s*[-*]\s)|(^\s*\d+\.\s)|(^\s*---+\s*$)|(```)|(`[^`\n]+`)|(\*\*[^*\n].+?\*\*)|(~~[^~\n].+?~~)|(<u>.+?<\/u>)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))|(^>\s)/m;

// A card is an event, not a paragraph: a coloured header makes an approval read as one
// at a glance, the way a chat client shows a pending decision. The body and the button
// row follow the shapes the platform's own client renders as a normal card; a legacy
// `action` container leaves the card unstyled (a grey block) on current clients.
const FILE_ROUTES: Record<string, { upload: string; msgType: string }> = {
	pdf: { upload: "pdf", msgType: "file" },
	doc: { upload: "doc", msgType: "file" },
	docx: { upload: "doc", msgType: "file" },
	xls: { upload: "xls", msgType: "file" },
	xlsx: { upload: "xls", msgType: "file" },
	ppt: { upload: "ppt", msgType: "file" },
	pptx: { upload: "ppt", msgType: "file" },
	ogg: { upload: "opus", msgType: "audio" },
	opus: { upload: "opus", msgType: "audio" },
	mp4: { upload: "mp4", msgType: "media" },
	mov: { upload: "mp4", msgType: "media" },
	avi: { upload: "mp4", msgType: "media" },
	m4v: { upload: "mp4", msgType: "media" },
};
const routeOf = (name: string): { upload: string; msgType: string } => {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return FILE_ROUTES[ext] ?? { upload: "stream", msgType: "file" };
};
const postWith = (text: string, rows: any[]): string => {
	const content = POST_ROWS(text);
	for (const row of rows) content.push([row]);
	return JSON.stringify({ zh_cn: { content } });
};

// A Bot's answer is a plain white card: no header bar, the text alone on the card's own
// background. The title is accepted for callers that still pass one and deliberately not
// drawn, because a coloured header over every reply reads as a system notice.
const replyCard = (text: string): string =>
	JSON.stringify({
		schema: "2.0",
		body: { elements: [{ tag: "markdown", content: text }] },
	});

const cardForm = (form: any): any => ({
	tag: "form",
	name: "oc_form",
	elements: [
		...form.fields.map((field: any) =>
			field.kind === "multi" || field.kind === "select"
				? {
						tag: field.kind === "multi" ? "multi_select_static" : "select_static",
						name: field.name,
						placeholder: { tag: "plain_text", content: field.label },
						options: (field.options ?? []).map((option: string) => ({
							text: { tag: "plain_text", content: option },
							value: option,
						})),
						...(Array.isArray(field.initial)
							? {}
							: field.initial === undefined
								? {}
								: { initial_option: field.initial }),
					}
				: {
						tag: "input",
						name: field.name,
						label: { tag: "plain_text", content: field.label },
						placeholder: { tag: "plain_text", content: field.label },
						...(field.multiline === true ? { input_type: "multiline_text" } : {}),
						...(typeof field.initial === "string" ? { default_value: field.initial } : {}),
					},
		),
		{
			tag: "button",
			name: "oc_submit",
			text: { tag: "plain_text", content: form.submit.label },
			type: "primary",
			form_action_type: "submit",
		},
		...(form.cancel === undefined
			? []
			: [
					{
						tag: "button",
						name: "oc_cancel",
						text: { tag: "plain_text", content: form.cancel.label },
						type: "default",
						behaviors: [{ type: "callback", value: { action: form.cancel.data } }],
					},
				]),
	],
});

const card = (text: string, buttons: any[], title?: string, form?: any): string => {
	const row =
		buttons === undefined || buttons.length === 0
			? []
			: [
					{ tag: "hr" },
					{
						tag: "column_set",
						flex_mode: "none",
						columns: buttons.slice(0, 5).map((button: any) => ({
							tag: "column",
							width: "weighted",
							weight: 1,
							elements: [
								{
									tag: "button",
									text: { tag: "plain_text", content: String(button.label ?? "").slice(0, 20) },
									type: "default",
									width: "fill",
									behaviors: [{ type: "callback", value: { action: button.data } }],
								},
							],
						})),
					},
				];
	return JSON.stringify({
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: title ?? "Action needed" },
			template: "blue",
		},
		body: {
			elements: [
				{ tag: "div", text: { tag: "lark_md", content: text } },
				...(form === undefined ? row : [cardForm(form)]),
			],
		},
	});
};

/** A quoted message renders to the same text a live one would; cached per message. */
const quotedCache = new Map<string, string>();
const quotedText = async (
	client: any,
	messageId: string,
	scrub: (text: unknown) => string,
	warn: (template: string, error: unknown) => void,
): Promise<string> => {
	const held = quotedCache.get(messageId);
	if (held !== undefined) return held;
	let text = "";
	try {
		const body = await call(
			"Feishu quoted message",
			() => client.im.message.get({ path: { message_id: messageId } }),
			scrub,
		);
		const item = Array.isArray(body?.data?.items) ? body.data.items[0] : undefined;
		const type = String(item?.msg_type ?? item?.message_type ?? "");
		const content = parseJson(item?.body?.content ?? item?.content);
		if (type === "post") text = postText(content);
		else if (type === "text") text = String(content?.text ?? "");
		else if (type === "merge_forward") text = mergeForwardText(content);
		else if (type === "share_chat") text = shareChatText(content);
		else if (type === "interactive") text = interactiveText(content);
		else if (type === "image") text = "[Image]";
		else if (type === "file" || type === "audio" || type === "media") {
			text = `[Attachment: ${String(content?.file_name ?? type)}]`;
		}
	} catch (error) {
		warn("ocean-crew im: feishu quoted message not readable: %s", error);
	}
	if (quotedCache.size > MAX_SEEN_MESSAGES) quotedCache.clear();
	quotedCache.set(messageId, text);
	return text;
};

/** A sender's display name, so the Bot does not read opaque open_ids. Cached with a TTL. */
const SENDER_TTL_MS = 10 * 60_000;
const senderNames = new Map<string, { name: string; at: number }>();
const senderName = async (client: any, senderId: string, scrub: (text: unknown) => string): Promise<string> => {
	if (senderId === "") return "";
	const held = senderNames.get(senderId);
	if (held !== undefined && Date.now() - held.at < SENDER_TTL_MS) return held.name;
	let name = "";
	try {
		const body = await call(
			"Feishu sender",
			() =>
				client.contact.v3.user.get({
					params: { user_id_type: "open_id" },
					path: { user_id: senderId },
				}),
			scrub,
		);
		name = String(body?.data?.user?.name ?? body?.data?.user?.en_name ?? "");
	} catch {
		// A bot or a user outside the app's scope has no contact record; the id is enough.
	}
	if (senderNames.size > MAX_SEEN_MESSAGES) senderNames.clear();
	senderNames.set(senderId, { name, at: Date.now() });
	return name;
};

/** One chat's remembered name and kind, so a chat.get is not run per message. */
interface ChatInfo {
	title: string;
	kind: string;
}

/** The Feishu adapter the host registers; env carries runtime/log and the SDK (tests inject it). */
const feishu = {
	id: "feishu",

	async check(fields: any, env: any): Promise<{ account: { id: string; name: string } }> {
		const lark = env.lark ?? Lark;
		const { appId, appSecret } = fieldsOf(fields);
		if (appId === "" || appSecret === "") throw new Error("Feishu needs an App ID and an App Secret");
		const scrub = (text: unknown): string => scrubText(text, appSecret);
		const client: any = new lark.Client({
			appId,
			appSecret,
			domain: domainOf(lark, fields),
			loggerLevel: lark.LoggerLevel.warn,
		});
		const bot = await botInfo(client, scrub);
		return { account: { id: bot.id || appId, name: bot.name || appId } };
	},

	connect(fields: any, env: any, handlers: any): any {
		const lark = env.lark ?? Lark;
		const { appId, appSecret } = fieldsOf(fields);
		if (appId === "" || appSecret === "") throw new Error("Feishu needs an App ID and an App Secret");
		const scrub = (text: unknown): string => scrubText(text, appSecret);
		const client: any = new lark.Client({
			appId,
			appSecret,
			domain: domainOf(lark, fields),
			loggerLevel: lark.LoggerLevel.warn,
		});
		const chats = new Map<string, ChatInfo>();
		// Message ids remembered across redeliveries and restarts: the SDK may
		// deliver an event again after a reconnect, and dispatching it twice would
		// run the Bot turn twice. In-flight ids also block a near-simultaneous copy.
		const remembered = env.runtime?.get?.()?.seenMessageIds;
		const seen = new Set<string>(
			Array.isArray(remembered) ? remembered.filter((id: unknown): id is string => typeof id === "string") : [],
		);
		const delivering = new Set<string>();
		while (seen.size > MAX_SEEN_MESSAGES) seen.delete(seen.values().next().value as string);
		let botOpenId = "";
		let stopped = false;

		const warn = (template: string, error: unknown): void => env.log?.warn?.(template, scrub(reason(error)));
		const remember = (messageId: string): void => {
			seen.add(messageId);
			while (seen.size > MAX_SEEN_MESSAGES) seen.delete(seen.values().next().value as string);
			try {
				env.runtime?.set?.({ seenMessageIds: [...seen] });
			} catch (error) {
				warn("ocean-crew im: feishu seen messages not saved: %s", error);
			}
		};

		// Chat names and kinds are remembered per chat_id: a chat.get per message
		// would be a REST call on every event.
		const chatOf = async (chatId: string, kind?: string): Promise<ChatInfo> => {
			if (chatId === "") return { title: "", kind: kind ?? "direct" };
			const held = chats.get(chatId);
			if (held !== undefined) return held;
			let title = "";
			let mode = "";
			try {
				const body = await call("Feishu chat info", () => client.im.chat.get({ path: { chat_id: chatId } }), scrub);
				title = String(body?.data?.name ?? "");
				mode = String(body?.data?.chat_mode ?? body?.data?.chat_type ?? "");
			} catch (error) {
				warn("ocean-crew im: feishu chat info failed: %s", error);
			}
			const chat: ChatInfo = {
				title: title || chatId,
				kind: kind ?? (mode === "p2p" ? "direct" : mode === "" ? "direct" : "group"),
			};
			chats.set(chatId, chat);
			return chat;
		};

		const onMessage = async (data: any): Promise<void> => {
			if (stopped) return;
			try {
				const event = data?.event ?? data ?? {};
				const message = event.message ?? {};
				const messageId = String(message.message_id ?? "");
				const chatId = String(message.chat_id ?? "");
				if (chatId === "" || messageId === "") return;
				if (seen.has(messageId) || delivering.has(messageId)) return;
				delivering.add(messageId);
				try {
					const direct = message.chat_type === "p2p";
					const mentions = Array.isArray(message.mentions) ? message.mentions : [];
					// Until the bot's open_id is known, any mention has to count.
					const mentioned = direct
						? false
						: botOpenId === ""
							? mentions.length > 0
							: mentions.some((mention: any) => String(mention?.id?.open_id ?? "") === botOpenId);
					const content = parseJson(message.content);
					const type = String(message.message_type ?? "");
					const rendered =
						type === "text"
							? emojiText(withoutMentions(content.text))
							: type === "post"
								? postText(content)
								: type === "merge_forward"
									? mergeForwardText(content)
									: type === "share_chat"
										? shareChatText(content)
										: type === "interactive"
											? interactiveText(content)
											: "";
					const images: Array<{ mediaType: string; data: string }> = [];
					const files: Array<{ name: string; data: Buffer }> = [];
					let renderedText = rendered;
					if (type === "merge_forward") {
						for (const part of mergeForwardImages(content)) {
							try {
								const bytes = await messageResource(client, part.messageId, part.imageKey, "image");
								images.push({ mediaType: imageMediaTypeOf(bytes), data: bytes.toString("base64") });
								renderedText = renderedText.replace(/\[Image\]/, "");
							} catch (error) {
								warn("ocean-crew im: feishu forwarded image download failed: %s", error);
							}
						}
						renderedText = renderedText.replace(/\n{3,}/g, "\n\n").trim();
					}
					if (type === "post") {
						const keys = postImageKeys(content);
						let read = 0;
						for (const key of keys.slice(0, 4)) {
							try {
								const bytes = await messageResource(client, messageId, key, "image");
								images.push({ mediaType: imageMediaTypeOf(bytes), data: bytes.toString("base64") });
								read += 1;
							} catch (error) {
								warn("ocean-crew im: feishu post image download failed: %s", error);
							}
						}
						// The placeholder only stays for an image whose bytes could not be read.
						if (read === keys.length)
							renderedText = renderedText
								.replace(/\[Image\]/g, "")
								.replace(/\n{3,}/g, "\n\n")
								.trim();
					}
					// A sticker carries a file key like an image does; read it as one so the desktop shows
					// the picture the chat shows. A sticker whose bytes cannot be read still says so in
					// words instead of vanishing.
					if (type === "sticker") {
						const key = String(content.file_key ?? content.image_key ?? "");
						let read = false;
						if (key !== "") {
							for (const kind of ["image", "file"] as const) {
								try {
									const bytes = await messageResource(client, messageId, key, kind);
									images.push({ mediaType: imageMediaTypeOf(bytes), data: bytes.toString("base64") });
									read = true;
									break;
								} catch {
									// Not this resource type; the next one may be right.
								}
							}
						}
						renderedText = read ? "[Emoji]" : "[Emoji: could not be read]";
					}
					if (type === "image" && typeof content.image_key === "string" && content.image_key !== "") {
						try {
							const bytes = await messageResource(client, messageId, content.image_key, "image");
							images.push({ mediaType: imageMediaTypeOf(bytes), data: bytes.toString("base64") });
						} catch (error) {
							warn("ocean-crew im: feishu image download failed: %s", error);
						}
					}
					if (type === "file" && typeof content.file_key === "string" && content.file_key !== "") {
						try {
							const bytes = await messageResource(client, messageId, content.file_key, "file", MAX_FILE_BYTES);
							files.push({ name: String(content.file_name ?? content.file_key), data: bytes });
						} catch (error) {
							warn("ocean-crew im: feishu file download failed: %s", error);
						}
					}
					// A voice note and a video are attachments inside the message body, and
					// their bytes come from the same resource endpoint. The Bot gets the file
					// plus one line saying what it is; a download that failed is named as such
					// instead of the message being dropped silently.
					let attachment = "";
					if (type === "audio" || type === "media") {
						const kind = type === "audio" ? "Voice message" : "Video";
						const seconds = Math.round(Number(content.duration) / 1000);
						const length = Number.isFinite(seconds) && seconds > 0 ? `, ${seconds}s` : "";
						const key = String(content.file_key ?? "");
						const fallback = type === "audio" ? `voice-${messageId}.opus` : `video-${messageId}.mp4`;
						let read = false;
						if (key !== "") {
							try {
								const bytes = await messageResource(client, messageId, key, "file", MAX_FILE_BYTES);
								files.push({ name: String(content.file_name ?? fallback), data: bytes });
								read = true;
							} catch (error) {
								warn(`ocean-crew im: feishu ${type} download failed: %s`, error);
							}
						}
						attachment = read ? `[${kind}${length}]` : `[${kind}${length}: could not be read]`;
					}
					// A reply quotes the message it answers; without it the model cannot tell
					// which earlier message this one refers to.
					const quotedId = String(message.parent_id ?? message.upper_message_id ?? "");
					const quoted = quotedId === "" ? "" : await quotedText(client, quotedId, scrub, warn);
					const text =
						quoted === "" ? renderedText : `[Replying to: "${quoted.slice(0, 500)}"]\n\n${renderedText}`.trim();
					const body = attachment === "" ? text : [text, attachment].filter(Boolean).join("\n\n").trim();
					// A text that was nothing but a mention still matters: the host turns
					// it into a pairing request. Other types without readable content are
					// skipped rather than dispatched empty.
					if (type !== "text" && body === "" && images.length === 0 && files.length === 0) return;
					const chat = await chatOf(chatId, direct ? "direct" : "group");
					if (stopped) return;
					const sender = event.sender ?? {};
					const senderId = String(sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "");
					const senderLabel = String(sender.sender_name ?? "") || (await senderName(client, senderId, scrub));
					await handlers.onMessage({
						chat: { key: chatId, kind: chat.kind, title: chat.title },
						sender: { id: senderId, name: senderLabel === "" ? senderId : senderLabel },
						text: body,
						images,
						files,
						mentioned,
						messageId,
					});
					remember(messageId);
				} finally {
					delivering.delete(messageId);
				}
			} catch (error) {
				warn("ocean-crew im: feishu message failed: %s", error);
			}
		};

		const onAction = async (data: any): Promise<void> => {
			if (stopped) return;
			try {
				const event = data?.event ?? data ?? {};
				const context = event.context ?? {};
				const chatId = String(context.open_chat_id ?? event.open_chat_id ?? "");
				const messageId = String(context.open_message_id ?? event.open_message_id ?? "");
				const action = event.action ?? {};
				const value = action.value;
				const buttonData =
					value !== null && typeof value === "object" ? (value.action ?? value.v ?? JSON.stringify(value)) : value;
				const collected = action.form_value ?? action.formValue;
				const form =
					collected !== null && typeof collected === "object" && !Array.isArray(collected)
						? (collected as Record<string, unknown>)
						: undefined;
				const operator = event.operator ?? {};
				const operatorId = String(operator.open_id ?? operator.user_id ?? "");
				const chat = await chatOf(chatId);
				if (stopped) return;
				await handlers.onAction({
					chat: { key: chatId, kind: chat.kind, title: chat.title },
					sender: { id: operatorId, name: String(operator.name ?? operatorId) },
					data: String(buttonData ?? ""),
					messageId,
					...(form === undefined ? {} : { form }),
				});
			} catch (error) {
				warn("ocean-crew im: feishu card action failed: %s", error);
			}
		};

		const socket: any = new lark.WSClient({
			appId,
			appSecret,
			domain: domainOf(lark, fields),
			loggerLevel: lark.LoggerLevel.warn,
			handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
			autoReconnect: true,
			onReady: () => {
				if (!stopped) handlers.onStatus({ state: "ready" });
			},
			onReconnecting: () => {
				if (!stopped) handlers.onStatus({ state: "connecting" });
			},
			onReconnected: () => {
				if (!stopped) handlers.onStatus({ state: "ready" });
			},
			onError: (error: any) => {
				if (!stopped) handlers.onStatus({ state: "error", error: scrub(reason(error)) });
			},
			wsConfig: { pingTimeout: PING_TIMEOUT_S },
		});

		handlers.onStatus({ state: "connecting" });

		const boot = async (): Promise<void> => {
			// The bot identity only sharpens group @ detection; it must not hold the
			// long connection back, and a mention counts until it arrives.
			const identity = botInfo(client, scrub).then(
				(bot) => bot.id,
				(error) => {
					warn("ocean-crew im: feishu bot info failed: %s", error);
					return "";
				},
			);
			// Acknowledge the frame before dispatch: the SDK answers after the
			// handler returns, and a slow host turn must not make Feishu redeliver.
			const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
				"im.message.receive_v1": (event: any) => {
					void onMessage(event);
				},
				"card.action.trigger": (event: any) => {
					void onAction(event);
				},
			});
			const started = socket.start({ eventDispatcher: dispatcher }).catch((error: any) => {
				if (!stopped) handlers.onStatus({ state: "error", error: scrub(reason(error)) });
			});
			botOpenId =
				(await withDeadline(identity, BOT_INFO_TIMEOUT_MS, () =>
					env.log?.warn?.("ocean-crew im: feishu bot info timed out"),
				)) ?? "";
			await started;
		};
		void boot().catch((error: any) => {
			if (!stopped) handlers.onStatus({ state: "error", error: scrub(reason(error)) });
		});

		return {
			// An answer threads under the message that asked for it, which is what makes a
			// private chat read as a conversation rather than a wall of separate bubbles.
			send: async (chat: any, { text, buttons, replyTo, media, card: asCard, title, form }: any = {}) => {
				// No text at all means no empty bubble: the attachments go on their own.
				const raw = String(text ?? "");
				const chunks = raw.trim() === "" ? [] : chunkMarkdown(raw, TEXT_LIMIT);
				const createBody = (type: string, body: string) => ({
					params: { receive_id_type: "chat_id" },
					data: {
						receive_id: String(chat?.key ?? ""),
						msg_type: type,
						content: body,
						// A retried send must not arrive twice.
						uuid: randomUUID(),
					},
				});
				let messageId: string | undefined;
				let replyToId = typeof replyTo === "string" && replyTo !== "" ? replyTo : undefined;
				// Attachments are uploaded first: a caption and its attachment then leave as
				// one post message, and the upload failing loses nothing that was already said.
				const uploadedImages: Array<{ row: any; msgType: string; content: string }> = [];
				const uploadedFiles: Array<{ row: any; msgType: string; content: string }> = [];
				for (const item of Array.isArray(media) ? media : []) {
					const bytes = Buffer.from(item.data);
					const name = String(item.name ?? "file");
					if (item.kind === "image") {
						const answer = await call(
							"Feishu image upload",
							() => client.im.image.create({ data: { image_type: "message", image: bytes } }),
							scrub,
						);
						const key = String(answer?.data?.image_key ?? answer?.image_key ?? "");
						if (key === "")
							throw Object.assign(new Error(`Feishu returned no key for ${name}`), { permanent: true });
						uploadedImages.push({
							row: { tag: "img", image_key: key },
							msgType: "image",
							content: JSON.stringify({ image_key: key }),
						});
						continue;
					}
					const route = routeOf(name);
					const answer = await call(
						"Feishu file upload",
						() => client.im.file.create({ data: { file_type: route.upload, file_name: name, file: bytes } }),
						scrub,
					);
					const key = String(answer?.data?.file_key ?? answer?.file_key ?? "");
					if (key === "")
						throw Object.assign(new Error(`Feishu returned no key for ${name}`), { permanent: true });
					uploadedFiles.push({
						row: { tag: "media", file_key: key, file_name: name },
						msgType: route.msgType,
						content: JSON.stringify({ file_key: key }),
					});
				}
				// What is left after the caption: no text, a button card, or a plain-text
				// fallback leaves the attachment as its own message.
				const sendAttachments = async (): Promise<void> => {
					for (const held of [...uploadedImages.splice(0), ...uploadedFiles.splice(0)]) {
						const sent = await call(
							"Feishu send",
							() => client.im.message.create(createBody(held.msgType, held.content)),
							scrub,
						);
						messageId = String(sent?.data?.message_id ?? messageId ?? "");
					}
				};
				for (const [index, chunk] of chunks.entries()) {
					// A form is an interactive card as well: its submit button reports the answer.
					const interactive = (buttons !== undefined || form !== undefined) && index === chunks.length - 1;
					// A Bot's answer rides on a card (white, no header): Feishu lays the text out
					// better there, and a split answer just repeats the card without a stack of
					// headers. A card that carries buttons or a form is the interactive path.
					const replyCardMode = asCard === true && !interactive;
					const markup = MARKDOWN_HINT.test(chunk);
					// Images ride on the last part of the answer, as a caption with its media,
					// unless a button card has to be that part. Other files are their own
					// message: a post's media element does not accept every upload type.
					const caption =
						!interactive && index === chunks.length - 1 && uploadedImages.length > 0
							? uploadedImages.splice(0)
							: [];
					const msgType =
						interactive || replyCardMode ? "interactive" : caption.length > 0 ? "post" : markup ? "post" : "text";
					const content = interactive
						? card(chunk, buttons, title, form)
						: replyCardMode
							? replyCard(chunk)
							: caption.length > 0
								? postWith(
										chunk,
										caption.map((held: any) => held.row),
									)
								: msgType === "post"
									? post(chunk)
									: JSON.stringify({ text: toPlain(chunk) });
					const plain = msgType === "interactive" ? msgType : "text";
					const plainContent = msgType === "interactive" ? content : JSON.stringify({ text: toPlain(chunk) });
					const create = () =>
						call("Feishu send", () => client.im.message.create(createBody(msgType, content)), scrub).catch(
							async (failure: any) => {
								if (msgType === "interactive" && !interactive) {
									// A card refused for its content falls back to plain text below.
									env.log?.warn?.("ocean-crew im: feishu rejected the reply card; sending plain text");
									return call(
										"Feishu send",
										() =>
											client.im.message.create(createBody("text", JSON.stringify({ text: toPlain(chunk) }))),
										scrub,
									);
								}
								if (msgType === "interactive" || !POST_INVALID.test(String(failure?.message ?? ""))) {
									throw failure;
								}
								env.log?.warn?.("ocean-crew im: feishu rejected the post; sending plain text");
								// The caption could not carry them: they follow as their own messages.
								if (caption.length > 0) uploadedImages.unshift(...caption);
								return call(
									"Feishu send",
									() => client.im.message.create(createBody(plain, plainContent)),
									scrub,
								);
							},
						);
					let body: any;
					if (replyToId === undefined) body = await create();
					else {
						try {
							body = await call(
								"Feishu send",
								() =>
									client.im.message.reply({
										path: { message_id: replyToId },
										data: { msg_type: msgType, content, uuid: randomUUID() },
									}),
								scrub,
							);
						} catch (failure) {
							// The message being answered is gone (recalled, or from an expired context).
							// That code is otherwise classified as a permanent send failure, so it is
							// handled here: post the answer on its own instead of losing it.
							if (!isReplyGone(failure)) throw failure;
							env.log?.warn?.("ocean-crew im: feishu reply target is gone; sending plainly");
							body = await create();
						}
					}
					messageId = String(body?.data?.message_id ?? messageId ?? "");
					// Only the first bubble threads under the question.
					replyToId = undefined;
				}
				await sendAttachments();
				return { messageId };
			},
			// Which endpoint settles a message depends on how it was sent: a card is patched
			// (the only endpoint that accepts one), a post or text is updated in place. Using
			// patch for everything would fail on any message that is not an interactive card.
			edit: async (_chat: any, messageId: string, { text, buttons }: any = {}) => {
				const body = String(text ?? "").slice(0, TEXT_LIMIT);
				if (buttons !== undefined && buttons.length > 0) {
					await call(
						"Feishu edit",
						() =>
							client.im.message.patch({
								path: { message_id: String(messageId ?? "") },
								data: { content: card(body, buttons) },
							}),
						scrub,
					);
					return;
				}
				try {
					await call(
						"Feishu edit",
						() =>
							client.im.message.patch({
								path: { message_id: String(messageId ?? "") },
								data: { content: card(body, []) },
							}),
						scrub,
					);
					return;
				} catch (failure) {
					// A message sent before replies became cards is updated in place instead.
					env.log?.warn?.("ocean-crew im: feishu card patch failed; updating the message instead");
				}
				const markup = MARKDOWN_HINT.test(body);
				await call(
					"Feishu update",
					() =>
						client.im.message.update({
							path: { message_id: String(messageId ?? "") },
							data: {
								msg_type: markup ? "post" : "text",
								content: markup ? post(body) : JSON.stringify({ text: toPlain(body) }),
							},
						}),
					scrub,
				);
			},
			// Status reactions are best effort: the host marks the message that asked
			// for the work, and a refused reaction must never hold up the reply.
			addReaction: async (_chat: any, messageId: string, emoji: string) => {
				const body = await call(
					"Feishu reaction",
					() =>
						client.im.messageReaction.create({
							path: { message_id: String(messageId ?? "") },
							data: { reaction_type: { emoji_type: String(emoji ?? "") } },
						}),
					scrub,
				);
				const id = String(body?.data?.reaction_id ?? "");
				return id === "" ? undefined : id;
			},
			removeReaction: async (_chat: any, messageId: string, reactionId: string) => {
				await call(
					"Feishu reaction remove",
					() =>
						client.im.messageReaction.delete({
							path: { message_id: String(messageId ?? ""), reaction_id: String(reactionId ?? "") },
						}),
					scrub,
				);
			},
			stop: () => {
				stopped = true;
				try {
					socket.close({ force: true });
				} catch {
					/* already gone */
				}
			},
		};
	},
};

// A reply whose target no longer exists: Feishu says so with one of these codes.
// Feishu says a post payload was rejected with this message; the same content as text
// usually goes through, and a plain answer beats no answer.
const POST_INVALID = /content format of the post type is incorrect/i;
const REPLY_GONE = new Set([230011, 231003]);
const isReplyGone = (failure: any): boolean => {
	// The adapter's own errors carry the Feishu code on `platformCode`.
	const code = Number(failure?.platformCode ?? failure?.code ?? failure?.response?.data?.code);
	return REPLY_GONE.has(code);
};

export default feishu;
