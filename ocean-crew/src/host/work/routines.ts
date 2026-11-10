// Routines that start on an event instead of a clock. A scheduled task asks "did the time come?";
// a routine asks "did something happen?" — a mail arrived from someone, a chat message matched a
// word. When it fires it opens a turn in the Bot's chat with the same framing a scheduled task
// uses, so run records, the "[PASS]" silence rule and the failure notice all apply unchanged.
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Runtime } from "../core/runtime.ts";

/** The events a routine can start on. Only a wired source is listed here. */
export type RoutineSource = "im_keyword";

export interface Routine {
	id: string;
	botId: string;
	name: string;
	/** What the Bot is asked when the event fires; the match travels with it. */
	prompt: string;
	trigger: RoutineTrigger;
	/** Minutes a match may be old and still count, so a restart does not replay old events. */
	windowMinutes: number;
	enabled: boolean;
	createdAt: number;
}

export interface RoutineTrigger {
	kind: "im_keyword";
	/** Words or phrases that start the routine; a match is a case-insensitive substring. */
	words: string[];
	/** Only listen in this chat (its key as the IM page shows it); every chat when absent. */
	chat?: string;
}

/** The team state key the routines live under. */
export const ROUTINES = "routines";

const MAX_ROUTINES = 20;

export interface RoutineMatch {
	/** What matched, short enough for a chat: "mail from Ana — Q3 numbers". */
	summary: string;
	/** When the matched thing happened, so a window can be applied. */
	at: number;
}

export interface Routines {
	list(): Routine[];
	create(input: Omit<Routine, "id" | "createdAt" | "enabled"> & { enabled?: boolean }): Promise<Routine>;
	remove(id: string): Promise<boolean>;
	/** Feed one already-observed event; returns the routines that matched it. */
	matchText(text: string, at: number): Routine[];
	/** The routines an IM message starts, in the chat it arrived in. */
	matchesMessage(text: string, chatKey?: string): Routine[];
}

const text = (value: unknown): string => String(value ?? "").trim();
const lower = (value: unknown): string => text(value).toLowerCase();

export function routinesOf(rt: Runtime): Routines {
	const table = (): Routine[] => {
		const team = rt.state as unknown as Record<string, unknown>;
		const held = team[ROUTINES];
		if (!Array.isArray(held)) return [];
		return held.filter(
			(entry): entry is Routine => entry !== null && typeof entry === "object" && typeof entry.id === "string",
		);
	};

	const matches = (routine: Routine, input: string, chatKey?: string): boolean => {
		const trigger = routine.trigger;
		if (trigger.words.length === 0) return false;
		if (trigger.chat !== undefined && trigger.chat !== "" && trigger.chat !== chatKey) return false;
		const haystack = lower(input);
		return trigger.words.some((word) => text(word) !== "" && haystack.includes(lower(word)));
	};

	return {
		list: () => table(),
		async create(input) {
			await rt.load();
			const team = rt.state as unknown as Record<string, unknown>;
			const held = table();
			if (held.length >= MAX_ROUTINES)
				throw Object.assign(new Error(`A team can have at most ${MAX_ROUTINES} routines.`), {
					code: "bot/invalid",
				});
			if (rt.botOf(input.botId) === undefined)
				throw Object.assign(new Error("No such Bot"), { code: "bot/invalid" });
			if (text(input.prompt) === "")
				throw Object.assign(new Error("Say what the Bot should do when it fires."), { code: "bot/invalid" });
			const routine: Routine = {
				...input,
				id: `routine-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
				createdAt: Date.now(),
				enabled: input.enabled !== false,
				prompt: text(input.prompt),
			};
			team[ROUTINES] = [...held, routine];
			await rt.save();
			return routine;
		},
		async remove(id) {
			await rt.load();
			const team = rt.state as unknown as Record<string, unknown>;
			const held = table();
			const next = held.filter((routine) => routine.id !== id);
			if (next.length === held.length) return false;
			team[ROUTINES] = next;
			await rt.save();
			return true;
		},
		matchText: (input) => table().filter((routine) => routine.enabled && matches(routine, input)),
		matchesMessage: (input, chatKey) =>
			table().filter((routine) => routine.enabled && matches(routine, input, chatKey)),
	};
}

/** What the Bot is asked when a routine fires: the prompt, the match, and what to do if nothing. */
export const routineText = (routine: Routine, match: RoutineMatch): string =>
	[
		`[Scheduled task] ${routine.prompt}`,
		"",
		`What triggered it: ${match.summary}`,
		"If this is not worth telling the user about, reply [PASS] and say nothing.",
	].join("\n");

/**
 * Open a turn in the Bot's chat for this routine. The message is framed as a scheduled task, which
 * is what it is: work the Bot started on its own, tracked and silenced by the same rules.
 */
export async function fireRoutine(rt: Runtime, routine: Routine, match: RoutineMatch): Promise<boolean> {
	const sessionId = rt.chatOf(routine.botId);
	if (sessionId === undefined) return false;
	const agent = await rt.agentOf?.(sessionId);
	if (agent === undefined) return false;
	const source = { kind: "schedule", taskId: `routine:${routine.id}` } as any;
	const message = createUserMessage({ content: [{ type: "text", text: routineText(routine, match) }], source });
	try {
		// A running Bot reads it at its next step; an idle one starts a turn. Either way the routine
		// does not wait for it here: its result arrives through the run record.
		if (agent.status === "idle") await agent.followup(message);
		else await agent.inject(message);
		return true;
	} catch (error: any) {
		rt.warn("ocean-crew: routine %s could not start: %s", routine.name, error?.message ?? error);
		return false;
	}
}
