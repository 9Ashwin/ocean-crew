// IM host behaviour: connections, pairing, routing, cards, the send queue, the runtime
// file, the status views and the im-* endpoints, driven through a fake platform adapter
// The full runtime is built by
// `createRuntime` with a fake DSH around it, and the IM module is installed on it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { adapters } from "../src/host/im/platforms/index.ts";
import { createRuntime } from "../src/index.ts";
import { IM_PLATFORMS } from "../src/shared/im-platforms.ts";
import { fakeContext } from "./fake-ctx.ts";

// A platform adapter that records sends/edits and lets the test feed inbound messages,
// actions and statuses. `fails` throws once per queued send.
function fakeAdapter({ buttons = true, reactions = false }: { buttons?: boolean; reactions?: boolean } = {}): any {
	const sent: any[] = [];
	const edited: any[] = [];
	const fails: any[] = [];
	const reactionAdds: any[] = [];
	const reactionRemoves: any[] = [];
	const adapter: any = {
		id: "fake",
		sent,
		edited,
		fails,
		reactionAdds,
		reactionRemoves,
		handlers: null,
		buttons,
		async check(fields: any) {
			if (fields.token === "bad-token") throw new Error("platform refused the token");
			return { account: { id: "bot1", name: "@fakebot" } };
		},
		connect(_fields: any, env: any, handlers: any) {
			adapter.handlers = handlers;
			adapter.env = env;
			adapter.connects = (adapter.connects ?? 0) + 1;
			handlers.onStatus({ state: "ready", account: { id: "bot1", name: "@fakebot" } });
			const handle: any = {
				send: async (chat: any, body: any) => {
					sent.push({ chat, ...body });
					const next = fails.shift();
					if (next !== undefined) throw next;
					return { messageId: sent.length };
				},
				edit: async (chat: any, messageId: any, body: any) => {
					edited.push({ chat, messageId, ...body });
				},
				typing: async () => {},
				stop: () => {
					adapter.stopped = (adapter.stopped ?? 0) + 1;
				},
			};
			// A platform that can react gets the optional pair; all others stay text-only.
			if (reactions) {
				handle.addReaction = async (chat: any, messageId: any, emoji: any) => {
					reactionAdds.push({ chat, messageId, emoji });
					return `rx${reactionAdds.length}`;
				};
				handle.removeReaction = async (chat: any, messageId: any, reactionId: any) => {
					reactionRemoves.push({ chat, messageId, reactionId });
				};
			}
			return handle;
		},
	};
	return adapter;
}

const TEAM = (): any => ({
	version: 1,
	mainBotIds: ["a"],
	bots: {
		a: { id: "a", name: "Chief", role: "Boss", sessionId: "a", createdAt: 1 },
		b: { id: "b", name: "Writer", role: "Write", sessionId: "b", createdAt: 2 },
	},
	rooms: {
		r1: { id: "r1", name: "Ops", members: ["a", "b"], mode: "everyone", admin: "a", named: true, log: [], seq: 0 },
	},
	agents: {},
	exchanges: [],
	exchangeTurns: {},
	questions: {},
	prefs: {},
	revision: 0,
});

interface Host {
	ctx: any;
	rt: any;
	home: string;
	platform: string;
	fake: any;
	prompts: any[];
	agents: Map<string, any>;
	emitEvent: (sessionId: string, type: string, data: any) => void;
	flush: () => Promise<void>;
	until: (check: () => boolean, ms?: number) => Promise<boolean>;
	stop: () => Promise<void>;
}

async function start(
	t: TestContext,
	{
		platform = "fake",
		adapter,
		seed,
		config,
		home: reuse,
		keep = false,
	}: {
		platform?: string;
		adapter?: any;
		seed?: any;
		config?: any;
		/** An existing home, so a test can restart the runtime over the same data. */
		home?: string;
		/** Leave the home on disk for the next start. */
		keep?: boolean;
	} = {},
): Promise<Host> {
	const home = reuse ?? mkdtempSync(join(tmpdir(), "ocean-crew-im-"));
	// A restarted runtime reads the state the first one saved, not a fresh seed.
	if (reuse === undefined) writeFileSync(join(home, "state.json"), JSON.stringify(seed ?? TEAM()));
	const ctx = fakeContext();
	const prompts: any[] = [];
	const agents = new Map<string, any>();
	const agentOf = (id: string): any => {
		if (!agents.has(id)) {
			agents.set(id, {
				id,
				session: { id, requestHeader: () => undefined },
				followup() {
					this.followed = (this.followed ?? 0) + 1;
				},
				cancel() {
					this.cancelled = true;
				},
				inbox: { nextStep: [], nextTurn: [], remove: () => false },
				async whenIdle() {},
			});
		}
		return agents.get(id);
	};
	Object.assign(ctx, {
		llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
		workspaceRegistry: {
			get: () => undefined,
			resolveByPath: async () => undefined,
			create: async () => ({ id: "w1" }),
			archiveSession: async () => {},
		},
		sessionController: {
			prompt: async (request: any) => {
				prompts.push(request);
				return { ok: true };
			},
			resolveAgent: async (sessionId: string) => ({ agent: agentOf(sessionId) }),
			selectModel: async () => {},
		},
		sessionTitle: { rename: async () => {} },
		sessions: { flush: async () => {} },
	});
	const fake = adapter ?? fakeAdapter();
	const real = (adapters as Record<string, any>)[platform];
	(adapters as Record<string, any>)[platform] = fake;
	const addedPlatform = IM_PLATFORMS.some((entry) => entry.id === platform)
		? undefined
		: {
				id: platform,
				name: platform,
				fields: [{ key: "token", label: "Token", secret: true }],
				buttons: fake.buttons !== false,
				groups: true,
			};
	if (addedPlatform) IM_PLATFORMS.push(addedPlatform as any);
	// The host entry installs the IM module along with the rest of the team modules.
	const rt: any = createRuntime(ctx as any, { home, ...config });
	const emitEvent = (sessionId: string, type: string, data: any): void => {
		for (const listener of ctx.listeners.get("session/event") ?? []) {
			if (listener.length >= 2) listener({ id: sessionId }, { type, data, time: Date.now() });
		}
	};
	const flush = async (): Promise<void> => {
		await delay(10);
	};
	const until = async (check: () => boolean, ms = 2_000): Promise<boolean> => {
		for (let at = 0; at < ms; at += 20) {
			if (check()) return true;
			await delay(20);
		}
		return check();
	};
	const stop = async (): Promise<void> => {
		(adapters as Record<string, any>)[platform] = real;
		if (addedPlatform) IM_PLATFORMS.splice(IM_PLATFORMS.indexOf(addedPlatform as any), 1);
		await ctx.dispose?.();
		if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	t.after(stop);
	return { ctx, rt, home, platform, fake, prompts, agents, emitEvent, flush, until, stop };
}

const FIELDS: Record<string, any> = { fake: { token: "tok-1234" }, feishu: { appId: "cli-1", appSecret: "sec-1234" } };
const add = (s: Host, fields: any = FIELDS[s.platform] ?? {}): Promise<any> =>
	s.rt.imEndpoint("im-add", { platform: s.platform, botId: "a", fields });
const dm = (s: Host, senderId: string, text: string, extra: any = {}): Promise<any> =>
	s.fake.handlers.onMessage({
		chat: { key: `dm-${senderId}`, kind: "direct", title: senderId },
		sender: { id: senderId, name: `User ${senderId}` },
		text,
		...extra,
	});
const gm = (
	s: Host,
	senderId: string,
	text: string,
	{ mentioned = true, chat = { key: "g1", kind: "group", title: "Group One" }, ...extra }: any = {},
): Promise<any> =>
	s.fake.handlers.onMessage({ chat, sender: { id: senderId, name: `User ${senderId}` }, text, mentioned, ...extra });

test("two concurrent syncs start exactly one adapter", async (t) => {
	const s = await start(t);
	await add(s);
	const conn = Object.values(s.rt.state.im.connections)[0] as any;
	s.fake.connects = 0;
	s.rt.state.im.connections[conn.id].enabled = false;
	await s.rt.save();
	await s.flush();
	assert.equal(s.fake.stopped, 1);
	s.rt.state.im.connections[conn.id].enabled = true;
	await Promise.all([s.rt.save(), s.rt.save()]);
	await s.flush();
	assert.equal(s.fake.connects, 1);
	assert.equal(s.rt.imStatusView()[conn.id].state, "ready");
});

test("im-update applies only the fields it is given and keeps the rest", async (t) => {
	const s = await start(t, { platform: "feishu" });
	const conn = await s.rt.imEndpoint("im-add", {
		platform: "feishu",
		botId: "a",
		fields: { domain: "lark", appId: "app-1", appSecret: "sec-1" },
	});
	const one = s.rt.state.im.connections[conn.id];
	assert.deepEqual(one.settings, { domain: "lark", appId: "app-1" });
	assert.deepEqual(one.secrets !== undefined, true);
	await s.rt.imEndpoint("im-update", { id: conn.id, fields: { appSecret: "sec-2" } });
	assert.deepEqual(s.rt.state.im.connections[conn.id].settings, { domain: "lark", appId: "app-1" });
	const view = s.rt.imView().connections.find((entry: any) => entry.id === conn.id);
	assert.deepEqual(view.settings, { domain: "lark", appId: "app-1" });
	await s.rt.imEndpoint("im-update", { id: conn.id, fields: { domain: "feishu" } });
	assert.equal(s.rt.state.im.connections[conn.id].settings.domain, "feishu");
	assert.equal(s.rt.state.im.connections[conn.id].settings.appId, "app-1");
});

test("unpaired DM asks once, allow pairs it, next message prompts the Bot", async (t) => {
	const s = await start(t);
	await add(s);
	const [one] = Object.values(s.rt.state.im.connections) as any[];
	await dm(s, "u1", "hello");
	assert.equal(one.requests.length, 1);
	assert.equal(s.fake.sent.length, 1);
	assert.match(s.fake.sent[0].text, /connection request/);
	assert.equal(s.prompts.length, 0);
	await dm(s, "u1", "hello again");
	assert.equal(one.requests.length, 1);
	assert.equal(s.fake.sent.length, 1);
	await s.rt.imEndpoint("im-pair", { id: one.id, senderId: "u1", allow: true });
	assert.equal(one.paired.length, 1);
	assert.match(s.fake.sent.at(-1).text, /talk to Chief/);
	await dm(s, "u1", "do a thing");
	assert.equal(s.prompts.length, 1);
	assert.equal(s.prompts[0].sessionId, "a");
	assert.equal(s.prompts[0].mode, "queue");
	assert.match(s.prompts[0].requestId, /^im:fake:/);
	assert.deepEqual(s.prompts[0].content, [{ type: "text", text: "do a thing" }]);
});

test("unbound group mention replies unbound and records the chat; binding routes mentions", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	s.rt.state.im.connections[conn.id].paired.push({ id: "u1", name: "User u1", at: 1 });
	await s.rt.save();
	await gm(s, "u1", "hi all", { mentioned: false });
	assert.equal(s.fake.sent.length, 0);
	assert.equal(s.prompts.length, 0);
	await gm(s, "u1", "@fakebot hello group");
	assert.equal(s.rt.state.im.connections[conn.id].chats.g1?.kind, "group");
	assert.equal(s.fake.sent.length, 1);
	assert.match(s.fake.sent[0].text, /not bound/);
	assert.equal(s.prompts.length, 0);
	await s.rt.imEndpoint("im-chat", { id: conn.id, chatKey: "g1", target: { roomId: "r1" } });
	// The adapter strips its own mention before the core sees the text.
	await gm(s, "u1", "hello group");
	assert.equal(s.prompts.length, 1);
	assert.equal(s.prompts[0].sessionId, "r1");
	assert.deepEqual(s.prompts[0].content, [{ type: "text", text: "hello group" }]);
});

test("outbound: an assistant message goes to the paired chat, hidden turns and user lines do not", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.fake.sent.length = 0;
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "visible reply" }] } });
	assert.equal(await s.until(() => s.fake.sent.length === 1), true);
	assert.equal(s.fake.sent[0].text, "visible reply");
	// A hidden turn's answer is another Bot's; a user's own line is not repeated.
	s.rt.state.exchangeTurns.a = [7];
	s.emitEvent("a", "assistant/message", {
		message: { content: [{ type: "text", text: "hidden" }] },
		turn: 7,
	});
	s.emitEvent("a", "user/message", { source: { kind: "user" }, content: [{ type: "text", text: "user typed" }] });
	await s.flush();
	assert.equal(s.fake.sent.length, 1);
});

test("IM user messages are tagged by seq for the current part, and dropped when the part is gone", async (t) => {
	const s = await start(t);
	const fire = (sessionId: string, seq: number, rpcId: string): void => {
		for (const listener of s.ctx.listeners.get("session/event") ?? []) {
			if (listener.length >= 2)
				listener(
					{ id: sessionId },
					{
						type: "user/message",
						seq,
						data: { source: { kind: "user", rpcId }, content: [{ type: "text", text: "x" }] },
						time: Date.now(),
					},
				);
		}
	};
	fire("a", 5, "im:fake:1");
	fire("a", 6, "web-request");
	fire("a", 7, "im:feishu:2");
	assert.deepEqual(s.rt.imViaView(), { a: { 5: "fake", 7: "feishu" } });
	s.rt.chatOwners.delete("a");
	assert.deepEqual(s.rt.imViaView(), {});
});

test("question card: buttons answer it, a stranger press is ignored, settled elsewhere edits the card", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 }, { id: "u2", name: "U2", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.fake.sent.length = 0;
	s.rt.state.questions.a = { id: "q1", question: "Which?", options: [{ label: "yes" }, { label: "no" }] };
	await s.rt.save();
	await s.flush();
	const card = s.fake.sent.find((entry: any) => entry.buttons !== undefined);
	assert.ok(card, "question card with buttons");
	assert.match(card.text, /Which\?/);
	await s.fake.handlers.onAction({
		chat: { key: "dm-u2", kind: "direct", title: "U2" },
		sender: { id: "u9", name: "stranger" },
		data: "q:q1:0",
		messageId: card.messageId ?? 1,
	});
	assert.ok(s.rt.state.questions.a !== undefined, "unpaired press does not answer");
	await s.fake.handlers.onAction({
		chat: { key: "dm-u1", kind: "direct", title: "U1" },
		sender: { id: "u1", name: "U1" },
		data: "q:q1:1",
		messageId: card.messageId ?? 1,
	});
	assert.ok(s.rt.state.questions.a === undefined, "paired press answers");
	await s.flush();
	assert.equal(s.fake.edited.length, 1);
	// Answered on the computer: the question leaves the state, the card edits shut.
	s.rt.state.questions.a = { id: "q2", question: "Again?", options: [{ label: "x" }] };
	await s.rt.save();
	await s.flush();
	delete s.rt.state.questions.a;
	await s.rt.save();
	await s.flush();
	assert.equal(s.fake.edited.length, 2);
});

test("numbered reply answers the newest open card on a no-button platform", async (t) => {
	const s = await start(t, { adapter: fakeAdapter({ buttons: false }) });
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.rt.state.questions.a = { id: "q1", question: "Pick", options: [{ label: "x" }, { label: "y" }] };
	await s.rt.save();
	await s.flush();
	const card = s.fake.sent.at(-1);
	assert.equal(card.buttons, undefined);
	await dm(s, "u1", "2");
	assert.ok(s.rt.state.questions.a === undefined);
});

test("a pending secret request sends text without buttons", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.fake.sent.length = 0;
	s.rt.state.secretRequests = {
		a: [{ id: "s1", name: "MY_KEY", purpose: "for tests", status: "pending", askedAt: 1 }],
	};
	await s.rt.save();
	await s.flush();
	const card = s.fake.sent.at(-1);
	assert.match(card.text, /MY_KEY/);
	assert.equal(card.buttons, undefined);
});

test("a read-only host runs no adapter; becoming writable starts it", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	assert.ok(s.fake.handlers !== null);
	const realReadOnly = s.rt.readOnly;
	s.rt.readOnly = () => "held elsewhere";
	await s.rt.imEndpoint("im-update", { id: conn.id, enabled: false });
	await s.rt.imEndpoint("im-update", { id: conn.id, enabled: true });
	assert.equal(s.fake.stopped, 1);
	s.rt.readOnly = realReadOnly;
	await s.rt.imEndpoint("im-retry", { id: conn.id });
	await s.flush();
	assert.ok(s.fake.handlers !== null);
});

test("/stop calls stopChat for a Bot target", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	let called = 0;
	s.rt.stopChat = async () => {
		called += 1;
		return true;
	};
	await dm(s, "u1", "/stop");
	assert.equal(called, 1);
	assert.match(s.fake.sent.at(-1).text, /Stopped|已停/);
	await dm(s, "u1", "/stop@fakebot");
	assert.equal(called, 2);
});

test("im-add keeps secrets out of the state file, and im-remove deletes them and the runtime file", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	const secretNames = Object.values(one.secrets) as string[];
	assert.equal(secretNames.length, 1);
	const saved = JSON.parse(readFileSync(join(s.home, "secrets.json"), "utf8"));
	assert.equal(saved.secrets[0].name, secretNames[0]);
	assert.deepEqual(saved.secrets[0].scope, []);
	const view = s.rt.imView();
	assert.equal(view.connections[0].id, conn.id);
	assert.ok(!JSON.stringify(view).includes("tok-1234"));
	await s.rt.imEndpoint("im-remove", { id: conn.id });
	assert.equal(s.rt.state.im.connections[conn.id], undefined);
	const after = JSON.parse(readFileSync(join(s.home, "secrets.json"), "utf8"));
	assert.equal(after.secrets.length, 0);
	assert.equal(existsSync(join(s.home, "im", `${conn.id}.json`)), false);
});

test("a deleted Bot target gets the unbound reply", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	one.botId = "gone";
	await s.rt.save();
	s.fake.sent.length = 0;
	await dm(s, "u1", "hi");
	assert.match(s.fake.sent.at(-1).text, /not bound|还没绑定/);
	assert.equal(s.prompts.length, 0);
});

test("an unknown send failure drops one message, keeps the connection ready and shows a reference", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	const warns: any[] = [];
	s.rt.warn = (template: any, ...args: any[]) => warns.push([template, ...args]);
	s.fake.sent.length = 0;
	s.fake.fails.push(Object.assign(new Error("reply not understood"), { unknown: true }));
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "lost" }] } });
	assert.equal(await s.until(() => s.rt.imStatusView()[conn.id].referenceId !== undefined), true);
	const status = s.rt.imStatusView()[conn.id];
	assert.equal(status.state, "ready", "the connection itself is still healthy");
	assert.match(status.referenceId, /^MF-[0-9a-f]{8}$/);
	assert.match(status.error, /reply not understood/);
	assert.equal(status.attempts, 0);
	assert.ok(warns.some(([template]) => String(template).includes("send")));
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "after" }] } });
	assert.equal(await s.until(() => s.fake.sent.length === 2), true);
	assert.deepEqual(
		s.fake.sent.map((entry: any) => entry.text),
		["lost", "after"],
		"the unknown failure is not resent",
	);
	await s.rt.imEndpoint("im-retry", { id: conn.id });
	assert.equal(s.rt.imStatusView()[conn.id].referenceId, undefined);
});

test("a send that times out is dropped as unknown and the chat keeps moving", async (t) => {
	const adapter = fakeAdapter();
	const connect = adapter.connect;
	let holding = false;
	adapter.connect = (fields: any, env: any, handlers: any) => {
		const handle = connect(fields, env, handlers);
		const send = handle.send;
		handle.send = async (chat: any, body: any) => {
			if (holding) {
				holding = false;
				return new Promise(() => {});
			}
			return send(chat, body);
		};
		return handle;
	};
	const s = await start(t, { adapter, config: { imSendTimeoutMs: 25 } });
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.fake.sent.length = 0;
	holding = true;
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "hangs" }] } });
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "next" }] } });
	assert.equal(await s.until(() => s.fake.sent.length === 1), true);
	assert.equal(s.fake.sent[0].text, "next", "the chat is not blocked by the timed-out send");
	const status = s.rt.imStatusView()[conn.id];
	assert.equal(status.state, "ready");
	assert.match(status.referenceId, /^MF-[0-9a-f]{8}$/);
	assert.match(status.error, /timed out/);
});

test("a permanent send error shows in the status and is not retried", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.fake.fails.push(Object.assign(new Error("forbidden"), { status: 403, permanent: true }));
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "will fail" }] } });
	await s.flush();
	assert.equal(s.rt.imStatusView()[conn.id].state, "error");
	assert.match(s.rt.imStatusView()[conn.id].error, /forbidden/);
	assert.match(s.rt.imStatusView()[conn.id].referenceId, /^MF-[0-9a-f]{8}$/);
	const before = s.fake.sent.length;
	await s.flush();
	assert.equal(s.fake.sent.length, before, "permanent failure is not retried");
});

test("a direct message is marked processing, then the turn end settles it", async (t) => {
	const s = await start(t, { adapter: fakeAdapter({ reactions: true }) });
	const conn = await add(s);
	s.rt.state.im.connections[conn.id].paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await s.flush();
	await dm(s, "u1", "hi", { messageId: "om_1" });
	assert.equal(await s.until(() => s.fake.reactionAdds.length === 1), true, "a processing mark goes on");
	assert.deepEqual(s.fake.reactionAdds[0], {
		chat: { key: "dm-u1", kind: "direct", title: "u1" },
		messageId: "om_1",
		emoji: "OnIt",
	});
	s.emitEvent("a", "user/message", { source: { kind: "user", rpcId: s.prompts[0].requestId }, content: [] });
	s.emitEvent("a", "turn/end", { reason: { kind: "completed" } });
	assert.equal(await s.until(() => s.fake.reactionAdds.length === 2), true, "the verdict goes on");
	assert.deepEqual(s.fake.reactionRemoves, [
		{ chat: { key: "dm-u1", kind: "direct", title: "u1" }, messageId: "om_1", reactionId: "rx1" },
	]);
	assert.equal(s.fake.reactionAdds[1].emoji, "DONE");
});

test("imReactions: false turns the marks off", async (t) => {
	const s = await start(t, { adapter: fakeAdapter({ reactions: true }), config: { imReactions: false } });
	const conn = await add(s);
	s.rt.state.im.connections[conn.id].paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await s.flush();
	await dm(s, "u1", "hi", { messageId: "om_1" });
	await s.flush();
	assert.equal(s.fake.reactionAdds.length, 0);
});

// ---------------------------------------------------------------------------
// The persistent outbox: a text that was never confirmed survives a restart.

const outboxFile = (home: string): string => {
	const dir = join(home, "im");
	const name = existsSync(dir) ? readdirSync(dir).find((entry) => entry.endsWith(".outbox.json")) : undefined;
	return name === undefined ? "" : join(dir, name);
};
const readOutbox = (home: string): any => {
	const file = outboxFile(home);
	return file === "" ? { chats: {} } : JSON.parse(readFileSync(file, "utf8"));
};
// The outbox write is debounced, so a test waits for the file rather than sleeping.
const untilOutbox = async (home: string, check: (data: any) => boolean, ms = 3_000): Promise<boolean> => {
	for (let at = 0; at < ms; at += 20) {
		try {
			if (check(readOutbox(home))) return true;
		} catch {
			// still being written
		}
		await delay(20);
	}
	return false;
};

test("a refused text waits in the outbox and leaves it once delivered", async (t) => {
	const s = await start(t);
	await add(s);
	// The first send is refused without being accepted, so it stays queued and is retried.
	s.fake.fails.push(Object.assign(new Error("busy"), { retryAfter: 1 }));
	await dm(s, "u1", "hello");
	assert.ok(
		await untilOutbox(s.home, (data) => JSON.stringify(data).includes("connection request")),
		"the refused text is on disk while it waits",
	);
	assert.ok(await s.until(() => s.fake.sent.some((entry: any) => /connection request/i.test(String(entry.text)))));
	assert.ok(
		await untilOutbox(s.home, (data) => Object.keys(data.chats).length === 0),
		"delivered texts leave no record",
	);
});

test("a queued record left by a previous process is sent on the next start", async (t) => {
	// The home stays on disk across the two starts: that is the restart.
	const s = await start(t, { seed: TEAM(), keep: true });
	const conn = await add(s);
	const home = s.home;
	await s.stop();
	// The record a process that died before sending would leave behind.
	mkdirSync(join(home, "im"), { recursive: true });
	writeFileSync(
		join(home, "im", `${conn.id}.outbox.json`),
		JSON.stringify({
			chats: {
				"dm-u1": [
					{
						id: "rec-1",
						chat: { key: "dm-u1", kind: "direct", title: "u1" },
						state: "queued",
						attempts: 0,
						body: "resumed after the restart",
					},
				],
			},
		}),
	);
	const again = await start(t, { home, keep: true });
	assert.ok(
		await again.until(() => again.fake.sent.some((entry: any) => entry.text === "resumed after the restart")),
		"the queued text reached the platform after the restart",
	);
	assert.ok(await untilOutbox(home, (data) => data.chats["dm-u1"] === undefined), "the delivered record is removed");
});

test("a record interrupted mid-send is reported unknown and never resent", async (t) => {
	const s = await start(t, { seed: TEAM(), keep: true });
	const conn = await add(s);
	const home = s.home;
	await s.stop();
	mkdirSync(join(home, "im"), { recursive: true });
	writeFileSync(
		join(home, "im", `${conn.id}.outbox.json`),
		JSON.stringify({
			chats: {
				"dm-u1": [
					{
						id: "rec-2",
						chat: { key: "dm-u1", kind: "direct", title: "u1" },
						state: "sending",
						attempts: 1,
						body: "may already have arrived",
					},
				],
			},
		}),
	);
	const again = await start(t, { home, keep: true });
	assert.ok(
		await untilOutbox(home, (data) => data.chats["dm-u1"][0]?.state === "unknown"),
		"an interrupted send becomes unknown",
	);
	assert.equal(
		again.fake.sent.some((entry: any) => entry.text === "may already have arrived"),
		false,
		"an interrupted send is never repeated",
	);
});
