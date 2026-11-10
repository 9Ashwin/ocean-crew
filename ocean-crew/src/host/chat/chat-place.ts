// Where this conversation is happening. A Bot has one chat in the window and any number of chats on
// Feishu or WeChat, and its prompt was the same in all of them: it did not know the user was on a
// phone, in a group, or talking to it from a chat app at all. That is why an answer written for the
// window arrived as a report in a chat that wanted a sentence — and why a Bot could not tell "send it
// here" from "send it to my chat".
//
// One snapshot per step carries the channel, the kind of chat and the reply rules of that platform.
// It is a context message, never a rewrite of what the user wrote.
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";

const SOURCE = "ocean-crew-im-context";

/** One identity for a place, so a snapshot can be recognised as still true. */
const placeKey = (place: ChatPlace): string => `${place.platform}:${place.kind}:${place.title ?? ""}`;

// DSH's message types close the producer-source union, while a plugin adds its own snapshot source.
// The cast is that one declared extension.
const createContextMessage = createUserMessage as unknown as (input: {
	content: unknown[];
	source: Record<string, unknown>;
}) => any;

interface StepDecision {
	kind: string;
	messages: any[];
	[key: string]: unknown;
}

/** What a chat platform is called in the words a person uses. */
const PLATFORM_NAME: Record<string, string> = {
	feishu: "Feishu",
	wechat: "WeChat",
};

export interface ChatPlace {
	platform: string;
	/** direct or group. */
	kind: "direct" | "group";
	/** The conversation's title, when the platform gave one. */
	title?: string;
}

/** The lines a Bot reads when it works in a chat app rather than in the window. */
export function chatContextLines(place: ChatPlace): string[] {
	const platform = PLATFORM_NAME[place.platform] ?? place.platform;
	const where =
		place.kind === "group"
			? `${platform} group chat${place.title === undefined ? "" : ` "${place.title}"`}`
			: `${platform} direct chat`;
	return [
		"# Where this conversation is happening",
		`- You are answering in a **${where}**, not in the Ocean Crew window. The user reads it on their phone or in their chat app.`,
		place.kind === "group"
			? "- Several people can read the group. Write what the group should see: no private reasoning, no notes to yourself."
			: "- Only the user reads this chat.",
		"- Your reply is sent to them as a chat message: keep it short, in the user's language, no headings, no status report. One thought per message is fine.",
		'- When the user says "send it to me", "here", or "this chat", they mean this conversation — send it here.',
		"- Your answer reaches the user directly. You do not need to repeat it, address it to yourself, or announce that you finished.",
		"- A picture, a voice note or a file they sent is an attachment in this chat; a link you open is not something they can see unless you send it back.",
	];
}

/** A conversation a Bot is known to be talking in, keyed by the Session the turn runs in. */
export interface ChatPlaces {
	/** Remember that this Session receives its messages from this chat. */
	note(sessionId: string, place: ChatPlace): void;
	/** The chat a Session's turns come from, or undefined when it is the window. */
	of(sessionId: string): ChatPlace | undefined;
	/** A Session that moved back to the window is no longer in a chat. */
	clear(sessionId: string): void;
}

export function chatPlaces(): ChatPlaces {
	const held = new Map<string, ChatPlace>();
	return {
		note: (sessionId, place) => void held.set(sessionId, place),
		of: (sessionId) => held.get(sessionId),
		clear: (sessionId) => void held.delete(sessionId),
	};
}

export function install(rt: Runtime): void {
	const places = chatPlaces();
	Object.assign(rt, {
		chatPlaces: places,
		/** The IM module says where a Session's messages come from. */
		noteChatPlace: (sessionId: string, place: ChatPlace) => places.note(sessionId, place),
		clearChatPlace: (sessionId: string) => places.clear(sessionId),
	});

	// The window and a chat share one Session only when the Bot has a single conversation, so a
	// message the user sends from the window means the place changed back.
	listenGlobal(rt.ctx, "session/event", (session: any, event: any) => {
		if (event?.type !== "user/message") return;
		const kind = event.data?.source?.kind;
		// A scheduled turn is not a person in a chat: it keeps whatever place that Session had.
		if (kind === "user") places.clear(String(session?.id ?? ""));
	});

	rt.ctx.on(
		"agent/pre-step",
		async ({ agent, signal }: any, next: () => Promise<StepDecision>): Promise<StepDecision> => {
			const decision = await next();
			if (decision.kind === "reject" || signal.aborted) return decision;
			const place = places.of(String(agent?.id ?? ""));
			if (place === undefined) return decision;
			const key = placeKey(place);
			// The newest snapshot in this step's messages: when it already names this place, the Bot
			// has been told, and repeating it every step would only cost tokens.
			for (let index = decision.messages.length - 1; index >= 0; index -= 1) {
				const source: any = (decision.messages[index] as any)?.source;
				if (source?.kind !== SOURCE) continue;
				if (source.place === key) return decision;
				break;
			}
			const message = createContextMessage({
				content: [{ type: "text", text: chatContextLines(place).join("\n") }],
				source: { kind: SOURCE, place: key },
			});
			return { ...decision, messages: [...decision.messages, message] };
		},
	);
}
