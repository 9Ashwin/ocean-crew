// Side chats: questions answered from a fresh snapshot of a Bot's private chat, shown
// in the Bot's side panel. A follow-up carries the chat's finished pairs on top of a new
// snapshot, so the route sees a short conversation. Nothing is written into the Session,
// and no tool call is ever dispatched. A Bot's chats live in one file
// (<home>/side/<botId>.json), not in state.json; only the host that owns the team
// writes them.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ASIDE_LIMIT } from "../core/constants.ts";
import { replaceFile } from "../core/files.ts";
import type { Runtime } from "../core/runtime.ts";
import type { Snapshot } from "./btw.ts";
import { callAside, EMPTY_ERROR, locatePrivate, RESTART_ERROR, snapshotOf, TOOL_ERROR } from "./btw.ts";

// The mock model recognizes a side question by this first line.
export const SIDE_MARKER = "ocean-crew/side";

const SIDE_PROMPT = [
	SIDE_MARKER,
	"Answer from the conversation so far, based on progress up to this snapshot, and from this side chat.",
	"Do not call any tool.",
	"If the answer needs information that is not in the conversation, say so.",
	"Never claim to have done anything.",
].join("\n");
const SIDE_RETRY = "Do not call any tool. Answer in text only.";
const GROUP_REFUSAL = "Side chat is only available in a Bot's private chat.";
const BUSY_ERROR = "Wait for the answer, or cancel it.";
const CHAT_ERROR = "This side chat is no longer here.";
const ENTRY_ERROR = "This side question is no longer here.";

const promptFor = (question: string, retry: boolean): string =>
	[SIDE_PROMPT, ...(retry ? [SIDE_RETRY] : []), question].join("\n\n");

// A side chat's question and answer.
export interface SideEntry {
	id: string;
	question: string;
	answer: string;
	status: string;
	error?: string;
	finish?: string;
	createdAt?: number;
	finishedAt?: number;
}

export interface SideChat {
	id: string;
	botId?: string;
	createdAt?: number;
	updatedAt?: number;
	entries: SideEntry[];
	[key: string]: unknown;
}

// The assistant
// pair carries the route tag a model-produced message needs — the assembler reads
// `source` on every assistant message.
const pairsOf = (chat: SideChat, entry: SideEntry, route: any): any[] =>
	(chat.entries ?? [])
		.filter((other) => other !== entry && other?.status === "done")
		.flatMap((other) => [
			{ role: "user", content: [{ type: "text", text: other.question }] },
			{
				role: "assistant",
				content: [{ type: "text", text: other.answer }],
				source: { kind: "model", provider: route?.provider, model: route?.model },
			},
		]);

const answering = (chat: SideChat | undefined): boolean =>
	(chat?.entries ?? []).some((entry) => entry?.status === "answering");

export function install(rt: Runtime): void {
	const { ctx, state } = rt;
	const flights = new Map<string, { botId: string; controller: AbortController; done?: Promise<void> }>();
	const byBot = new Map<string, Set<string>>();
	// Set before abort, so a call that settles in the abort turn cannot save.
	let disposing = false;
	const dropped = new Set<string>();
	const creating = new Map<string, SideChat>();

	const track = (id: string, botId: string, controller: AbortController): void => {
		flights.set(id, { botId, controller });
		const ids = byBot.get(botId) ?? new Set<string>();
		ids.add(id);
		byBot.set(botId, ids);
	};
	const untrack = (id: string): void => {
		const flight = flights.get(id);
		if (flight === undefined) return;
		flights.delete(id);
		const ids = byBot.get(flight.botId);
		ids?.delete(id);
		if (ids?.size === 0) byBot.delete(flight.botId);
	};

	// All of a Bot's chats in one list. It is read from <home>/side/<botId>.json on
	// first need and kept here; writes are whole-file replaces, queued so a finish and
	// a cancel never interleave. A runtime without a home keeps chats in memory only.
	const sideDir = typeof rt.home === "string" ? join(rt.home, "side") : undefined;
	const botFile = (botId: string): string => join(sideDir as string, `${botId}.json`);
	const writes = (): boolean => rt.readOnly?.() === undefined;
	const chats = new Map<string, SideChat[]>();
	const reading = new Map<string, Promise<SideChat[]>>();
	let writing: Promise<void> = Promise.resolve();

	const writeBot = (botId: string): Promise<void> => {
		const run = writing.then(async () => {
			if (sideDir === undefined || !writes() || dropped.has(botId) || rt.botOf(botId) === undefined) return;
			const path = botFile(botId);
			await mkdir(sideDir as string, { recursive: true });
			const temp = `${path}.${process.pid}.tmp`;
			try {
				await writeFile(temp, JSON.stringify(chats.get(botId) ?? [], null, 2), "utf8");
				await replaceFile(temp, path);
			} catch (error) {
				await unlink(temp).catch(() => {});
				throw error;
			}
		});
		writing = run.catch(() => {});
		return run;
	};

	// A chat event rewrites its Bot's file; the state save afterwards only bumps the
	// revision, so a window polls fresh chats.
	const persist = async (botId: string): Promise<void> => {
		await writeBot(botId).catch((error) => rt.warn("ocean-crew: side chats of %s not saved: %s", botId, error));
		await rt.save();
	};

	// A Bot's chat list, reading its file once. The owning host records the restart a
	// previous process left behind: an 'answering' entry that is not one of this
	// process's flights failed with it, and the file is written again. A reading host
	// keeps the chats as they were saved.
	async function readBot(botId: string): Promise<SideChat[]> {
		const held = chats.get(botId);
		if (held !== undefined) return held;
		const pending = reading.get(botId);
		if (pending !== undefined) return pending;
		const job = (async (): Promise<SideChat[]> => {
			let list: SideChat[] = [];
			if (sideDir !== undefined) {
				try {
					const parsed: unknown = JSON.parse(await readFile(botFile(botId), "utf8"));
					if (Array.isArray(parsed)) {
						list = parsed.filter(
							(chat) => chat !== null && typeof chat === "object" && !Array.isArray(chat),
						) as SideChat[];
					}
				} catch (error) {
					const code = (error as { code?: string })?.code;
					if (code !== "ENOENT")
						rt.warn("ocean-crew: unreadable side chats %s: %s", botFile(botId), code ?? error);
				}
			}
			for (const chat of list) if (!Array.isArray(chat.entries)) chat.entries = [];
			if (writes()) {
				const now = Date.now();
				let touched = false;
				for (const chat of list) {
					for (const entry of chat.entries) {
						if (entry?.status !== "answering" || flights.has(entry.id)) continue;
						entry.status = "failed";
						entry.error = entry.error ?? RESTART_ERROR;
						entry.finishedAt = entry.finishedAt ?? now;
						touched = true;
					}
				}
				chats.set(botId, list);
				if (touched)
					await writeBot(botId).catch((error) =>
						rt.warn("ocean-crew: side chats of %s not saved: %s", botId, error),
					);
			} else {
				chats.set(botId, list);
			}
			return chats.get(botId) ?? list;
		})();
		reading.set(botId, job);
		try {
			return await job;
		} finally {
			reading.delete(botId);
		}
	}

	const originalLoad = typeof rt.load === "function" ? rt.load.bind(rt) : undefined;
	if (originalLoad !== undefined) {
		let ready: Promise<void> | undefined;
		rt.load = () => {
			ready ??= (async () => {
				await originalLoad();
				for (const botId of Object.keys(state.bots)) await readBot(botId);
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
			// re-read the loaded Bots so a leftover 'answering' is recorded now.
			if (wasWriting || !writes()) return;
			for (const botId of [...chats.keys()]) {
				chats.delete(botId);
				await readBot(botId);
			}
		};
	}

	// The team view carries every Bot's chats, sorted by creation.
	const sideView = (): Record<string, SideChat[]> => {
		const view: Record<string, SideChat[]> = {};
		for (const botId of Object.keys(state.bots)) {
			const list = chats.get(botId) ?? [];
			if (list.length > 0) view[botId] = [...list].sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0));
		}
		return view;
	};

	const abandoned = (botId: string): boolean => disposing || dropped.has(botId) || rt.botOf(botId) === undefined;
	const stopError = (botId: string): Error =>
		new Error(
			disposing && !dropped.has(botId) && rt.botOf(botId) !== undefined ? "Ocean Crew is stopping." : "Unknown Bot",
		);

	// Wait until every targeted flight has left. A call still inside resolveAgent has
	// no `done` yet; yielding lets it notice disposal and drop the slot.
	async function drain(ids?: string[]): Promise<void> {
		const left = (): string[] => (ids === undefined ? [...flights.keys()] : ids.filter((id) => flights.has(id)));
		for (;;) {
			const idsLeft = left();
			if (idsLeft.length === 0) return;
			const waiting = idsLeft.map((id) => flights.get(id)?.done).filter(Boolean) as Promise<void>[];
			if (waiting.length > 0) {
				await Promise.allSettled(waiting);
				continue;
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			});
		}
	}

	// The entry is gone when its Bot was deleted, this host is unloading, or the chat
	// itself was closed.
	function alive(botId: string, chat: SideChat, entry: SideEntry): boolean {
		if (disposing || dropped.has(botId)) return false;
		if (rt.botOf(botId) === undefined) return false;
		const list = chats.get(botId);
		return list?.includes(chat) === true && (chat.entries ?? []).includes(entry);
	}

	// Only the first writer wins. Cancel sets 'cancelled' before it aborts.
	function settle(botId: string, chat: SideChat, entry: SideEntry, patch: Partial<SideEntry>): boolean {
		if (entry.status !== "answering" || !alive(botId, chat, entry)) return false;
		Object.assign(entry, patch, { finishedAt: Date.now() });
		chat.updatedAt = entry.finishedAt;
		return true;
	}

	async function complete(
		botId: string,
		chat: SideChat,
		entry: SideEntry,
		snapshot: Snapshot,
		signal: AbortSignal,
	): Promise<void> {
		const extra = pairsOf(chat, entry, snapshot.header?.config);
		try {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				if (signal.aborted || entry.status !== "answering" || !alive(botId, chat, entry)) return;
				const result = await callAside(ctx as any, rt, snapshot, {
					extra,
					question: entry.question,
					promptFor,
					kind: "side",
					retry: attempt === 1,
					signal,
				});
				if (signal.aborted || entry.status !== "answering" || !alive(botId, chat, entry)) return;
				if (result.failed !== undefined) {
					// Cancel already left this entry, and the check above returned. A provider
					// that stops on its own still fails it, so it does not stay 'answering'.
					if (settle(botId, chat, entry, { status: "failed", error: result.failed, answer: "" }))
						await persist(botId);
					return;
				}
				if (result.cutOff) {
					const answer = result.text ?? "";
					if (settle(botId, chat, entry, { status: "failed", error: ASIDE_LIMIT, answer, finish: "max-tokens" }))
						await persist(botId);
					return;
				}
				if (result.toolCalls) {
					if (attempt === 0) continue;
					if (settle(botId, chat, entry, { status: "failed", error: TOOL_ERROR, answer: "" }))
						await persist(botId);
					return;
				}
				if ((result.text ?? "") === "") {
					if (settle(botId, chat, entry, { status: "failed", error: EMPTY_ERROR, answer: "" }))
						await persist(botId);
					return;
				}
				if (settle(botId, chat, entry, { status: "done", answer: result.text })) await persist(botId);
				return;
			}
		} catch (error) {
			if (signal.aborted || entry.status !== "answering" || !alive(botId, chat, entry)) return;
			const message = (error as Error)?.message ?? String(error);
			rt.warn("ocean-crew: side for %s failed: %s", botId, message);
			if (settle(botId, chat, entry, { status: "failed", error: message, answer: "" })) await persist(botId);
		}
	}

	const newChat = (botId: string): SideChat => ({
		id: randomUUID(),
		botId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		entries: [],
	});

	async function sideNew({ sessionId: raw }: { sessionId: string }): Promise<{ chatId: string }> {
		const { botId } = locatePrivate(rt, raw, GROUP_REFUSAL);
		const list = await readBot(botId);
		const chat = newChat(botId);
		list.push(chat);
		await persist(botId);
		return { chatId: chat.id };
	}

	async function sideAsk({
		sessionId: raw,
		chatId,
		recent,
		text,
	}: {
		sessionId: string;
		chatId?: string;
		recent?: boolean;
		text?: string;
	}): Promise<{ chatId: string; entryId: string }> {
		const question = typeof text === "string" ? text : "";
		if (question.trim() === "") throw Object.assign(new Error("Write a question."), { code: "bot/invalid" });
		const { sessionId, botId } = locatePrivate(rt, raw, GROUP_REFUSAL);
		const list = await readBot(botId);
		let chat: SideChat | undefined;
		if (typeof chatId === "string" && chatId !== "") {
			chat = list.find((item) => item.id === chatId);
			if (chat === undefined) throw new Error(CHAT_ERROR);
			if (answering(chat)) throw new Error(BUSY_ERROR);
		} else if (recent === true) {
			// `/side` reuses the freshest chat whose last entry is not still answering.
			chat = [...list]
				.filter((item) => item.entries?.at(-1)?.status !== "answering")
				.sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0];
		}
		const id = randomUUID();
		const controller = new AbortController();
		track(id, botId, controller);
		let started = false;
		let created = false;
		try {
			const agent = await rt.resolveAgent(sessionId);
			if (abandoned(botId)) throw stopError(botId);
			const snapshot = snapshotOf(agent.session, (ctx as any).get?.("sessionProjections"));
			const route = snapshot.header?.config;
			if (!route?.provider || !route?.model)
				throw new Error("This Bot has not called a model yet. Send a normal message first.");
			if (chat === undefined) {
				chat = newChat(botId);
				list.push(chat);
				creating.set(chat.id, chat);
				created = true;
			}
			// `recent` only skips an answering last entry; a stale answering entry
			// anywhere else still holds the chat for one question at a time.
			if (answering(chat)) throw new Error(BUSY_ERROR);
			const entry: SideEntry = { id, question, answer: "", status: "answering", createdAt: Date.now() };
			chat.entries.push(entry);
			chat.updatedAt = entry.createdAt;
			await persist(botId);
			// Unload keeps the saved entry for the next owner. Deletion already removed it.
			if (abandoned(botId) || !alive(botId, chat, entry)) {
				if (disposing && !dropped.has(botId) && alive(botId, chat, entry)) return { chatId: chat.id, entryId: id };
				throw new Error("Unknown Bot");
			}
			const done = complete(botId, chat, entry, snapshot, controller.signal).finally(() => untrack(id));
			const flight = flights.get(id);
			if (flight !== undefined) flight.done = done;
			started = true;
			return { chatId: chat.id as string, entryId: id };
		} catch (error) {
			if (chat !== undefined && (chat.entries ?? []).some((entry) => entry?.id === id)) {
				chat.entries = chat.entries.filter((entry) => entry?.id !== id);
				if (created && chat.entries.length === 0) {
					const index = list.indexOf(chat);
					if (index !== -1) list.splice(index, 1);
				}
				await writeBot(botId).catch(() => {});
			}
			throw error;
		} finally {
			if (!started) untrack(id);
			if (chat !== undefined) creating.delete(chat.id);
		}
	}

	async function sideCancel({
		chatId,
		entryId,
	}: {
		chatId: string;
		entryId: string;
	}): Promise<{ answering: boolean }> {
		for (const [botId, list] of chats) {
			const chat = list.find((item) => item?.id === chatId);
			if (chat === undefined) continue;
			const entry = (chat.entries ?? []).find((item) => item?.id === entryId);
			if (entry === undefined) throw new Error(ENTRY_ERROR);
			if (entry.status !== "answering") return { answering: false };
			entry.status = "cancelled";
			entry.finishedAt = Date.now();
			chat.updatedAt = entry.finishedAt;
			flights.get(entryId)?.controller.abort();
			await persist(botId);
			return { answering: true };
		}
		throw new Error(CHAT_ERROR);
	}

	// Closing a chat drops it whole: any call in it aborts, then the chat leaves the
	// file. A chat another host already removed is a no-op.
	async function sideClose({ chatId }: { chatId: string }): Promise<Record<string, never>> {
		for (const [botId, list] of chats) {
			const index = list.findIndex((item) => item?.id === chatId);
			if (index === -1) continue;
			const chat = list[index];
			const ids = (chat.entries ?? []).filter((entry) => entry?.status === "answering").map((entry) => entry.id);
			for (const id of ids) flights.get(id)?.controller.abort();
			await drain(ids);
			const current = chats.get(botId);
			if (current?.includes(chat) === true) {
				chats.set(
					botId,
					current.filter((item) => item !== chat),
				);
				await persist(botId);
			}
			return {};
		}
		return {};
	}

	// Plugin unload. The entry stays 'answering'; the next owning host records the restart.
	async function sideDispose(): Promise<void> {
		disposing = true;
		for (const flight of flights.values()) flight.controller.abort();
		await drain();
		await writing;
	}

	// Clears the Bot's chats before the roster save, and waits out calls that would
	// otherwise finish into the deleted team.
	async function dropBot(botId: string): Promise<void> {
		dropped.add(botId);
		chats.delete(botId);
		reading.delete(botId);
		const ids = [...(byBot.get(botId) ?? [])];
		for (const id of ids) flights.get(id)?.controller.abort();
		await drain(ids);
		if (sideDir !== undefined && writes()) {
			await rm(botFile(botId), { force: true }).catch((error) =>
				rt.warn("ocean-crew: side chats of %s not removed: %s", botId, error),
			);
		}
	}

	// Channel can be installed without the roster (the thinking route test). The full
	// runtime always has deleteBot, and that is the path that must drop chats.
	if (typeof rt.deleteBot === "function") {
		const originalDelete = rt.deleteBot.bind(rt);
		rt.deleteBot = async (id: string) => {
			if (rt.botOf(id) !== undefined && !rt.isMain(id)) await dropBot(id);
			return originalDelete(id);
		};
	}

	const sideJoin = (id: string): Promise<void> => flights.get(id)?.done ?? Promise.resolve();

	Object.assign(rt, { sideNew, sideAsk, sideCancel, sideClose, sideJoin, sideDispose, sideView });
}
