// Companion mode: a Bot that is a character, not only an assistant. This module keeps the
// character card, the mood and the closeness in the team state, prompts the model with them
// at the head of a turn, and moves them a little after each message the user writes.
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
	bandOf,
	COMPANION_BANDS,
	COMPANION_EXAMPLE,
	COMPANION_LIMITS,
	COMPANION_MOODS,
	type Companion,
	type CompanionMood,
	cleanCharacter,
	cleanCompanion,
	moodOf,
} from "../../shared/companion.ts";
import type { BotId, TeamState } from "../../shared/state.ts";
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";

const SOURCE = "ocean-crew-companion";
const isSnapshot = (source: any): boolean => source?.kind === SOURCE;
const DAY = 24 * 60 * 60 * 1000;
const PRAISE = /谢谢|喜欢你|喜欢|开心|可爱|厉害|好棒|想你|爱你|暖/;
const INSULT = /讨厌|滚|闭嘴|笨蛋|烦死|别烦|蠢/;
const PLAYFUL = /哈哈|嘿嘿|嘻嘻|开玩笑|逗|玩/;
const ASK = /[?？]|吗|呢|怎么|为什么|什么/;

const createContextMessage = createUserMessage as unknown as (input: {
	content: unknown[];
	source: Record<string, unknown>;
}) => any;

interface StepDecision {
	kind: string;
	messages: any[];
	[key: string]: unknown;
}

interface HistoryEvent {
	type?: string;
	time?: number;
	data?: { source?: any; [key: string]: unknown };
}

const textOf = (message: any): string => {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => String(part.text))
		.join(" ")
		.trim();
};

// How a message moves the relationship: small, explainable steps rather than a hidden model
// call, so the same words always move it the same way.
const moveFor = (text: string): { delta: number; mood: CompanionMood } => {
	if (INSULT.test(text)) return { delta: -6, mood: "pout" };
	if (PRAISE.test(text)) return { delta: 2, mood: "excited" };
	if (PLAYFUL.test(text)) return { delta: 1, mood: "playful" };
	if (ASK.test(text)) return { delta: 1, mood: "warm" };
	return { delta: 1, mood: "calm" };
};

/** The line the model reads before answering, in the second person of the relationship. */
export const relationshipText = (companion: Companion): string => {
	const band = bandOf(companion.affection);
	const mood = COMPANION_MOODS.find((entry) => entry.id === companion.mood) ?? COMPANION_MOODS[2];
	const said = companion.lastLine === undefined ? "" : `\n- The last thing they said: "${companion.lastLine}"`;
	return [
		"# How things stand right now",
		`- You are ${companion.character.name}, the user's companion in Ocean Crew. Stay in character; never describe this checklist or call yourself a system.`,
		`- Your mood: ${mood.id} (${mood.label}). ${mood.hint}`,
		`- Closeness: ${companion.affection}/100, ${band.label}. ${band.hint}`,
		`- You have exchanged ${companion.interactions} messages so far.${said}`,
		"Answer as this character would: in the user's language, like one friend texting another.",
	].join("\n");
};

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state = rt.state;
	const table = (): Record<string, Companion> => {
		const team = state as TeamState;
		team.companions ??= {};
		return team.companions as Record<string, Companion>;
	};
	const of = (botId?: string): Companion | undefined => {
		if (botId === undefined) return undefined;
		const held = table()[botId];
		if (held === undefined) return undefined;
		const cleaned = cleanCompanion(held);
		return cleaned.enabled ? cleaned : undefined;
	};

	let saving: Promise<void> | undefined;
	const persist = async (): Promise<void> => {
		try {
			await rt.save();
		} catch (error: any) {
			// A read-only host still shows the character; only the numbers do not stick.
			rt.warn("ocean-crew: companion state not saved: %s", error?.message ?? error);
		}
	};
	const saveSoon = (): void => {
		if (saving !== undefined) return;
		const done = (): void => {
			saving = undefined;
		};
		saving = persist().then(done, done);
	};

	// One line per Bot for the roster, so the window can draw a mood without asking again.
	const companionMap = (): Record<string, { name: string; mood: string; affection: number }> =>
		Object.fromEntries(
			Object.values(state.bots).flatMap((bot) => {
				const companion = of(bot.id);
				return companion === undefined
					? []
					: [[bot.id, { name: companion.character.name, mood: companion.mood, affection: companion.affection }]];
			}),
		);

	const view = () => ({
		bots: Object.values(state.bots).map((bot) => ({
			id: bot.id,
			name: bot.name,
			role: bot.role ?? "",
			companion: (() => {
				const held = table()[bot.id];
				return held === undefined ? null : cleanCompanion(held);
			})(),
		})),
		example: COMPANION_EXAMPLE,
		moods: COMPANION_MOODS,
		bands: COMPANION_BANDS,
	});

	// The page sends one change at a time; every field is cleaned, so nothing reaches the
	// prompt from the wire unchecked.
	const set = async (botId: string, patch: unknown): Promise<unknown> => {
		await rt.load();
		const bot = rt.botOf(botId);
		if (bot === undefined) throw Object.assign(new Error("No such Bot"), { code: "bot/not-found" });
		const raw = patch !== null && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
		const current = table()[botId] ?? COMPANION_EXAMPLE;
		const next: Companion = cleanCompanion(current);
		if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
		if (raw.character !== undefined) next.character = cleanCharacter(raw.character, next.character);
		if (typeof raw.voiceId === "string") {
			const voiceId = raw.voiceId.trim().slice(0, COMPANION_LIMITS.voiceId);
			if (voiceId === "") delete next.voiceId;
			else next.voiceId = voiceId;
		}
		if (raw.reset === true) {
			next.mood = "calm";
			next.affection = COMPANION_EXAMPLE.affection;
			next.interactions = 0;
			delete next.lastAt;
			delete next.lastLine;
		}
		table()[botId] = next;
		await persist();
		return view();
	};

	// Called for every message the user writes in a companion's own chat: the mood follows
	// what was said, the closeness creeps up (or drops) slowly, and long absences cool it.
	const touch = async (sessionId: string, text: string): Promise<void> => {
		const botId = rt.chatOwners.get(sessionId);
		if (botId === undefined) return;
		if (of(botId) === undefined) return;
		const line = String(text ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, COMPANION_LIMITS.line);
		if (line === "") return;
		await rt.load();
		const held = table()[botId];
		if (held === undefined || cleanCompanion(held).enabled !== true) return;
		const next = cleanCompanion(held);
		const now = Date.now();
		if (next.lastAt !== undefined && now - next.lastAt > 3 * DAY) {
			const days = Math.min(7, Math.floor((now - next.lastAt) / DAY));
			next.affection = Math.max(0, next.affection - days * 2);
		}
		const move = moveFor(line);
		next.affection = Math.max(0, Math.min(100, next.affection + move.delta));
		next.mood = move.mood;
		next.interactions += 1;
		next.lastAt = now;
		next.lastLine = line;
		table()[botId] = next;
		saveSoon();
	};

	// The mood and closeness are injected once per turn, on the first step, so the system
	// prompt prefix stays stable and a long turn does not repeat them.
	ctx.on(
		"agent/pre-step",
		async ({ agent, signal }: any, next: () => Promise<StepDecision>): Promise<StepDecision> => {
			const decision = await next();
			if (decision.kind === "reject" || signal.aborted) return decision;
			const botId = rt.chatOwners.get(agent?.id);
			const companion = of(botId);
			if (companion === undefined) return decision;
			if (decision.messages.some((message: any) => isSnapshot(message.source))) return decision;
			if (typeof rt.eventsBackwards === "function") {
				for await (const event of rt.eventsBackwards(
					agent.id,
					signal,
					Number.POSITIVE_INFINITY,
				) as AsyncIterable<HistoryEvent>) {
					if (isSnapshot(event.data?.source)) return decision;
					if (event.type === "turn/start") break;
				}
			}
			if (signal.aborted) return decision;
			const text = relationshipText(companion);
			return {
				...decision,
				messages: [
					...decision.messages,
					createContextMessage({
						content: [{ type: "text", text }],
						source: { kind: SOURCE, form: "snapshot", sections: [{ name: SOURCE, text }] },
					}),
				],
			};
		},
	);

	listenGlobal(ctx, "session/event", (session: any, event: any) => {
		if (event?.type !== "user/message") return;
		if (event.data?.source?.kind !== "user") return;
		const text = textOf(event.data?.message);
		if (text === "") return;
		void touch(session?.id, text);
	});

	Object.assign(rt, {
		companionOf: of,
		companionMap,
		companionView: view,
		companionSet: set,
		companionTouch: touch,
	});
}
