// Memory behaviour: the layered Markdown files, the writes and their change log,
// snapshots, recall, the panel, undo, the review with its batch states, and the
// retrieval port.
// memory-state design's reliability points (parse failure holds the cursor, finite
// retries then repair_required, op ids make a replay idempotent, explicit changes
// invalidate snapshots).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { format as formatText } from "node:util";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { createClock } from "../src/host/core/text.ts";
import { install as installModels } from "../src/host/team/models.ts";
import { install as installPrivacy } from "../src/host/team/privacy.ts";
import {
	addLink,
	cleanEntry,
	cleanTopic,
	formatEntry,
	insertEntry,
	install as installMemory,
	looksLikeKey,
	looksSecret,
	MEMORY_LIMITS,
	matchEntries,
	parseAsk,
	parseMemory,
	parseReview,
	removeLink,
	reviewEntries,
	splitMeta,
	writtenIn,
} from "../src/host/work/memory.ts";
import { fakeContext } from "./fake-ctx.ts";

type TestRuntime = Runtime & Record<string, any>;
type RawEvent = { event: { seq: number; type?: string; data?: Record<string, any>; time?: number } };

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
		b3: { id: "b3", sessionId: "b3", name: "Coder", role: "代码", instructions: "", createdAt: 3 },
		b4: { id: "b4", sessionId: "b4", name: "Temp", role: "临时", instructions: "", createdAt: 4 },
	},
	rooms: {
		r1: {
			id: "r1",
			name: "Launch",
			named: true,
			members: ["b2", "b3"],
			admin: "b3",
			mode: "everyone",
			notice: "",
			sessions: { b3: "g3" },
			seq: 3,
			log: [
				{ who: "User", text: "Keep everything you send me under one page", seq: 1 },
				{ who: "Coder", botId: "b3", kind: "lookup", text: "page", seq: 2 },
				{ who: "Coder", botId: "b3", text: "Will do.", seq: 3 },
			],
		},
	},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
};

const ownChat: RawEvent[] = [
	{
		event: {
			seq: 10,
			type: "user/message",
			data: { source: { kind: "user" }, content: [{ type: "text", text: "Please remember this" }] },
		},
	},
	{
		event: { seq: 11, type: "assistant/message", data: { message: { content: [{ type: "text", text: "Saved." }] } } },
	},
];

// The parts module's two views of a Session, reproduced here so the memory tests do

const textOf = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.filter((block) => (block as { type?: unknown })?.type === "text")
		.map((block) => String((block as { text?: unknown }).text ?? ""))
		.join("\n")
		.trim();

interface HistoryEntryView {
	answer: boolean;
	text: string;
	who?: "user" | "bot";
	keepAnswers?: boolean;
}
const historyEntry = (event: RawEvent["event"], _group: boolean): HistoryEntryView | undefined => {
	if (event.type === "assistant/message") {
		const text = textOf(event.data?.message?.content);
		return text === "" ? undefined : { answer: true, text };
	}
	const source = event.data?.source;
	if (event.type !== "user/message" || (source?.kind !== "user" && source?.kind !== "bot")) return undefined;
	const text = textOf(event.data?.content);
	return { answer: false, who: source.kind === "bot" ? "bot" : "user", text, keepAnswers: true };
};

interface SetupOptions {
	home?: string;
	replies?: Array<unknown>;
	config?: Record<string, unknown>;
	history?: Record<string, RawEvent[]>;
	reasoning?: { efforts: Array<{ id: string; name?: string }>; defaultEffort?: string };
	models?: string[];
	defaultModel?: string;
	overrides?: Record<string, unknown>;
}

interface Setup {
	ctx: ReturnType<typeof fakeContext>;
	rt: TestRuntime;
	home: string;
	warnings: string[];
	requests: Array<Record<string, any>>;
	tool(name: string, args: Record<string, unknown>, sessionId: string): Promise<any>;
	call(endpoint: string, payload: Record<string, unknown>): Promise<any>;
	section(sessionId: string): string;
	read(...path: string[]): string;
	journal(): Array<Record<string, any>>;
	reviewed(): Record<string, any>;
	reviewState(key: string): Record<string, any>;
	preStep(sessionId: string, history?: unknown[]): Promise<unknown>;
	reviewedDone(): Promise<void>;
	summarized(botId?: string): Promise<void>;
	stop(options?: { keep?: boolean }): Promise<void>;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

async function until(check: () => boolean, tries = 200): Promise<void> {
	for (let at = 0; at < tries && !check(); at += 1) await settle();
	assert.ok(check(), "the condition did not hold within 4 s");
}

async function start({
	home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-")),
	replies = [],
	config = {},
	history = {},
	reasoning = { efforts: [{ id: "off" }, { id: "high" }] },
	models = ["v4"],
	defaultModel,
	overrides = {},
}: SetupOptions = {}): Promise<Setup> {
	if (!existsSync(join(home, "state.json"))) writeFileSync(join(home, "state.json"), JSON.stringify(TEAM));
	const services: Record<string, unknown> =
		defaultModel === undefined
			? {}
			: { agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: defaultModel }) } };
	const ctx = fakeContext({ services }) as ReturnType<typeof fakeContext> & Record<string, any>;
	const warnings: string[] = [];
	const requests: Array<Record<string, any>> = [];
	ctx.logger.warn = (...args: unknown[]) => warnings.push(formatText(...args));
	// The same array the test keeps pushing to: a queued reply may arrive later.
	const replyQueue = replies as unknown[];
	(ctx as any).llm = {
		listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
		listModels: async () => models.map((id) => ({ id })),
		resolveModelInfo: async () => ({ reasoning }),
		async *stream(request: Record<string, any>) {
			requests.push(request);
			const reply = await replyQueue.shift();
			if (reply instanceof Error) throw reply;
			const out =
				typeof reply === "object" && reply !== null ? (reply as Record<string, any>) : { text: reply ?? "" };
			yield { type: "text-delta", index: 0, text: out.text ?? "" };
			yield {
				type: "finish",
				reason: { kind: out.finish ?? "stop", ...(out.failure ? { failure: { message: out.failure } } : {}) },
			};
		},
	};
	const rt = {
		ctx,
		config: { home, ...config },
		dshHome: join(home, "dsh"),
		home,
		statePath: join(home, "state.json"),
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief of Staff" },
		warn: (...args: unknown[]) => warnings.push(formatText(...args)),
		...overrides,
	} as unknown as TestRuntime;
	installStore(rt);
	await rt.load();
	installModels(rt);
	installPrivacy(rt);
	installMemory(rt);

	// The parts and chat-index hooks memory reads;
	rt.clock = createClock();
	rt.partsOf = (botId: string): Array<{ sessionId: string }> => {
		const bot = rt.botOf(botId);
		return [
			...(bot?.segments ?? []).map((segment: { sessionId: string }) => ({ sessionId: segment.sessionId })),
			{ sessionId: rt.chatOf(botId) },
		];
	};
	rt.eventsBackwards = async function* (sessionId: string): AsyncGenerator<RawEvent["event"]> {
		const events = (history[sessionId] ?? ownChat).map((record) => record.event);
		for (const event of [...events].reverse()) yield event;
	};
	rt.historyEntry = historyEntry;
	rt.partLines = async function* (sessionId: string): AsyncGenerator<Record<string, unknown>> {
		const events = (history[sessionId] ?? ownChat).map((record) => record.event);
		let answers: Array<Record<string, unknown>> = [];
		for (const event of [...events].reverse()) {
			const entry = historyEntry(event, false);
			if (entry === undefined) continue;
			if (entry.answer) {
				answers.push({ text: `You: ${entry.text}`, time: event.time, seq: event.seq, who: "you" });
				continue;
			}
			const kept = entry.keepAnswers ? answers : [];
			answers = [];
			yield* kept;
			if (entry.text !== "")
				yield {
					text: entry.who === "user" ? `User: ${entry.text}` : entry.text,
					time: event.time,
					seq: event.seq,
					who: entry.who,
				};
		}
	};

	const tool = async (name: string, args: Record<string, unknown>, sessionId: string): Promise<any> => {
		await rt.load();
		const found = rt.teamTools.find((candidate) => candidate.name === name);
		assert.ok(found?.execute !== undefined, `tool ${name}`);
		return await found.execute(args, { agent: { id: sessionId } });
	};
	const call = async (endpoint: string, payload: Record<string, unknown> = {}): Promise<any> => {
		await rt.load();
		return await rt.memoryEndpoint(endpoint, payload);
	};
	const section = (sessionId: string): string =>
		ctx.sections.get("bot-memory")?.text?.({ agent: { id: sessionId } }) ?? "";
	const read = (...path: string[]): string => readFileSync(join(home, "memory", ...path), "utf8");
	const journal = (): Array<Record<string, any>> =>
		read("journal.jsonl")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, any>);
	const reviewed = (): Record<string, any> => JSON.parse(read("reviewed.json"));
	const preStep = async (sessionId: string, past: unknown[] = []): Promise<unknown> => {
		const listeners = ctx.listeners.get("agent/pre-step") ?? [];
		const listener = listeners.find((candidate) => /isGroupMemory/.test(String(candidate)));
		assert.ok(listener !== undefined, "the group memory pre-step");
		const agent = { id: sessionId, session: { deriveMessages: () => past } };
		const decision = await listener(
			{ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) },
			async () => ({
				kind: "enter",
				messages: [],
			}),
		);
		return (decision as { messages?: unknown[] }).messages?.find(
			(message) => (message as { source?: { kind?: string } }).source?.kind === "ocean-crew-group-memory",
		);
	};
	const reviewedDone = async (): Promise<void> => {
		await until(() => rt.memoryReviews() === 0);
	};
	// The summary is written to disk after the model answers; wait for that, never a
	// fixed delay.
	const summarized = async (botId = "b2"): Promise<void> => {
		for (let at = 0; at < 200; at += 1) {
			if ((await call("memory-view", { botId })).summarizing === false) return;
			await settle();
		}
		throw new Error("the memory summary did not finish");
	};
	const stop = async ({ keep = false }: { keep?: boolean } = {}): Promise<void> => {
		await ctx.dispose();
		if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return {
		ctx,
		rt,
		home,
		warnings,
		requests,
		tool,
		call,
		section,
		read,
		journal,
		reviewed,
		reviewState: (key) => rt.memoryReviewState(key),
		preStep,
		reviewedDone,
		summarized,
		stop,
	};
}

// ---------------------------------------------------------------------------
// Files and text.

test("entries carry their metadata at the end of the line, as Agent Memory Repo writes it", () => {
	assert.deepEqual(splitMeta("Prefers tea [source: part 2 #14; by: Chief; added: 2026-10-09]"), {
		text: "Prefers tea",
		meta: { source: "part 2 #14", by: "Chief", added: "2026-10-09" },
	});
	// Brackets that are not metadata stay in the text.
	assert.deepEqual(splitMeta("Uses [[travel]] notes [draft]"), { text: "Uses [[travel]] notes [draft]", meta: {} });
	assert.equal(
		formatEntry("Prefers tea", { source: "part 1 #3", by: "", added: "2026-10-09" }),
		"- Prefers tea [source: part 1 #3; added: 2026-10-09]",
	);
	assert.equal(formatEntry("x", { source: "a; b [c]" }), "- x [source: a b c]");
	assert.equal(cleanEntry("  - * Likes  short\nreplies [source: forged] "), "Likes short replies");
	assert.equal(cleanTopic(" [[Project X.md]] "), "project-x");
	assert.equal(cleanTopic("旅行"), "旅行");
	for (const bad of ["", "../etc", "a/b", "memory", "-x", "x".repeat(49)])
		assert.equal(cleanTopic(bad), undefined, bad);
});

test("the Index holds topic links; entries above it, and hand-written lines, stay put", () => {
	const text = "# Memory\n\nA note by hand.\n\n- One [added: 2026-10-01]\n\n## Index\n- [[travel]]\n";
	const parsed = parseMemory(text);
	assert.deepEqual(
		parsed.entries.map((entry) => [entry.line, entry.text]),
		[[4, "One"]],
	);
	assert.deepEqual(parsed.links, ["travel"]);
	const added = insertEntry(parsed.lines, "- Two");
	assert.deepEqual(added, [
		"# Memory",
		"",
		"A note by hand.",
		"",
		"- One [added: 2026-10-01]",
		"- Two",
		"",
		"## Index",
		"- [[travel]]",
	]);
	assert.deepEqual(insertEntry(["# Memory", "", "## Index"], "- First"), ["# Memory", "", "- First", "", "## Index"]);
	assert.deepEqual(insertEntry(["# travel"], "- Fly"), ["# travel", "", "- Fly"]);
	assert.deepEqual(addLink(added, "work"), [...added, "- [[work]]"]);
	assert.deepEqual(addLink(["# Memory", "", "- One"], "work"), [
		"# Memory",
		"",
		"- One",
		"",
		"## Index",
		"- [[work]]",
	]);
	assert.deepEqual(removeLink(addLink(added, "work"), "travel"), [...added.slice(0, -1), "- [[work]]"]);
});

test("a request names one entry by its text, or by a part only it has", () => {
	const entries = parseMemory("- Likes tea\n- Likes green tea\n- Lives in Hangzhou\n").entries;
	assert.deepEqual(
		matchEntries(entries, "likes tea").map((entry) => entry.text),
		["Likes tea"],
	);
	assert.deepEqual(
		matchEntries(entries, "tea").map((entry) => entry.text),
		["Likes tea", "Likes green tea"],
	);
	assert.deepEqual(
		matchEntries(entries, "hangzhou").map((entry) => entry.text),
		["Lives in Hangzhou"],
	);
	assert.deepEqual(matchEntries(entries, "  "), []);
});

test("keys are refused, while paths, names, and links are kept", () => {
	for (const key of [
		"sk-" + "abcdefghijklmnopqrstuv",
		"ghp_abcdefghijklmnopqrstuvwxyz12",
		"AKIA" + "ABCDEFGHIJKLMNOP",
		"token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f",
	])
		assert.equal(looksLikeKey(key), true, key);
	for (const fine of [
		"The repo is ~/repos/dsbot/the earlier host tree",
		"Doc: https://docs.example.com/d/aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f/edit",
		"Uses deepseek-v4-flash for drafts",
		"用户喜欢简短的回答",
	])
		assert.equal(looksLikeKey(fine), false, fine);
	// Passwords given as such, and ID or card numbers, are secrets too.
	for (const secret of [
		"测试服务器的 root 密码是 hunter2-prod",
		"The root password is hunter2",
		"pwd: x",
		"身份证号 330106199001011234",
		"card 6222 0212 3456 7890",
		"the password for root is hunter2",
		"The user's ATM PIN is 1234",
		"passcode is 654321",
		"验证码是 123456",
		"the CVV is 123",
		"staging password remains hunter2",
		"root 的密码还是 hunter2",
		"the db password was changed to s3cret",
		"card 6222-0212-3456-7890",
		"Amex 3714-496353-98431",
		"身份证 330106-19900101-1234",
		"I use hunter2 as my password",
		"Use 654321 for the PIN",
		"The user uses s3cret as the staging root password",
		"我的密码用 hunter2",
		"我用 hunter2 当密码",
		"用 abc123 作为服务器密码",
		"I use correct horse battery staple as my password",
		"Use six five four three two one for the PIN",
		"我用 correct horse battery staple 当密码",
		"The user's SSN is 123-45-6789",
		"passport number is A12345678",
		"护照号E12345678",
		"driver's license D1234567",
	]) {
		assert.equal(looksSecret(secret), true, secret);
	}
	for (const fine of [
		"用户不想把密码存进记忆",
		"Trip on 2026-11-15, back 2026-11-17",
		"The user keeps passwords in a password manager, which is 1Password",
		"用户的密码管理器是 1Password",
		"The user pins the sidebar",
		"Pin the tab, it is handy",
		"The user uses 1Password for passwords",
		"Uses Bitwarden as the password manager",
		"Use the PIN pad on the left",
		"密码用 1Password 管理",
		"密码不能告诉用户",
		"密码用于登录",
		"用 1Password 作为密码管理器",
		"Uses Tab for the password field",
		"The user uses Vim for editing and Rust for work",
		"The user's passport expires 2027-05-01",
		"Passport renewed 2026-11-15, flight 2026-11-17",
		"ID card photo, call 138 0013 8000",
		"密码不能明文保存因为不安全",
		"Off 2026-11-15 2026-11-17",
		"电话 138-0013-8000",
		"手机 138 0013 8000 是工作号",
		"Issue https://x.test/a/1234567890123456789",
	]) {
		assert.equal(looksSecret(fine), false, fine);
	}
});

test("the memory review writes entries in the language of the user's lines", () => {
	assert.equal(
		writtenIn(["帮我写个函数。我们项目用 TypeScript，包管理只用 pnpm，别给我 npm 命令。"], "x"),
		"Chinese (简体中文)",
	);
	assert.equal(writtenIn(["Use pnpm, not npm"], "x"), "English");
	assert.equal(writtenIn(["Rename it to 订单 service please, the old one is wrong"], "x"), "x");
	assert.equal(writtenIn(["👍"], "x"), "x");
});

test("the memory panel reads JSON from the model, in a fence or not", () => {
	assert.deepEqual(parseAsk('```json\n{"reply": "Done.", "changes": [{"op": "add", "text": "x"}]}\n```'), {
		reply: "Done.",
		changes: [{ op: "add", text: "x" }],
	});
	assert.deepEqual(parseAsk("I could not do that."), { reply: "I could not do that.", changes: [] });
	assert.deepEqual(parseAsk('{"reply": 3}'), { reply: "3", changes: [] });
	// The review takes only a list of changes; prose or a broken object is no answer.
	assert.deepEqual(parseReview('```json\n{"changes": [{"op": "add", "text": "x"}]}\n```'), {
		changes: [{ op: "add", text: "x" }],
		leftOut: [],
	});
	assert.deepEqual(parseReview('{"changes": []}'), { changes: [], leftOut: [] });
	for (const bad of ["Nothing to keep.", '{"changes": "none"}', '{"changes": [{"op": "add"'])
		assert.equal(parseReview(bad), undefined, bad);
	// A malformed change is set aside; the well-formed ones still count.
	for (const bad of [
		'"remember this"',
		'{"text": "x"}',
		'{"op": "add", "text": " "}',
		'{"op": "edit", "entry": "two", "text": "x"}',
		'{"op": "remove", "entry": 0}',
		'{"op": "add", "text": "x", "team": "true"}',
	]) {
		const parsed = parseReview(`{"changes": [${bad}, {"op": "add", "text": "y"}]}`);
		assert.deepEqual(parsed?.changes, [{ op: "add", text: "y" }], bad);
		assert.deepEqual(parsed?.leftOut, [JSON.parse(bad)], bad);
	}
	assert.deepEqual(parseReview('{"changes": [{"op": "remove", "entry": "2"}]}'), {
		changes: [{ op: "remove", entry: "2" }],
		leftOut: [],
	});
});

test("a review shows both MEMORY.md files whole, then the newest topic entries that fit", () => {
	const own = [
		{ entries: [{ text: "A", meta: {} }] },
		{
			topic: "t",
			entries: [
				{ text: "old", meta: { added: "2026-01-01" } },
				{ text: "new", meta: { added: "2026-10-01" } },
			],
		},
	];
	const team = [{ entries: [{ text: "T", meta: {} }] }];
	const { numbered, left } = reviewEntries(own, team, 5);
	assert.deepEqual(
		numbered.map((entry) => [entry.scope, entry.file.topic, entry.text]),
		[
			["own", undefined, "A"],
			["team", undefined, "T"],
			["own", "t", "new"],
		],
	);
	assert.equal(left, 1);
	assert.equal(reviewEntries(own, team).left, 0);
	// One entry too long for what is left does not keep out a shorter one after it.
	const tight = [
		{ entries: [{ text: "A", meta: {} }] },
		{
			topic: "t",
			entries: [
				{ text: "x".repeat(5), meta: { added: "2026-10-01" } },
				{ text: "yy", meta: { added: "2026-01-01" } },
			],
		},
	];
	const fit = reviewEntries(tight, [{ entries: [] }], 5);
	assert.deepEqual(
		fit.numbered.map((entry) => entry.text),
		["A", "yy"],
	);
	assert.equal(fit.left, 1);
	// Topic entries that share words with the user's new lines come first.
	const shared = [
		{ entries: [] },
		{
			topic: "work",
			entries: [
				{ text: "Ships on Fridays", meta: { added: "2026-01-01" } },
				{ text: "Drinks green tea", meta: { added: "2026-10-01" } },
				{ text: "用户住在杭州的西湖区附近哦", meta: { added: "2026-02-01" } },
			],
		},
	];
	const shown = (about: string) =>
		reviewEntries(shared, [{ entries: [] }], 16, about).numbered.map((entry) => entry.text);
	assert.deepEqual(shown(""), ["Drinks green tea"]);
	assert.deepEqual(shown("We no longer ship on Fridays"), ["Ships on Fridays"]);
	assert.deepEqual(shown("我搬离杭州了"), ["用户住在杭州的西湖区附近哦"]);
});

// ---------------------------------------------------------------------------
// The tools, the files, and the change log.

test("remember saves one entry with its source, and forget removes it, both in the journal", async (t) => {
	const { tool, read, journal, stop } = await start();
	t.after(() => stop());
	assert.match(
		await tool("remember", { text: "- User prefers short replies" }, "b2"),
		/^Saved to your memory, in MEMORY\.md \(MEMORY\.md: \d+ of 4000 characters\)\. It shows in your memory from your next conversation; recall finds it now\.$/,
	);
	assert.match(
		read("bots", "b2", "MEMORY.md"),
		/^# Memory\n\n- User prefers short replies \[source: part 1 #10; added: \d{4}-\d{2}-\d{2}\]\n\n## Index\n$/,
	);
	assert.match(
		await tool("remember", { text: "user prefers  SHORT replies" }, "b2"),
		/^Already in your memory \(MEMORY\.md\): "User prefers short replies"\. Nothing changed\.$/,
	);
	assert.match(
		await tool("remember", { text: "User prefers detailed replies", replace: "short replies" }, "b2"),
		/"User prefers short replies" is now "User prefers detailed replies"/,
	);
	assert.match(
		await tool("forget", { entry: "detailed" }, "b2"),
		/^Removed from your memory \(MEMORY\.md\): "User prefers detailed replies", all of it, so save again with remember any part that is still true\. The change log keeps a copy\.$/,
	);
	assert.equal(parseMemory(read("bots", "b2", "MEMORY.md")).entries.length, 0);
	assert.deepEqual(
		journal().map((row) => [row.op, row.scope, row.file, row.actorName]),
		[
			["add", "bot:b2", "MEMORY.md", "Writer"],
			["replace", "bot:b2", "MEMORY.md", "Writer"],
			["remove", "bot:b2", "MEMORY.md", "Writer"],
		],
	);
	await assert.rejects(
		tool("forget", { entry: "nothing like it" }, "b2"),
		/No entry in your memory matches "nothing like it"\. recall shows what is saved\.$/,
	);
});

test("topics hold details, linked from MEMORY.md, and go when their last entry does", async (t) => {
	const { tool, read, stop, home } = await start();
	t.after(() => stop());
	assert.match(
		await tool("remember", { text: "Flies from Hangzhou", topic: "Travel" }, "b2"),
		/in the new topic \[\[travel\]\], linked from MEMORY\.md/,
	);
	assert.match(
		await tool("remember", { text: "Prefers window seats", topic: "travel" }, "b2"),
		/in topic \[\[travel\]\] \(travel\.md: \d+ of 16000 characters\)/,
	);
	assert.match(
		read("bots", "b2", "travel.md"),
		/^# travel\n\n- Flies from Hangzhou \[.*\]\n- Prefers window seats \[.*\]\n$/,
	);
	assert.equal(read("bots", "b2", "MEMORY.md"), "# Memory\n\n## Index\n- [[travel]]\n");
	await assert.rejects(tool("remember", { text: "x", topic: "../up" }, "b2"), /cannot be a topic name/);
	assert.match(
		await tool("recall", { topic: "travel" }, "b2"),
		/^Topic \[\[travel\]\] in your memory \(travel\.md: \d+ of 16000 characters\):\n# travel\n\n- Flies from Hangzhou/,
	);
	assert.match(
		await tool("recall", { query: "window" }, "b2"),
		/^Entries with "window" in your memory and the team memory:\n\[yours · \[\[travel\]\]\] Prefers window seats \[source: part 1 #10; added: /,
	);
	assert.match(
		await tool("recall", {}, "b2"),
		/^Your memory: MEMORY\.md has 0 entries \(MEMORY\.md: \d+ of 4000 characters\); topics \[\[travel\]\] \(2\)\.\n\nThe team memory: MEMORY\.md has 0 entries/,
	);
	await tool("forget", { entry: "Flies" }, "b2");
	assert.match(
		await tool("forget", { entry: "window", topic: "travel" }, "b2"),
		/The topic \[\[travel\]\] was empty, so it is gone too\./,
	);
	assert.equal(existsSync(join(home, "memory", "bots", "b2", "travel.md")), false);
	assert.equal(read("bots", "b2", "MEMORY.md"), "# Memory\n\n## Index\n");
});

test("a write that changed nothing fails the call with a code, and a saved one keeps its answer", async (t) => {
	const { tool, stop } = await start();
	t.after(() => stop());
	assert.match(
		await tool("remember", { text: "Likes tea" }, "b2"),
		/^Saved to your memory, in MEMORY\.md \(MEMORY\.md: \d+ of 4000 characters\)\. It shows in your memory from your next conversation; recall finds it now\.$/,
	);
	await assert.rejects(tool("remember", { text: "Ship on Friday", scope: "team" }, "b2"), (error: any) => {
		assert.equal(error.code, "memory/refused");
		assert.match(error.message, /Only Main Bots and group admins write the team memory/);
		return true;
	});
	await assert.rejects(tool("remember", { text: "  " }, "b2"), (error: any) => {
		assert.equal(error.code, "memory/empty");
		assert.match(error.message, /Write the entry to save\./);
		return true;
	});
	await assert.rejects(tool("forget", { entry: "nothing like it" }, "b2"), (error: any) => {
		assert.equal(error.code, "memory/no-match");
		return true;
	});
});

test("keys, long entries, and full files are refused with what to do instead", async (t) => {
	const { tool, read, stop, home } = await start();
	t.after(() => stop());
	await assert.rejects(
		tool("remember", { text: "API key sk-" + "abcdefghijklmnopqrstuvwx" }, "b2"),
		/looks like a key.*request_secret/,
	);
	await assert.rejects(
		tool("remember", { text: "x".repeat(MEMORY_LIMITS.entry + 1) }, "b2"),
		/at most 300 characters; this one has 301/,
	);
	await assert.rejects(tool("remember", { text: "  " }, "b2"), /Write the entry to save\.$/);
	// A MEMORY.md written past its size by hand still takes a shorter replacement.
	const big = Array.from({ length: 16 }, (_, index) => `- Fact ${index} ${"y".repeat(250)}`);
	mkdirSync(join(home, "memory", "bots", "b2"), { recursive: true });
	writeFileSync(join(home, "memory", "bots", "b2", "MEMORY.md"), `# Memory\n\n${big.join("\n")}\n`);
	await assert.rejects(
		tool("remember", { text: "One more" }, "b2"),
		/MEMORY\.md would have \d+ of its 4000 characters\. Make room first: move details into a topic/,
	);
	assert.match(
		await tool("remember", { text: "Fact 3 is short now", replace: "Fact 3 " }, "b2"),
		/is now "Fact 3 is short now"/,
	);
	assert.match(read("bots", "b2", "MEMORY.md"), /- Fact 3 is short now \[/);
	await assert.rejects(
		tool("forget", { entry: "Fact 1" }, "b2"),
		/matches \d+ entries in your memory; quote more of the one you mean:\n- Fact 1 y+ \(MEMORY\.md\)\n- Fact 10/,
	);
});

test("Main Bots and group admins write the team memory; only Main Bots touch another Bot's", async (t) => {
	const { tool, read, stop } = await start();
	t.after(() => stop());
	await assert.rejects(
		tool("remember", { text: "Ship on Friday", scope: "team" }, "b2"),
		/Only Main Bots and group admins write the team memory/,
	);
	// Coder is the admin of Launch, and speaks there from its group Session.
	assert.match(await tool("remember", { text: "Ship on Friday", scope: "team" }, "g3"), /^Saved to the team memory/);
	assert.match(
		read("team", "MEMORY.md"),
		/- Ship on Friday \[source: group "Launch" \d{2}-\d{2} \d{2}:\d{2}; by: Coder; added: /,
	);
	assert.match(
		await tool("remember", { text: "Writes in Chinese", scope: "Writer" }, "m1"),
		/^Saved to Writer's memory/,
	);
	assert.match(read("bots", "b2", "MEMORY.md"), /- Writes in Chinese \[source: part 1 #10; by: Chief; added: /);
	await assert.rejects(
		tool("remember", { text: "Bossy", scope: "Chief" }, "b2"),
		/Only a Main Bot can change another Bot's memory/,
	);
	assert.match(await tool("recall", { scope: "Writer" }, "b3"), /^Only a Main Bot can read another Bot's memory/);
	assert.match(await tool("recall", { scope: "Nobody" }, "b3"), /^No Bot named Nobody/);
	assert.match(await tool("recall", { query: "friday" }, "b2"), /\[team · MEMORY\.md\] Ship on Friday/);
	await assert.rejects(tool("forget", { entry: "Friday", scope: "team" }, "b2"), /Only Main Bots and group admins/);
	assert.match(await tool("forget", { entry: "Friday", scope: "team" }, "m1"), /^Removed from the team memory/);
	await assert.rejects(tool("remember", { text: "x" }, "stranger"), /Only Bots on the team keep a memory\./);
});

test("in a group, remember and forget write the group memory unless told otherwise, for any member", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(
		join(home, "state.json"),
		JSON.stringify({
			...TEAM,
			rooms: { r1: { ...TEAM.rooms.r1, members: ["b2", "b3", "b4"], sessions: { b2: "g2", b3: "g3" } } },
		}),
	);
	const { tool, read, journal, stop } = await start({ home });
	t.after(() => stop());
	assert.match(
		await tool("remember", { text: "Builds go in the out folder" }, "g2"),
		/^Saved to the group memory, in MEMORY\.md \(MEMORY\.md: \d+ of 4000 characters\)\. Every member sees it in its next conversation in this group; recall finds it now\.$/,
	);
	assert.match(
		read("groups", "r1", "MEMORY.md"),
		/- Builds go in the out folder \[source: group "Launch" \d{2}-\d{2} \d{2}:\d{2}; by: Writer; added: /,
	);
	assert.equal(existsSync(join(home, "memory", "bots", "b2", "MEMORY.md")), false);
	// "own" keeps it for the Bot itself, in all its conversations.
	assert.match(await tool("remember", { text: "I review drafts twice", scope: "own" }, "g2"), /^Saved to your memory/);
	assert.match(read("bots", "b2", "MEMORY.md"), /- I review drafts twice \[source: group "Launch"/);
	// Another member changes the same memory.
	assert.match(
		await tool("remember", { text: "Builds go in the dist folder", replace: "out folder" }, "g3"),
		/"Builds go in the out folder" is now "Builds go in the dist folder"/,
	);
	assert.match(await tool("forget", { entry: "dist folder" }, "g3"), /^Removed from the group memory/);
	assert.deepEqual(
		journal().map((row) => [row.op, row.scope, row.actorName]),
		[
			["add", "group:r1", "Writer"],
			["add", "bot:b2", "Writer"],
			["replace", "group:r1", "Coder"],
			["remove", "group:r1", "Coder"],
		],
	);
	// A Bot's own chat has no group memory to write.
	await assert.rejects(tool("remember", { text: "x", scope: "group" }, "b2"), /There is no group memory here/);
});

// ---------------------------------------------------------------------------
// Snapshots.

test("a Session keeps the memory it began with, across restarts, until its snapshot goes", async (t) => {
	const first = await start();
	t.after(() => first.stop());
	await first.tool("remember", { text: "Likes tea" }, "b2");
	const opened = first.section("b2");
	assert.match(opened, /^# Your memory\n/);
	assert.match(
		opened,
		/## Your memory \(MEMORY\.md\)\n- Likes tea \[source: part 1 #10; added: [\d-]+\]\n\n## Team memory, shared by every Bot \(team\/MEMORY\.md\)\n\(nothing saved yet\)$/,
	);
	assert.match(opened, /when the whole team should know something, tell a Main Bot with message_bot/);
	assert.match(first.section("m1"), /As a Main Bot you write it with remember scope "team"/);
	assert.match(first.section("g3"), /As a group admin you write it/);
	assert.equal(first.section("nobody"), "");
	await first.tool("remember", { text: "Lives in Hangzhou", topic: "home" }, "b2");
	assert.equal(first.section("b2"), opened);
	// Another dsh run finds the snapshot and keeps the same bytes.
	await first.stop({ keep: true });
	const second = await start({ home: first.home });
	await second.tool("recall", {}, "b2");
	assert.equal(second.section("b2"), opened);
	// Without its snapshot (renewMemory removes it), the Session freezes the memory anew.
	await second.stop({ keep: true });
	rmSync(join(first.home, "memory", "snapshots", "b2.md"));
	const renewed = await start({ home: first.home });
	t.after(() => renewed.stop());
	await renewed.tool("recall", {}, "b2");
	assert.match(renewed.section("b2"), /- Likes tea \[.*\]\nTopics: \[\[home\]\]\n/);
});

test("a change of role freezes the section again, so its team rule matches the tools", async (t) => {
	const { tool, section, stop, rt } = await start();
	t.after(() => stop());
	await tool("remember", { text: "Likes tea" }, "b2");
	const before = section("b2");
	assert.match(before, /tell a Main Bot with message_bot/);
	await tool("remember", { text: "Lives in Hangzhou" }, "b2");
	assert.equal(section("b2"), before);
	rt.state.mainBotIds.push("b2");
	const promoted = section("b2");
	assert.match(promoted, /As a Main Bot you write it with remember scope "team"/);
	assert.doesNotMatch(promoted, /tell a Main Bot with message_bot/);
	assert.match(promoted, /- Lives in Hangzhou \[/);
	assert.equal(section("b2"), promoted);
	rt.state.mainBotIds = ["m1"];
	assert.match(section("b2"), /tell a Main Bot with message_bot/);
	assert.match(section("g3"), /As a group admin you write it/);
	const room = rt.roomOf("r1");
	assert.ok(room !== undefined);
	room.admin = "b2";
	assert.match(section("g3"), /tell a Main Bot with message_bot/);
	assert.match(section("b2"), /As a group admin you write it/);
});

test("an explicit change by the user invalidates the snapshots that read it", async (t) => {
	const replies = [JSON.stringify({ reply: "Done.", changes: [{ op: "add", text: "Likes green tea" }] })];
	const { call, section, home, stop } = await start({ replies, overrides: { uiLanguage: () => "English" } });
	t.after(() => stop());
	await call("memory-ask", { botId: "b2", text: "I like green tea now" });
	assert.match(section("b2"), /- Likes green tea \[/);
	// The explicit write removed the snapshot, and the render read the files again.
	assert.equal(existsSync(join(home, "memory", "snapshots", "b2.md")), true);
	// The new entry is what the next render reads, never the snapshot it replaced.
	assert.match(section("b2"), /- Likes green tea \[source: memory panel; by: user; added: \d{4}-\d{2}-\d{2}\]/);
});

test("a memory file that cannot be read is left alone, and the section says so", async (t) => {
	const { home, tool, section, stop } = await start();
	t.after(() => stop());
	// A directory reads as EISDIR on every platform; no chmod games needed.
	mkdirSync(join(home, "memory", "bots", "b2", "MEMORY.md"), { recursive: true });
	await assert.rejects(
		tool("remember", { text: "Likes tea" }, "b2"),
		/Memory file .*MEMORY\.md could not be read \(EISDIR\)\. Ocean Crew leaves it as it is/,
	);
	assert.deepEqual(readdirSync(join(home, "memory", "bots", "b2")), ["MEMORY.md"]);
	// The prompt shows the failure instead of looking empty, and nothing is frozen.
	assert.match(section("b2"), /\(this memory could not be read: EISDIR\)/);
	assert.equal(existsSync(join(home, "memory", "snapshots", "b2.md")), false);
	rmSync(join(home, "memory", "bots", "b2", "MEMORY.md"), { recursive: true });
	const after = section("b2");
	assert.doesNotMatch(after, /could not be read/);
	assert.match(after, /\(nothing saved yet\)/);
});

// ---------------------------------------------------------------------------
// The group memory message.

// ---------------------------------------------------------------------------
// The memory review and its batch states.

async function reviewOnce(setup: Setup, sessionId: string): Promise<void> {
	setup.ctx.emit("agent/status", { agent: { id: sessionId }, status: "idle" });
	await setup.reviewedDone();
}

test("when a turn ends, the memory review keeps what the user said, through the same rules", async (t) => {
	const history = {
		b2: [
			{
				event: {
					seq: 20,
					type: "user/message",
					data: {
						source: { kind: "user" },
						content: [
							{
								type: "text",
								text: "Too busy. I like it plain, mostly black and white. I moved to Rust. The root password is hunter2",
							},
						],
					},
				},
			},
			{
				event: {
					seq: 21,
					type: "assistant/message",
					data: { message: { content: [{ type: "text", text: "Here is a plainer one." }] } },
				},
			},
		],
	};
	const replies: unknown[] = [];
	const setup = await start({ replies, history, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	const { ctx, tool, read, journal, requests, section, reviewed } = setup;
	await tool("remember", { text: "The user writes Go" }, "b2");
	assert.match(section("b2"), /After each of your turns, a memory review reads the new messages/);
	replies.push(
		`\`\`\`json\n${JSON.stringify({
			changes: [
				{ op: "add", text: "The user likes a plain style, mostly black and white" },
				{ op: "add", text: "Everyone should keep it plain", team: true },
				{ op: "edit", entry: 1, text: "The user writes Rust" },
				{ op: "add", text: "The root password is hunter2" },
			],
		})}\n\`\`\``,
	);
	await reviewOnce(setup, "b2");
	assert.equal(requests.length, 1);
	assert.match(String(requests[0]!.system), /^You keep the long-term memory of one Bot/);
	assert.doesNotMatch(String(requests[0]!.system), /"team": true/);
	assert.equal(
		String((requests[0]!.messages as any[])[0].content[0].text),
		[
			"The Bot: Writer, 写作.",
			"",
			"MEMORY.md has 81 of 4000 characters (own) and 0 of 4000 (team).",
			"",
			"Its memory now (own: this Bot's; team: shared by every Bot):",
			"[1] (own) The user writes Go",
			"",
			"New in its own chat with the user, oldest first:",
			"User: Too busy. I like it plain, mostly black and white. I moved to Rust. The root password is hunter2",
			"Writer: Here is a plainer one.",
			"",
			"Write every new or changed entry in English.",
		].join("\n"),
	);
	// Writer writes no team memory, so the team entry stays its own; no password is kept.
	const entries = parseMemory(read("bots", "b2", "MEMORY.md")).entries;
	assert.deepEqual(
		entries.map((entry) => entry.text),
		["The user writes Rust", "The user likes a plain style, mostly black and white", "Everyone should keep it plain"],
	);
	assert.equal(entries[1]!.meta.source, "part 1 #20");
	assert.deepEqual(
		journal()
			.slice(1)
			.map((row) => [row.op, row.actorName, row.auto]),
		[
			["add", "Writer", true],
			["add", "Writer", true],
			["replace", "Writer", true],
		],
	);
	// The batch is one committed step, with an id and its op ids in the rows.
	const state = reviewed();
	const key = "chat:b2";
	const entry = state[key] as Record<string, any>;
	assert.equal(entry.cursor, 21);
	const batches = Object.values(entry.batches as Record<string, any>);
	assert.equal(batches.length, 1);
	// The answer was well formed; one change (the password) could not be kept, so the
	// batch is partial: the kept changes committed and the gap stays visible.
	assert.equal(batches[0].status, "partial");
	assert.ok(batches[0].leftOut >= 1);
	assert.ok(
		journal().some((row) => typeof row.opId === "string" && String(row.opId).startsWith(String(batches[0].id))),
	);
	void ctx;
});

test("a valid answer with nothing to keep commits as valid_empty; no user line needs no model call", async (t) => {
	const replies = [JSON.stringify({ changes: [] })];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	const { ctx } = setup;
	await reviewOnce(setup, "b2");
	assert.equal(setup.requests.length, 1);
	const entry = setup.reviewed()["chat:b2"] as Record<string, any>;
	assert.equal(entry.cursor, 11);
	const batches = Object.values(entry.batches as Record<string, any>) as Array<Record<string, any>>;
	const [batch] = batches;
	assert.equal(batch?.status, "valid_empty");
	// A later idle with nothing new to read calls no model and commits nothing new.
	ctx.emit("agent/status", { agent: { id: "b2" }, status: "idle" });
	await setup.reviewedDone();
	assert.equal(setup.requests.length, 1);
});

test("a parse failure holds the cursor, a limited retry follows, then repair_required; retry repairs it", async (t) => {
	const replies = [
		"Nothing worth keeping here.",
		"Still no list.",
		"Yet another miss.",
		JSON.stringify({ changes: [{ op: "add", text: "The user wants this remembered" }] }),
	];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	const { ctx } = setup;
	// Three attempts, all unparsable: the committed cursor never moves and the batch
	// becomes repair_required.
	for (let at = 0; at < 3; at += 1) {
		ctx.emit("agent/status", { agent: { id: "b2" }, status: "idle" });
		await setup.reviewedDone();
		assert.equal(setup.requests.length, at + 1);
		const state = setup.reviewed()["chat:b2"] as Record<string, any>;
		if (at < 2) {
			assert.equal(state.cursor, undefined);
			const batches = Object.values(state.batches as Record<string, any>) as Array<Record<string, any>>;
			assert.equal(batches.at(-1)!.status, "parse_failed");
			assert.equal(batches.at(-1)!.attempts, at + 1);
		} else {
			assert.equal(state.cursor, undefined);
			assert.equal(state.repair.status, "repair_required");
			assert.equal(state.repair.attempts, 3);
		}
	}
	assert.ok(setup.warnings.some((line) => /repair_required/.test(line)));
	// A further idle does nothing while the repair waits.
	ctx.emit("agent/status", { agent: { id: "b2" }, status: "idle" });
	await setup.reviewedDone();
	assert.equal(setup.requests.length, 3);
	// The user retries the repair: the same lines are read again and applied.
	assert.equal((await setup.rt.memoryReviewRepair("chat:b2", "retry")).repair, null);
	ctx.emit("agent/status", { agent: { id: "b2" }, status: "idle" });
	await setup.reviewedDone();
	assert.equal(setup.requests.length, 4);
	assert.match(setup.read("bots", "b2", "MEMORY.md"), /- The user wants this remembered \[/);
	const repaired = setup.reviewed()["chat:b2"] as Record<string, any>;
	assert.equal(repaired.cursor, 11);
	assert.equal(repaired.repair, undefined);
});

test("discarding a repair_required batch moves the cursor past it and keeps the gap", async (t) => {
	const replies = ["no list", "no list", "no list"];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	for (let at = 0; at < 3; at += 1) await reviewOnce(setup, "b2");
	const state = setup.reviewed()["chat:b2"] as Record<string, any>;
	assert.equal(state.repair.status, "repair_required");
	const through = state.repair.through;
	await setup.rt.memoryReviewRepair("chat:b2", "discard");
	const discarded = setup.reviewed()["chat:b2"] as Record<string, any>;
	assert.equal(discarded.cursor, through);
	assert.equal(discarded.repair, undefined);
	// The batch record stays, marked discarded, so the gap remains visible.
	const batches = Object.values(discarded.batches as Record<string, any>) as Array<Record<string, any>>;
	assert.ok(batches.some((batch) => batch.status === "discarded"));
	// Nothing more is read for those lines.
	assert.equal(
		await setup.rt.memoryReviewRepair("chat:b2", "retry").catch((error: Error) => error.message),
		"No memory review repair is waiting for chat:b2.",
	);
});

test("a review that writes again from the same batch lands each change once by its op id", async (t) => {
	const replies = [
		JSON.stringify({
			changes: [
				{ op: "add", text: "The user likes tea" },
				{ op: "add", text: "The user writes Rust" },
			],
		}),
		JSON.stringify({
			changes: [
				{ op: "add", text: "The user likes tea" },
				{ op: "add", text: "The user writes Rust" },
			],
		}),
	];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	// A duplicate replay of the same batch (as after a crash between apply and ack)
	// must not duplicate the entries; the op ids in the journal skip what landed.
	await reviewOnce(setup, "b2");
	const entries = parseMemory(setup.read("bots", "b2", "MEMORY.md")).entries;
	assert.deepEqual(
		entries.map((entry) => entry.text),
		["The user likes tea", "The user writes Rust"],
	);
	// The second turn's review reads the new line only; a replay of the same changes
	// changes nothing (the entries are already there). The cursor commits valid_empty.
	setup.requests.length = 0;
	await reviewOnce(setup, "b2");
	assert.equal(parseMemory(setup.read("bots", "b2", "MEMORY.md")).entries.length, 2);
});

test("a toolbar batch's write failure holds the cursor and is retried without losing the place", async (t) => {
	const replies = [
		JSON.stringify({ changes: [{ op: "add", text: "The user likes tea" }] }),
		JSON.stringify({ changes: [{ op: "add", text: "The user likes tea" }] }),
	];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	const { home } = setup;
	// The change cannot be published while the change log is a directory.
	mkdirSync(join(home, "memory", "journal.jsonl"), { recursive: true });
	await reviewOnce(setup, "b2");
	const failed = setup.reviewed()["chat:b2"] as Record<string, any>;
	assert.equal(failed.cursor, undefined);
	const failedBatch = (Object.values(failed.batches as Record<string, any>) as Array<Record<string, any>>).at(-1)!;
	assert.equal(failedBatch.status, "write_failed");
	assert.match(setup.warnings.join("\n"), /its place is kept/);
	// Once the log is writable again, the same lines are read and kept.
	rmSync(join(home, "memory", "journal.jsonl"), { recursive: true, force: true });
	await reviewOnce(setup, "b2");
	assert.match(setup.read("bots", "b2", "MEMORY.md"), /- The user likes tea \[/);
	assert.equal((setup.reviewed()["chat:b2"] as Record<string, any>).cursor, 11);
});

test("a full answer is re-read once, and a change set aside does not re-arm the review", async (t) => {
	const many = Array.from({ length: 9 }, (_, at) => ({ op: "add", text: `The user likes thing ${at + 1}` }));
	const replies = [JSON.stringify({ changes: many }), JSON.stringify({ changes: [many[8]] })];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	await reviewOnce(setup, "b2");
	assert.equal(setup.requests.length, 2);
	assert.match(String(setup.requests[0]!.system), /At most 8 changes in one answer/);
	assert.equal(parseMemory(setup.read("bots", "b2", "MEMORY.md")).entries.length, 9);
	assert.equal((setup.reviewed()["chat:b2"] as Record<string, any>).cursor, 11);
});

test("a backlog past the text limit is reviewed in passes, oldest first", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	mkdirSync(join(home, "memory"), { recursive: true });
	writeFileSync(join(home, "memory", "reviewed.json"), JSON.stringify({ "chat:b2": 19 }));
	const notes = Array.from({ length: 8 }, (_, at) => ({
		event: {
			seq: 20 + at,
			type: "user/message",
			data: { source: { kind: "user" }, content: [{ type: "text", text: `Note ${at + 1} ${"x".repeat(2480)}` }] },
		},
	}));
	const replies = [JSON.stringify({ changes: [] }), JSON.stringify({ changes: [] })];
	const setup = await start({ home, replies, history: { b2: notes }, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	await reviewOnce(setup, "b2");
	assert.equal(setup.requests.length, 2);
	const [first, second] = setup.requests.map((request) => String((request.messages as any[])[0].content[0].text));
	assert.match(first!, /oldest first \(newer messages come in the next review\):\nUser: Note 1 /);
	assert.deepEqual(first!.match(/Note \d/g), ["Note 1", "Note 2", "Note 3", "Note 4", "Note 5", "Note 6"]);
	assert.deepEqual(second!.match(/Note \d/g)?.slice(-2), ["Note 7", "Note 8"]);
	assert.equal((setup.reviewed()["chat:b2"] as Record<string, any>).cursor, 27);
});

test("a group's review keeps what is said there in the group memory, read once for all its members", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-memory-"));
	writeFileSync(
		join(home, "state.json"),
		JSON.stringify({
			...TEAM,
			rooms: { r1: { ...TEAM.rooms.r1, members: ["b2", "b3", "b4"], sessions: { b2: "g2", b3: "g3" } } },
		}),
	);
	const replies = [
		JSON.stringify({ changes: [{ op: "add", text: "The user wants everything under one page", team: true }] }),
	];
	const setup = await start({ home, replies, config: { memoryReviewDelayMs: 0 } });
	t.after(() => setup.stop());
	const { ctx, read, requests, reviewed } = setup;
	await reviewOnce(setup, "g3");
	assert.equal(requests.length, 1);
	assert.match(String(requests[0]!.system), /^You keep the long-term memory of one group chat/);
	// The admin's model reads it, but no team entry comes of a group's review.
	assert.doesNotMatch(String(requests[0]!.system), /"team": true/);
	assert.equal(requests[0]!.sessionId, "r1");
	const text = String((requests[0]!.messages as any[])[0].content[0].text);
	assert.match(
		text,
		/^The group chat: "Launch", with the user and Writer, Coder \(admin\), Temp\.\n\nMEMORY\.md has 0 of 4000 characters \(group\) and 0 of 4000 \(team\)\.\n\nIts memory now \(group: shared by the members of this group; team: shared by every Bot\):\n\(none yet\)\n/,
	);
	assert.match(
		text,
		/New in the group chat "Launch", oldest first:\nUser: Keep everything you send me under one page\nCoder: Will do\.\n\nWrite every new or changed entry in English\.$/,
	);
	assert.match(
		read("groups", "r1", "MEMORY.md"),
		/- The user wants everything under one page \[source: group "Launch" \d{2}-\d{2} \d{2}:\d{2}; added: /,
	);
	for (const elsewhere of [["team"], ["bots", "b2"], ["bots", "b3"]])
		assert.equal(existsSync(join(home, "memory", ...elsewhere, "MEMORY.md")), false, elsewhere.join("/"));
	assert.equal((reviewed()["group:r1"] as Record<string, any>).cursor, 3);
	// The members read it in their Sessions there, and no Bot reads it anywhere else.
	for (const [member, bot] of [
		["g2", "b2"],
		["g3", "b3"],
	] as const) {
		assert.equal(setup.section(member), setup.section(bot));
		const message = await setup.preStep(member);
		assert.match(
			String(message === undefined ? undefined : (message as any).content[0].text),
			/^## Group memory, shared by the members of this group chat\nOnly the members of this group read it[^\n]*\n\n- The user wants everything under one page \[source: group "Launch"[^\n]*\]$/,
		);
		assert.match(
			await setup.tool("recall", { query: "page" }, member),
			/^Entries with "page" in your memory, the group memory, and the team memory:\n\[group · MEMORY\.md\] The user wants everything under one page/,
		);
	}
	for (const elsewhere of ["b2", "b3", "b4", "m1"]) {
		assert.doesNotMatch(setup.section(elsewhere), /one page|Group memory/, elsewhere);
		assert.equal(await setup.preStep(elsewhere), undefined, elsewhere);
	}
	void ctx;
});

// ---------------------------------------------------------------------------
// The panel, undo, archive and read-only.

test("a host that only reads the team shows memory but changes none of it", async (t) => {
	const setup = await start();
	t.after(() => setup.stop());
	// A foreign lock makes this host read-only, as store.ts reports it.
	await setup.rt.load();
	setup.rt.readOnly = () => "The Bot team is open in another dsh.";
	await assert.rejects(
		setup.tool("remember", { text: "Likes tea" }, "b2"),
		/Memory cannot change now: The Bot team is open in another dsh\./,
	);
	assert.equal(((await setup.call("memory-view", { botId: "b2" })) as Record<string, any>).entries.length, 0);
	// The panel may read; a change cannot be written, and its write is refused.
	await assert.rejects(
		setup.call("memory-ask", { botId: "b2", text: "hi" }),
		/The model wrote nothing|Memory cannot change now/,
	);
	assert.match(setup.section("b2"), /^# Your memory/);
	assert.equal(existsSync(join(setup.home, "memory", "snapshots")), false);
});

test("the memory panel shows every entry and a summary the Bot's model writes once per change", async (t) => {
	const replies = ["## Overview\nYou like tea."];
	const setup = await start({ replies, overrides: { uiLanguage: () => "English" } });
	const { tool, call, requests, stop } = setup;
	t.after(() => stop());
	const empty = (await call("memory-view", { botId: "b2", summarize: true })) as Record<string, any>;
	assert.deepEqual([empty.entries, empty.summary, empty.fresh, empty.summarizing], [[], null, true, false]);
	assert.deepEqual(empty.limits, MEMORY_LIMITS);
	assert.equal(requests.length, 0);
	await tool("remember", { text: "Likes tea" }, "b2");
	const asked = (await call("memory-view", { botId: "b2", summarize: true })) as Record<string, any>;
	assert.deepEqual(
		asked.entries.map((entry: any) => [entry.scope, entry.topic, entry.text]),
		[["own", null, "Likes tea"]],
	);
	assert.equal(asked.summarizing, true);
	await setup.summarized("b2");
	const done = (await call("memory-view", { botId: "b2", summarize: true })) as Record<string, any>;
	assert.deepEqual(
		[done.summary.text, done.fresh, done.summarizing, done.error],
		["## Overview\nYou like tea.", true, false, null],
	);
	assert.equal(requests.length, 1);
	assert.deepEqual(
		[requests[0]!.provider, requests[0]!.model, requests[0]!.reasoningEffort],
		["deepseek", "v4", "off"],
	);
	assert.match(
		String((requests[0]!.messages as any[])[0].content[0].text),
		/## Writer's memory\n- Likes tea\n\n## Team memory\n\(nothing\)/,
	);
	// A new entry leaves the old summary up, marked stale, until the next one is in.
	await tool("remember", { text: "Lives in Hangzhou" }, "b2");
	assert.equal(((await call("memory-view", { botId: "b2", summarize: true })) as Record<string, any>).fresh, false);
	await assert.rejects(call("memory-view", { botId: "nope" }), /Unknown Bot/);
});

test("a journal line restores its change: remove, replace, and add undone; drift is refused", async (t) => {
	const { tool, call, read, journal, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "User prefers short replies" }, "b2");
	const added = journal().at(-1)!;
	assert.equal(added.op, "add");
	await tool("forget", { entry: "short replies" }, "b2");
	const removed = journal().at(-1)!;
	assert.equal(removed.op, "remove");
	assert.equal(parseMemory(read("bots", "b2", "MEMORY.md")).entries.length, 0);
	await call("memory-restore", { botId: "b2", id: removed.id });
	assert.match(read("bots", "b2", "MEMORY.md"), /- User prefers short replies \[/);
	assert.equal(journal().at(-1)!.op, "add");
	assert.equal(journal().at(-1)!.restored, removed.id);
	// A remove already undone is not undone twice.
	await assert.rejects(call("memory-restore", { botId: "b2", id: removed.id }), /already restored/);
	// Undoing an add takes the line back out, while it still reads as written.
	await call("memory-restore", { botId: "b2", id: added.id });
	assert.equal(journal().at(-1)!.op, "remove");
	assert.equal(parseMemory(read("bots", "b2", "MEMORY.md")).entries.length, 0);
	// A replace puts the before-line back.
	await tool("remember", { text: "Lives in Hangzhou" }, "b2");
	await tool("remember", { text: "Lives in Shanghai", replace: "Hangzhou" }, "b2");
	const replaced = journal().at(-1)!;
	await call("memory-restore", { botId: "b2", id: replaced.id });
	assert.match(read("bots", "b2", "MEMORY.md"), /- Lives in Hangzhou \[/);
	assert.doesNotMatch(read("bots", "b2", "MEMORY.md"), /Shanghai/);
	// Drift: the entry the add wrote was replaced since, so undoing it now is NO_MATCH.
	await tool("remember", { text: "Wears a green coat" }, "b2");
	const coat = journal().at(-1)!;
	await tool("remember", { text: "Wears a red coat", replace: "green coat" }, "b2");
	await assert.rejects(
		call("memory-restore", { botId: "b2", id: coat.id }),
		/no longer in|not where the change log left it/,
	);
	// Missing ids are refused.
	await assert.rejects(call("memory-restore", { botId: "b2", id: "" }), /change log id/);
	await assert.rejects(
		call("memory-restore", { botId: "b2", id: "row-that-is-not-there" }),
		/not in the change log of this memory/,
	);
});

test("memory-history lists a Bot's own and team changes, newest first, and pages", async (t) => {
	const { tool, call, journal, stop, home } = await start();
	t.after(() => stop());
	await tool("remember", { text: "Team drinks tea", scope: "team" }, "m1");
	await tool("remember", { text: "Likes quiet mornings" }, "b2");
	await tool("remember", { text: "Another Bot fact" }, "b4");
	const page = await call("memory-history", { botId: "b2" });
	assert.equal(page.more, null);
	assert.deepEqual(
		page.rows.map((row: any) => [row.op, row.scope, row.by]),
		[
			["add", "own", "Writer"],
			["add", "team", "Chief"],
		],
	);
	assert.match(page.rows[0].text, /Likes quiet mornings/);
	assert.equal(
		page.rows.every((row: any) => row.restored === false),
		true,
	);
	assert.equal(journal().length, 3);
	// 60 synthetic rows make a second page.
	const journalPath = join(home, "memory", "journal.jsonl");
	const forged = Array.from({ length: 60 }, (_, i) => ({
		id: `old-${i}`,
		time: new Date(Date.now() - (60 - i) * 1000).toISOString(),
		op: "add",
		scope: "bot:b2",
		file: "MEMORY.md",
		actor: "user",
		actorName: "user",
		after: `- forged ${i}`,
	}));
	writeFileSync(
		journalPath,
		`${journal()
			.map((row) => JSON.stringify(row))
			.join("\n")}\n${forged.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	const first = await call("memory-history", { botId: "b2" });
	assert.equal(first.rows.length, 50);
	assert.notEqual(first.more, null);
	const second = await call("memory-history", { botId: "b2", before: first.more });
	assert.equal(second.rows.length, 12);
	assert.equal(second.more, null);
	assert.equal(second.rows.at(-1).id, "old-0");
});

test("deleting a Bot and a group moves their memory to the archive", async (t) => {
	const { tool, stop, home, rt } = await start();
	t.after(() => stop());
	await tool("remember", { text: "Temporary fact" }, "b4");
	const folder = join(home, "memory", "bots", "b4");
	assert.equal(existsSync(folder), true);
	await rt.archiveBotMemory("b4");
	assert.equal(existsSync(folder), false);
	const [archived] = readdirSync(join(home, "memory", "archive"));
	assert.match(String(archived), /^b4-\d{4}-/);
	assert.match(readFileSync(join(home, "memory", "archive", String(archived), "MEMORY.md"), "utf8"), /Temporary fact/);
	await tool("remember", { text: "Ship on Friday" }, "g3");
	const group = join(home, "memory", "groups", "r1");
	assert.equal(existsSync(group), true);
	const room = rt.roomOf("r1");
	await rt.archiveGroupMemory(room);
	assert.equal(existsSync(group), false);
	assert.ok(readdirSync(join(home, "memory", "archive")).some((name) => /^group-r1-/.test(name)));
});

test("the retrieval port returns active entries with where they came from", async (t) => {
	const { tool, rt, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "Likes green tea" }, "b2");
	await tool("remember", { text: "Trip to Kyoto", topic: "travel" }, "b2");
	const found = (await rt.memorySearch({ botId: "b2" }, { query: "tea" })) as Array<Record<string, any>>;
	assert.deepEqual(
		found.map((hit) => [hit.scope, hit.topic, hit.text]),
		[["own", null, "Likes green tea"]],
	);
	assert.equal((await rt.memorySearch({ botId: "b2" }, { topic: "travel" }))[0].text, "Trip to Kyoto");
	// A group's port reads the group and the team, not a Bot's own.
	const group = (await rt.memorySearch({ roomId: "r1" }, {})) as Array<Record<string, any>>;
	assert.deepEqual(group, []);
});

test("config.memory false leaves the tools, the section, and the panel out", async (t) => {
	const { ctx, call, stop, rt } = await start({ config: { memory: false } });
	t.after(() => stop());
	assert.ok(!ctx.calls.some((entry) => /tool (remember|forget|recall)|bot-memory/.test(entry)));
	assert.equal(
		await call("memory-view", { botId: "b2" }).catch((error: Error) => error.message),
		"Memory is turned off on this host",
	);
	assert.equal(rt.memoryEnabled, false);
	assert.equal(rt.memoryReviews(), 0);
});

test("a summary cut off at the output limit is written once more with a bigger budget", async (t) => {
	const replies = [{ text: "## Overview\nYou like", finish: "max-tokens" }, "## Overview\nYou like tea."];
	const setup = await start({ replies, overrides: { uiLanguage: () => "English" } });
	const { tool, call, requests, stop } = setup;
	t.after(() => stop());
	await tool("remember", { text: "Likes tea" }, "b2");
	await call("memory-view", { botId: "b2", summarize: true });
	await setup.summarized("b2");
	const done = (await call("memory-view", { botId: "b2" })) as Record<string, any>;
	assert.deepEqual([done.summary?.text, done.fresh, done.error], ["## Overview\nYou like tea.", true, null]);
	assert.deepEqual(
		requests.map((request) => request.maxTokens),
		[2048, 8192],
	);
});

test("a summary the Bot's model refuses is written by the profile default model", async (t) => {
	const replies = [{ text: "", finish: "error", failure: "403 Forbidden" }, "## Overview\nYou like tea."];
	const setup = await start({
		replies,
		models: ["v4", "flash"],
		defaultModel: "flash",
		overrides: { uiLanguage: () => "English" },
	});
	const { tool, call, requests, stop } = setup;
	t.after(() => stop());
	await tool("remember", { text: "Likes tea" }, "b2");
	await call("memory-view", { botId: "b2", summarize: true });
	await setup.summarized("b2");
	const done = (await call("memory-view", { botId: "b2" })) as Record<string, any>;
	assert.deepEqual([done.summary?.text, done.fresh, done.error], ["## Overview\nYou like tea.", true, null]);
	assert.deepEqual(
		requests.map((request) => `${request.provider}/${request.model}@${request.maxTokens}`),
		["deepseek/v4@2048", "deepseek/flash@2048"],
	);
});

test("an explicit forget removes the entry, journals it as the user's, and refreshes the snapshot", async (t) => {
	const setup = await start();
	const { tool, call, journal, section, home, stop } = setup;
	t.after(() => stop());
	await tool("remember", { text: "Likes tea" }, "b2");
	assert.match(section("b2"), /- Likes tea \[/);
	assert.equal(existsSync(join(home, "memory", "snapshots", "b2.md")), true);
	await call("memory-forget", { botId: "b2", scope: "own", topic: null, text: "Likes tea" });
	const row = journal().at(-1)!;
	assert.deepEqual([row.op, row.actor, row.actorName], ["remove", "user", "user"]);
	// The snapshot that read the entry is gone, never revived: the next render reads the
	// files, where the entry no longer is.
	assert.equal(existsSync(join(home, "memory", "snapshots", "b2.md")), false);
	assert.doesNotMatch(section("b2"), /- Likes tea \[/);
});

test("the retrieval port reads a group's memory and the team's, not a Bot's own", async (t) => {
	const setup = await start();
	const { tool, rt, stop } = setup;
	t.after(() => stop());
	await tool("remember", { text: "Keep replies under one page" }, "g3");
	await tool("remember", { text: "Ship on Friday", scope: "team" }, "m1");
	assert.deepEqual(
		(await rt.memorySearch({ roomId: "r1" }, { limit: 5 })).map((hit: any) => hit.scope),
		["group", "team"],
	);
	assert.deepEqual(
		(await rt.memorySearch({ botId: "b2" }, { query: "friday" })).map((hit: any) => [hit.scope, hit.text]),
		[["team", "Ship on Friday"]],
	);
});

test("config.memoryReview false leaves memory to the Bots' own remember calls", async (t) => {
	const setup = await start({ config: { memoryReview: false, memoryReviewDelayMs: 0 } });
	const { ctx, requests, section, home, stop } = setup;
	t.after(() => stop());
	assert.match(section("b2"), /Call it in that same turn, before you reply/);
	assert.equal(ctx.listeners.get("agent/status")?.length ?? 0, 0);
	ctx.emit("agent/status", { agent: { id: "b2" }, status: "idle" });
	await settle();
	assert.equal(requests.length, 0);
	assert.equal(setup.rt.memoryReviews(), 0);
	assert.equal(existsSync(join(home, "memory", "reviewed.json")), false);
});

test("a conversation waiting for repair does not stop another conversation's review", async (t) => {
	const replies = [
		"no list",
		"no list",
		"no list",
		JSON.stringify({ changes: [{ op: "add", text: "The group keeps it short" }] }),
	];
	const setup = await start({ replies, config: { memoryReviewDelayMs: 0 } });
	const { ctx, read, requests, reviewed, stop } = setup;
	t.after(() => stop());
	// Writer's own chat fails three times and waits for repair.
	for (let at = 0; at < 3; at += 1) await reviewOnce(setup, "b2");
	assert.equal((reviewed()["chat:b2"] as Record<string, any>).repair.status, "repair_required");
	// The group's review is another conversation: it runs, with its own place.
	await reviewOnce(setup, "g3");
	assert.equal(requests.length, 4);
	assert.match(read("groups", "r1", "MEMORY.md"), /- The group keeps it short \[/);
	// The blocked chat still reads no more lines, and its committed cursor never moved.
	assert.equal((reviewed()["chat:b2"] as Record<string, any>).cursor, undefined);
	ctx.emit("agent/status", { agent: { id: "b2" }, status: "idle" });
	await setup.reviewedDone();
	assert.equal(requests.length, 4);
});

// ---------------------------------------------------------------------------
// Forgetting a range leaves tombstones: the fact stays gone.

test("a range forget removes every matching entry and none of the others", async (t) => {
	const { tool, rt, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "The user lives in Shanghai" }, "m1");
	await tool("remember", { text: "The user prefers metric units" }, "m1");
	await tool("forget", { entry: "shanghai", range: true }, "m1");
	const recalled = (await rt.memorySearch({ botId: "m1" }, { query: "" })) as Array<Record<string, any>>;
	assert.deepEqual(
		recalled.map((hit) => hit.text),
		["The user prefers metric units"],
	);
});

test("a forgotten fact cannot be saved again, recalled, or restored from the change log", async (t) => {
	const { tool, rt, call, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "The user's card ends in 4242" }, "m1");
	await tool("forget", { entry: "card ends in 4242", range: true }, "m1");
	assert.deepEqual(await rt.memorySearch({ botId: "m1" }, { query: "card" }), []);
	await assert.rejects(
		async () => await tool("remember", { text: "The user's card ends in 4242" }, "m1"),
		/forget this/i,
	);
	// The change log still holds the add, but restoring it is refused.
	const history = await call("memory-history", { botId: "m1" });
	const add = history.rows.find((row: any) => row.op === "add");
	assert.ok(add !== undefined, "the add row is still in the change log");
	await assert.rejects(async () => await call("memory-restore", { botId: "m1", id: add.id }), /forget this/i);
});

test("a tombstone holds no text, only a hash", async (t) => {
	const { tool, home, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "The user's passport number is X1234" }, "m1");
	await tool("forget", { entry: "passport number", range: true }, "m1");
	const saved = readFileSync(join(home, "memory", "bots", "m1", "tombstones.json"), "utf8");
	assert.ok(!saved.includes("passport"), "the tombstone keeps no text");
	assert.ok(!saved.includes("X1234"), "the tombstone keeps no value");
	assert.equal(JSON.parse(saved).hashes.length, 1);
});

test("undoing a forget cannot bring the forgotten text back", async (t) => {
	const { tool, call, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "The user's card ends in 4242" }, "m1");
	await tool("forget", { entry: "card ends in 4242", range: true }, "m1");
	// Undoing a forget means restoring its `remove` row, which carries the text in
	// `before`; the tombstone must refuse that path too, not only the add row.
	const history = await call("memory-history", { botId: "m1" });
	const removed = history.rows.find((row: any) => row.op === "remove");
	assert.ok(removed !== undefined, "the remove row is in the change log");
	await assert.rejects(async () => await call("memory-restore", { botId: "m1", id: removed.id }), /forget this/i);
	// The change log does not show the text either: the row stays, its content does not.
	assert.equal(removed.text, "[forgotten]");
});

test("an unreadable tombstone file does not read as an empty one", async (t) => {
	const { tool, home, call, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "The user's card ends in 4242" }, "m1");
	await tool("forget", { entry: "card ends in 4242", range: true }, "m1");
	const path = join(home, "memory", "bots", "m1", "tombstones.json");
	writeFileSync(path, "{not json");
	// A damaged tombstone file must not let the fact back in, nor be treated as absent.
	await assert.rejects(async () => await call("memory-history", { botId: "m1" }), /could not be read/i);
	const kept = readdirSync(join(home, "memory", "bots", "m1")).filter((name) => name.includes(".corrupt-"));
	assert.equal(kept.length, 1, "the damaged file is kept for inspection");
});

test("a forget reports the layers it covered instead of implying a full delete", async (t) => {
	const { tool, rt, call, stop } = await start();
	t.after(() => stop());
	await tool("remember", { text: "The user lives in Shanghai" }, "m1");
	await tool("remember", { text: "The user prefers metric units" }, "m1");
	const result: any = await call("memory-forget", { botId: "m1", text: "shanghai", range: true });
	assert.equal(result.forgotten.removed, 1);
	// Only the matching entry is gone; the rest of the memory is still there.
	const recalled = (await rt.memorySearch({ botId: "m1" }, { query: "" })) as Array<Record<string, any>>;
	assert.deepEqual(
		recalled.map((hit) => hit.text),
		["The user prefers metric units"],
	);
	assert.equal(result.forgotten.layers.memory.removed, 1);
	assert.equal(result.forgotten.layers.snapshots, "invalidated");
	// The change log keeps its rows, the chats were never the plugin's, backups are not touched.
	assert.equal(result.forgotten.layers.journal, "kept-without-restore");
	assert.equal(result.forgotten.layers.chats, "untouched");
	assert.equal(result.forgotten.layers.backups, "untouched");
});

test("the last review's outcome is visible per conversation", async (t) => {
	const { call, home, rt, stop } = await start();
	t.after(() => stop());
	// A stored review state is what the interface reads: a legitimate empty answer and a
	// partial application are different results and must not look the same.
	const reviewedPath = join(home, "memory", "reviewed.json");
	mkdirSync(dirname(reviewedPath), { recursive: true });
	writeFileSync(
		reviewedPath,
		JSON.stringify({
			"chat:b1": {
				cursor: 10,
				batches: {
					other: { id: "other", status: "valid_empty", attempts: 1, at: 1 },
					latest: {
						id: "latest",
						status: "partial",
						attempts: 1,
						leftOut: 2,
						message: "2 entries were refused",
						at: 2,
					},
				},
				repair: { id: "r", status: "repair_required", attempts: 2, message: "unreadable answer", at: 3 },
			},
		}),
	);
	const view = (rt as any).memoryReviewStates?.() ?? {};
	const state = view["chat:b1"];
	assert.ok(state !== undefined, "the conversation has a visible review state");
	assert.equal(state.status, "partial");
	assert.equal(state.leftOut, 2);
	assert.equal(state.repair.status, "repair_required");
	assert.equal(state.repair.attempts, 2);
});

test("the panel shows the review outcome of its own conversations only", async (t) => {
	const { call, home, stop } = await start();
	t.after(() => stop());
	// b2's own chat and another Bot's chat: the panel must show the first and not the second.
	const reviewedPath = join(home, "memory", "reviewed.json");
	mkdirSync(dirname(reviewedPath), { recursive: true });
	writeFileSync(
		reviewedPath,
		JSON.stringify({
			"chat:b2": {
				cursor: 5,
				batches: {
					b1: { id: "b1", status: "partial", attempts: 1, leftOut: 2, message: "2 entries were refused", at: 20 },
				},
			},
			"chat:b3": {
				cursor: 5,
				batches: { b1: { id: "b1", status: "parse_failed", attempts: 3, at: 30 } },
			},
		}),
	);
	const view: any = await call("memory-view", { botId: "b2" });
	assert.equal(view.reviews.length, 1, "only this Bot's conversation is reported");
	assert.equal(view.reviews[0].sessionId, "b2");
	assert.equal(view.reviews[0].status, "partial");
	assert.equal(view.reviews[0].leftOut, 2);
	const other: any = await call("memory-view", { botId: "m1" });
	assert.deepEqual(other.reviews, [], "another Bot's reviews are not shown");
});
