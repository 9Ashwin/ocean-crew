// A memory change that was interrupted.
//
// The record of the change is what accepts it: it holds the files to write and the row
// to append. When a write cannot finish, the record stays and the change is finished
// before memory is read or written again; a record that cannot be read stops the memory
// rather than being passed over.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { format as formatText } from "node:util";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { createClock } from "../src/host/core/text.ts";
import { install as installPrivacy } from "../src/host/team/privacy.ts";
import { install as installMemory } from "../src/host/work/memory.ts";
import { inside, PENDING_FILE, record, serialize } from "../src/host/work/memory-pending.ts";
import { fakeContext } from "./fake-ctx.ts";

type TestRuntime = Runtime & Record<string, any>;

const TEAM = {
	version: 1,
	mainBotIds: ["m1"],
	revision: 1,
	whaleStored: true,
	bots: {
		m1: {
			id: "m1",
			sessionId: "m1",
			name: "Chief",
			role: "Chief of Staff",
			model: "deepseek/v4",
			instructions: "",
			createdAt: 1,
		},
		b2: {
			id: "b2",
			sessionId: "b2",
			name: "Writer",
			role: "写作",
			model: "deepseek/v4",
			instructions: "",
			createdAt: 2,
		},
	},
	rooms: {},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
};

interface Setup {
	ctx: ReturnType<typeof fakeContext>;
	rt: TestRuntime;
	home: string;
	warnings: string[];
	tool(name: string, args: Record<string, unknown>, sessionId: string): Promise<any>;
	section(sessionId: string): string;
	read(...path: string[]): string;
	journal(): Array<Record<string, any>>;
	stop(options?: { keep?: boolean }): Promise<void>;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean, tries = 200): Promise<void> {
	for (let at = 0; at < tries && !check(); at += 1) await settle();
	assert.ok(check(), "the condition did not hold within 4 s");
}

async function start({
	home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-")),
}: {
	home?: string;
} = {}): Promise<Setup> {
	if (!existsSync(join(home, "state.json"))) writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	const ctx = fakeContext() as ReturnType<typeof fakeContext> & Record<string, any>;
	const warnings: string[] = [];
	ctx.logger.warn = (...args: unknown[]) => warnings.push(formatText(...args));
	const rt = {
		ctx,
		config: { home },
		dshHome: join(home, "dsh"),
		home,
		statePath: join(home, "state.json"),
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief of Staff" },
		warn: (...args: unknown[]) => warnings.push(formatText(...args)),
	} as unknown as TestRuntime;
	installStore(rt);
	await rt.load();
	installPrivacy(rt);
	installMemory(rt);
	rt.clock = createClock();
	const tool = async (name: string, args: Record<string, unknown>, sessionId: string): Promise<any> => {
		await rt.load();
		const found = rt.teamTools.find((candidate) => candidate.name === name);
		assert.ok(found?.execute !== undefined, `tool ${name}`);
		return await found.execute(args, { agent: { id: sessionId } });
	};
	const section = (sessionId: string): string =>
		ctx.sections.get("bot-memory")?.text?.({ agent: { id: sessionId } }) ?? "";
	const read = (...path: string[]): string => readFileSync(join(home, "memory", ...path), "utf8");
	const journal = (): Array<Record<string, any>> =>
		read("journal.jsonl")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, any>);
	const stop = async ({ keep = false }: { keep?: boolean } = {}): Promise<void> => {
		await ctx.dispose();
		if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
	};
	return { ctx, rt, home, warnings, tool, section, read, journal, stop };
}

const failureText = (promise: Promise<unknown>): Promise<string> =>
	promise.then(
		() => "",
		(error: any) => {
			assert.match(error.code ?? "", /^memory\//);
			return error.message;
		},
	);
const pendingFile = (home: string): string => join(home, "memory", PENDING_FILE);
// The record of a change that was interrupted, as it lies on disk.
const interrupted = (
	home: string,
	{
		id = "change-1",
		op = "add",
		scope = "bot:b2",
		steps,
		row,
	}: { id?: string; op?: string; scope?: string; steps: unknown[]; row: Record<string, unknown> },
): void => {
	writeFileSync(
		pendingFile(home),
		JSON.stringify(record({ id, time: "2026-10-23T10:00:00.000Z", op, scope, steps: steps as never, row })),
	);
};

test("a record names paths inside the memory folder only, and refuses one too large", () => {
	// A platform-absolute path, so Windows resolves it the same way the module does.
	const root = join(tmpdir(), "memory-root");
	assert.equal(inside(root, "bots/b2/MEMORY.md"), join(root, "bots/b2/MEMORY.md"));
	assert.throws(() => inside(root, "../state.json"), /outside the memory folder/);
	assert.throws(() => inside(root, "bots/../../etc/passwd"), /outside the memory folder/);
	const change = record({
		id: "change-1",
		time: "2026-10-23T10:00:00.000Z",
		op: "add",
		scope: "bot:b2",
		steps: [{ action: "write", path: "bots/b2/MEMORY.md", text: "- One" }],
		row: { op: "add", scope: "bot:b2", file: "MEMORY.md", actor: "b2", after: "- One" },
	});
	assert.equal(change.row.id, "change-1");
	assert.equal(change.row.time, "2026-10-23T10:00:00.000Z");
	assert.match(serialize(change), /"steps":\[/);
	// A record that cannot be read back would stop the memory for good: it is refused.
	const huge = record({
		id: "change-2",
		time: "2026-10-23T10:00:00.000Z",
		op: "add",
		scope: "bot:b2",
		steps: [{ action: "write", path: "bots/b2/MEMORY.md", text: "x".repeat(1_200_000) }],
		row: { op: "add", scope: "bot:b2", file: "MEMORY.md", actor: "b2", after: "- One" },
	});
	assert.throws(() => serialize(huge), /too large to record/);
});

test("a change that cannot be published stays pending, and is finished before the next read", async (t) => {
	const { home, tool, read, journal, stop, section } = await start();
	t.after(() => stop());
	// The change log cannot be written: the entry is published, but its row is not.
	mkdirSync(join(home, "memory", "journal.jsonl"), { recursive: true });
	const said = await failureText(tool("remember", { text: "Trip to Kyoto", topic: "travel" }, "b2"));
	assert.doesNotMatch(said, /^Saved to your memory/);
	assert.match(read("bots", "b2", "travel.md"), /Trip to Kyoto/);
	assert.ok(existsSync(pendingFile(home)), "the change is pending");
	await until(() => section("b2").includes("pending"));
	const prompt = (): string => section("b2");
	assert.match(prompt(), /memory.*unavailable/i);
	assert.doesNotMatch(prompt(), /\[\[travel\]\]/);
	// The change log is there again: the next read finishes the change.
	rmSync(join(home, "memory", "journal.jsonl"), { recursive: true, force: true });
	assert.match(await tool("recall", { query: "Kyoto" }, "b2"), /Trip to Kyoto/);
	assert.ok(!existsSync(pendingFile(home)), "the change is finished");
	assert.deepEqual(
		journal().map((row) => [row.op, row.scope, row.file]),
		[["add", "bot:b2", "travel.md"]],
	);
	assert.match(read("bots", "b2", "MEMORY.md"), /- \[\[travel\]\]/);
	assert.match(prompt(), /\[\[travel\]\]/);
	// Reading again does not write a second row.
	await tool("recall", {}, "b2");
	assert.equal(journal().length, 1);
});

test("a change that cannot be accepted leaves the memory as it was", async (t) => {
	const { home, tool, read, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "First fact" }, "b2");
	const before = read("bots", "b2", "MEMORY.md");
	// The record of the change cannot be written: the change is not accepted, so
	// nothing changed.
	mkdirSync(pendingFile(home), { recursive: true });
	const said = await failureText(tool("remember", { text: "Second fact" }, "b2"));
	assert.doesNotMatch(said, /Second fact/);
	assert.equal(read("bots", "b2", "MEMORY.md"), before);
	assert.doesNotMatch(read("journal.jsonl"), /Second fact/);
	// With the record writable again, the change goes through.
	rmSync(pendingFile(home), { recursive: true, force: true });
	assert.match(await tool("remember", { text: "Second fact" }, "b2"), /^Saved to your memory/);
	assert.match(read("bots", "b2", "MEMORY.md"), /Second fact/);
});

test("an interrupted change is finished when the host starts", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	// A change that was interrupted after its topic was written, before the Index
	// that links it.
	mkdirSync(join(home, "memory", "bots", "b2"), { recursive: true });
	const topic = "# travel\n\n- Trip to Kyoto [source: part 1 #10; added: 2026-10-23]\n";
	writeFileSync(join(home, "memory", "bots", "b2", "travel.md"), topic);
	interrupted(home, {
		steps: [
			{ action: "write", path: "bots/b2/travel.md", text: topic },
			{ action: "write", path: "bots/b2/MEMORY.md", text: "# Memory\n\n## Index\n- [[travel]]\n" },
		],
		row: {
			op: "add",
			scope: "bot:b2",
			file: "travel.md",
			actor: "b2",
			actorName: "Writer",
			after: "- Trip to Kyoto [source: part 1 #10; added: 2026-10-23]",
		},
	});
	const { read, journal, stop } = await start({ home });
	t.after(() => stop());
	await until(() => !existsSync(pendingFile(home)));
	assert.match(read("bots", "b2", "MEMORY.md"), /- \[\[travel\]\]/);
	assert.deepEqual(
		journal().map((row) => [row.op, row.file]),
		[["add", "travel.md"]],
	);
});

test("an interrupted change that removes a topic and its link is finished as one", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	mkdirSync(join(home, "memory", "bots", "b2"), { recursive: true });
	writeFileSync(join(home, "memory", "bots", "b2", "MEMORY.md"), "# Memory\n\n## Index\n- [[travel]]\n");
	writeFileSync(join(home, "memory", "bots", "b2", "travel.md"), "# travel\n\n- Trip to Kyoto [added: 2026-10-23]\n");
	// The change was interrupted after the topic was removed, before the Index lost
	// its link.
	interrupted(home, {
		op: "remove",
		steps: [
			{ action: "remove", path: "bots/b2/travel.md" },
			{ action: "write", path: "bots/b2/MEMORY.md", text: "# Memory\n\n## Index\n" },
		],
		row: {
			op: "remove",
			scope: "bot:b2",
			file: "travel.md",
			actor: "b2",
			actorName: "Writer",
			before: "- Trip to Kyoto [added: 2026-10-23]",
			removedTopic: true,
		},
	});
	const { read, journal, stop } = await start({ home });
	t.after(() => stop());
	await until(() => !existsSync(pendingFile(home)));
	assert.doesNotMatch(read("bots", "b2", "MEMORY.md"), /travel/);
	assert.ok(!existsSync(join(home, "memory", "bots", "b2", "travel.md")));
	assert.deepEqual(
		journal().map((row) => [row.op, row.removedTopic]),
		[["remove", true]],
	);
});

test("a change that was already finished does not get a second row", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	const row = {
		op: "add",
		scope: "bot:b2",
		file: "MEMORY.md",
		actor: "b2",
		actorName: "Writer",
		after: "- One [added: 2026-10-23]",
	};
	// The change is finished: its row is in the change log, and the record of it is
	// still there.
	mkdirSync(join(home, "memory"), { recursive: true });
	writeFileSync(
		join(home, "memory", "journal.jsonl"),
		`${JSON.stringify({ id: "change-1", time: "2026-10-23T10:00:00.000Z", ...row })}\n`,
	);
	interrupted(home, {
		steps: [
			{ action: "write", path: "bots/b2/MEMORY.md", text: "# Memory\n\n- One [added: 2026-10-23]\n\n## Index\n" },
		],
		row,
	});
	const { read, journal, stop } = await start({ home });
	t.after(() => stop());
	await until(() => !existsSync(pendingFile(home)));
	assert.equal(journal().length, 1);
	assert.match(read("bots", "b2", "MEMORY.md"), /- One/);
});

test("a record of a change that cannot be read stops the memory", async (t) => {
	const { home, tool, read, stop, section } = await start();
	t.after(() => stop());
	await tool("remember", { text: "First fact" }, "b2");
	const before = read("bots", "b2", "MEMORY.md");
	writeFileSync(pendingFile(home), "{ this is not a record");
	assert.match(await tool("recall", {}, "b2"), /pending\.json is not readable/);
	assert.doesNotMatch(await failureText(tool("remember", { text: "Second fact" }, "b2")), /Second fact/);
	assert.equal(read("bots", "b2", "MEMORY.md"), before);
	const prompt = (): string => section("b2");
	assert.doesNotMatch(prompt(), /First fact/);
	assert.match(prompt(), /memory.*unavailable/i);
	assert.equal(existsSync(join(home, "memory", "snapshots", "b2.md")), false);
	rmSync(pendingFile(home));
	assert.match(prompt(), /First fact/);
});

test("a prompt keeps its committed snapshot while an unfinished change is recovered", async (t) => {
	const first = await start();
	const { ctx, home, tool, stop } = first;
	let active = first;
	t.after(() => active.stop());
	await tool("remember", { text: "Committed fact" }, "b2");
	const prompt = (sessionId: string): string => first_setup_section(ctx, sessionId);
	const committed = prompt("b2");
	rmSync(join(home, "memory", "journal.jsonl"));
	mkdirSync(join(home, "memory", "journal.jsonl"));
	await failureText(tool("remember", { text: "Pending fact" }, "b2"));
	assert.ok(existsSync(pendingFile(home)));
	assert.equal(prompt("b2"), committed);
	// A snapshot read from disk after a restart is equally safe.
	await stop({ keep: true });
	const next = await start({ home });
	active = next;
	await next.tool("recall", {}, "b2");
	assert.equal(next.section("b2"), committed);
});

// The section reader of one started runtime, for the snapshot test above.
function first_setup_section(ctx: ReturnType<typeof fakeContext>, sessionId: string): string {
	return ctx.sections.get("bot-memory")?.text?.({ agent: { id: sessionId } }) ?? "";
}

test("an interrupted change that replaces an entry is finished with the line it had before", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	mkdirSync(join(home, "memory", "bots", "b2"), { recursive: true });
	writeFileSync(
		join(home, "memory", "bots", "b2", "MEMORY.md"),
		"# Memory\n\n- Likes tea [added: 2026-10-23]\n\n## Index\n",
	);
	interrupted(home, {
		op: "replace",
		steps: [
			{
				action: "write",
				path: "bots/b2/MEMORY.md",
				text: "# Memory\n\n- Likes green tea [added: 2026-10-23]\n\n## Index\n",
			},
		],
		row: {
			op: "replace",
			scope: "bot:b2",
			file: "MEMORY.md",
			actor: "b2",
			actorName: "Writer",
			before: "- Likes tea [added: 2026-10-23]",
			after: "- Likes green tea [added: 2026-10-23]",
		},
	});
	const { read, journal, stop } = await start({ home });
	t.after(() => stop());
	await until(() => !existsSync(pendingFile(home)));
	assert.match(read("bots", "b2", "MEMORY.md"), /Likes green tea/);
	assert.deepEqual(
		journal().map((row) => [row.op, row.before, row.after]),
		[["replace", "- Likes tea [added: 2026-10-23]", "- Likes green tea [added: 2026-10-23]"]],
	);
});

test("a change log from before the operation ids keeps its rows", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	mkdirSync(join(home, "memory"), { recursive: true });
	writeFileSync(
		join(home, "memory", "journal.jsonl"),
		`${JSON.stringify({ time: "2026-10-01T10:00:00.000Z", op: "add", scope: "bot:b2", file: "MEMORY.md", actor: "b2", actorName: "Writer", after: "- Older fact" })}\n`,
	);
	const { tool, journal, stop } = await start({ home });
	t.after(() => stop());
	await tool("remember", { text: "Newer fact" }, "b2");
	const rows = journal();
	assert.equal(rows.length, 2);
	assert.equal(rows[0]!.id, undefined);
	assert.equal(typeof rows[1]!.id, "string");
});

test("a half-written row of the change log is not proof: the change gets one whole row", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	mkdirSync(join(home, "memory"), { recursive: true });
	// The row of op-1 was cut in half while it was being appended.
	const half = '{"id":"op-1","time":"2026-10-23T10:00:00.000Z","op":"ad';
	writeFileSync(join(home, "memory", "journal.jsonl"), half);
	interrupted(home, {
		id: "op-1",
		steps: [
			{ action: "write", path: "bots/b2/MEMORY.md", text: "# Memory\n\n- One [added: 2026-10-23]\n\n## Index\n" },
		],
		row: {
			op: "add",
			scope: "bot:b2",
			file: "MEMORY.md",
			actor: "b2",
			actorName: "Writer",
			after: "- One [added: 2026-10-23]",
		},
	});
	const { read, stop } = await start({ home });
	t.after(() => stop());
	await until(() => !existsSync(pendingFile(home)));
	// Every line of the log parses, and the change has one whole row.
	const rows = read("journal.jsonl")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, any>);
	assert.deepEqual(
		rows.map((row) => row.id),
		["op-1"],
	);
	assert.match(read("bots", "b2", "MEMORY.md"), /- One/);
	// The half row is kept beside the log, as the evidence it is.
	assert.ok(read("journal.torn").includes(half));
});

test("a half-written row of another change does not swallow the row after it", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	mkdirSync(join(home, "memory"), { recursive: true });
	const older = `${JSON.stringify({ time: "2026-10-01T10:00:00.000Z", id: "op-old", op: "add", scope: "bot:b2", file: "MEMORY.md", actor: "b2", actorName: "Writer", after: "- 旧的记录" })}\n`;
	const half = '{"id":"op-0","time":"2026-10-23T10:00:00.000Z","op":"ad';
	writeFileSync(join(home, "memory", "journal.jsonl"), `${older}${half}`);
	const { tool, read, stop } = await start({ home });
	t.after(() => stop());
	await tool("remember", { text: "Second fact" }, "b2");
	const rows = read("journal.jsonl")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, any>);
	assert.deepEqual(rows.map((row) => row.id).slice(0, 1), ["op-old"]);
	assert.match(rows[0]!.after, /旧的记录/);
	assert.match(rows.at(-1)!.after, /^- Second fact/);
	assert.ok(read("journal.torn").includes(half));
});

test("a change that would not fit in the record is refused, and the memory still reads", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	mkdirSync(join(home, "memory", "bots", "b2"), { recursive: true });
	// A memory file that was edited by hand and is far past its size.
	const huge = `# Memory\n\n- Teas and a long story about the tea [added: 2026-10-23]\n${"x".repeat(1_200_000)}\n\n## Index\n`;
	writeFileSync(join(home, "memory", "bots", "b2", "MEMORY.md"), huge);
	const { tool, read, stop } = await start({ home });
	t.after(() => stop());
	// The change would leave a record that cannot be read back, so it is refused
	// before it is accepted: the memory is as it was, and still reads.
	const said = await failureText(
		tool("remember", { text: "Coffee", replace: "Teas and a long story about the tea" }, "b2"),
	);
	assert.match(said, /too large to record/);
	assert.equal(read("bots", "b2", "MEMORY.md"), huge);
	assert.ok(!existsSync(pendingFile(home)), "the change was not accepted");
	assert.match(await tool("recall", { query: "Teas and a long story" }, "b2"), /Teas and a long story/);
});

test("the change log keeps what each change replaced, and the id that tells it apart", async (t) => {
	const { tool, journal, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "Likes tea" }, "b2");
	await tool("remember", { text: "Likes green tea", replace: "Likes tea" }, "b2");
	const [added, replaced] = journal();
	assert.deepEqual(Object.keys(added!).sort(), ["actor", "actorName", "after", "file", "id", "op", "scope", "time"]);
	assert.equal(replaced!.before, added!.after);
	assert.notEqual(replaced!.id, added!.id);
});
