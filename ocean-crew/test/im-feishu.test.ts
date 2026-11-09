// The Feishu adapter runs on @larksuiteoapi/node-sdk; these tests inject a fake of
// the SDK parts it uses (`env.lark`), so no WebSocket or HTTP request is made. The
// dispatcher receives events the way the real EventDispatcher delivers them — the
// v2 envelope flattened onto the event object.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import feishu from "../src/host/im/platforms/feishu.ts";

const FIELDS = { domain: "feishu", appId: "cli_a1", appSecret: "sec-123" };
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

const until = async (check: () => unknown, tries = 200): Promise<any> => {
	for (let at = 0; at < tries; at += 1) {
		const value = check();
		if (value !== undefined && value !== false) return value;
		await tick();
	}
	throw new Error("timed out waiting for the fake SDK");
};

function fakeSdk(overrides: any = {}) {
	const fake: any = {
		Domain: { Feishu: 0, Lark: 1 },
		LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
		warns: [] as string[],
		clientOptions: [] as any[],
		socketOptions: [] as any[],
		requests: [] as any[],
		creates: [] as any[],
		patches: [] as any[],
		updates: [] as any[],
		replies: [] as any[],
		messageGets: [] as any[],
		contactGets: [] as any[],
		reactionCreates: [] as any[],
		reactionDeletes: [] as any[],
		chatGets: [] as any[],
		resourceGets: [] as any[],
		dispatchers: [] as any[],
		sockets: [] as any[],
		bot: overrides.bot ?? { open_id: "ou_bot", app_name: "fakebot" },
		botResult: overrides.botResult,
		chatResult: overrides.chatResult,
		createResult: overrides.createResult,
		createFailures: overrides.createFailures ? [...overrides.createFailures] : [],
		patchResult: overrides.patchResult,
		updateResult: overrides.updateResult,
		replyResult: overrides.replyResult,
		replyGone: overrides.replyGone,
		quotedMessages: overrides.quotedMessages ?? {},
		contactNames: overrides.contactNames ?? {},
		reactionCreateResult: overrides.reactionCreateResult,
		reactionDeleteResult: overrides.reactionDeleteResult,
		resources: overrides.resources ?? {},
		chatInfo: overrides.chatInfo ?? (() => ({ name: "Fake Group", chat_mode: "group" })),
		sent: 0,
	};
	const settle = (value: any, fallback: any): any => {
		if (value === undefined) return fallback;
		if (value instanceof Error) throw value;
		if (typeof value === "function") return value();
		return value;
	};
	fake.Client = class {
		im: any;
		contact: any;
		constructor(options: any) {
			fake.clientOptions.push(options);
			this.contact = {
				v3: {
					user: {
						get: (payload: any) => {
							fake.contactGets.push(payload);
							const name = fake.contactNames[payload?.path?.user_id];
							if (name === undefined) {
								return Promise.reject(
									Object.assign(new Error("no such user"), {
										response: { status: 400, data: { code: 41050, msg: "no user authority" } },
									}),
								);
							}
							return settle(undefined, { code: 0, data: { user: { name } } });
						},
					},
				},
			};
			this.im = {
				message: {
					create: (payload: any) => {
						fake.creates.push(payload);
						const failure = fake.createFailures.shift();
						if (failure !== undefined) {
							const rejected: any = new Error(failure);
							rejected.response = { status: 400, data: { code: 230001, msg: failure } };
							return Promise.reject(rejected);
						}
						return settle(fake.createResult, { code: 0, data: { message_id: `om_${++fake.sent}` } });
					},
					patch: (payload: any) => {
						fake.patches.push(payload);
						return settle(fake.patchResult, { code: 0, data: {} });
					},
					update: (payload: any) => {
						fake.updates.push(payload);
						return settle(fake.updateResult, { code: 0, data: {} });
					},
					get: (payload: any) => {
						fake.messageGets.push(payload);
						const held = fake.quotedMessages[payload?.path?.message_id];
						if (held === undefined) {
							return Promise.reject(
								Object.assign(new Error("message not found"), {
									response: { status: 400, data: { code: 230011, msg: "message not found" } },
								}),
							);
						}
						return settle(undefined, { code: 0, data: { items: [held] } });
					},
					reply: (payload: any) => {
						fake.replies.push(payload);
						const gone = fake.replyGone;
						if (gone !== undefined) {
							// The SDK rejects with the platform answer on `response.data`.
							const failure: any = new Error("reply target is gone");
							failure.response = { status: 400, data: { code: gone, msg: "message not found" } };
							return Promise.reject(failure);
						}
						return settle(fake.replyResult, { code: 0, data: { message_id: `om_r${++fake.sent}` } });
					},
				},
				messageReaction: {
					create: (payload: any) => {
						fake.reactionCreates.push(payload);
						return settle(fake.reactionCreateResult, {
							code: 0,
							data: { reaction_id: `re_${fake.reactionCreates.length}` },
						});
					},
					delete: (payload: any) => {
						fake.reactionDeletes.push(payload);
						return settle(fake.reactionDeleteResult, { code: 0, data: {} });
					},
				},
				messageResource: {
					get: (payload: any) => {
						fake.resourceGets.push(payload);
						const held = fake.resources[payload.path.file_key];
						if (held === undefined) return Promise.reject(new Error(`no fake resource ${payload.path.file_key}`));
						if (held instanceof Error) return Promise.reject(held);
						const data = Buffer.isBuffer(held) ? held : held.data;
						return Promise.resolve({
							headers: held.headers ?? { "content-length": String(data.length) },
							getReadableStream: () => Readable.from([data]),
						});
					},
				},
				chat: {
					get: (payload: any) => {
						fake.chatGets.push(payload);
						return settle(fake.chatResult, { code: 0, data: fake.chatInfo(payload.path.chat_id) });
					},
				},
			};
		}

		request(payload: any) {
			fake.requests.push(payload);
			return settle(fake.botResult, { code: 0, bot: fake.bot });
		}
	};
	fake.WSClient = class {
		options: any;
		started = false;
		closed: any[] = [];
		constructor(options: any) {
			this.options = options;
			fake.socketOptions.push(options);
			fake.sockets.push(this);
		}

		async start({ eventDispatcher }: any) {
			this.started = true;
			fake.dispatchers.push(eventDispatcher);
			await Promise.resolve();
			this.options.onReady?.();
		}

		close(params?: any) {
			this.closed.push(params ?? {});
		}
	};
	fake.EventDispatcher = class {
		options: any;
		handlers: Record<string, (event: any) => void> = {};
		constructor(options: any) {
			this.options = options;
			fake.dispatchers.push({ handlers: this.handlers });
		}

		register(handlers: Record<string, (event: any) => void>) {
			Object.assign(this.handlers, handlers);
			const registered = fake.dispatchers.at(-1);
			if (registered !== undefined && registered.handlers !== this.handlers) registered.handlers = this.handlers;
			return this;
		}
	};
	return fake;
}

const fakeRuntime = (initial: any = {}) => {
	const data = { ...initial };
	return { data, get: () => data, set: (patch: any) => Object.assign(data, patch) };
};

const envOf = (fake: any, runtime: any = fakeRuntime()) => ({
	lark: fake,
	config: {},
	runtime,
	log: { warn: (template: string, ...args: unknown[]) => fake.warns.push([template, ...args].map(String).join(" ")) },
});

const setup = async (fake: any, fields: any = FIELDS, runtime: any = fakeRuntime()) => {
	const seen: { statuses: any[]; messages: any[]; actions: any[] } = { statuses: [], messages: [], actions: [] };
	const handle = feishu.connect(fields, envOf(fake, runtime), {
		onStatus: (status: any) => {
			seen.statuses.push(status);
		},
		onMessage: async (message: any) => {
			seen.messages.push(message);
		},
		onAction: async (action: any) => {
			seen.actions.push(action);
		},
	});
	await until(() => seen.statuses.some((status) => status.state === "ready"));
	return { handle, runtime, ...seen };
};

const handlerOf = (fake: any, name: string): ((event: any) => void) => {
	const dispatcher = fake.dispatchers.at(-1);
	assert.ok(dispatcher, "an EventDispatcher was registered");
	const handler = dispatcher.handlers[name];
	assert.equal(typeof handler, "function", `${name} is registered`);
	return handler;
};

// The adapter acknowledges the event before it dispatches (a slow handler
// makes Feishu redeliver), so the caller waits for the observable effect.
const dispatch = async (fake: any, name: string, event: any, settled: () => unknown = () => true) => {
	handlerOf(fake, name)(event);
	await until(settled);
};

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 20));

const messageEvent = (body: any) => ({
	sender: { sender_id: { open_id: "ou_u1" }, sender_name: "Alice" },
	message: {
		chat_type: "group",
		chat_id: "oc_group",
		message_id: "om_1",
		message_type: "text",
		content: JSON.stringify({ text: "hello" }),
		mentions: [],
		...body,
	},
});

test("check reads the bot identity and follows fields.domain", async () => {
	const fake = fakeSdk();
	const { account } = await feishu.check(FIELDS, envOf(fake));
	assert.deepEqual(account, { id: "ou_bot", name: "fakebot" });
	assert.equal(fake.clientOptions.length, 1);
	assert.equal(fake.clientOptions[0].appId, "cli_a1");
	assert.equal(fake.clientOptions[0].appSecret, "sec-123");
	assert.equal(fake.clientOptions[0].domain, fake.Domain.Feishu);
	assert.deepEqual(fake.requests[0], { method: "GET", url: "/open-apis/bot/v3/info" });

	const larkEdition = fakeSdk();
	await feishu.check({ ...FIELDS, domain: "lark" }, envOf(larkEdition));
	assert.equal(larkEdition.clientOptions[0].domain, larkEdition.Domain.Lark);
});

test("check reports the platform code and message when the credentials are refused", async () => {
	const fake = fakeSdk({ botResult: { code: 10003, msg: "invalid param" } });
	await assert.rejects(feishu.check(FIELDS, envOf(fake)), (error: any) => {
		assert.match(error.message, /invalid param/);
		assert.match(error.message, /10003/);
		assert.equal(error.permanent, true);
		return true;
	});
});

test("check refuses blank credentials", async () => {
	await assert.rejects(feishu.check({ appId: "", appSecret: "" }, envOf(fakeSdk())), /App ID and an App Secret/);
});

test("connect builds the SDK clients and reports the connection state", async () => {
	const fake = fakeSdk();
	const { statuses } = await setup(fake);
	assert.deepEqual(statuses[0], { state: "connecting" });
	const options = fake.socketOptions[0];
	assert.equal(options.appId, "cli_a1");
	assert.equal(options.appSecret, "sec-123");
	assert.equal(options.domain, fake.Domain.Feishu);
	assert.equal(options.handshakeTimeoutMs, 15_000);
	assert.equal(options.autoReconnect, true);
	assert.ok(options.wsConfig.pingTimeout > 0);
	const handlers = fake.dispatchers[0].handlers;
	assert.equal(typeof handlers["im.message.receive_v1"], "function");
	assert.equal(typeof handlers["card.action.trigger"], "function");

	const socket = fake.sockets[0];
	socket.options.onReconnecting();
	socket.options.onReconnected();
	socket.options.onError(new Error("the secret sec-123 was rejected"));
	assert.equal(statuses.filter((status) => status.state === "connecting").length, 2);
	assert.equal(statuses.filter((status) => status.state === "ready").length, 2);
	const error = statuses.find((status) => status.state === "error");
	assert.match(error.error, /the secret \*\*\* was rejected/);
	assert.doesNotMatch(error.error, /sec-123/);
});

test("a p2p message is direct and drops mention placeholders", async () => {
	const fake = fakeSdk({ chatInfo: () => ({ name: "Alice", chat_mode: "p2p" }) });
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			chat_type: "p2p",
			chat_id: "oc_p2p",
			content: JSON.stringify({ text: "@_user_1 hello" }),
			mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
		}),
		() => messages.length === 1,
	);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].chat, { key: "oc_p2p", kind: "direct", title: "Alice" });
	assert.equal(messages[0].mentioned, false);
	assert.equal(messages[0].text, "hello");
	assert.deepEqual(messages[0].sender, { id: "ou_u1", name: "Alice" });
	assert.equal(messages[0].messageId, "om_1");
});

test("a group message counts only when the bot is mentioned, and the chat name is cached", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_1",
			content: JSON.stringify({ text: "@_user_1 ping" }),
			mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
		}),
		() => messages.length === 1,
	);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_2", content: JSON.stringify({ text: "noise" }) }),
		() => messages.length === 2,
	);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].chat.kind, "group");
	assert.equal(messages[0].chat.title, "Fake Group");
	assert.equal(messages[0].mentioned, true);
	assert.equal(messages[0].text, "ping");
	assert.equal(messages[1].mentioned, false);
	assert.equal(fake.chatGets.length, 1);
});

test("a mention-only text is dispatched but an unreadable type is skipped", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			content: JSON.stringify({ text: "@_user_1 " }),
			mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
		}),
		() => messages.length === 1,
	);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_2", message_type: "sticker", content: JSON.stringify({ file_key: "sticker_1" }) }),
	);
	await settle();
	assert.equal(messages.length, 1);
	assert.equal(messages[0].text, "");
	assert.equal(messages[0].mentioned, true);
});

test("a group mention still counts when the bot info is unavailable", async () => {
	const fake = fakeSdk({ botResult: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			content: JSON.stringify({ text: "@_user_1 hi" }),
			mentions: [{ key: "@_user_1", id: { open_id: "ou_someone" } }],
		}),
		() => messages.length === 1,
	);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].mentioned, true);
	assert.equal(messages[0].text, "hi");
	assert.ok(fake.warns.some((warn: string) => warn.includes("feishu bot info failed")));
});

test("an image message downloads the resource and keeps its real media type", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5]);
	const fake = fakeSdk({ resources: { img_png: png, img_jpeg: jpeg } });
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_1", message_type: "image", content: JSON.stringify({ image_key: "img_png" }) }),
		() => messages.length === 1,
	);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_2", message_type: "image", content: JSON.stringify({ image_key: "img_jpeg" }) }),
		() => messages.length === 2,
	);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].images.length, 1);
	assert.equal(messages[0].images[0].mediaType, "image/png");
	assert.equal(messages[0].images[0].data, png.toString("base64"));
	assert.equal(messages[1].images[0].mediaType, "image/jpeg");
	assert.deepEqual(fake.resourceGets[0], {
		path: { message_id: "om_1", file_key: "img_png" },
		params: { type: "image" },
	});
});

test("a file message downloads it and drops one over the size limit", async () => {
	const data = Buffer.from("hello file");
	const fake = fakeSdk({
		resources: {
			file_small: data,
			file_big: { data: Buffer.alloc(8), headers: { "content-length": String(21 * 1024 * 1024) } },
		},
	});
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_1",
			message_type: "file",
			content: JSON.stringify({ file_key: "file_small", file_name: "notes.txt" }),
		}),
		() => messages.length === 1,
	);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_2",
			message_type: "file",
			content: JSON.stringify({ file_key: "file_big", file_name: "huge.bin" }),
		}),
		() => fake.warns.some((warn: string) => warn.includes("feishu file download failed")),
	);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].files.length, 1);
	assert.equal(messages[0].files[0].name, "notes.txt");
	assert.deepEqual(messages[0].files[0].data, data);
	assert.ok(fake.warns.some((warn: string) => warn.includes("feishu file download failed")));
});

test("a post message contributes the text of its title and paragraphs", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_type: "post",
			content: JSON.stringify({
				title: "Report",
				content: [
					[
						{ tag: "text", text: "first " },
						{ tag: "a", text: "link", href: "https://example.com" },
					],
					[{ tag: "text", text: "@_user_1 second" }],
				],
			}),
		}),
		() => messages.length === 1,
	);
	assert.equal(messages.length, 1);
	// A link keeps its target, and a mention placeholder is still stripped from plain text.
	assert.equal(messages[0].text, "Report\nfirst [link](https://example.com)\nsecond");
});

test("a card action reports its button data and chat identity", async () => {
	const fake = fakeSdk();
	const { messages, actions } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ content: JSON.stringify({ text: "hi" }) }),
		() => messages.length === 1,
	);
	assert.equal(messages.length, 1);
	await dispatch(
		fake,
		"card.action.trigger",
		{
			operator: { open_id: "ou_u1", name: "Alice" },
			action: { value: { v: "q:q1:0" } },
			context: { open_chat_id: "oc_group", open_message_id: "om_card" },
		},
		() => actions.length === 1,
	);
	assert.equal(actions.length, 1);
	assert.deepEqual(actions[0].chat, { key: "oc_group", kind: "group", title: "Fake Group" });
	assert.deepEqual(actions[0].sender, { id: "ou_u1", name: "Alice" });
	assert.equal(actions[0].data, "q:q1:0");
	assert.equal(actions[0].messageId, "om_card");
	assert.equal(fake.chatGets.length, 1);
});

test("send chunks the text and turns the last chunk into a card", async () => {
	const fake = fakeSdk();
	const { handle } = await setup(fake);
	const { messageId } = await handle.send(
		{ key: "oc_group", kind: "group" },
		{ text: "a".repeat(4001), buttons: [{ data: "q:q1:0", label: "yes" }] },
	);
	assert.equal(fake.creates.length, 2);
	const [first, last] = fake.creates;
	assert.deepEqual(first.params, { receive_id_type: "chat_id" });
	assert.equal(first.data.receive_id, "oc_group");
	// Prose is a Markdown post, so the platform renders emphasis and lists itself.
	assert.equal(first.data.msg_type, "post");
	const firstText = JSON.parse(first.data.content).zh_cn.content[0][0].text;
	// A split reply marks each part, and the marker fits inside the limit.
	assert.match(firstText, / \(1\/2\)$/);
	assert.ok([...firstText].length <= 4000, `part is within the limit: ${[...firstText].length}`);
	assert.equal(last.data.msg_type, "interactive");
	const card = JSON.parse(last.data.content);
	assert.equal(card.schema, "2.0");
	// 4001 chars split at the limit leaves the remainder plus the marker.
	assert.deepEqual(card.body.elements[0], { tag: "markdown", content: `${"a".repeat(9)} (2/2)` });
	assert.equal(card.body.elements[1].tag, "action");
	assert.deepEqual(card.body.elements[1].actions[0].value, { v: "q:q1:0" });
	assert.equal(card.body.elements[1].actions[0].text.content, "yes");
	assert.equal(messageId, "om_2");
});

test("send posts text and edit patches the card", async () => {
	const fake = fakeSdk();
	const { handle } = await setup(fake);
	const sent = await handle.send({ key: "oc_p2p", kind: "direct" }, { text: "hello" });
	assert.equal(sent.messageId, "om_1");
	assert.equal(fake.creates.length, 1);
	assert.equal(fake.creates[0].data.receive_id, "oc_p2p");
	assert.equal(fake.creates[0].data.msg_type, "post");
	await handle.edit({ key: "oc_p2p", kind: "direct" }, "om_9", {
		text: "done",
		buttons: [{ data: "a:1:allow", label: "Allow" }],
	});
	assert.equal(fake.patches.length, 1);
	assert.deepEqual(fake.patches[0].path, { message_id: "om_9" });
	const card = JSON.parse(fake.patches[0].data.content);
	assert.equal(card.body.elements[0].content, "done");
	assert.deepEqual(card.body.elements[1].actions[0].value, { v: "a:1:allow" });
});

test("a refused send is permanent while a lost response is unknown", async () => {
	const fake = fakeSdk({ createResult: { code: 230002, msg: "bot is not in the chat" } });
	const { handle } = await setup(fake);
	await assert.rejects(handle.send({ key: "oc_group" }, { text: "hello" }), (error: any) => {
		assert.match(error.message, /bot is not in the chat/);
		assert.match(error.message, /230002/);
		assert.equal(error.permanent, true);
		return true;
	});
	fake.createResult = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
	await assert.rejects(handle.send({ key: "oc_group" }, { text: "hello" }), (error: any) => {
		assert.equal(error.unknown, true);
		assert.notEqual(error.permanent, true);
		return true;
	});
});

test("a refused HTTP status is permanent and a 429 carries the retry delay", async () => {
	const fake = fakeSdk();
	const { handle } = await setup(fake);
	fake.createResult = Object.assign(new Error("bad request"), {
		response: { status: 400, data: { code: 10003, msg: "invalid param" } },
	});
	await assert.rejects(handle.send({ key: "oc_group" }, { text: "hello" }), (error: any) => {
		assert.match(error.message, /invalid param/);
		assert.match(error.message, /10003/);
		assert.equal(error.permanent, true);
		return true;
	});
	fake.createResult = Object.assign(new Error("too many requests"), {
		response: { status: 429, headers: { "retry-after": "7" } },
	});
	await assert.rejects(handle.send({ key: "oc_group" }, { text: "hello" }), (error: any) => {
		assert.equal(error.retryAfter, 7);
		assert.notEqual(error.permanent, true);
		return true;
	});
});

test("stop closes the socket with force and drops later callbacks", async () => {
	const fake = fakeSdk();
	const { handle, statuses, messages } = await setup(fake);
	const socket = fake.sockets[0];
	const before = statuses.length;
	handle.stop();
	assert.deepEqual(socket.closed, [{ force: true }]);
	socket.options.onReady();
	socket.options.onError(new Error("late error"));
	await dispatch(fake, "im.message.receive_v1", messageEvent({ content: JSON.stringify({ text: "late" }) }));
	await settle();
	assert.equal(statuses.length, before);
	assert.equal(messages.length, 0);
});

test("a redelivered message id is dispatched once", async () => {
	const fake = fakeSdk();
	const { runtime, messages } = await setup(fake);
	const event = messageEvent({ message_id: "om_dup", content: JSON.stringify({ text: "hello" }) });
	// A copy can arrive while the first one is still being handled.
	handlerOf(fake, "im.message.receive_v1")(event);
	await dispatch(fake, "im.message.receive_v1", event);
	await until(() => runtime.data.seenMessageIds?.includes("om_dup"));
	// A copy arriving after the first one finished is dropped by the runtime set.
	await dispatch(fake, "im.message.receive_v1", event);
	await settle();
	assert.equal(messages.length, 1);
	assert.deepEqual(runtime.data.seenMessageIds, ["om_dup"]);
});

test("a message id remembered in the runtime is not dispatched again", async () => {
	const fake = fakeSdk();
	const runtime = fakeRuntime({ seenMessageIds: ["om_seen"] });
	const { messages } = await setup(fake, FIELDS, runtime);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_seen", content: JSON.stringify({ text: "again" }) }),
	);
	await settle();
	assert.equal(messages.length, 0);
	assert.deepEqual(runtime.data.seenMessageIds, ["om_seen"]);
});

test("the handle marks and unmarks the source message with emoji reactions", async () => {
	const fake = fakeSdk();
	const { handle, runtime } = await setup(fake);
	const id = await handle.addReaction({ key: "oc_p2p", kind: "direct" }, "om_1", "OnIt");
	assert.equal(id, "re_1");
	assert.deepEqual(fake.reactionCreates[0], {
		path: { message_id: "om_1" },
		data: { reaction_type: { emoji_type: "OnIt" } },
	});
	await handle.removeReaction({ key: "oc_p2p", kind: "direct" }, "om_1", "re_1");
	assert.deepEqual(fake.reactionDeletes[0], {
		path: { message_id: "om_1", reaction_id: "re_1" },
	});
	assert.deepEqual(runtime.data, {}, "a reaction is never written to the adapter runtime");
});

test("a refused reaction is a classified error the host can swallow", async () => {
	const fake = fakeSdk({ reactionCreateResult: { code: 230002, msg: "no reaction permission" } });
	const { handle } = await setup(fake);
	await assert.rejects(handle.addReaction({}, "om_1", "OnIt"), (error: any) => {
		assert.match(error.message, /no reaction permission/);
		assert.match(error.message, /230002/);
		assert.equal(error.permanent, true);
		return true;
	});
	const unknown = fakeSdk({ reactionCreateResult: { code: 230049, msg: "result unknown" } });
	const second = await setup(unknown);
	await assert.rejects(second.handle.addReaction({}, "om_1", "OnIt"), (error: any) => {
		assert.equal(error.unknown, true);
		return true;
	});
});

// A reply threads under the message that asked for it; a gone target falls back.
test("an answer replies to the message it answers, and only the first bubble does", async () => {
	const fake = fakeSdk();
	const { handle } = await setup(fake);
	const sent = await handle.send(
		{ key: "oc_p2p", kind: "direct" },
		{ text: `${"a".repeat(4001)}`, replyTo: "om_ask" },
	);
	assert.equal(fake.replies.length, 1, "only the first bubble threads");
	// The returned id is the last bubble sent, which here is the plainly-sent second one.
	assert.equal(sent.messageId, "om_2");
	assert.deepEqual(fake.replies[0].path, { message_id: "om_ask" });
	assert.equal(fake.creates.length, 1, "the second bubble is a plain message");
});

test("a reply whose target is gone is sent plainly instead of lost", async () => {
	const fake = fakeSdk({ replyGone: 230011 });
	const { handle } = await setup(fake);
	const sent = await handle.send({ key: "oc_p2p", kind: "direct" }, { text: "hello", replyTo: "om_deleted" });
	assert.equal(fake.replies.length, 1);
	assert.equal(fake.creates.length, 1, "fell back to a plain message");
	assert.equal(sent.messageId, "om_1");
});

test("edit patches a card and updates a post, each on its own endpoint", async () => {
	const fake = fakeSdk();
	const { handle } = await setup(fake);
	await handle.edit({ key: "oc_p2p", kind: "direct" }, "om_5", { text: "done" });
	assert.equal(fake.updates.length, 1, "a post is updated in place");
	assert.equal(fake.patches.length, 0);
	assert.deepEqual(fake.updates[0].path, { message_id: "om_5" });
	assert.equal(fake.updates[0].data.msg_type, "post");
	await handle.edit({ key: "oc_p2p", kind: "direct" }, "om_6", {
		text: "answered",
		buttons: [{ data: "a:1:allow", label: "Allow" }],
	});
	assert.equal(fake.patches.length, 1, "a card is patched");
	assert.equal(fake.updates.length, 1);
});

// A post Feishu refuses is retried as plain text, so the answer still arrives.
test("a rejected post is sent as plain text instead of failing the reply", async () => {
	const fake = fakeSdk({ createFailures: ["content format of the post type is incorrect"] });
	const { handle } = await setup(fake);
	const sent = await handle.send({ key: "oc_p2p", kind: "direct" }, { text: "**bold** answer" });
	assert.equal(fake.creates.length, 2, "first the post, then the fallback");
	assert.equal(fake.creates[0].data.msg_type, "post");
	assert.equal(fake.creates[1].data.msg_type, "text");
	assert.match(fake.creates[1].data.content, /bold/);
	assert.equal(sent.messageId, "om_1");
});

test("every send carries a uuid so a retry cannot double-post", async () => {
	const fake = fakeSdk();
	const { handle } = await setup(fake);
	await handle.send({ key: "oc_p2p", kind: "direct" }, { text: "hello" });
	assert.match(fake.creates[0].data.uuid, /^[0-9a-f-]{36}$/);
});

// A reply quotes the message it answers: the model cannot resolve "this one" otherwise.
test("a replied-to message is inlined before the reply text", async () => {
	const fake = fakeSdk({
		quotedMessages: {
			om_q: { msg_type: "text", body: { content: JSON.stringify({ text: "明天几点出发？" }) } },
		},
	});
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_2", parent_id: "om_q", content: JSON.stringify({ text: "九点" }) }),
		() => messages.length > 0,
	);
	assert.equal(messages[0].text, '[Replying to: "明天几点出发？"]\n\n九点');
	// The quoted message is fetched once and cached for the next reply.
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_id: "om_3", parent_id: "om_q", content: JSON.stringify({ text: "好" }) }),
		() => messages.length > 1,
	);
	assert.equal(fake.messageGets.length, 1);
});

test("a sender without a name is resolved through the contact API", async () => {
	const fake = fakeSdk({ contactNames: { ou_u1: "Alice" } });
	const { messages } = await setup(fake);
	const event = messageEvent({});
	event.sender = { sender_id: { open_id: "ou_u1" } } as any;
	await dispatch(fake, "im.message.receive_v1", event, () => messages.length > 0);
	assert.equal(messages[0].sender.name, "Alice");
	// The name is cached, so a second message does not call the API again.
	await dispatch(fake, "im.message.receive_v1", messageEvent({ message_id: "om_9" }), () => messages.length > 1);
	assert.equal(fake.contactGets.length, 1);
});

test("a forwarded conversation keeps its title and entries", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_type: "merge_forward",
			content: JSON.stringify({
				title: "运维讨论",
				message_list: [
					{ sender_name: "Bob", text: "磁盘满了" },
					{ sender_name: "Carol", text: "先清日志" },
				],
			}),
		}),
		() => messages.length > 0,
	);
	assert.match(messages[0].text, /运维讨论/);
	assert.match(messages[0].text, /Bob: 磁盘满了/);
	assert.match(messages[0].text, /Carol: 先清日志/);
});

test("a shared chat and an interactive card are no longer dropped", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({ message_type: "share_chat", content: JSON.stringify({ chat_id: "oc_x", chat_name: "值班群" }) }),
		() => messages.length > 0,
	);
	assert.match(messages[0].text, /值班群/);
	assert.match(messages[0].text, /oc_x/);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_card",
			message_type: "interactive",
			content: JSON.stringify({
				card: {
					header: { title: { content: "部署确认" } },
					elements: [
						{ tag: "markdown", content: "要发布到生产吗？" },
						{ tag: "action", actions: [{ tag: "button", text: { content: "发布" } }] },
					],
				},
			}),
		}),
		() => messages.length > 1,
	);
	assert.match(messages[1].text, /部署确认/);
	assert.match(messages[1].text, /要发布到生产吗/);
	assert.match(messages[1].text, /Actions: 发布/);
});

test("post elements keep mentions, line breaks and code blocks", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_type: "post",
			content: JSON.stringify({
				zh_cn: {
					title: "周报",
					content: [
						[
							{ tag: "at", user_name: "Bob" },
							{ tag: "text", text: " 看下" },
						],
						[{ tag: "text", text: "第一行" }, { tag: "br" }, { tag: "text", text: "第二行" }],
						[{ tag: "code_block", language: "js", text: "const a = 1;" }],
					],
				},
			}),
		}),
		() => messages.length > 0,
	);
	assert.match(messages[0].text, /@Bob 看下/);
	assert.match(messages[0].text, /第一行\n第二行/);
	assert.match(messages[0].text, /```js\nconst a = 1;\n```/);
});

test("a voice note and a video are downloaded and named for the Bot", async () => {
	const voice = Buffer.from("OggS fake opus");
	const video = Buffer.from("ftyp mp4 bytes");
	const fake = fakeSdk({ resources: { voice_1: voice, video_1: video } });
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_1",
			message_type: "audio",
			content: JSON.stringify({ file_key: "voice_1", duration: 3200 }),
		}),
		() => messages.length === 1,
	);
	assert.equal(messages[0].text, "[Voice message, 3s]");
	assert.equal(messages[0].files.length, 1);
	assert.equal(messages[0].files[0].name, "voice-om_1.opus");
	assert.deepEqual(messages[0].files[0].data, voice);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_2",
			message_type: "media",
			content: JSON.stringify({ file_key: "video_1", duration: 60_000, file_name: "demo.mp4" }),
		}),
		() => messages.length === 2,
	);
	assert.equal(messages[1].text, "[Video, 60s]");
	assert.equal(messages[1].files[0].name, "demo.mp4");
	// Both came from the resource endpoint as files.
	assert.deepEqual(fake.resourceGets.at(-1), {
		path: { message_id: "om_2", file_key: "video_1" },
		params: { type: "file" },
	});
});

test("a voice note that cannot be downloaded says so instead of vanishing", async () => {
	const fake = fakeSdk();
	const { messages } = await setup(fake);
	await dispatch(
		fake,
		"im.message.receive_v1",
		messageEvent({
			message_id: "om_1",
			message_type: "audio",
			content: JSON.stringify({ file_key: "gone", duration: 1000 }),
		}),
		() => messages.length === 1,
	);
	assert.equal(messages[0].text, "[Voice message, 1s: could not be read]");
	assert.equal(messages[0].files.length, 0);
	assert.ok(fake.warns.some((warn: string) => warn.includes("feishu audio download failed")));
});
