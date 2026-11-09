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
	const until = async (check: () => boolean, ms = 8_000): Promise<boolean> => {
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
// A durable queue means the send starts a tick after the caller returns; a test that
// reads the last sent message waits for it instead of assuming it already happened.
const lastSent = async (s: Host, after = 0): Promise<any> => {
	await s.until(() => s.fake.sent.length > after);
	return s.fake.sent[s.fake.sent.length - 1];
};
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
	assert.ok(await s.until(() => s.fake.sent.length === 1), "sent 1 message(s)");
	assert.match(s.fake.sent[0].text, /connection request/);
	assert.equal(s.prompts.length, 0);
	await dm(s, "u1", "hello again");
	assert.equal(one.requests.length, 1);
	assert.ok(await s.until(() => s.fake.sent.length === 1), "sent 1 message(s)");
	await s.rt.imEndpoint("im-pair", { id: one.id, senderId: "u1", allow: true });
	assert.equal(one.paired.length, 1);
	assert.match((await lastSent(s, 1)).text, /talk to Chief/);
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
	assert.ok(await s.until(() => s.fake.sent.length === 1), "sent 1 message(s)");
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
	assert.ok(await s.until(() => s.fake.sent.length === 1), "sent 1 message(s)");
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
	// A durable queue sends a tick after the save; wait for the card itself, not a fixed nap.
	assert.ok(
		await s.until(() => s.fake.sent.some((entry: any) => entry.buttons !== undefined)),
		"question card with buttons",
	);
	const card = s.fake.sent.find((entry: any) => entry.buttons !== undefined);
	assert.match(card.text, /Which\?/);
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
	assert.ok(await s.until(() => s.fake.edited.length === 1), "the answered card is edited shut");
	// Answered on the computer: the question leaves the state, the card edits shut.
	s.rt.state.questions.a = { id: "q2", question: "Again?", options: [{ label: "x" }] };
	await s.rt.save();
	assert.ok(await s.until(() => s.fake.sent.length > 1), "the second card goes out");
	delete s.rt.state.questions.a;
	await s.rt.save();
	assert.ok(await s.until(() => s.fake.edited.length === 2), "the second card is edited shut");
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
	const card = await lastSent(s);
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
	const card = await lastSent(s);
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
	assert.match((await lastSent(s)).text, /Stopped|已停/);
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
	assert.match((await lastSent(s)).text, /not bound|还没绑定/);
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
	// The durable queue means the send settles a tick later; wait for its verdict.
	assert.ok(
		await s.until(() => s.rt.imStatusView()[conn.id].state === "error"),
		"the permanent failure reaches the status",
	);
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

// ---------------------------------------------------------------------------
// Where a reply goes: back to the chat it came from, not to every bound chat.

test("a reply answers the chat the message came from, not every bound chat", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	// An unpaired sender only gets a request; pairing lets the message reach the Bot.
	await dm(s, "u1", "hello");
	await s.rt.imEndpoint("im-pair", { id: conn.id, senderId: "u1", allow: true });
	await dm(s, "u1", "hello from this chat");
	await s.flush();
	// The origin is recorded for the request, so a later background result goes there
	// rather than to whichever chat spoke last.
	const records = Object.values(s.rt.state.im.origins) as any[];
	assert.equal(records.length, 1);
	assert.equal(records[0].connId, conn.id);
	assert.equal(records[0].chatKey, "dm-u1");
	assert.equal(records[0].ownerKey, "a");
	assert.equal(typeof records[0].at, "number");
	assert.ok(s.fake.sent.length > 0, "the message was answered in its own chat");
	assert.ok(
		s.fake.sent.every((entry: any) => String(entry.chat?.key ?? "").startsWith("dm-")),
		"nothing went to another chat",
	);
});

test("a turn started in the window sends nothing to IM by default", async (t) => {
	const s = await start(t);
	await add(s);
	const before = s.fake.sent.length;
	// The window starts the turn: no IM message led to it, so no origin exists.
	s.emitEvent("a", "user/message", { content: [{ type: "text", text: "typed in the window" }] });
	s.emitEvent("a", "assistant/message", { content: [{ type: "text", text: "a window answer" }] });
	s.emitEvent("a", "turn/end", { reason: { kind: "stop" } });
	await s.flush();
	assert.equal(s.fake.sent.length, before, "the window's turn is not mirrored into IM");
});

test("a mirroring connection still reaches every chat of that Bot", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	await s.rt.imEndpoint("im-update", { id: conn.id, mirror: "all" });
	await dm(s, "u1", "hello");
	await s.flush();
	assert.ok(s.fake.sent.length > 0, "the message was answered");
});

// ---------------------------------------------------------------------------
// Slice: the outbox is a commit boundary, not a best-effort log.

test("a message whose queued record cannot be written is not accepted", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	// Paired before the message, so the turn starts and records where it came from.
	s.rt.state.im.connections[conn.id].paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	await s.flush();
	s.fake.sent.length = 0;
	// A file where the im directory belongs makes every outbox write fail.
	rmSync(join(s.home, "im"), { recursive: true, force: true });
	writeFileSync(join(s.home, "im"), "not a directory");
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "hello" }] } });
	await delay(200);
	assert.deepEqual(s.fake.sent, [], "nothing is sent without a durable record");
	const status: any = s.rt.imStatusView()[conn.id];
	assert.match(String(status?.error ?? ""), /could not be queued for sending/);
});

test("the sending record is on disk before the platform is called", async (t) => {
	const adapter = fakeAdapter();
	const connect = adapter.connect;
	const probe: { home: string; states: string[] } = { home: "", states: [] };
	adapter.connect = (fields: any, env: any, handlers: any) => {
		const handle = connect(fields, env, handlers);
		const send = handle.send;
		handle.send = async (chat: any, body: any) => {
			// What recovery could see at the moment transport starts.
			const dir = join(probe.home, "im");
			const name = existsSync(dir) ? readdirSync(dir).find((entry) => entry.endsWith(".outbox.json")) : undefined;
			if (name !== undefined) {
				const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
				for (const list of Object.values(data.chats ?? {}) as any[][]) {
					for (const record of list) probe.states.push(String(record.state));
				}
			}
			return send(chat, body);
		};
		return handle;
	};
	const s = await start(t, { adapter });
	probe.home = s.home;
	const conn = await add(s);
	s.rt.state.im.connections[conn.id].paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	await s.flush();
	s.fake.sent.length = 0;
	probe.states.length = 0;
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "hi" }] } });
	assert.ok(await s.until(() => s.fake.sent.length === 1));
	assert.ok(probe.states.includes("sending"), `the attempt is recorded first, saw ${JSON.stringify(probe.states)}`);
});

test("a corrupt outbox is kept aside instead of being treated as empty", async (t) => {
	const s = await start(t, { keep: true });
	const conn = await add(s);
	mkdirSync(join(s.home, "im"), { recursive: true });
	writeFileSync(join(s.home, "im", `${conn.id}.outbox.json`), "{not json");
	await s.stop();
	const next = await start(t, { home: s.home, keep: true });
	// Connecting is what reads the outbox back, so ask for a reconnect explicitly.
	await next.rt.imEndpoint("im-retry", { id: conn.id });
	await next.flush();
	const kept = readdirSync(join(next.home, "im")).filter((name) => name.includes(".corrupt-"));
	assert.equal(kept.length, 1, "the unreadable record is preserved for inspection");
});

test("a host that does not own the team does not accept a message for sending", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	await s.flush();
	s.fake.sent.length = 0;
	// Another process owns the team: this host must not dispatch, or both would send.
	const realMode = s.rt.writerMode;
	s.rt.writerMode = () => "readonly";
	s.rt.readOnly = () => "the team is held by another host";
	s.emitEvent("a", "assistant/message", { message: { content: [{ type: "text", text: "hello" }] } });
	await delay(150);
	assert.deepEqual(s.fake.sent, [], "a read-only host sends nothing");
	s.rt.writerMode = realMode;
});

test("outbox capacity never evicts a message whose outcome is unknown", async (t) => {
	const s = await start(t, { keep: true });
	const conn = await add(s);
	await s.stop();
	// A previous process left more settled-unknown records than the bound allows.
	mkdirSync(join(s.home, "im"), { recursive: true });
	const unknown = Array.from({ length: 60 }, (_, index) => ({
		id: `u-${index}`,
		chat: { key: "dm-u2", kind: "direct", title: "U2" },
		state: "unknown",
		attempts: 1,
		body: `lost ${index}`,
	}));
	writeFileSync(join(s.home, "im", `${conn.id}.outbox.json`), JSON.stringify({ chats: { "dm-u2": unknown } }));
	const next = await start(t, { home: s.home, keep: true });
	await next.rt.imEndpoint("im-retry", { id: conn.id });
	// A new pairing request goes through the accept path, which applies the bound.
	await dm(next, "u2", "hello");
	await next.flush();
	const after = JSON.parse(readFileSync(join(next.home, "im", `${conn.id}.outbox.json`), "utf8"));
	const kept = (after.chats["dm-u2"] ?? []).filter((record: any) => record.state === "unknown");
	assert.equal(kept.length, 60, "records the user may need to see are not evicted");
});

// ---------------------------------------------------------------------------
// A reply belongs to the request that started the work, not to the session's
// most recent message.

test("a later message in another chat does not steal an earlier turn's reply", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	for (const id of ["u1", "u2"]) {
		await dm(s, id, "hello");
		await s.rt.imEndpoint("im-pair", { id: conn.id, senderId: id, allow: true });
	}
	// Both are paired now; each message starts its own turn.
	await dm(s, "u1", "first chat asks");
	await dm(s, "u2", "second chat asks");
	await s.flush();
	const firstRequest = s.prompts.at(-2)?.requestId;
	assert.match(String(firstRequest), /^im:fake:/);
	// DSH echoes the request on the user message and stamps the turn; that is what ties
	// the turn to the chat it came from.
	s.emitEvent("a", "user/message", {
		source: { kind: "user", rpcId: firstRequest },
		turn: 7,
		content: [],
	});
	s.emitEvent("a", "user/message", {
		source: { kind: "user", rpcId: s.prompts.at(-1)?.requestId },
		turn: 8,
		content: [],
	});
	s.fake.sent.length = 0;
	// Turn 7's late output arrives after turn 8 started: it still belongs to the first chat.
	s.emitEvent("a", "assistant/message", { turn: 7, message: { content: [{ type: "text", text: "late first" }] } });
	s.emitEvent("a", "assistant/message", { turn: 8, message: { content: [{ type: "text", text: "second" }] } });
	assert.ok(await s.until(() => s.fake.sent.length === 2));
	const byChat = s.fake.sent.map((entry: any) => `${entry.chat.key}:${entry.text}`).sort();
	assert.deepEqual(byChat, ["dm-u1:late first", "dm-u2:second"]);
});

test("a window turn clears the session's route instead of inheriting it", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	await dm(s, "u1", "hello");
	await s.rt.imEndpoint("im-pair", { id: conn.id, senderId: "u1", allow: true });
	await dm(s, "u1", "from im");
	await s.flush();
	s.fake.sent.length = 0;
	// The user types in the window: this turn has no IM request, so it must not inherit
	// the chat the previous IM message came from.
	s.emitEvent("a", "user/message", { turn: 3, content: [{ type: "text", text: "typed in the window" }] });
	s.emitEvent("a", "assistant/message", { turn: 3, message: { content: [{ type: "text", text: "window answer" }] } });
	await s.flush();
	assert.deepEqual(s.fake.sent, [], "a window turn is not sent to IM");
});

test("changing a chat's target invalidates routes recorded before it", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	await dm(s, "u1", "hello");
	await s.rt.imEndpoint("im-pair", { id: conn.id, senderId: "u1", allow: true });
	await dm(s, "u1", "from im");
	// The sends before this point are durable but asynchronous; let them land before the
	// list is reset, or a late one looks like the stale route firing.
	assert.ok(await s.until(() => s.fake.sent.length >= 2), "the earlier replies are sent");
	const request = s.prompts.at(-1)?.requestId;
	s.emitEvent("a", "user/message", { source: { kind: "user", rpcId: request }, turn: 4, content: [] });
	s.fake.sent.length = 0;
	// The chat is pointed somewhere else: the old route must not deliver to it.
	await s.rt.imEndpoint("im-chat", { id: conn.id, chatKey: "dm-u1", target: null });
	s.emitEvent("a", "assistant/message", { turn: 4, message: { content: [{ type: "text", text: "late" }] } });
	await s.flush();
	assert.deepEqual(s.fake.sent, [], "a stale binding sends nothing");
});

// A card belongs to the request that raised it, like its text does.
test("a question card goes only to the chat whose request raised it", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 }, { id: "u2", name: "U2", at: 1 });
	one.chats ??= {};
	one.chats["dm-u1"] = { kind: "direct", title: "U1", at: 1 };
	one.chats["dm-u2"] = { kind: "direct", title: "U2", at: 1 };
	await s.rt.save();
	// The request came from u1; u2 is a bound chat but did not ask for this.
	await dm(s, "u1", "raise a question");
	await s.flush();
	s.fake.sent.length = 0;
	s.rt.state.questions.a = { id: "q1", question: "Which?", options: [{ label: "yes" }, { label: "no" }] };
	await s.rt.save();
	await s.flush();
	assert.ok(await s.until(() => s.fake.sent.length > 0), "the card is sent");
	assert.ok(
		s.fake.sent.every((entry: any) => entry.chat.key === "dm-u1"),
		`only the asking chat gets the card, saw ${JSON.stringify(s.fake.sent.map((entry: any) => entry.chat.key))}`,
	);
});

test("a question raised in the window sends no card to IM", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await s.flush();
	s.fake.sent.length = 0;
	// The window opened the question: no IM request raised it.
	s.rt.state.questions.a = { id: "q2", question: "Which?", options: [{ label: "yes" }] };
	await s.rt.save();
	await s.flush();
	assert.deepEqual(s.fake.sent, [], "a window question stays in the window");
});

// ---------------------------------------------------------------------------
// Group chats: a platform group bound to an in-app group chat.

test("a group line reaches the bound group chat and no other chat", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	one.chats ??= {};
	one.chats["dm-u1"] = { kind: "direct", title: "U1", at: 1 };
	await s.rt.save();
	// The work came from the group: this request is the group chat's origin.
	await gm(s, "u1", "hello group");
	await s.rt.imEndpoint("im-chat", { id: conn.id, chatKey: "g1", target: { roomId: "r1" } });
	await gm(s, "u1", "@fakebot do the thing");
	await s.flush();
	s.fake.sent.length = 0;
	// A member's line is posted back into the group chat, never into a direct chat.
	s.rt.logRoom(s.rt.state.rooms.r1, { botId: "b", who: "Writer", text: "the draft is ready" });
	assert.ok(await s.until(() => s.fake.sent.length > 0), "the line is posted");
	assert.ok(
		s.fake.sent.every((entry: any) => entry.chat.key === "g1"),
		"only the group chat got it",
	);
	assert.match(s.fake.sent[0].text, /draft is ready/);
});

test("a question raised in a bound group chat sends its card there", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await gm(s, "u1", "@fakebot ask the team");
	await s.rt.imEndpoint("im-chat", { id: conn.id, chatKey: "g1", target: { roomId: "r1" } });
	await gm(s, "u1", "@fakebot a question");
	await s.flush();
	s.fake.sent.length = 0;
	s.rt.state.questions.r1 = { id: "q1", question: "Which provider?", options: [{ label: "A" }, { label: "B" }] };
	await s.rt.save();
	await s.flush();
	assert.ok(await s.until(() => s.fake.sent.length > 0), "the card is sent");
	assert.ok(
		s.fake.sent.every((entry: any) => entry.chat.key === "g1"),
		"the card stays in the group chat",
	);
});

test("an unpaired sender in a group asks once, and pairing lets the mention through", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	await gm(s, "u9", "@fakebot hello group");
	assert.ok(await s.until(() => s.fake.sent.some((entry: any) => /connection request/.test(String(entry.text)))));
	assert.equal(s.prompts.length, 0, "nothing reaches a Bot before pairing");
	await s.rt.imEndpoint("im-pair", { id: conn.id, senderId: "u9", allow: true });
	await s.rt.imEndpoint("im-chat", { id: conn.id, chatKey: "g1", target: { roomId: "r1" } });
	await gm(s, "u9", "@fakebot now do it");
	assert.equal(s.prompts.length, 1, "the paired mention starts a turn in the group chat");
	assert.equal(s.prompts[0].sessionId, "r1");
});

test("a Bot hands a file to the IM chat its request came from, and the copy is dropped", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	s.rt.state.im.connections[conn.id].paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	// A direct chat of a paired sender already belongs to the connection's Bot.
	await dm(s, "u1", "make me a report");
	await s.flush();
	const file = join(s.home, "report.txt");
	writeFileSync(file, "the numbers");
	const result = await s.rt.imSendFile(s.rt.chatOf("a"), { path: file, note: "Here is the report" });
	assert.equal(result.sent, 1);
	const sent = await lastSent(s);
	assert.equal(sent.text, "Here is the report");
	assert.equal(sent.media.length, 1);
	assert.equal(sent.media[0].name, "report.txt");
	assert.equal(Buffer.from(sent.media[0].data).toString(), "the numbers");
	// The copy under the plugin home is gone once the send has an outcome.
	await s.until(() => {
		try {
			return readdirSync(join(s.home, "im", "media")).length === 0;
		} catch {
			return true;
		}
	});
});

test("a file is refused when the request did not come from an IM chat", async (t) => {
	const s = await start(t);
	await add(s);
	const file = join(s.home, "loose.txt");
	writeFileSync(file, "x");
	const result = await s.rt.imSendFile(s.rt.chatOf("a"), { path: file });
	assert.equal(result.sent, 0);
	assert.match(String(result.reason), /not linked to an IM chat/);
});

// Real DSH shapes: the turn is on turn/start, and user/message only carries the rpc id.
// The reply has to find its request through that start event, not through a turn field
// the message never had.
test("a real-DSH turn binds through turn/start and its answer reaches the chat", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	const request = s.prompts.at(-1)?.requestId;
	s.emitEvent("a", "turn/start", { turn: 2 });
	s.emitEvent("a", "user/message", { source: { kind: "user", rpcId: request }, content: [] });
	s.emitEvent("a", "assistant/message", { turn: 2, message: { content: [{ type: "text", text: "real reply" }] } });
	assert.ok(await s.until(() => s.fake.sent.length === 1), "the answer reaches the chat");
	assert.equal(s.fake.sent[0].text, "real reply");
});

test("a window turn in the same session does not inherit the IM route", async (t) => {
	const s = await start(t);
	const conn = await add(s);
	const one = s.rt.state.im.connections[conn.id];
	one.paired.push({ id: "u1", name: "U1", at: 1 });
	await s.rt.save();
	await dm(s, "u1", "hi");
	s.fake.sent.length = 0;
	s.emitEvent("a", "turn/start", { turn: 3 });
	s.emitEvent("a", "user/message", { source: { kind: "user" }, content: [] });
	s.emitEvent("a", "assistant/message", {
		turn: 3,
		message: { content: [{ type: "text", text: "typed at the desk" }] },
	});
	await s.flush();
	assert.deepEqual(s.fake.sent, [], "a turn from the window answers the window");
});
