// Chat index behaviour: Session history pages, the FTS5 search over every part of a
// Bot's own chat, latest/around reads, the log scan used when SQLite is unavailable, and
// the marks that make a rebuild cheap. The SQLite module is the real one; the DSH
// history behind it is a small fake, so the cases can be exact.
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { install, termQuery } from "../src/host/chat/chat-index.ts";
import { HISTORY_PAGE } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";

type TestRuntime = Runtime & Record<string, any>;

interface FakeEvent {
	type: "user/message" | "assistant/message" | "turn/start";
	seq: number;
	time: number;
	data: any;
}

interface Part {
	sessionId: string;
	number: number;
	startedAt: number;
	endedAt?: number;
}

// The DSH history behind the index: events by Session, the parts of each Bot's own chat,
// and the page reader the index walks backwards. A test can hide one seq (`omitSeq`) to
// simulate a gap, and a Session can be made unreadable.
class FakeDsh {
	histories = new Map<string, FakeEvent[]>();
	parts = new Map<string, Part[]>();
	omitSeq: number | undefined;
	unreadable = new Set<string>();
	failPartsOf = false;
	private tick = 0;

	events(sessionId: string): FakeEvent[] {
		return this.histories.get(sessionId) ?? [];
	}

	private push(sessionId: string, event: Omit<FakeEvent, "seq" | "time">): FakeEvent {
		let list = this.histories.get(sessionId);
		if (list === undefined) {
			list = [];
			this.histories.set(sessionId, list);
		}
		this.tick += 10;
		const full = { ...event, seq: list.length, time: this.tick } as FakeEvent;
		list.push(full);
		return full;
	}

	user(sessionId: string, text: string, from: "user" | "bot" = "user"): FakeEvent {
		return this.push(sessionId, { type: "user/message", data: { text, source: { kind: from } } });
	}

	assistant(sessionId: string, text: string): FakeEvent {
		return this.push(sessionId, { type: "assistant/message", data: { text } });
	}

	turnStart(sessionId: string): FakeEvent {
		return this.push(sessionId, { type: "turn/start", data: {} });
	}

	resolveAgent = async (sessionId: string): Promise<unknown> => {
		if (this.unreadable.has(sessionId)) throw new Error(`Session ${sessionId} is unavailable`);
		return { session: { id: sessionId, seq: this.events(sessionId).length } };
	};

	page = async (request: {
		address: { sessionId: string };
		throughSeq: number;
		beforeSeq?: number;
		maxMessages: number;
	}): Promise<{ records: { event: FakeEvent }[]; hasMore: boolean }> => {
		const sessionId = request.address.sessionId;
		if (this.unreadable.has(sessionId)) throw new Error(`Session ${sessionId} is unavailable`);
		const eligible = this.events(sessionId).filter(
			(event) =>
				event.seq <= request.throughSeq &&
				(request.beforeSeq === undefined || event.seq < request.beforeSeq) &&
				event.seq !== this.omitSeq,
		);
		const slice = eligible.slice(-request.maxMessages);
		return { records: slice.map((event) => ({ event })), hasMore: eligible.length > slice.length };
	};

	historyEntry = (event: FakeEvent): unknown => {
		if (event.type === "assistant/message") return { answer: true, text: event.data.text };
		if (event.type !== "user/message") return undefined;
		return {
			answer: false,
			who: event.data.source?.kind === "bot" ? "bot" : "user",
			text: event.data.text,
			keepAnswers: true,
		};
	};

	clock = (time?: number): string => `T${time ?? "?"}`;

	partLines = async function* (this: FakeDsh, sessionId: string): AsyncIterable<{ text: string; time: number }> {
		for (const event of this.events(sessionId)) {
			if (event.type === "user/message") yield { text: `User: ${event.data.text}`, time: event.time };
			else if (event.type === "assistant/message") yield { text: `Bot: ${event.data.text}`, time: event.time };
		}
	};
}

interface Host {
	rt: TestRuntime;
	dsh: FakeDsh;
	home: string;
	warnings: unknown[][];
	dispose(): Promise<unknown[]>;
}

function boot(t: TestContext, { home: given, dsh = new FakeDsh() }: { home?: string; dsh?: FakeDsh } = {}): Host {
	const home = given ?? mkdtempSync(join(tmpdir(), "ocean-crew-chat-index-"));
	const warnings: unknown[][] = [];
	const disposers: Array<() => unknown> = [];
	// The SQLite file is open while the module is installed; close it before the
	// temporary home goes, or Windows refuses to remove the directory.
	if (given === undefined)
		t.after(async () => {
			for (const dispose of disposers.splice(0).reverse()) await dispose();
			rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		});
	const ctx = {
		logger: { warn: (...args: unknown[]) => warnings.push(args) },
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
		sessionController: { page: dsh.page },
	};
	const rt = {
		ctx,
		home,
		warn: (...args: unknown[]) => warnings.push(args),
		resolveAgent: dsh.resolveAgent,
		partsOf: (botId: string) => {
			if (dsh.failPartsOf) throw new Error("no parts module");
			return dsh.parts.get(botId) ?? [];
		},
		historyEntry: dsh.historyEntry,
		clock: dsh.clock,
		partLines: dsh.partLines.bind(dsh),
	} as unknown as TestRuntime;
	install(rt);
	let disposed = false;
	const host: Host = {
		rt,
		dsh,
		home,
		warnings,
		async dispose() {
			if (disposed) return [];
			disposed = true;
			return Promise.all(
				disposers
					.splice(0)
					.reverse()
					.map((dispose) => dispose()),
			);
		},
	};
	return host;
}

// One Bot with a single current part, its Session called "p1".
function onePart(dsh = new FakeDsh(), botId = "a"): { dsh: FakeDsh; part: Part } {
	const part: Part = { sessionId: `${botId}-p1`, number: 1, startedAt: 100 };
	dsh.parts.set(botId, [part]);
	return { dsh, part };
}

// --- the query builder ---------------------------------------------------------------

test("termQuery quotes long terms for FTS5 and filters short ones with LIKE", () => {
	const query = termQuery(["hello", "ab"], ["s1"], 5, { session: "s1", from: 3 });
	assert.match(query.sql, /^SELECT text, session, seq, time, who FROM lines WHERE lines MATCH \?/);
	assert.match(query.sql, /session IN \(SELECT value FROM json_each\(\?\)\)/);
	assert.match(query.sql, /NOT \(session = \? AND seq >= \?\)/);
	assert.match(query.sql, /text LIKE \? ESCAPE '\\'/);
	assert.match(query.sql, /ORDER BY rank LIMIT 5$/);
	assert.deepEqual(query.args, ['"hello"', '["s1"]', "s1", 3, "%ab%"]);
	// A short-only search is ordered by time, oldest first.
	const short = termQuery(["ab", "c"], ["s1"], 2);
	assert.match(short.sql, /ORDER BY time DESC LIMIT 2$/);
	assert.deepEqual(short.args, ['["s1"]', "%ab%", "%c%"]);
	// A term with a quote is escaped, and % and _ are escaped in LIKE terms.
	assert.equal(termQuery(['he"llo'], [], 1).args[0], '"he""llo"');
	assert.equal(termQuery(["a%"], [], 1).args[1], "%a\\%%");
});

// --- history pages -------------------------------------------------------------------

test("eventsBackwards reads a Session newest first, page by page", async (t) => {
	const dsh = new FakeDsh();
	for (let index = 0; index < HISTORY_PAGE * 2 + 50; index += 1) dsh.user("s", `message ${index}`);
	const host = boot(t, { dsh });
	const all: number[] = [];
	for await (const event of host.rt.eventsBackwards("s", AbortSignal.timeout(10_000))) all.push(event.seq);
	assert.equal(all.length, HISTORY_PAGE * 2 + 50);
	assert.equal(all[0], HISTORY_PAGE * 2 + 49);
	assert.equal(all.at(-1), 0);
	assert.deepEqual(all.slice(0, 3), [HISTORY_PAGE * 2 + 49, HISTORY_PAGE * 2 + 48, HISTORY_PAGE * 2 + 47]);
	// A page limit stops early; one page carries at most HISTORY_PAGE events.
	const limited: number[] = [];
	for await (const event of host.rt.eventsBackwards("s", AbortSignal.timeout(10_000), 1)) limited.push(event.seq);
	assert.equal(limited.length, HISTORY_PAGE);
	// An unreadable Session rejects.
	dsh.unreadable.add("gone");
	await assert.rejects(
		(async () => {
			for await (const event of host.rt.eventsBackwards("gone", AbortSignal.timeout(10_000))) void event;
		})(),
		/Session gone is unavailable/,
	);
});

// --- search and reads ---------------------------------------------------------------

test("search finds messages across the parts of a Bot's own chat, oldest first", async (t) => {
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "hello there", "user");
	dsh.user(part.sessionId, "hello from another Bot", "bot");
	const host = boot(t, { dsh });
	const { lines, every } = await host.rt.searchOwnChat("a", "hello");
	assert.equal(every, true);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^\[#0 · T10\] User: hello there$/);
	// Another Bot's words are shown as they are, without a speaker prefix.
	assert.match(lines[1], /^\[#1 · T20\] hello from another Bot$/);
	// Two parts are named in the anchor.
	const second: Part = { sessionId: "a-p2", number: 2, startedAt: 200 };
	dsh.parts.set("a", [part, second]);
	dsh.user("a-p2", "hello again");
	const both = await host.rt.searchOwnChat("a", "hello again");
	assert.match(both.lines[0], /^\[part 2 #0 · T30\] User: hello again$/);
	assert.equal((await host.rt.searchOwnChat("a", "zzzz yyyy")).lines.length, 0);
});

test("the search does not match the turn that is asking", async (t) => {
	const { dsh, part } = onePart();
	dsh.turnStart(part.sessionId);
	dsh.user(part.sessionId, "an older message about needle");
	dsh.turnStart(part.sessionId);
	dsh.user(part.sessionId, "the current question about needle");
	const host = boot(t, { dsh });
	// Asked from the current part, the asking turn is left out.
	const hidden = await host.rt.searchOwnChat("a", "needle", { askingId: part.sessionId });
	assert.equal(hidden.lines.length, 1);
	assert.match(hidden.lines[0], /an older message about needle/);
	// Asked from elsewhere, both are found.
	const all = await host.rt.searchOwnChat("a", "needle");
	assert.equal(all.lines.length, 2);
});

test("a Chinese word of three characters is a trigram match, a shorter one a LIKE filter", async (t) => {
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "今天天气很好");
	dsh.user(part.sessionId, "世界和平");
	const host = boot(t, { dsh });
	assert.equal((await host.rt.searchOwnChat("a", "天气很")).lines.length, 1);
	assert.equal((await host.rt.searchOwnChat("a", "世界")).lines.length, 1);
	assert.equal((await host.rt.searchOwnChat("a", "不存在的词")).lines.length, 0);
});

test("with no message holding every word, the ones holding the most come first", async (t) => {
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "alpha beta together");
	dsh.user(part.sessionId, "alpha alone");
	dsh.user(part.sessionId, "beta alone");
	const host = boot(t, { dsh });
	const { lines, every } = await host.rt.searchOwnChat("a", "alpha gamma beta");
	assert.equal(every, false);
	assert.match(lines[0], /alpha beta together/);
	assert.equal(lines.length, 3);
	// All the words in one message is the normal case.
	const all = await host.rt.searchOwnChat("a", "alpha beta");
	assert.equal(all.every, true);
	assert.equal(all.lines.length, 1);
});

test("a user message and the Bot's answer are both indexed once the user wrote first", async (t) => {
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "what is the status?");
	dsh.assistant(part.sessionId, "the status is green");
	const host = boot(t, { dsh });
	const { lines } = await host.rt.searchOwnChat("a", "request status green", { askingId: "elsewhere" });
	assert.equal(lines.length, 2);
	assert.match(lines[0], /User: what is the status\?/);
	assert.match(lines[1], /You: the status is green/);
});

test("latestOwnChat returns the latest messages across parts, oldest first", async (t) => {
	const first: Part = { sessionId: "a-p1", number: 1, startedAt: 100, endedAt: 150 };
	const second: Part = { sessionId: "a-p2", number: 2, startedAt: 200 };
	const dsh = new FakeDsh();
	dsh.parts.set("a", [first, second]);
	dsh.user("a-p1", "one");
	dsh.user("a-p2", "two");
	dsh.assistant("a-p2", "three");
	const host = boot(t, { dsh });
	const lines = await host.rt.latestOwnChat("a", { limit: 2 });
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^\[part 2 #0 · T20\] User: two$/);
	assert.match(lines[1], /^\[part 2 #1 · T30\] You: three$/);

	const three = await host.rt.latestOwnChat("a", { limit: 3 });
	assert.equal(three.length, 3);
	assert.match(three[0], /part 1 #0 · T10\] User: one$/);
});

test("aroundOwnChat shows an anchor whole and its neighbours", async (t) => {
	const { dsh, part } = onePart();
	for (let index = 0; index < 5; index += 1) dsh.user(part.sessionId, `message ${index}`);
	const host = boot(t, { dsh });
	const found = await host.rt.aroundOwnChat("a", "#2");
	assert.equal(found.error, undefined);
	assert.equal(found.exact, true);
	assert.deepEqual(
		found.lines?.map((line: string) => line.match(/User: message \d/)![0]),
		["User: message 0", "User: message 1", "User: message 2", "User: message 3", "User: message 4"],
	);
	// An anchor no message sits at still shows the nearest ones.
	const near = await host.rt.aroundOwnChat("a", "#99");
	assert.equal(near.exact, false);
	assert.ok((near.lines?.length ?? 0) > 0);
	// The part prefix and the errors are the reader's own words.
	assert.match((await host.rt.aroundOwnChat("a", "part 2 #1")).error ?? "", /has no part 2/);
	assert.match((await host.rt.aroundOwnChat("a", "nonsense")).error ?? "", /is not an anchor/);
	assert.equal((await host.rt.aroundOwnChat("a", "part 1 #1")).part?.sessionId, part.sessionId);
});

test("partIndex and ownChatBrief describe the parts and the latest words", async (t) => {
	const first: Part = { sessionId: "a-p1", number: 1, startedAt: 100, endedAt: 150 };
	const second: Part = { sessionId: "a-p2", number: 2, startedAt: 200 };
	const dsh = new FakeDsh();
	dsh.parts.set("a", [first, second]);
	dsh.user("a-p2", "the latest words");
	const host = boot(t, { dsh });
	assert.equal(host.rt.partIndex([first, second]), "part 1 (T100 – T150), part 2 (T200 – now)");
	const brief = await host.rt.ownChatBrief({ id: "a", name: "Writer" });
	assert.match(brief, /^Your own chat with the user so far/);
	assert.match(brief, /User: the latest words/);
	assert.match(brief, /This brief does not change\./);
	// An empty chat says so; a brief that cannot be read is reported, not thrown.
	const empty = boot(t, { dsh: onePart().dsh });
	assert.match(await empty.rt.ownChatBrief({ id: "a", name: "Writer" }), /Nothing yet\./);
	host.dsh.failPartsOf = true;
	assert.match(await host.rt.ownChatBrief({ id: "a", name: "Writer" }), /Nothing yet\./);
	assert.ok(host.warnings.some((args) => /brief for %s failed/.test(String(args))));
});

// --- the index file ------------------------------------------------------------------

test("the index is rebuilt after its file is deleted, and survives a restart otherwise", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-chat-index-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "remember the milk");
	const first = boot(t, { home, dsh });
	const before = await first.rt.searchOwnChat("a", "milk");
	assert.equal(before.lines.length, 1);
	assert.equal(fs.existsSync(join(home, "chat-index.sqlite")), true);
	await first.dispose();
	// A restart reads the marks, and the next search finds the line without re-reading it.
	const second = boot(t, { home, dsh });
	assert.equal((await second.rt.searchOwnChat("a", "milk")).lines.length, 1);
	// New events are indexed in steps from the mark.
	dsh.user(part.sessionId, "and the bread");
	assert.equal((await second.rt.searchOwnChat("a", "bread")).lines.length, 1);
	await second.dispose();
	// Deleting the derived file costs a rebuild, nothing else.
	fs.rmSync(join(home, "chat-index.sqlite"), { force: true });
	const third = boot(t, { home, dsh });
	assert.equal((await third.rt.searchOwnChat("a", "milk")).lines.length, 1);
	assert.equal((await third.rt.searchOwnChat("a", "bread")).lines.length, 1);
	await third.dispose();
});

test("a damaged index file is rebuilt instead of read as empty", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-chat-index-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "something to find");
	fs.writeFileSync(join(home, "chat-index.sqlite"), Buffer.alloc(2048, 7));
	const host = boot(t, { home, dsh });
	assert.equal((await host.rt.searchOwnChat("a", "something")).lines.length, 1);
	await host.dispose();
});

test("a part that ended is sealed, and later events stay out of the index", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-chat-index-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
	const ended: Part = { sessionId: "a-p1", number: 1, startedAt: 100, endedAt: Date.now() - 61_000 };
	const current: Part = { sessionId: "a-p2", number: 2, startedAt: 200 };
	const dsh = new FakeDsh();
	dsh.parts.set("a", [ended, current]);
	dsh.user(ended.sessionId, "the ended part");
	dsh.user(current.sessionId, "the current part");
	const host = boot(t, { home, dsh });
	assert.equal((await host.rt.searchOwnChat("a", "ended")).lines.length, 1);
	// A late event in the sealed part is not read again.
	dsh.user(ended.sessionId, "a late straggler");
	assert.equal((await host.rt.searchOwnChat("a", "straggler")).lines.length, 0);
	// The live part keeps indexing.
	dsh.user(current.sessionId, "a fresh message");
	assert.equal((await host.rt.searchOwnChat("a", "fresh")).lines.length, 1);
	await host.dispose();
});

test("a gap in the history is a visible failure, not a silent skip", async (t) => {
	const { dsh, part } = onePart();
	dsh.user(part.sessionId, "indexed first");
	const host = boot(t, { dsh });
	assert.equal((await host.rt.searchOwnChat("a", "indexed")).lines.length, 1);
	// Two new events, but the page reader hides the first of them.
	dsh.user(part.sessionId, "lost in the gap");
	dsh.user(part.sessionId, "after the gap");
	dsh.omitSeq = dsh.events(part.sessionId).at(-2)?.seq;
	assert.equal((await host.rt.searchOwnChat("a", "gap")).lines.length, 0);
	assert.ok(host.warnings.some((args) => /indexing .* failed: .*came back with a gap/.test(String(args))));
});

test("a part that cannot be read now is searched as far as it was indexed", async (t) => {
	// A part that ended a moment ago is not sealed yet, so a read still goes to its log.
	const first: Part = { sessionId: "a-p1", number: 1, startedAt: 100, endedAt: Date.now() - 1_000 };
	const second: Part = { sessionId: "a-p2", number: 2, startedAt: 200 };
	const dsh = new FakeDsh();
	dsh.parts.set("a", [first, second]);
	dsh.user(first.sessionId, "one from the first part");
	dsh.user(second.sessionId, "one from the second part");
	const host = boot(t, { dsh });
	assert.equal((await host.rt.searchOwnChat("a", "part")).lines.length, 2);
	// the current one is still searchable.
	dsh.unreadable.add(first.sessionId);
	assert.equal((await host.rt.searchOwnChat("a", "second")).lines.length, 1);
	assert.ok(host.warnings.some((args) => /indexing %s failed/.test(String(args))));
});

// --- without SQLite ------------------------------------------------------------------

test("without a usable SQLite the reads scan the logs instead, and say why", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "ocean-crew-chat-index-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
	// A file where the data folder should be: the index cannot be created there.
	const home = join(root, "not-a-folder");
	fs.writeFileSync(home, "a file, not a folder");
	const first: Part = { sessionId: "a-p1", number: 1, startedAt: 100, endedAt: 150 };
	const second: Part = { sessionId: "a-p2", number: 2, startedAt: 200 };
	const dsh = new FakeDsh();
	dsh.parts.set("a", [first, second]);
	dsh.user(first.sessionId, "beta in the early part");
	dsh.user(second.sessionId, "beta in the current part");
	const host = boot(t, { home, dsh });
	const searched = await host.rt.searchOwnChat("a", "beta");
	assert.equal(searched.lines.length, 2);
	assert.match(searched.lines[0], /^\[part 1 · T10\] User: beta in the early part$/);
	assert.match(searched.lines[1], /^\[part 2 · T20\] User: beta in the current part$/);
	assert.equal(searched.every, true);
	// The latest words come back the same way.
	assert.equal((await host.rt.latestOwnChat("a", { limit: 1 }))[0], "[part 2 · T20] User: beta in the current part");
	// Anchors need the index, and the answer says so.
	assert.match((await host.rt.aroundOwnChat("a", "#1")).error ?? "", /need the chat index/);
	assert.ok(host.warnings.some((args) => /no chat index, read_own_chat scans the logs/.test(String(args))));
});
