// Delivery: how one Bot, the user, or Ocean Crew itself puts a message into a Bot
// Session. A relay carries a header line, a producer source that turns and resume read,
// and its exchange record. A message past MESSAGE_INLINE_MAX goes as a DSH file instead
// of whole into every Session it reaches.
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Exchange } from "../../shared/state.ts";
import {
	HISTORY_TIMEOUT_MS,
	LONG_HEAD,
	MESSAGE_INLINE_MAX,
	READ_LINE_MAX,
	SOURCE_KIND,
	TEXT_KEPT,
	TEXT_SHOW_MAX,
} from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";
import { headOf, textOf } from "../core/text.ts";

/** The message a relay sends; only the fields it names are put on the source. */
export interface DeliverArgs {
	fromId?: string;
	toId: string;
	sessionId?: string;
	text: string;
	role: string;
	replyTo?: string;
	roomId?: string;
	audience?: string;
	note?: string;
	exchangeId?: string;
	steer?: boolean;
	deferred?: boolean;
	resumed?: boolean;
	retried?: boolean;
	resent?: boolean;
	merged?: boolean;
	askedBy?: string;
	fromRoomId?: string;
	images?: unknown[];
	files?: unknown[];
	length?: number;
	work?: string;
}

/** A long message as attachLong sends it: the note, its head, and the file. */
export interface LongMessage {
	text: string;
	files: unknown[];
	length?: number;
}

/** What reading a stored message back yields; `whole` is false when only its start is known. */
export interface MessageText {
	text: string;
	whole: boolean;
}

interface HeaderOptions {
	resumed?: boolean;
	retried?: boolean;
	resent?: boolean;
	asker?: string;
}

// The roles recorded as team exchanges; the others inform a turn without waiting for it.
const EXCHANGE_ROLES = new Set(["request", "reply", "stopped"]);

// DSH's message types close the producer-source union, while a plugin adds its own

// DSH passes through. The cast is that one declared extension; every other field stays
// checked.
interface RelayMessageInput {
	content: unknown[];
	source: Record<string, unknown>;
}

interface RelayMessage {
	id: string;
	content: readonly unknown[];
	source: Record<string, any>;
}

const createRelayMessage = createUserMessage as unknown as (input: RelayMessageInput) => RelayMessage;

const sessionsService = (ctx: Runtime["ctx"]): { flush(session: unknown): Promise<void> } =>
	ctx.sessions as unknown as { flush(session: unknown): Promise<void> };

const attachmentsService = (
	ctx: Runtime["ctx"],
):
	| {
			saveFile?(input: { data: Uint8Array; name: string }): Promise<any>;
			readFileStream?(file: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>;
	  }
	| undefined => ctx.get?.("attachments") as any;

// What one delivered message says above its text. The wording is what the model reads
// and what the client shows; it is part of the public behavior, so it is kept verbatim.
export function headerFor(
	role: string,
	fromName: string,
	roomName: string | undefined,
	audience: string | undefined,
	note = "new message",
	deferred = false,
	{ resumed = false, retried = false, resent = false, asker }: HeaderOptions = {},
): string {
	// What came back for work another Bot gave this one says where its answer goes.
	const goesOn =
		asker === undefined
			? ""
			: ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`;
	if (deferred && role === "reply")
		return `[Reply from ${fromName} · you read it during your last task; go on with the work it is for now${goesOn}]`;
	if (deferred && role === "report")
		return `[Group chat "${roomName}" · replies to your post · you read them during your last task; go on with the work they are for now${goesOn}]`;
	if (deferred && role !== "room")
		return `[Message from ${fromName} · you read it during your last task; answer it now]`;
	if (retried && role !== "room") return "[Your last reply wrote a tool call as text, so nothing ran]";
	if (resumed && role === "resume") return "[DeepSeek Harness restarted while you were working]";
	if (resumed && role !== "room")
		return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`;
	if (resent && role === "reply")
		return `[Reply from ${fromName} · DeepSeek Harness restarted before it could reach you]`;
	if (resent && role !== "room")
		return `[Message from ${fromName} · DeepSeek Harness restarted before it could reach you]`;
	if (role === "reply") return `[Reply from ${fromName}${goesOn}]`;
	if (role === "stopped") return `[Stopped by ${fromName}]`;
	if (role === "room") return `[Group chat "${roomName}" · ${note}]`;
	if (role === "report") return `[Group chat "${roomName}" · replies to your post${goesOn}]`;
	if (role === "kickoff") return "[Bot team setup]";
	if (role === "continue") return "[Retry after a failed turn]";
	// The editor can be the user or a Bot (its own tool call, or a Main Bot's): the
	// header stays neutral about who changed the profile.
	if (role === "update") return "[Your profile was updated — follow the latest version]";
	if (role === "secret") return "[Secret card]";
	if (audience === "user") return `[Message from ${fromName} · the user sees your reply here]`;
	return `[Message from ${fromName}]`;
}

export function install(rt: Runtime): void {
	const { ctx, state } = rt;

	// The Agent a Session is on now, opened if needed. A Session DSH cannot open rejects
	// with the code DSH gave, so the caller can tell a gone Session from a failure.
	const resolveAgent = async (sessionId: string): Promise<any> => {
		const controller = ctx.sessionController as unknown as {
			resolveAgent(sessionId: string): Promise<{ agent?: any; error?: { message?: string; code?: string } }>;
		};
		const resolved = await controller.resolveAgent(sessionId);
		if ("error" in resolved)
			throw Object.assign(new Error(resolved.error?.message ?? "Session unavailable"), {
				code: resolved.error?.code,
			});
		rt.hideBotUnusedTools?.(resolved.agent);
		return resolved.agent;
	};

	// `sessionId` defaults to the recipient's own chat; group turns name its group Session.
	// `deferred`: a request the Bot already read mid-turn, handed back to answer in a turn
	// of its own; its exchange was recorded when it first arrived. `resumed` and
	// `retried` carry on a turn a restart cut off or that wrote its tool call as text;
	// their exchange is recorded already too. `resent` is a message a shutdown cancelled;
	// its first send may not have been recorded. `askedBy` is the member whose @mention
	// called a group turn. `fromRoomId`: the group whose Session the sender wrote from;
	// the reply goes back to that Session. `images` and `files` go along as image and
	// file blocks, which DSH projects for the recipient's model and tools. `length`: the
	// whole message's length when it went as a file (attachLong). `work`: the work a
	// result that came back goes on with.
	// one its recipient had not read, under that one's exchange.
	async function deliver(args: DeliverArgs): Promise<string> {
		const {
			fromId,
			toId,
			sessionId,
			text,
			role,
			replyTo,
			roomId,
			audience,
			note,
			exchangeId = randomUUID(),
			steer = false,
			deferred = false,
			resumed = false,
			retried = false,
			resent = false,
			merged = false,
			askedBy,
			fromRoomId,
			images = [],
			files = [],
			length,
			work,
		} = args;
		const from = rt.botOf(fromId);
		const to = rt.botOf(toId);
		if (to === undefined) throw new Error(`Unknown Bot ${toId}`);
		const fromName = from?.name ?? "You";
		const room = rt.roomOf(roomId);
		const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name;
		// Session events reject `undefined` members, so optional fields are omitted instead.
		const source = {
			kind: SOURCE_KIND,
			form: "relay",
			role,
			exchangeId,
			senderName: fromName,
			...(work ? { work } : {}),
			...(fromId ? { senderSessionId: fromId } : {}),
			...(replyTo ? { replyTo } : {}),
			...(roomId ? { roomId } : {}),
			...(audience === "user" ? { audience } : {}),
			...(deferred ? { deferred: true } : {}),
			...(resumed ? { resumed: true } : {}),
			...(retried ? { retried: true } : {}),
			...(askedBy ? { askedBy } : {}),
			...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
		};
		const targetSessionId = sessionId ?? rt.chatOf(toId);
		await rt.ensureCapabilities?.(targetSessionId);
		const agent = await resolveAgent(targetSessionId);
		// A steered message cuts into a running turn at its next step; a follow-up queues
		// for the next turn.
		const message = createRelayMessage({
			content: [
				{
					type: "text",
					text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, asker })}\n${text}`,
				},
				...images.map((attachment) => ({ type: "image", attachment })),
				...files.map((attachment) => ({ type: "file", attachment })),
			],
			source,
		});
		if (steer) agent.steer(message);
		else agent.followup(message);
		await sessionsService(ctx).flush(agent.session);
		if (EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried) {
			// failed delivery as delivered. The whole text is in its file, or in the
			// Session it goes to; exchangeText reads it back there.
			const kept = headOf(text, TEXT_KEPT);
			const whole =
				length !== undefined
					? { length, files }
					: kept.length < text.length
						? { length: text.length, sessionId: targetSessionId }
						: {};
			const entry: Exchange = {
				id: exchangeId,
				from: fromId ?? "",
				to: toId,
				text: kept,
				...whole,
				role,
				time: Date.now(),
				...(replyTo ? { replyTo } : {}),
				...(audience === "user" ? { audience } : {}),
			};
			const earlier = state.exchanges.findIndex((other) => other.id === exchangeId);
			if (earlier === -1) state.exchanges.push(entry);
			else if (merged) state.exchanges[earlier] = entry;
			void rt.save().catch(() => {});
		}
		return exchangeId;
	}

	// A message between Bots, whole, from the Session it was delivered to: the message
	// there is its header line, then the text. `whole` is false when only the start could
	// be read (the Session is gone, or the message is past what the dialog shows).
	async function exchangeText(entry: Exchange): Promise<MessageText> {
		if (entry.length === undefined) return { text: entry.text, whole: true };
		const files = entry.files ?? [];
		if (files.length > 0) return (await fileText(files[0])) ?? { text: entry.text, whole: false };
		try {
			// The durable Session log reader is a later module's; without it the call throws
			// and the start of the message, said to be only that, is the answer.
			for await (const event of rt.eventsBackwards(
				entry.sessionId ?? rt.chatOf(entry.to),
				AbortSignal.timeout(HISTORY_TIMEOUT_MS),
			)) {
				if (event.type !== "user/message" || event.data?.source?.exchangeId !== entry.id) continue;
				const delivered = textOf(event.data.content);
				const text = delivered.slice(delivered.indexOf("\n") + 1);
				return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX };
			}
		} catch (error) {
			rt.warn("ocean-crew: message %s not read back: %s", entry.id, error);
		}
		return { text: entry.text, whole: false };
	}

	// A message a Bot sends past MESSAGE_INLINE_MAX goes as a DSH file: it is stored once,
	// not in every Session it reaches, and the model reads it with its file tools when it
	// needs it. Undefined when this DSH cannot store files.
	async function attachLong(text: string, name: string): Promise<LongMessage | undefined> {
		if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] };
		try {
			const attachments = attachmentsService(ctx);
			const file = await attachments?.saveFile?.({ data: new TextEncoder().encode(text), name });
			if (file === undefined) return undefined;
			// The file stays verbatim, so a line past what the read tool shows needs
			// another way.
			const wide = text.split("\n").some((line) => line.length > READ_LINE_MAX);
			const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ""}]`;
			return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length };
		} catch (error) {
			rt.warn("ocean-crew: long message not stored as a file: %s", error);
			return undefined;
		}
	}

	// The text of a stored file, up to what the dialogs show.
	async function fileText(file: unknown): Promise<MessageText | undefined> {
		const attachments = attachmentsService(ctx);
		if (attachments?.readFileStream === undefined) return undefined;
		const decoder = new TextDecoder();
		let text = "";
		try {
			for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
				text += decoder.decode(chunk, { stream: true });
				if (text.length > TEXT_SHOW_MAX) return { text: headOf(text, TEXT_SHOW_MAX), whole: false };
			}
		} catch (error) {
			rt.warn("ocean-crew: file %s not read: %s", (file as { name?: string } | undefined)?.name, error);
			return undefined;
		}
		text += decoder.decode();
		return { text, whole: true };
	}

	Object.assign(rt, { resolveAgent, deliver, exchangeText, attachLong, fileText });
}
