// Delivery behavior: the relay header a model reads, the source fields turns and resume
// read, the exchange record (with its 600/2000 bounds), and long text that goes as a DSH
// file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headerFor, install } from "../src/host/chat/delivery.ts";
import { MESSAGE_INLINE_MAX, READ_LINE_MAX, TEXT_KEPT, TEXT_SHOW_MAX } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { fakeAttachments, fakeContext } from "./fake-ctx.ts";

interface TestHost {
	rt: Runtime & Record<string, any>;
	ctx: any;
	agents: Map<string, any>;
	bots: Record<string, any>;
	saves: () => number;
	warnings: unknown[][];
	flushes: number;
	agentOf(id: string): any;
	dispose(): Promise<unknown>;
}

interface HostOptions {
	attachments?: ReturnType<typeof fakeAttachments>;
	room?: { id: string; name: string; sessions?: Record<string, string> };
}

function runtime(options: HostOptions = {}): TestHost {
	const ctx = fakeContext({
		services: options.attachments === undefined ? {} : { attachments: options.attachments },
	}) as any;
	const agents = new Map<string, any>();
	const bots: Record<string, any> = { a: { id: "a", name: "Chief" }, b: { id: "b", name: "Writer" } };
	const warnings: unknown[][] = [];
	const state: any = { exchanges: [], works: {} };
	let saveCount = 0;
	const flushes: string[] = [];
	const agentOf = (id: string): any => {
		if (!agents.has(id)) {
			const calls: any[] = [];
			agents.set(id, {
				session: { id },
				status: "idle",
				calls,
				followup(message: any) {
					calls.push(["followup", message]);
				},
				steer(message: any) {
					calls.push(["steer", message]);
				},
			});
		}
		return agents.get(id);
	};
	ctx.sessionController = { resolveAgent: async (sessionId: string) => ({ agent: agentOf(sessionId) }) };
	ctx.sessions = {
		flush: async (session: any) => {
			flushes.push(session?.id);
		},
	};
	const rt = {
		ctx,
		state,
		home: "/tmp/ocean-crew-delivery-test",
		chatOf: (botId: string) => botId,
		botOf: (id?: string) => (id === undefined ? undefined : bots[id]),
		roomOf: (id?: string) => (options.room !== undefined && id === options.room.id ? options.room : undefined),
		save: async () => {
			saveCount += 1;
		},
		warn: (...args: unknown[]) => warnings.push(args),
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	return {
		rt,
		ctx,
		agents,
		bots,
		saves: () => saveCount,
		warnings,
		get flushes() {
			return flushes.length;
		},
		agentOf,
		dispose: () => ctx.dispose(),
	} as TestHost;
}

const callsOf = (host: TestHost, id: string): any[] => host.agentOf(id).calls;

test("a relay header names who wrote and what the message wants", () => {
	const name = "Chief";
	assert.equal(headerFor("reply", name, undefined, undefined), "[Reply from Chief]");
	assert.equal(headerFor("stopped", name, undefined, undefined), "[Stopped by Chief]");
	assert.equal(headerFor("room", name, "Ops", undefined), '[Group chat "Ops" · new message]');
	assert.equal(
		headerFor("room", name, "Ops", undefined, "your tool call did not run"),
		'[Group chat "Ops" · your tool call did not run]',
	);
	assert.equal(headerFor("report", name, "Ops", undefined), '[Group chat "Ops" · replies to your post]');
	assert.equal(headerFor("kickoff", name, undefined, undefined), "[Bot team setup]");
	assert.equal(headerFor("continue", name, undefined, undefined), "[Retry after a failed turn]");
	assert.equal(
		headerFor("update", name, undefined, undefined),
		"[Your profile was updated — follow the latest version]",
	);
	assert.equal(headerFor("secret", name, undefined, undefined), "[Secret card]");
	assert.equal(headerFor("request", name, undefined, "user"), "[Message from Chief · the user sees your reply here]");
	assert.equal(headerFor("request", name, undefined, undefined), "[Message from Chief]");
	assert.equal(headerFor("request", name, undefined, undefined, "ignored"), "[Message from Chief]");
	// What came back for work another Bot gave this one says where its answer goes.
	assert.equal(
		headerFor("reply", name, undefined, undefined, "new message", false, { asker: "Writer" }),
		"[Reply from Chief · for the work Writer asked you for; your answer goes to Writer once everything you handed on is back]",
	);
	// A deferred request was read mid-turn and comes back to be answered.
	assert.equal(
		headerFor("reply", name, undefined, undefined, "new message", true),
		"[Reply from Chief · you read it during your last task; go on with the work it is for now]",
	);
	assert.equal(
		headerFor("report", name, "Ops", undefined, "new message", true),
		'[Group chat "Ops" · replies to your post · you read them during your last task; go on with the work they are for now]',
	);
	assert.equal(
		headerFor("request", name, undefined, undefined, "new message", true),
		"[Message from Chief · you read it during your last task; answer it now]",
	);
	assert.equal(
		headerFor("request", name, undefined, undefined, "new message", false, { retried: true }),
		"[Your last reply wrote a tool call as text, so nothing ran]",
	);
	// A resumed turn says the restart cut it; a resend says the restart held it.
	assert.equal(
		headerFor("resume", name, undefined, undefined, "new message", false, { resumed: true }),
		"[DeepSeek Harness restarted while you were working]",
	);
	assert.equal(
		headerFor("request", name, undefined, undefined, "new message", false, { resumed: true }),
		"[Message from Chief · DeepSeek Harness restarted while you were working on it]",
	);
	assert.equal(
		headerFor("reply", name, undefined, undefined, "new message", false, { resent: true }),
		"[Reply from Chief · DeepSeek Harness restarted before it could reach you]",
	);
	assert.equal(
		headerFor("request", name, undefined, undefined, "new message", false, { resent: true }),
		"[Message from Chief · DeepSeek Harness restarted before it could reach you]",
	);
	// A group message keeps its plain header.
	assert.equal(
		headerFor("room", name, "Ops", undefined, "new message", false, { retried: true }),
		'[Group chat "Ops" · new message]',
	);
});

test("deliver puts the header, the text and the source a Session event carries", async () => {
	const host = runtime({ room: { id: "r1", name: "Ops", sessions: { b: "gb" } } });
	await host.rt.deliver({
		fromId: "a",
		toId: "b",
		text: "carry out the plan",
		role: "request",
		exchangeId: "x1",
		replyTo: "r0",
		work: "w1",
		roomId: "r1",
		fromRoomId: "gr",
		askedBy: "m1",
		audience: "user",
		deferred: true,
		resumed: true,
		retried: true,
		images: [{ attachmentId: "img" }],
		files: [{ attachmentId: "file" }],
	});
	const [[kind, message]] = callsOf(host, "b");
	assert.equal(kind, "followup");
	assert.deepEqual(message.source, {
		kind: "bot",
		form: "relay",
		role: "request",
		exchangeId: "x1",
		senderName: "Chief",
		work: "w1",
		senderSessionId: "a",
		replyTo: "r0",
		roomId: "r1",
		audience: "user",
		deferred: true,
		resumed: true,
		retried: true,
		askedBy: "m1",
		senderRoomId: "gr",
	});
	assert.deepEqual(message.content, [
		{
			type: "text",
			text: "[Message from Chief · you read it during your last task; answer it now]\ncarry out the plan",
		},
		{ type: "image", attachment: { attachmentId: "img" } },
		{ type: "file", attachment: { attachmentId: "file" } },
	]);
	// A deferred relay was recorded when it first arrived.
	assert.deepEqual(host.rt.state.exchanges, []);
	assert.equal(host.flushes, 1);
});

test("deliver steers when asked and follows up otherwise; a named group Session receives it", async () => {
	const host = runtime({ room: { id: "r1", name: "Ops", sessions: { b: "gb" } } });
	await host.rt.deliver({
		fromId: "a",
		toId: "b",
		sessionId: "gb",
		text: "one",
		role: "room",
		roomId: "r1",
		exchangeId: "x1",
		steer: true,
	});
	await host.rt.deliver({ fromId: "a", toId: "b", text: "two", role: "request", exchangeId: "x2" });
	// The group Session receives the steered group message; the own chat the follow-up.
	assert.deepEqual(
		callsOf(host, "gb").map(([kind]) => kind),
		["steer"],
	);
	assert.deepEqual(
		callsOf(host, "b").map(([kind]) => kind),
		["followup"],
	);
	assert.equal(callsOf(host, "gb")[0][1].source.roomId, "r1");
	// Only the roles that wait for an answer are exchanges.
	assert.deepEqual(
		host.rt.state.exchanges.map((entry: any) => [entry.id, entry.role, entry.from, entry.to]),
		[["x2", "request", "a", "b"]],
	);
});

test("deliver records an exchange only after the message is in the Session", async () => {
	const host = runtime();
	host.ctx.sessions.flush = async () => {
		throw Object.assign(new Error("Session b is gone"), { code: "session/not-found" });
	};
	await assert.rejects(host.rt.deliver({ fromId: "a", toId: "b", text: "hello", role: "request", exchangeId: "x1" }), {
		code: "session/not-found",
	});
	assert.deepEqual(host.rt.state.exchanges, []);
	assert.equal(host.saves(), 0);
});

test("deliver rejects an unknown recipient and a Session that cannot be opened", async () => {
	const host = runtime();
	await assert.rejects(
		host.rt.deliver({ fromId: "a", toId: "nobody", text: "hello", role: "request" }),
		/Unknown Bot nobody/,
	);
	host.ctx.sessionController.resolveAgent = async () => ({
		error: { code: "session/not-found", message: "Session b is gone" },
	});
	await assert.rejects(host.rt.deliver({ toId: "b", text: "hello", role: "request" }), {
		code: "session/not-found",
		message: "Session b is gone",
	});
	// The recipient's Agent has its unused Bot tools hidden before the message lands.
	const hide: string[] = [];
	host.rt.hideBotUnusedTools = (agent: any) => hide.push(agent.session.id);
	host.ctx.sessionController.resolveAgent = async (sessionId: string) => ({ agent: host.agentOf(sessionId) });
	await host.rt.deliver({ toId: "b", text: "hello", role: "request" });
	assert.deepEqual(hide, ["b"]);
});

test("a long exchange keeps only its start and remembers where the whole one is", async () => {
	const host = runtime();
	const long = "长".repeat(15_000);
	await host.rt.deliver({ fromId: "a", toId: "b", text: long, role: "request", exchangeId: "x1" });
	const [entry] = host.rt.state.exchanges;
	assert.equal(entry.text.length, TEXT_KEPT);
	assert.equal(entry.length, long.length);
	assert.equal(entry.sessionId, "b");
	assert.deepEqual([entry.id, entry.role], ["x1", "request"]);
	assert.equal(host.saves(), 1);
	// A duplicate exchange id is not added twice; a merged request replaces its record.
	await host.rt.deliver({ fromId: "a", toId: "b", text: "again", role: "request", exchangeId: "x1" });
	assert.equal(host.rt.state.exchanges.length, 1);
	await host.rt.deliver({
		fromId: "a",
		toId: "b",
		text: "merged text",
		role: "request",
		exchangeId: "x1",
		merged: true,
	});
	assert.equal(host.rt.state.exchanges.length, 1);
	assert.equal(host.rt.state.exchanges[0].text, "merged text");
	// Roles that only inform a turn are not exchanges.
	await host.rt.deliver({ fromId: "a", toId: "b", text: "hi", role: "kickoff", exchangeId: "k1" });
	await host.rt.deliver({ fromId: "a", toId: "b", text: "hi", role: "update", exchangeId: "u1" });
	assert.deepEqual(
		host.rt.state.exchanges.map((entry: any) => entry.id),
		["x1"],
	);
});

test("exchangeText reads the whole message back from the Session it reached", async () => {
	const host = runtime();
	const long = `${"y".repeat(3000)}end`;
	const entry = {
		id: "x1",
		from: "a",
		to: "b",
		text: "y".repeat(2000),
		length: long.length,
		sessionId: "b",
		role: "request",
	};
	host.rt.eventsBackwards = async function* () {
		yield {
			type: "user/message",
			data: { source: { exchangeId: "other" }, content: [{ type: "text", text: "other" }] },
		};
		yield {
			type: "user/message",
			data: { source: { exchangeId: "x1" }, content: [{ type: "text", text: `[Message from Chief]\n${long}` }] },
		};
	};
	assert.deepEqual(await host.rt.exchangeText(entry), { text: long, whole: true });
	// A message shorter than the dialog limit comes back whole; one past it is cut, said
	// to be only that.
	const shorter = { ...entry, length: 2100, text: "z".repeat(2000) };
	host.rt.eventsBackwards = async function* () {
		yield {
			type: "user/message",
			data: {
				source: { exchangeId: "x1" },
				content: [{ type: "text", text: `[Message from Chief]\n${"z".repeat(2100)}` }],
			},
		};
	};
	assert.deepEqual(await host.rt.exchangeText(shorter), { text: "z".repeat(2100), whole: true });
	const huge = "h".repeat(TEXT_SHOW_MAX + 10);
	host.rt.eventsBackwards = async function* () {
		yield {
			type: "user/message",
			data: { source: { exchangeId: "x1" }, content: [{ type: "text", text: `[Message from Chief]\n${huge}` }] },
		};
	};
	assert.deepEqual(await host.rt.exchangeText({ ...entry, length: huge.length }), {
		text: huge.slice(0, TEXT_SHOW_MAX),
		whole: false,
	});
});

test("exchangeText falls back to the kept start when the Session cannot be read", async () => {
	const host = runtime();
	const entry = { id: "x1", from: "a", to: "b", text: "start", length: 5000, sessionId: "b", role: "request" };
	// No reader at all: the start, said to be only that.
	assert.deepEqual(await host.rt.exchangeText(entry), { text: "start", whole: false });
	host.rt.eventsBackwards = async function* () {
		yield { type: "user/message", data: { source: { exchangeId: "other" } } };
		throw new Error("gone");
	};
	assert.deepEqual(await host.rt.exchangeText(entry), { text: "start", whole: false });
	assert.ok(host.warnings.some((args) => /not read back/.test(String(args[0]))));
	// A message whose start was kept needs no read back.
	assert.deepEqual(await host.rt.exchangeText({ ...entry, length: undefined }), { text: "start", whole: true });
});

test("a message past 20,000 characters goes as a file, and reads back whole", async () => {
	const attachments = fakeAttachments();
	const host = runtime({ attachments });
	const long = Array.from({ length: 400 }, (_, at) => `第 ${at + 1} 行：${"长消息的一行。".repeat(8)}`).join("\n");
	assert.ok(long.length > MESSAGE_INLINE_MAX);
	const shown = await host.rt.attachLong(long, "Message from Chief.txt");
	assert.ok(shown !== undefined);
	assert.ok(
		shown.text.startsWith(
			`[A long message: ${long.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.]\n`,
		),
	);
	assert.ok(!shown.text.includes("shell command"));
	assert.equal(shown.length, long.length);
	assert.equal(shown.files.length, 1);
	// The file stays verbatim.
	const [file] = shown.files as any[];
	assert.equal(new TextDecoder().decode(attachments.files.get(file.attachmentId)), long);
	assert.deepEqual(await host.rt.fileText(file), { text: long, whole: true });
	// The exchange names the file, so the dialog reads it here rather than from a Session.
	await host.rt.deliver({
		fromId: "a",
		toId: "b",
		text: shown.text,
		role: "request",
		exchangeId: "long",
		files: shown.files,
		length: shown.length,
	});
	const [entry] = host.rt.state.exchanges;
	assert.equal(entry.length, long.length);
	assert.deepEqual(entry.files, shown.files);
	assert.deepEqual(await host.rt.exchangeText(entry), { text: long, whole: true });
});

test("a long message with a line past what the read tool shows says how to read it", async () => {
	const host = runtime({ attachments: fakeAttachments() });
	const written = await host.rt.attachLong("x".repeat(25_000), "Message from Chief.txt");
	assert.ok(written !== undefined);
	assert.match(
		written.text,
		new RegExp(
			`Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command\\.`,
		),
	);
});

test("a message within the inline size, or with no file storage, is not sent as a file", async () => {
	const host = runtime();
	assert.deepEqual(await host.rt.attachLong("x".repeat(MESSAGE_INLINE_MAX), "m.txt"), {
		text: "x".repeat(MESSAGE_INLINE_MAX),
		files: [],
	});
	// No attachments service on this DSH: the caller must not send it whole.
	assert.equal(await host.rt.attachLong("x".repeat(MESSAGE_INLINE_MAX + 1), "m.txt"), undefined);
	// A storage failure is a warning and the same refusal, never a silent whole send.
	const failing = fakeAttachments();
	failing.saveFile = async () => {
		throw new Error("disk full");
	};
	const withStorage = runtime({ attachments: failing });
	assert.equal(await withStorage.rt.attachLong("x".repeat(MESSAGE_INLINE_MAX + 1), "m.txt"), undefined);
	assert.ok(withStorage.warnings.some((args) => /not stored as a file/.test(String(args[0]))));
});

test("fileText reports only the start of a file past what the dialog shows, and a missing reader", async () => {
	const attachments = fakeAttachments();
	const host = runtime({ attachments });
	const file = await attachments.saveFile({
		data: new TextEncoder().encode("first line\nsecond line"),
		name: "a.txt",
	});
	assert.deepEqual(await host.rt.fileText(file), { text: "first line\nsecond line", whole: true });
	const huge = await attachments.saveFile({
		data: new TextEncoder().encode("h".repeat(TEXT_SHOW_MAX + 5)),
		name: "big.txt",
	});
	assert.deepEqual(await host.rt.fileText(huge), { text: "h".repeat(TEXT_SHOW_MAX), whole: false });
	const unreadable = runtime();
	assert.equal(await unreadable.rt.fileText(file), undefined);
	const broken = runtime({
		attachments: Object.assign(fakeAttachments(), {
			readFileStream() {
				throw new Error("gone");
			},
		}),
	});
	assert.equal(await broken.rt.fileText(file), undefined);
	assert.ok(broken.warnings.some((args) => /not read/.test(String(args[0]))));
});
