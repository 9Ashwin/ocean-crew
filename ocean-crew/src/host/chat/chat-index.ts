// Reading a Bot's own chat: Session history pages, the SQLite FTS5 index, and the
// search, latest, and around reads behind read_own_chat.
//
// Chat index. read_own_chat searches a SQLite FTS5 table of every part of a Bot's own
// chat, ranked by BM25. The trigram tokenizer matches any run of three or more
// characters, so Chinese needs no word splitting; shorter words fall back to LIKE.
// The index is derived from the Session logs: a part catches up when it is read, an
// ended part is sealed once it is complete, and deleting the file only costs a
// rebuild. Without SQLite, read_own_chat scans the logs as before.
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	ANCHOR_LINE_MAX,
	HISTORY_PAGE,
	HISTORY_PAGES_MAX,
	HISTORY_TIMEOUT_MS,
	OWN_CHAT_BRIEF,
	OWN_CHAT_LINE_MAX,
	OWN_CHAT_READ,
	OWN_CHAT_SEARCH,
} from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";
import { excerpt } from "../core/text.ts";

const INDEX_VERSION = 3;
const AROUND_LINES = 6;
const SEARCH_TERMS_MAX = 6;
const ANY_TERM_HITS = 50;
const INDEX_TIMEOUT_MS = 120_000;
// A part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000;

const likeOf = (term: string): string => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** One FTS5 statement and the arguments bound into it. */
export interface TermQuery {
	sql: string;
	args: unknown[];
}

/** Where the turn that asks starts, so its own question does not match itself. */
export interface HiddenTurn {
	session: string;
	from: number;
}

// Each term is a quoted FTS5 phrase when trigrams can match it, else a LIKE filter.
export function termQuery(
	terms: readonly string[],
	sessions: readonly string[],
	limit: number,
	hidden?: HiddenTurn,
): TermQuery {
	const long = terms.filter((term) => [...term].length >= 3);
	const short = terms.filter((term) => [...term].length < 3);
	const where: string[] = ["session IN (SELECT value FROM json_each(?))"];
	const args: unknown[] = [JSON.stringify(sessions)];
	if (hidden !== undefined) {
		where.push("NOT (session = ? AND seq >= ?)");
		args.push(hidden.session, hidden.from);
	}
	if (long.length > 0) {
		where.unshift("lines MATCH ?");
		args.unshift(long.map((term) => `"${term.replace(/"/g, '""')}"`).join(" "));
	}
	for (const term of short) {
		where.push("text LIKE ? ESCAPE '\\'");
		args.push(likeOf(term));
	}
	return {
		sql: `SELECT text, session, seq, time, who FROM lines WHERE ${where.join(" AND ")} ORDER BY ${
			long.length > 0 ? "rank" : "time DESC"
		} LIMIT ${limit}`,
		args,
	};
}

/** One message a Session kept, as the reader and the index need it. */
export interface SessionEvent {
	type?: string;
	seq: number;
	time?: number;
	data?: unknown;
	[key: string]: unknown;
}

/** One part of a Bot's own chat. */
interface PartLike {
	sessionId: string;
	number: number;
	startedAt?: number;
	endedAt?: number;
}

/** One line the log scanner found. */
interface LogLine {
	text: string;
	time?: number;
}

/** What one event means for the Bot's own chat, as the parts module decides it. */
interface HistoryEntry {
	answer?: boolean;
	who?: string;
	text: string;
	keepAnswers?: boolean;
}

interface SessionPageRequest {
	address: { kind: "session"; sessionId: string };
	throughSeq: number;
	beforeSeq?: number;
	maxMessages: number;
}

interface SessionPage {
	records: { event: SessionEvent }[];
	hasMore: boolean;
}

interface SessionControllerService {
	page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>;
}

/** One indexed line as the queries return it. */
interface SearchRow {
	text: string;
	session: string;
	seq: number;
	time: number;
	who: string;
}

interface Mark {
	through: number;
	keep: number;
	sealed: number;
	turn: number;
}

// The optional native SQLite module, as this module reads it. It is loaded at run time:
// the host must keep working on a Node build without `node:sqlite`, and rebuilding the
// index from the logs is what that build gets instead.
interface SqliteStatement {
	run(...args: unknown[]): unknown;
	get(...args: unknown[]): Record<string, unknown> | undefined;
	all(...args: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface DatabaseSyncConstructor {
	new (path: string): SqliteDatabase;
}

interface ChatIndex {
	db: SqliteDatabase;
	mark: SqliteStatement;
	setMark: SqliteStatement;
	insert: SqliteStatement;
	before: SqliteStatement;
	from: SqliteStatement;
}

export function install(rt: Runtime): void {
	const { ctx, home } = rt;
	const controller = (): SessionControllerService => ctx.sessionController as unknown as SessionControllerService;
	const partLines = (sessionId: string, signal: AbortSignal): AsyncIterable<LogLine> =>
		rt.partLines(sessionId, signal) as AsyncIterable<LogLine>;

	const indexPath = join(home, "chat-index.sqlite");
	let chatIndex: ChatIndex | undefined;
	let indexOpening: Promise<ChatIndex | null> | undefined;

	// A Session's events from newest to oldest, also for an archived part.
	async function* eventsBackwards(
		sessionId: string,
		signal: AbortSignal,
		maxPages = HISTORY_PAGES_MAX,
	): AsyncGenerator<SessionEvent> {
		const agent = (await rt.resolveAgent(sessionId)) as { session?: { seq?: unknown } };
		const throughSeq = Number(agent.session?.seq) - 1;
		let beforeSeq: number | undefined;
		for (let pages = 0; throughSeq >= 0 && pages < maxPages; pages += 1) {
			const page = await controller().page(
				{
					address: { kind: "session", sessionId },
					throughSeq,
					...(beforeSeq === undefined ? {} : { beforeSeq }),
					maxMessages: HISTORY_PAGE,
				},
				signal,
			);
			const events = page.records.map((record) => record.event);
			for (let index = events.length - 1; index >= 0; index -= 1) yield events[index];
			if (!page.hasMore || events.length === 0) return;
			beforeSeq = events[0].seq;
		}
	}

	function createIndex(db: SqliteDatabase): ChatIndex {
		try {
			db.exec("PRAGMA journal_mode = WAL");
			const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
			if (version !== INDEX_VERSION) {
				db.exec(`
          DROP TABLE IF EXISTS lines;
          DROP TABLE IF EXISTS marks;
          CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, tokenize = 'trigram');
          CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);
          PRAGMA user_version = ${INDEX_VERSION};`);
			}
			return {
				db,
				mark: db.prepare("SELECT through, keep, sealed, turn FROM marks WHERE session = ?"),
				setMark: db.prepare(
					"INSERT OR REPLACE INTO marks (session, through, keep, sealed, turn) VALUES (?, ?, ?, ?, ?)",
				),
				insert: db.prepare("INSERT INTO lines (text, session, seq, time, who) VALUES (?, ?, ?, ?, ?)"),
				before: db.prepare(
					"SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
				),
				from: db.prepare(
					"SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?",
				),
			};
		} catch (error) {
			db.close();
			throw error;
		}
	}

	function openIndex(): Promise<ChatIndex | null> {
		if (chatIndex !== undefined) return Promise.resolve(chatIndex);
		if (indexOpening !== undefined) return indexOpening;
		const opening = (async (): Promise<ChatIndex | null> => {
			let DatabaseSync: DatabaseSyncConstructor;
			try {
				// Loaded at run time on purpose: `node:sqlite` is an optional native module,
				// and a host without it must still load and scan the logs (see the file head).
				({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: DatabaseSyncConstructor });
				await mkdir(home, { recursive: true });
			} catch (error) {
				rt.warn("ocean-crew: no chat index, read_own_chat scans the logs: %s", error);
				return null;
			}
			// A damaged file is rebuilt from the logs once.
			for (const fresh of [false, true]) {
				try {
					if (fresh) await unlink(indexPath).catch(() => undefined);
					return createIndex(new DatabaseSync(indexPath));
				} catch (error) {
					if (fresh) rt.warn("ocean-crew: no chat index, read_own_chat scans the logs: %s", error);
				}
			}
			return null;
		})();
		let tracked: Promise<ChatIndex | null> | undefined;
		tracked = opening.then((index) => {
			// The plugin may have been disposed while the file opened.
			if (indexOpening !== tracked) {
				index?.db.close();
				return null;
			}
			chatIndex = index ?? undefined;
			return index;
		});
		indexOpening = tracked;
		return tracked;
	}

	ctx.effect(
		() => () => {
			chatIndex?.db.close();
			chatIndex = undefined;
			indexOpening = undefined;
		},
		"ocean-crew: chat index",
	);

	// Adds what a part said since its mark. Reads of one part wait for each other, so no
	// line is added twice.
	const catchingUp = new Map<string, Promise<void>>();
	function catchUp(index: ChatIndex, part: PartLike): Promise<void> {
		const running = catchingUp.get(part.sessionId);
		if (running !== undefined) return running;
		const job = (async () => {
			const mark = index.mark.get(part.sessionId) as Mark | undefined;
			if (mark?.sealed) return;
			const through = mark?.through ?? -1;
			const events: SessionEvent[] = [];
			for await (const event of eventsBackwards(part.sessionId, AbortSignal.timeout(INDEX_TIMEOUT_MS), Infinity)) {
				if (event.seq <= through) break;
				events.push(event);
			}
			if (events.length > 0 && events[events.length - 1].seq !== through + 1)
				throw new Error(`the history of ${part.sessionId} came back with a gap`);
			events.reverse();
			if (index !== chatIndex) return;
			let keep = mark ? mark.keep === 1 : false;
			let turn = mark?.turn ?? -1;
			const seal = part.endedAt !== undefined && Date.now() - part.endedAt > SEAL_AFTER_MS;
			index.db.exec("BEGIN");
			try {
				let last = through;
				for (const event of events) {
					last = event.seq;
					if (event.type === "turn/start") turn = event.seq;
					const entry = rt.historyEntry(event, false) as HistoryEntry | undefined;
					if (entry === undefined) continue;
					if (entry.answer === true) {
						if (keep) index.insert.run(entry.text, part.sessionId, event.seq, event.time ?? 0, "you");
						continue;
					}
					keep = entry.keepAnswers === true;
					if (entry.text !== "")
						index.insert.run(entry.text, part.sessionId, event.seq, event.time ?? 0, entry.who ?? "");
				}
				index.setMark.run(part.sessionId, last, keep ? 1 : 0, seal ? 1 : 0, turn);
				index.db.exec("COMMIT");
			} catch (error) {
				index.db.exec("ROLLBACK");
				throw error;
			}
		})().finally(() => catchingUp.delete(part.sessionId));
		catchingUp.set(part.sessionId, job);
		return job;
	}

	// A message's anchor: its part (once there are several) and its seq in that part.
	const anchorOf = (parts: readonly PartLike[], row: SearchRow): string => {
		const part = parts.find((item) => item.sessionId === row.session);
		return `${parts.length > 1 ? `part ${part?.number ?? "?"} ` : ""}#${row.seq}`;
	};
	const rowLine = (
		parts: readonly PartLike[],
		row: SearchRow,
		terms: readonly string[] = [],
		max = OWN_CHAT_LINE_MAX,
	): string => {
		const lower = row.text.toLowerCase();
		const wanted = terms.find((term) => lower.includes(term)) ?? "";
		const text = row.who === "user" ? `User: ${row.text}` : row.who === "you" ? `You: ${row.text}` : row.text;
		return `[${anchorOf(parts, row)} · ${rt.clock(row.time)}] ${excerpt(text, wanted, max)}`;
	};

	// Every part, caught up. Asked from the current part, the turn that asks is left out
	// (`hidden`): it is in context, and its own question would match.
	async function indexedParts(
		botId: string,
		askingId?: string,
	): Promise<{ index: ChatIndex | null; parts: PartLike[]; hidden?: HiddenTurn }> {
		const index = await openIndex();
		if (index === null) return { index, parts: [] };
		const parts = rt.partsOf(botId) as PartLike[];
		// A part that cannot be read now is searched as far as it was indexed.
		for (const part of parts)
			await catchUp(index, part).catch((error: unknown) =>
				rt.warn("ocean-crew: indexing %s failed: %s", part.sessionId, error),
			);
		const turn =
			askingId !== undefined && askingId === parts.at(-1)?.sessionId
				? (index.mark.get(askingId) as Mark | undefined)?.turn
				: undefined;
		return {
			index,
			parts,
			hidden: turn === undefined || turn < 0 ? undefined : { session: askingId as string, from: turn },
		};
	}

	// Messages with all the words, best first; with none of them having all, those with
	// the most of them. Shown oldest first.
	async function searchOwnChat(
		botId: string,
		query: string,
		{ askingId, limit = OWN_CHAT_SEARCH }: { askingId?: string; limit?: number } = {},
	): Promise<{ lines: string[]; every: boolean }> {
		const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX);
		const { index, parts, hidden } = await indexedParts(botId, askingId);
		if (index === null) return { lines: await scanOwnChat(botId, query, limit), every: true };
		const sessions = parts.map((part) => part.sessionId);
		const run = (wanted: readonly string[], max: number): SearchRow[] => {
			const { sql, args } = termQuery(wanted, sessions, max, hidden);
			return index.db.prepare(sql).all(...args) as unknown as SearchRow[];
		};
		const byTime = (a: SearchRow, b: SearchRow): number =>
			a.time - b.time || sessions.indexOf(a.session) - sessions.indexOf(b.session) || a.seq - b.seq;
		let rows = run(terms, limit);
		let every = true;
		if (rows.length === 0 && terms.length > 1) {
			every = false;
			const found = new Map<string, { row: SearchRow; count: number }>();
			for (const term of terms) {
				for (const row of run([term], ANY_TERM_HITS)) {
					const key = `${row.session}#${row.seq}`;
					const hit = found.get(key) ?? { row, count: 0 };
					hit.count += 1;
					found.set(key, hit);
				}
			}
			rows = [...found.values()]
				.sort((a, b) => b.count - a.count || b.row.time - a.row.time)
				.slice(0, limit)
				.map((hit) => hit.row);
		}
		return { lines: rows.sort(byTime).map((row) => rowLine(parts, row, terms)), every };
	}

	// The latest messages across all parts, oldest first.
	async function latestOwnChat(
		botId: string,
		{ askingId, limit = OWN_CHAT_READ }: { askingId?: string; limit?: number } = {},
	): Promise<string[]> {
		const { index, parts, hidden } = await indexedParts(botId, askingId);
		if (index === null) return scanOwnChat(botId, "", limit);
		const rows: SearchRow[] = [];
		for (const part of [...parts].reverse()) {
			const below = hidden?.session === part.sessionId ? hidden.from : Number.MAX_SAFE_INTEGER;
			rows.push(...(index.before.all(part.sessionId, below, limit - rows.length) as unknown as SearchRow[]));
			if (rows.length >= limit) break;
		}
		return rows.reverse().map((row) => rowLine(parts, row));
	}

	// The messages around an anchor, in its part.
	async function aroundOwnChat(
		botId: string,
		anchor: string,
	): Promise<{ error?: string; part?: PartLike; exact?: boolean; lines?: string[] }> {
		const { index, parts } = await indexedParts(botId);
		if (index === null)
			return { error: "Anchors need the chat index, which is unavailable here. Search with words instead." };
		const found = /(?:part\s*)?(\d+)?\s*#\s*(\d+)/i.exec(anchor);
		if (found === null)
			return {
				error: `"${anchor}" is not an anchor. Anchors look like "part 2 #1234", or "#1234" in the current part.`,
			};
		const number = found[1] === undefined ? parts.length : Number(found[1]);
		const part = parts[number - 1];
		if (part === undefined) return { error: `Your own chat has no part ${number}.` };
		const seq = Number(found[2]);
		const rows = [
			...(index.before.all(part.sessionId, seq, AROUND_LINES) as unknown as SearchRow[]).reverse(),
			...(index.from.all(part.sessionId, seq, AROUND_LINES + 1) as unknown as SearchRow[]),
		];
		return {
			part,
			exact: rows.some((row) => row.seq === seq),
			lines: rows.map((row) => rowLine(parts, row, [], row.seq === seq ? ANCHOR_LINE_MAX : OWN_CHAT_LINE_MAX)),
		};
	}

	// Without the index: what the user, other Bots, and the Bot itself said, across all
	// parts, oldest first, by reading the logs.
	async function scanOwnChat(botId: string, query: string, limit: number): Promise<string[]> {
		const wanted = query.toLowerCase();
		const parts = rt.partsOf(botId) as PartLike[];
		const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS);
		const lines: string[] = [];
		for (const part of [...parts].reverse()) {
			for await (const line of partLines(part.sessionId, signal)) {
				if (wanted !== "" && !line.text.toLowerCase().includes(wanted)) continue;
				lines.push(
					`[${parts.length > 1 ? `part ${part.number} · ` : ""}${rt.clock(line.time)}] ${excerpt(line.text, wanted)}`,
				);
				if (lines.length >= limit) break;
			}
			if (lines.length >= limit) break;
		}
		return lines.reverse();
	}

	// The parts of a Bot's own chat, for the model: when each ran.
	const partIndex = (parts: readonly PartLike[]): string =>
		parts
			.map(
				(part) =>
					`part ${part.number} (${rt.clock(part.startedAt)} – ${part.endedAt === undefined ? "now" : rt.clock(part.endedAt)})`,
			)
			.join(", ");

	async function ownChatBrief(member: { id: string; name?: string }): Promise<string> {
		let lines: string[] = [];
		try {
			lines = await latestOwnChat(member.id, { limit: OWN_CHAT_BRIEF });
		} catch (error) {
			rt.warn("ocean-crew: brief for %s failed: %s", member.name, error);
		}
		return [
			"Your own chat with the user so far (latest messages, oldest first; private, so share only what the group needs):",
			lines.length > 0 ? lines.join("\n") : "Nothing yet.",
			"This brief does not change. Call read_own_chat when you need something newer or older from your own chat.",
		].join("\n");
	}

	Object.assign(rt, { eventsBackwards, searchOwnChat, latestOwnChat, aroundOwnChat, partIndex, ownChatBrief });
}
