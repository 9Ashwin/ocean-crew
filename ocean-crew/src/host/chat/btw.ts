// The ask path is gone, but saved
// cards stay readable until the user deletes them, so this file keeps their files, the
// projection that places a card on the turn it belongs to, and the shared snapshot /
// model-call helpers that side chats use.
//
// Cards live in `<home>/btw/<botId>/<partId>.json`, not in state.json, so a save never
// rewrites them; only the host that owns the team writes them.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { replaceFile } from "../core/files.ts";
import type { Runtime } from "../core/runtime.ts";

export const RESTART_ERROR = "Ocean Crew restarted before this answer finished.";
export const TOOL_ERROR = "The model called a tool again after being told not to, so this aside was not answered.";
export const EMPTY_ERROR = "The model wrote nothing.";
// Events that still belong to a turn. A model selection or a title does not.
const MESSAGE_EVENTS = new Set([
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"turn/start",
	"turn/end",
]);
// Host-only projection. `turnBoundary` clears its open seq on turn/end, so a log-only
// tail would lose the turn it still belongs to.
const ANCHOR_KEY = "dsBotAnchor";

const seqOf = (value: unknown): number | null =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const turnOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

interface AnchorState {
	turnStartSeq: number | null;
	turn: number | null;
	messageSeq: number | null;
	starts: { seq: number; turn: number }[];
}

// Checkpoint check for the projection registry. The live read does not use it.
const anchorStateSchema = {
	parse(value: unknown): AnchorState {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new Error("ocean-crew anchor projection state is not an object");
		const record = value as Record<string, unknown>;
		const starts: { seq: number; turn: number }[] = [];
		if (Array.isArray(record.starts)) {
			for (const raw of record.starts) {
				const start = raw as Record<string, unknown> | null | undefined;
				const seq = seqOf(start?.seq);
				const turn = turnOf(start?.turn);
				if (seq === null || turn === null) continue;
				starts.push({ seq, turn });
			}
		}
		return {
			turnStartSeq: seqOf(record.turnStartSeq),
			turn: turnOf(record.turn),
			messageSeq: seqOf(record.messageSeq),
			starts,
		};
	},
};

// `turnStartSeq` is the latest turn/start and stays set after turn/end.
// `starts` lists every numbered turn/start so a later page can seed its rows.
const anchorProjection = {
	key: ANCHOR_KEY,
	stateVersion: 1,
	stateSchema: anchorStateSchema,
	init(): AnchorState {
		return { turnStartSeq: null, turn: null, messageSeq: null, starts: [] };
	},
	apply(state: AnchorState, event: any): AnchorState {
		const seq = seqOf(event?.seq);
		if (seq === null) return state;
		if (event.type === "turn/start") {
			const turn = turnOf(event.data?.turn);
			if (turn === null)
				return state.turnStartSeq === seq && state.messageSeq === seq
					? state
					: { ...state, turnStartSeq: seq, messageSeq: seq };
			return { turnStartSeq: seq, turn, messageSeq: seq, starts: [...state.starts, { seq, turn }] };
		}
		if (!MESSAGE_EVENTS.has(event.type) || state.messageSeq === seq) return state;
		return { ...state, messageSeq: seq };
	},
};

// The projections service, when this DSH build has it.
const projectionsOf = (ctx: any): any => (typeof ctx?.get === "function" ? ctx.get("sessionProjections") : undefined);

// `session.eventAt` is closed to new callers. The registry folds the log;
// this reads the fold. Absent means the capability is not loaded.
function registerAnchor(ctx: any): void {
	const register = (projections: any): void => {
		if (typeof projections?.register === "function") projections.register(anchorProjection);
	};
	if (typeof ctx?.inject === "function") {
		ctx.inject(["sessionProjections"], (projectionCtx: any) => {
			register(projectionCtx.sessionProjections);
		});
		return;
	}
	register(projectionsOf(ctx));
}

const anchorState = (session: any, projections: any): AnchorState | undefined => {
	if (typeof projections?.stateOf !== "function" || session == null) return undefined;
	return projections.stateOf(session, ANCHOR_KEY);
};

const callIds = (message: any): string[] => {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const block of message.content) if (block?.type === "tool-call") ids.push(block.id);
	return ids;
};

// DSH commits the assistant message before tool results exist. A tail that still
// owes a result is dropped whole: an adapter rejects a tool call with no result,
// and an aside does not wait for one or invent one.
export function trimToolBoundary(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return [];
	let index = messages.length;
	while (index > 0 && messages[index - 1]?.role === "tool") index -= 1;
	const calls = callIds(messages[index - 1]);
	if (calls.length === 0) return messages;
	const answered = new Set<string>();
	for (const message of messages.slice(index)) {
		if (typeof message?.toolCallId === "string") answered.add(message.toolCallId);
	}
	const balanced = calls.every((id) => typeof id === "string" && answered.has(id));
	return balanced ? messages : messages.slice(0, index - 1);
}

// `seq` is the next event's number. The last committed one is the snapshot's atSeq.
const committedSeq = (session: any): number | null => {
	const seq = session?.seq;
	return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq - 1 : null;
};

// `atSeq` is the last committed event, which may be log-only. `anchorSeq` is the
// turn/start of the turn that event belongs to (or the newest message when no turn
// has started) so the card is not left turnless. `turn` is that turn's number from the
// same read, or null when no numbered turn owns the snapshot.
function placementOf(session: any, projections: any): { anchorSeq: number | null; turn: number | null } {
	const state = anchorState(session, projections);
	if (state == null) return { anchorSeq: null, turn: null };
	return { anchorSeq: seqOf(state.turnStartSeq) ?? seqOf(state.messageSeq), turn: turnOf(state.turn) };
}

// The turn number in effect at `seq`: the latest numbered turn/start at or before it.
// No projection, no session, or no such start leaves it unset.
export function openTurnAt(projections: any, session: any, seq: unknown): number | undefined {
	if (seqOf(seq) === null) return undefined;
	const starts = anchorState(session, projections)?.starts;
	if (!Array.isArray(starts)) return undefined;
	let best = -1;
	let turn: number | undefined;
	for (const start of starts) {
		const at = seqOf(start?.seq);
		if (at === null || at > (seq as number) || at < best) continue;
		const next = turnOf(start.turn);
		if (next === null) continue;
		best = at;
		turn = next;
	}
	return turn;
}

export interface Snapshot {
	header: any;
	messages: any[];
	toolHistory: any;
	sessionId: string;
	atSeq: number | null;
	anchorSeq: number | null;
	turn: number | null;
}

// Header, derived history, tool history, and the session id, taken together.
export function snapshotOf(session: any, projections: any): Snapshot {
	const header = session.requestHeader();
	const messages = trimToolBoundary(session.deriveMessages());
	const toolHistory = session.toolHistory();
	const { anchorSeq, turn } = placementOf(session, projections);
	return { header, messages, toolHistory, sessionId: session.id, atSeq: committedSeq(session), anchorSeq, turn };
}

export interface AsideResult {
	text?: string;
	failed?: string;
	cutOff?: boolean;
	toolCalls?: boolean;
}

// The same route as the conversation, including temperature, stop, and the output
// budget: thinking shares it, so an aside must not set a small one of its own. The
// messages array is tagged for usage when the usage module is installed. `extra`
// messages sit between the snapshot and the prompt;
// pairs go there.
export async function callAside(
	ctx: any,
	rt: Runtime,
	snapshot: Snapshot,
	{
		extra = [],
		question,
		promptFor,
		kind,
		retry = false,
		signal,
	}: {
		extra?: any[];
		question: string;
		promptFor: (question: string, retry: boolean) => string;
		kind: string;
		retry?: boolean;
		signal: AbortSignal;
	},
): Promise<AsideResult> {
	const raw = [
		...snapshot.messages,
		...extra,
		{ role: "user", content: [{ type: "text", text: promptFor(question, retry) }] },
	];
	const messages = typeof rt.tagUsage === "function" ? rt.tagUsage(raw, { sessionId: snapshot.sessionId, kind }) : raw;
	const assembler = new BlockAssembler();
	const tools = snapshot.header?.tools;
	for await (const chunk of ctx.llm.stream({
		...snapshot.header?.config,
		messages,
		toolHistory: snapshot.toolHistory,
		...(tools ? { tools: [...tools] } : {}),
		sessionId: snapshot.sessionId,
		signal,
	}))
		assembler.push(chunk as never);
	const finish: any = assembler.finish;
	if (finish.kind === "error" || finish.kind === "aborted") {
		return { failed: finish.failure?.message ?? finish.kind };
	}
	const text = assembler
		.blocks()
		.filter((block: any) => block.type === "text")
		.map((block: any) => block.text)
		.join("\n")
		.trim();
	// Checked before a tool-call retry: a truncated tool call is not a request.
	if (finish.kind === "max-tokens") return { text, cutOff: true };
	const toolCalls =
		finish.kind === "tool-calls" || assembler.blocks().some((block: any) => block?.type === "tool-call");
	return { text, toolCalls };
}

// `groupError` is the refusal a group chat raises.
export function locatePrivate(rt: Runtime, raw: unknown, groupError: string): { sessionId: string; botId: string } {
	const past = rt.pastOwners.get(String(raw));
	const sessionId =
		rt.botOf(String(raw)) !== undefined
			? rt.chatOf(String(raw))
			: past && past.roomId === undefined && past.botId !== undefined
				? rt.chatOf(past.botId)
				: String(raw);
	const grouped =
		rt.roomOf(String(raw)) !== undefined ||
		rt.roomOf(sessionId) !== undefined ||
		rt.groupOwners.has(String(raw)) ||
		rt.groupOwners.has(sessionId) ||
		past?.roomId !== undefined;
	if (grouped) throw new Error(groupError);
	const botId = rt.chatOwners.get(sessionId) ?? rt.botOf(String(raw))?.id;
	if (botId === undefined || rt.botOf(botId) === undefined) throw new Error("Unknown Bot");
	return { sessionId, botId };
}

// One saved aside card.
export interface BtwCard {
	id: string;
	botId?: string;
	partId?: string;
	status?: string;
	error?: string;
	finishedAt?: number;
	[key: string]: unknown;
}

export function install(rt: Runtime): void {
	const { ctx, state } = rt;
	registerAnchor(ctx as any);
	const dropped = new Set<string>();

	// Cards by Bot and part. A part's list is read from
	// <home>/btw/<botId>/<partId>.json on first need and kept here; writes are
	// whole-file replaces, queued so two deletes never interleave. A runtime without
	// a home (a bare channel install) keeps cards in memory only.
	const cardsDir = typeof rt.home === "string" ? join(rt.home, "btw") : undefined;
	const partFile = (botId: string, partId: string): string => join(cardsDir as string, botId, `${partId}.json`);
	const partKey = (botId: string, partId: string): string => `${botId}/${partId}`;
	const writes = (): boolean => rt.readOnly?.() === undefined;
	const cards = new Map<string, Map<string, BtwCard[]>>();
	const reading = new Map<string, Promise<BtwCard[]>>();
	let writing: Promise<void> = Promise.resolve();
	let deleting: Promise<unknown> = Promise.resolve();

	const listOf = (botId: string, partId: string): BtwCard[] => cards.get(botId)?.get(partId) ?? [];

	const writePart = (botId: string, partId: string): Promise<void> => {
		const run = writing.then(async () => {
			if (cardsDir === undefined || !writes() || dropped.has(botId) || rt.botOf(botId) === undefined) return;
			const path = partFile(botId, partId);
			await mkdir(dirname(path), { recursive: true });
			const temp = `${path}.${process.pid}.tmp`;
			try {
				await writeFile(temp, JSON.stringify(cards.get(botId)?.get(partId) ?? [], null, 2), "utf8");
				await replaceFile(temp, path);
			} catch (error) {
				await unlink(temp).catch(() => {});
				throw error;
			}
		});
		writing = run.catch(() => {});
		return run;
	};

	// A part's list, reading its file once. The owning host records the restart a
	// previous process left behind: an 'answering' card could only have failed with
	// it, and the file is written again. A reading host keeps the cards as they were
	// saved.
	async function readPart(botId: string, partId: string): Promise<BtwCard[]> {
		const byBot = cards.get(botId) ?? new Map<string, BtwCard[]>();
		cards.set(botId, byBot);
		const held = byBot.get(partId);
		if (held !== undefined) return held;
		const key = partKey(botId, partId);
		const pending = reading.get(key);
		if (pending !== undefined) return pending;
		const job = (async (): Promise<BtwCard[]> => {
			let list: BtwCard[] = [];
			if (cardsDir === undefined) {
				byBot.set(partId, list);
				return list;
			}
			try {
				const parsed: unknown = JSON.parse(await readFile(partFile(botId, partId), "utf8"));
				if (Array.isArray(parsed)) {
					list = parsed
						.filter((card) => card !== null && typeof card === "object" && !Array.isArray(card))
						.map((card) => ({ ...(card as BtwCard), botId, partId }));
				}
			} catch (error) {
				const code = (error as { code?: string })?.code;
				if (code !== "ENOENT")
					rt.warn("ocean-crew: unreadable btw cards %s: %s", partFile(botId, partId), code ?? error);
			}
			if (writes()) {
				const now = Date.now();
				let touched = false;
				list = list.map((card) => {
					if (card.status !== "answering") return card;
					touched = true;
					return {
						...card,
						status: "failed",
						error: card.error ?? RESTART_ERROR,
						finishedAt: card.finishedAt ?? now,
					};
				});
				byBot.set(partId, list);
				if (touched)
					await writePart(botId, partId).catch((error) =>
						rt.warn("ocean-crew: btw cards of %s not saved: %s", botId, error),
					);
			} else {
				byBot.set(partId, list);
			}
			return byBot.get(partId) ?? list;
		})();
		reading.set(key, job);
		try {
			return await job;
		} finally {
			reading.delete(key);
		}
	}

	// Only each Bot's current part is read up front.

	const originalLoad = typeof rt.load === "function" ? rt.load.bind(rt) : undefined;
	if (originalLoad !== undefined) {
		let ready: Promise<void> | undefined;
		rt.load = () => {
			ready ??= (async () => {
				await originalLoad();
				for (const botId of Object.keys(state.bots)) await readPart(botId, rt.chatOf(botId));
			})();
			return ready;
		};
	}

	const originalRefresh = typeof rt.refresh === "function" ? rt.refresh.bind(rt) : undefined;
	if (originalRefresh !== undefined) {
		rt.refresh = async () => {
			const wasWriting = writes();
			await originalRefresh();
			// Taking over a team the other host closed makes this one the writer:
			// re-read the loaded parts so a leftover 'answering' is recorded now.
			if (wasWriting || !writes()) return;
			for (const [botId, byBot] of cards) {
				const parts = [...byBot.keys()];
				byBot.clear();
				for (const partId of parts) await readPart(botId, partId);
			}
		};
	}

	// The team view carries each Bot's current part only;
	// their history pages.
	const btwView = (): Record<string, BtwCard[]> => {
		const view: Record<string, BtwCard[]> = {};
		for (const botId of Object.keys(state.bots)) {
			const list = listOf(botId, rt.chatOf(botId));
			if (list.length > 0) view[botId] = list;
		}
		return view;
	};

	// Deleting a card removes only that saved aside. The whole read-modify-write is
	// queued so two cards deleted together cannot restore each other. A state save
	// afterwards bumps the revision, so every window polls the new lists.
	function btwDelete({ sessionId, cardId }: { sessionId: string; cardId: string }): Promise<{ deleted: boolean }> {
		const run = deleting.then(async (): Promise<{ deleted: boolean }> => {
			const { botId } = locatePrivate(rt, sessionId, "Side chat is only available in a Bot's private chat.");
			const list = await readPart(botId, sessionId);
			const next = list.filter((card) => card?.id !== cardId);
			if (next.length === list.length) return { deleted: false };
			const byBot = cards.get(botId) as Map<string, BtwCard[]>;
			byBot.set(sessionId, next);
			try {
				await writePart(botId, sessionId);
			} catch (error) {
				byBot.set(sessionId, list);
				throw error;
			}
			await rt.save();
			return { deleted: true };
		});
		deleting = run.catch(() => {});
		return run;
	}

	// Plugin unload; queued deletes and their file writes have to finish.
	async function btwDispose(): Promise<void> {
		await deleting;
		await writing;
	}

	// Clears the Bot's cards before the roster save.
	async function dropBot(botId: string): Promise<void> {
		dropped.add(botId);
		cards.delete(botId);
		for (const key of reading.keys()) if (key.startsWith(`${botId}/`)) reading.delete(key);
		if (cardsDir !== undefined && writes() && typeof rm === "function") {
			await rm(join(cardsDir, botId), { recursive: true, force: true }).catch((error) =>
				rt.warn("ocean-crew: btw cards of %s not removed: %s", botId, error),
			);
		}
	}

	// Channel can be installed without the roster (the thinking route test). The full
	// runtime always has deleteBot, and that is the path that must drop cards.
	if (typeof rt.deleteBot === "function") {
		const originalDelete = rt.deleteBot.bind(rt);
		rt.deleteBot = async (id: string) => {
			if (rt.botOf(id) !== undefined && !rt.isMain(id)) await dropBot(id);
			return originalDelete(id);
		};
	}

	Object.assign(rt, {
		btwDelete,
		btwDispose,
		btwView,
		btwPartCards: readPart,
	});
}

// A card id for a new aside; the ask path is gone, but tests and older cards use it.
export const newCardId = (): string => randomUUID();
