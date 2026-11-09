// The WeChat iLink adapter against a fake local iLink: a real loopback HTTP server
// answers the protocol paths, so the adapter's poll/send/typing code runs for real
// without touching the network. Every request's path, headers and body are recorded.

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import weixin, { chunk, withQuoted } from "../src/host/im/platforms/weixin.ts";

// The iLink client version the adapter identifies itself as: 2.4.6 packed as 0x00MMNNPP.
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

// A fake iLink: the QR endpoints walk the login states the test wants, the
// getupdates long poll answers from a queued script or a per-test function,
// and every request is recorded with its headers and body. A test can answer a
// path with raw text, a custom HTTP status, or never answer at all (hang).
async function fakeIlink() {
	const calls: any[] = [];
	const replies: any = { raw: {}, http: {} };
	const pending: any[] = [];
	const aborted: string[] = [];
	const hang = new Set<string>();
	let updates: any[] = [];

	const sendJson = (res: any, answer: any): void => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(answer));
	};
	const http = createServer((req: any, res: any) => {
		let body = "";
		req.on("data", (chunk: any) => {
			body += chunk;
		});
		req.on("end", () => {
			let params: any = {};
			try {
				params = JSON.parse(body || "{}");
			} catch {
				params = {};
			}
			calls.push({
				method: req.method,
				path: req.url,
				params,
				headers: req.headers,
				auth: req.headers.authorization,
			});
			if (hang.has(req.url)) {
				pending.push({ req, res });
				res.on("close", () => {
					if (!res.writableEnded) aborted.push(req.url);
				});
				return;
			}
			// A raw body, for a proxy error page or any other non-JSON 200.
			if (replies.raw?.[req.url] !== undefined) {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(replies.raw[req.url]);
				return;
			}
			// A custom HTTP answer, for 429/5xx/4xx paths.
			if (replies.http?.[req.url] !== undefined) {
				const { status = 200, headers = {}, body: payload = {} } = replies.http[req.url];
				res.writeHead(status, { "content-type": "application/json", ...headers });
				res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
				return;
			}
			if (req.url.startsWith("/ilink/bot/get_bot_qrcode")) {
				sendJson(res, replies.qrcode ?? { qrcode: "qr-tok-1", qrcode_img_content: "weixin://qr/abc" });
				return;
			}
			if (req.url.startsWith("/ilink/bot/get_qrcode_status")) {
				const status = (replies.statuses ?? []).shift() ?? replies.lastStatus ?? "wait";
				sendJson(res, typeof status === "object" ? status : { status });
				return;
			}
			if (req.url === "/ilink/bot/getupdates") {
				let answer: any;
				if (updates.length > 0) answer = updates.shift();
				else if (typeof replies.updates === "function") answer = replies.updates(params);
				else answer = replies.updates ?? { ret: 0, msgs: [], get_updates_buf: "c1" };
				sendJson(res, answer);
				return;
			}
			sendJson(res, replies[req.url] ?? { ret: 0 });
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const address = http.address() as any;
	return {
		base: `http://127.0.0.1:${address.port}/`,
		calls,
		replies,
		aborted,
		hang,
		queue: (items: any[]) => {
			updates = items;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const { res } of pending) res.destroy();
				(http as any).closeAllConnections?.();
				http.close(() => resolve());
			}),
	};
}

const env = (fake: any, runtime: any = {}, extra: any = {}) => ({
	fetch: (...args: any[]) => (globalThis.fetch as any)(...args),
	config: { api: fake.base, qr: fake.base },
	runtime: { get: () => runtime, set: (patch: any) => Object.assign(runtime, patch) },
	log: { warn: () => {} },
	...extra,
});
const FIELDS = { token: "wx-tok", baseUrl: "" };
const tokenHash = (value: string): string => createHash("sha256").update(value).digest("hex");
// Runtime context tokens are bound to the bot token's hash and keep a small
// ordering record per user, as the adapter writes them.
const contexts = (users: any): any => ({ contextTokens: { credentialHash: tokenHash("wx-tok"), users } });
const noopHandlers = (statuses: any[] = [], messages: any[] = []) => ({
	onMessage: async (msg: any) => {
		messages.push(msg);
	},
	onAction: () => {},
	onStatus: (status: any) => {
		statuses.push(status);
	},
});

const until = async (fn: () => unknown, tries = 120): Promise<any> => {
	for (let at = 0; at < tries; at += 1) {
		const value = await fn();
		if (value !== undefined && value !== false) return value;
		await new Promise((done) => setTimeout(done, 25));
	}
	return undefined;
};
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 80));

test("login start returns a code, wait reports waiting then scanned then done with the owner", async () => {
	const fake = await fakeIlink();
	fake.replies.statuses = [
		"wait",
		"scaned",
		{ status: "confirmed", bot_token: "wx-tok", baseurl: fake.base, ilink_bot_id: "bot-9", ilink_user_id: "owner-1" },
	];
	try {
		const { loginId, qr, expiresAt } = await weixin.loginStart(env(fake));
		assert.equal(qr, "weixin://qr/abc");
		assert.ok(expiresAt > Date.now());
		assert.equal((await weixin.loginWait(loginId, env(fake))).status, "waiting");
		assert.equal((await weixin.loginWait(loginId, env(fake))).status, "scanned");
		const done = await weixin.loginWait(loginId, env(fake));
		assert.equal(done.status, "done");
		assert.deepEqual(done.owner, { id: "owner-1", name: "owner-1" });
		assert.equal(done.connection.secrets.token, "wx-tok");
		assert.equal(done.connection.account.id, "bot-9");
		assert.equal(done.connection.settings.baseUrl, fake.base);
	} finally {
		await fake.close();
	}
});

test("a refused QR request is a permanent platform error", async () => {
	const fake = await fakeIlink();
	fake.replies.qrcode = { errcode: -1, errmsg: "no permission" };
	try {
		await assert.rejects(
			() => weixin.loginStart(env(fake)),
			(error: any) => error.permanent === true && /no permission/.test(error.message),
		);
	} finally {
		await fake.close();
	}
});

test("login wait follows redirect_host and keeps polling the named host", async () => {
	const first = await fakeIlink();
	const second = await fakeIlink();
	first.replies.statuses = [{ status: "scaned_but_redirect", redirect_host: second.base }];
	second.replies.statuses = [
		"scaned",
		{
			status: "confirmed",
			bot_token: "wx-tok",
			baseurl: second.base,
			ilink_bot_id: "bot-9",
			ilink_user_id: "owner-1",
		},
	];
	try {
		const { loginId } = await weixin.loginStart(env(first));
		assert.equal((await weixin.loginWait(loginId, env(first))).status, "scanned");
		assert.equal((await weixin.loginWait(loginId, env(first))).status, "scanned");
		const done = await weixin.loginWait(loginId, env(first));
		assert.equal(done.status, "done");
		assert.equal(done.connection.settings.baseUrl, second.base);
		assert.equal(first.calls.filter((call) => call.path.startsWith("/ilink/bot/get_qrcode_status")).length, 1);
		assert.equal(second.calls.filter((call) => call.path.startsWith("/ilink/bot/get_qrcode_status")).length, 2);
	} finally {
		await first.close();
		await second.close();
	}
});

test("verification-code and already-bound QR states are terminal errors, not waiting", async () => {
	const cases: Array<[string, RegExp]> = [
		["need_verifycode", /verification code/],
		["verify_code_blocked", /blocked the verification/],
		["binded_redirect", /already bound/],
	];
	for (const [status, pattern] of cases) {
		const fake = await fakeIlink();
		try {
			fake.replies.statuses = [{ status }];
			const { loginId } = await weixin.loginStart(env(fake));
			await assert.rejects(
				() => weixin.loginWait(loginId, env(fake)),
				(error: any) => error.permanent === true && pattern.test(error.message),
			);
			// The login is over: the next poll asks the page to show a new code.
			assert.deepEqual(await weixin.loginWait(loginId, env(fake)), { status: "expired" });
		} finally {
			await fake.close();
		}
	}
});

test("a confirmed scan without bot_token or ilink_bot_id is refused", async () => {
	for (const body of [
		{ status: "confirmed", baseurl: "https://example.weixin.qq.com/", ilink_bot_id: "bot-9" },
		{ status: "confirmed", baseurl: "https://example.weixin.qq.com/", bot_token: "wx-tok" },
	]) {
		const fake = await fakeIlink();
		try {
			fake.replies.statuses = [body];
			const { loginId } = await weixin.loginStart(env(fake));
			await assert.rejects(
				() => weixin.loginWait(loginId, env(fake)),
				(error: any) => error.permanent === true && /credentials/.test(error.message),
			);
		} finally {
			await fake.close();
		}
	}
});

// The session has to be opened before getupdates carries anything, and iLink
// identifies the client by headers on every request it answers.
test("msg/notifystart opens the session before the first getupdates, with the iLink headers", async (t) => {
	const fake = await fakeIlink();
	const statuses: any[] = [];
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	const first = fake.calls[0];
	assert.equal(first.path, "/ilink/bot/msg/notifystart");
	assert.equal(first.headers["ilink-app-id"], "bot");
	assert.equal(first.headers["ilink-app-clientversion"], ILINK_CLIENT_VERSION);
	assert.ok(String(first.headers["x-wechat-uin"] ?? "").length > 0, "X-WECHAT-UIN is sent");
	assert.equal(first.auth, "Bearer wx-tok");
	assert.equal(first.params.base_info.channel_version, "ocean-crew");
	const poll = fake.calls.find((call) => call.path === "/ilink/bot/getupdates");
	assert.equal(poll.params.get_updates_buf, "");
	assert.equal(poll.headers["ilink-app-id"], "bot");
	assert.equal(poll.headers["ilink-app-clientversion"], ILINK_CLIENT_VERSION);
	assert.ok(String(poll.headers["x-wechat-uin"] ?? "").length > 0);
});

test("getupdates keeps the cursor and context_token in runtime and delivers text and voice", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const messages: any[] = [];
	fake.replies.updates = (params: any) => {
		if (params.get_updates_buf === "c1") return { ret: 0, msgs: [], get_updates_buf: "c1" };
		return {
			ret: 0,
			get_updates_buf: "c1",
			msgs: [
				{
					from_user_id: "u1",
					client_id: "m1",
					context_token: "tok-u1",
					item_list: [{ type: 1, text_item: { text: "hello" } }],
				},
				{
					from_user_id: "u1",
					client_id: "m2",
					context_token: "tok-u1",
					item_list: [{ type: 3, voice_item: { text: "a voice transcript" } }],
				},
			],
		};
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers([], messages));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => messages.length === 2);
	assert.equal(runtime.cursor, "c1");
	assert.equal(runtime.contextTokens.credentialHash, tokenHash("wx-tok"));
	assert.equal(runtime.contextTokens.users.u1.token, "tok-u1");
	assert.equal(runtime.contextTokens.users.u1.seq, null);
	assert.equal(messages[0].chat.kind, "direct");
	assert.equal(messages[0].text, "hello");
	assert.equal(messages[1].text, "a voice transcript");
});

// A message is delivered before the cursor moves: a crash between delivery and
// the runtime write replays the batch, which the seen set then skips.
test("the cursor is written only after the batch was delivered", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const cursors: string[] = [];
	let first = true;
	fake.replies.updates = () => {
		if (first) {
			first = false;
			return {
				ret: 0,
				get_updates_buf: "c2",
				msgs: [{ from_user_id: "u1", client_id: "m1", item_list: [{ type: 1, text_item: { text: "hello" } }] }],
			};
		}
		return { ret: 0, msgs: [], get_updates_buf: "c2" };
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), {
		onMessage: async () => {
			cursors.push(runtime.cursor ?? "");
		},
		onAction: () => {},
		onStatus: () => {},
	});
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => runtime.cursor === "c2" && cursors.length === 1);
	assert.deepEqual(cursors, [""]);
	assert.deepEqual(runtime.seenMessageIds, ["m1"]);
});

test("a re-delivered message reaches onMessage once", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const messages: any[] = [];
	let batch = 0;
	fake.replies.updates = () => {
		batch += 1;
		if (batch === 1) {
			return {
				ret: 0,
				get_updates_buf: "c1",
				msgs: [{ from_user_id: "u1", message_id: "m1", item_list: [{ type: 1, text_item: { text: "one" } }] }],
			};
		}
		if (batch === 2) {
			return {
				ret: 0,
				get_updates_buf: "c2",
				msgs: [
					{ from_user_id: "u1", message_id: "m1", item_list: [{ type: 1, text_item: { text: "one" } }] },
					{ from_user_id: "u1", message_id: "m2", item_list: [{ type: 1, text_item: { text: "two" } }] },
				],
			};
		}
		return { ret: 0, msgs: [], get_updates_buf: "c2" };
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers([], messages));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => runtime.cursor === "c2" && runtime.seenMessageIds?.length === 2);
	await settle();
	assert.deepEqual(
		messages.map((msg) => msg.text),
		["one", "two"],
	);
	assert.deepEqual(runtime.seenMessageIds, ["m1", "m2"]);
});

test("send goes through sendmessage with the stored context_token, chunked at the limit", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = { cursor: "c1", ...contexts({ u1: { token: "tok-u1" } }) };
	// The base URL is stored without a trailing slash by iLink; the adapter must
	// not glue the path on twice.
	const fields = { token: "wx-tok", baseUrl: fake.base.replace(/\/$/, "") };
	const handle = weixin.connect(fields, env(fake, runtime), noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	const { messageId } = await handle.send({ key: "u1", kind: "direct" }, { text: "x".repeat(4000) });
	const sends = fake.calls.filter((call) => call.path === "/ilink/bot/sendmessage");
	assert.equal(sends.length, 3, "chunked at the limit");
	assert.equal(sends[0].params.msg.to_user_id, "u1");
	assert.equal(sends[0].params.msg.context_token, "tok-u1");
	assert.equal(sends[0].params.msg.item_list[0].type, 1);
	assert.equal(new Set(sends.map((call) => call.params.msg.client_id)).size, 3);
	assert.equal(messageId, sends.at(-1).params.msg.client_id);
	assert.ok(messageId.startsWith("ocean-crew-"));
});

test("a refused send is permanent, and the auth header carries the token", async (t) => {
	const fake = await fakeIlink();
	fake.replies.updates = { ret: 0, msgs: [] };
	fake.replies["/ilink/bot/sendmessage"] = { ret: -2, errmsg: "msg out of window" };
	const handle = weixin.connect(FIELDS, env(fake, {}), noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	await assert.rejects(
		() => handle.send({ key: "u1", kind: "direct" }, { text: "late" }),
		(error: any) => error.permanent === true && /window/.test(error.message),
	);
	assert.equal(fake.calls[0].auth, "Bearer wx-tok");
	fake.replies.http = { "/ilink/bot/sendmessage": { status: 401 } };
	await assert.rejects(
		() => handle.send({ key: "u1", kind: "direct" }, { text: "late" }),
		(error: any) => error.permanent === true && /refused the token/.test(error.message),
	);
});

// iLink answers with the bare host and the request URL appends its path, so the
// connection base and the QR base must end in exactly one slash for every form the
// user, the scan or a copied URL can produce.
test("the QR base and the connection base end in exactly one slash", async () => {
	const fake = await fakeIlink();
	try {
		const origin = fake.base.replace(/\/$/, "");
		for (const suffix of ["", "/", "///"]) {
			const qrEnv = { ...env(fake), config: { qr: `${origin}${suffix}` } };
			await weixin.loginStart(qrEnv);
			assert.equal(
				fake.calls.at(-1).path,
				"/ilink/bot/get_bot_qrcode?bot_type=3",
				`QR base ${JSON.stringify(suffix)}`,
			);
		}
		for (const api of [origin, `${origin}/`, `${origin}///`]) {
			const answer = await weixin.check({ ...FIELDS, baseUrl: api }, { ...env(fake), config: { api } });
			assert.deepEqual(answer.account, { id: "", name: "WeChat" });
			assert.equal(fake.calls.at(-1).path, "/ilink/bot/msg/notifystart", `baseUrl ${JSON.stringify(api)}`);
		}
	} finally {
		await fake.close();
	}
});

// check probes with msg/notifystart: getupdates would consume the pending
// message batch and would be a side effect of a settings-page test.
test("check opens the session instead of polling, and no ret reads as success", async () => {
	const fake = await fakeIlink();
	try {
		fake.replies["/ilink/bot/msg/notifystart"] = {};
		const answer = await weixin.check(FIELDS, env(fake));
		assert.equal(answer.account.name, "WeChat");
		assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/getupdates").length, 0);
		assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/msg/notifystart").length, 1);
		fake.replies["/ilink/bot/msg/notifystart"] = { ret: 0 };
		await weixin.check(FIELDS, env(fake));
		fake.replies["/ilink/bot/msg/notifystart"] = { ret: -2, errmsg: "bad token" };
		await assert.rejects(
			() => weixin.check(FIELDS, env(fake)),
			(error: any) => error.permanent === true && /start the session \(-2\)/.test(error.message),
		);
		fake.replies["/ilink/bot/msg/notifystart"] = { errcode: -14 };
		await assert.rejects(
			() => weixin.check(FIELDS, env(fake)),
			(error: any) => error.permanent === true && /scan the QR code again/.test(error.message),
		);
	} finally {
		await fake.close();
	}
});

test("check refuses an unreadable answer and reports a 429 retry_after", async () => {
	const fake = await fakeIlink();
	try {
		fake.replies.raw = { "/ilink/bot/msg/notifystart": "<html>bad gateway</html>" };
		await assert.rejects(
			() => weixin.check(FIELDS, env(fake)),
			(error: any) => error.permanent !== true && /unreadable/.test(error.message),
		);
		delete fake.replies.raw;
		fake.replies.http = { "/ilink/bot/msg/notifystart": { status: 429, headers: { "retry-after": "3" } } };
		await assert.rejects(
			() => weixin.check(FIELDS, env(fake)),
			(error: any) => error.retryAfter === 3 && error.permanent !== true,
		);
	} finally {
		await fake.close();
	}
});

test("an idle getupdates without ret is a success: ready, cursor and message", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const messages: any[] = [];
	const statuses: any[] = [];
	let polls = 0;
	// The real idle answer has no ret at all; only errors carry one.
	fake.replies.updates = () => {
		polls += 1;
		if (polls === 1) {
			return {
				msgs: [
					{
						from_user_id: "u1",
						client_id: "m1",
						context_token: "tok-u1",
						item_list: [{ type: 1, text_item: { text: "hello without ret" } }],
					},
				],
				get_updates_buf: "c2",
			};
		}
		return { msgs: [], get_updates_buf: "c2" };
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers(statuses, messages));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => messages.length === 1);
	assert.equal(messages[0].text, "hello without ret");
	assert.equal(runtime.cursor, "c2");
	assert.equal(runtime.contextTokens.users.u1.token, "tok-u1");
	assert.ok(
		statuses.some((status) => status.state === "ready"),
		JSON.stringify(statuses),
	);
});

test("a -14 getupdates answer is terminal and asks for a new scan", async (t) => {
	const fake = await fakeIlink();
	const statuses: any[] = [];
	fake.replies.updates = { ret: -14 };
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => statuses.some((status) => status.state === "error"));
	assert.match(statuses.find((status) => status.state === "error").error, /scan the QR code again/);
	await settle();
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/getupdates").length, 1, "polling stopped");
});

test("a -14 notifystart answer is terminal before any getupdates", async (t) => {
	const fake = await fakeIlink();
	const statuses: any[] = [];
	fake.replies["/ilink/bot/msg/notifystart"] = { errcode: -14 };
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => statuses.some((status) => status.state === "error"));
	assert.match(statuses.find((status) => status.state === "error").error, /scan the QR code again/);
	await settle();
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/getupdates").length, 0);
});

test("a non-zero ret during the poll is still an error and 401 stops it", async (t) => {
	const fake = await fakeIlink();
	const statuses: any[] = [];
	fake.replies.updates = { ret: 401 };
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => statuses.some((status) => status.state === "error"));
	assert.match(statuses.find((status) => status.state === "error").error, /401/);
});

// Failures back off min(2000 * 2^(n-1), 10000); the third one in a row is
// reported to the host and stops the poll instead of retrying the same error forever.
test("poll failures back off 2s then 4s, and the third one reports an error", async (t) => {
	const fake = await fakeIlink();
	const statuses: any[] = [];
	const waits: number[] = [];
	fake.replies.raw = { "/ilink/bot/getupdates": "<html>bad gateway</html>" };
	const handle = weixin.connect(
		FIELDS,
		env(fake, {}, { sleep: async (ms: number) => waits.push(ms) }),
		noopHandlers(statuses),
	);
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => statuses.some((status) => status.state === "error"));
	assert.deepEqual(waits, [2000, 4000]);
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/getupdates").length, 3);
	assert.ok(statuses.some((status) => status.state === "connecting"));
	await settle();
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/getupdates").length, 3, "polling stopped");
});

test("a network error during the poll is retried and does not end the connection", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const statuses: any[] = [];
	const waits: number[] = [];
	const network = Object.assign(new TypeError("fetch failed"), {
		cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
	});
	let polls = 0;
	const flaky = {
		...env(fake, runtime),
		fetch: (url: any, init: any) => {
			if (String(url).endsWith("/ilink/bot/getupdates") && polls++ === 0) return Promise.reject(network);
			return (globalThis.fetch as any)(url, init);
		},
		sleep: async (ms: number) => {
			waits.push(ms);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => runtime.cursor === "c1");
	assert.deepEqual(waits, [2000]);
	assert.ok(!statuses.some((status) => status.state === "error"), JSON.stringify(statuses));
});

test("a long-poll timeout is an idle batch, not a failure", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const statuses: any[] = [];
	const waits: number[] = [];
	const timeout = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
	let polls = 0;
	const flaky = {
		...env(fake, runtime),
		fetch: (url: any, init: any) => {
			if (String(url).endsWith("/ilink/bot/getupdates") && polls++ === 0) return Promise.reject(timeout);
			return (globalThis.fetch as any)(url, init);
		},
		sleep: async (ms: number) => {
			waits.push(ms);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => runtime.cursor === "c1");
	assert.deepEqual(waits, [], "a timeout is not a backoff");
	assert.ok(!statuses.some((status) => status.state === "error"), JSON.stringify(statuses));
	assert.ok(fake.calls.filter((call) => call.path === "/ilink/bot/getupdates").length >= 2);
});

test("the poll never reports ready for a non-JSON or empty answer without ret", async () => {
	for (const answer of ["not json at all", {}]) {
		const fake = await fakeIlink();
		const statuses: any[] = [];
		if (typeof answer === "string") fake.replies.raw = { "/ilink/bot/getupdates": answer };
		else fake.replies.updates = answer;
		const handle = weixin.connect(FIELDS, env(fake, {}, { sleep: async () => {} }), noopHandlers(statuses));
		try {
			await until(() => statuses.some((status) => status.state === "error"));
			assert.ok(!statuses.some((status) => status.state === "ready"), `ready after ${JSON.stringify(answer)}`);
			assert.ok(
				statuses.some((status) => status.state === "connecting"),
				JSON.stringify(statuses),
			);
		} finally {
			handle.stop();
			await fake.close();
		}
	}
});

test("a network failure keeps its cause for diagnosis", async () => {
	const fake = await fakeIlink();
	try {
		const network = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
		});
		const failing = {
			...env(fake),
			fetch: async () => {
				throw network;
			},
		};
		await assert.rejects(weixin.check(FIELDS, failing), (error: any) => {
			assert.match(error.message, /ENOTFOUND/);
			assert.equal(error.cause, network);
			assert.equal(error.timeout, false);
			return true;
		});
	} finally {
		await fake.close();
	}
});

// A 429 is not permanent: the host's send queue retries it after Retry-After.
test("a rate-limited send carries retryAfter in seconds and is not permanent", async (t) => {
	const fake = await fakeIlink();
	fake.replies.updates = { ret: 0, msgs: [] };
	fake.replies.http = { "/ilink/bot/sendmessage": { status: 429, headers: { "retry-after": "7" } } };
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	await assert.rejects(
		() => handle.send({ key: "u1", kind: "direct" }, { text: "slow down" }),
		(error: any) => error.retryAfter === 7 && error.permanent !== true && error.unknown !== true,
	);
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/sendmessage").length, 1);
});

// A send that may already have reached the platform is reported as unknown and
// never repeated; only a connection that produced no HTTP answer at all keeps
// its client_id and is retried.
test("a timed-out send is unknown and is not retried", async (t) => {
	const fake = await fakeIlink();
	fake.replies.updates = { ret: 0, msgs: [] };
	const timeout = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
	let attempted = 0;
	const flaky = {
		...env(fake),
		fetch: (url: any, init: any) => {
			if (String(url).endsWith("/ilink/bot/sendmessage")) {
				attempted += 1;
				return Promise.reject(timeout);
			}
			return (globalThis.fetch as any)(url, init);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	await assert.rejects(
		() => handle.send({ key: "u1", kind: "direct" }, { text: "uncertain" }),
		(error: any) => error.unknown === true && error.permanent !== true,
	);
	assert.equal(attempted, 1);
});

test("a server-error send answer is unknown and is not retried", async (t) => {
	const fake = await fakeIlink();
	fake.replies.updates = { ret: 0, msgs: [] };
	fake.replies.http = { "/ilink/bot/sendmessage": { status: 500 } };
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	await assert.rejects(
		() => handle.send({ key: "u1", kind: "direct" }, { text: "uncertain" }),
		(error: any) => error.unknown === true && error.permanent !== true,
	);
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/sendmessage").length, 1);
});

test("a network-level send failure is retried with the same client_id", async (t) => {
	const fake = await fakeIlink();
	fake.replies.updates = { ret: 0, msgs: [] };
	const waits: number[] = [];
	const clientIds: string[] = [];
	const flaky = {
		...env(fake),
		fetch: (url: any, init: any) => {
			if (String(url).endsWith("/ilink/bot/sendmessage")) {
				clientIds.push(JSON.parse(init.body).msg.client_id);
				if (clientIds.length <= 2) {
					return Promise.reject(
						Object.assign(new TypeError("fetch failed"), {
							cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
						}),
					);
				}
			}
			return (globalThis.fetch as any)(url, init);
		},
		sleep: async (ms: number) => {
			waits.push(ms);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	const { messageId } = await handle.send({ key: "u1", kind: "direct" }, { text: "retry me" });
	assert.deepEqual(waits, [400, 1200]);
	assert.equal(clientIds.length, 3);
	assert.equal(new Set(clientIds).size, 1);
	assert.equal(messageId, clientIds[0]);
	assert.equal(fake.calls.filter((call) => call.path === "/ilink/bot/sendmessage").length, 1);
});

test("typing asks for a ticket and sends it with the context_token", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = { ...contexts({ u1: { token: "tok-u1" } }) };
	fake.replies["/ilink/bot/getconfig"] = { ret: 0, typing_ticket: "ticket-1" };
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	await handle.typing({ key: "u1", kind: "direct" });
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/sendtyping"));
	const config = fake.calls.find((call) => call.path === "/ilink/bot/getconfig");
	const typing = fake.calls.find((call) => call.path === "/ilink/bot/sendtyping");
	assert.equal(config.params.context_token, "tok-u1");
	assert.equal(typing.params.context_token, "tok-u1");
	assert.equal(typing.params.typing_ticket, "ticket-1");
	assert.equal(typing.params.status, 1);
});

test("stop aborts an in-flight getupdates instead of waiting for the timeout", async (t) => {
	const fake = await fakeIlink();
	const statuses: any[] = [];
	fake.hang.add("/ilink/bot/getupdates");
	const handle = weixin.connect(FIELDS, env(fake), noopHandlers(statuses));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => fake.calls.some((call) => call.path === "/ilink/bot/getupdates"));
	const started = Date.now();
	handle.stop();
	await until(() => fake.aborted.includes("/ilink/bot/getupdates"));
	assert.ok(Date.now() - started < 1_000, "the long poll was aborted");
	await settle();
	assert.ok(!statuses.some((status) => status.state === "error"), "a stop is not an error");
});

// Context tokens belong to one bot login: a new bot token throws them away, and
// a late message must not replace a newer capability.
test("context tokens are cleared when the bot token changes", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {
		cursor: "c9",
		contextTokens: { credentialHash: tokenHash("old-token"), users: { u1: { token: "old" } } },
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	assert.equal(runtime.contextTokens.credentialHash, tokenHash("wx-tok"));
	assert.deepEqual(runtime.contextTokens.users, {});
	assert.equal(runtime.cursor, "c9");
});

test("context tokens reject older seq and timestamp, but accept a message without either", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = { ...contexts({ u1: { token: "newer", seq: "10", messageTimeMs: 2000, receivedAt: 1 } }) };
	let polls = 0;
	fake.replies.updates = () => {
		polls += 1;
		if (polls > 1) return { ret: 0, msgs: [] };
		return {
			ret: 0,
			get_updates_buf: "c1",
			msgs: [
				{
					from_user_id: "u1",
					message_id: "m1",
					context_token: "older-seq",
					seq: "5",
					create_time_ms: 1000,
					item_list: [{ type: 1, text_item: { text: "a" } }],
				},
				{
					from_user_id: "u1",
					message_id: "m2",
					context_token: "older-time",
					message_time_ms: 500,
					item_list: [{ type: 1, text_item: { text: "b" } }],
				},
				{
					from_user_id: "u1",
					message_id: "m3",
					context_token: "without-order",
					item_list: [{ type: 1, text_item: { text: "c" } }],
				},
			],
		};
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers([]));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => runtime.contextTokens.users.u1.token === "without-order");
	assert.equal(runtime.contextTokens.users.u1.seq, null);
});

test("context tokens are capped at 1000 with least-recently-used eviction", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const count = 1005;
	let polls = 0;
	fake.replies.updates = () => {
		polls += 1;
		if (polls > 1) return { ret: 0, msgs: [] };
		return {
			ret: 0,
			get_updates_buf: "c1",
			msgs: Array.from({ length: count }, (_, at) => ({
				from_user_id: `u${at}`,
				message_id: `m${at}`,
				context_token: `t${at}`,
				item_list: [{ type: 1, text_item: { text: `msg ${at}` } }],
			})),
		};
	};
	const handle = weixin.connect(FIELDS, env(fake, runtime), noopHandlers([]));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => runtime.seenMessageIds?.length === 1000);
	const users = runtime.contextTokens.users;
	assert.equal(Object.keys(users).length, 1000);
	assert.equal(users.u0, undefined);
	assert.equal(users.u4, undefined);
	assert.equal(users.u5.token, "t5");
	assert.equal(users.u1004.token, "t1004");
	assert.equal(runtime.seenMessageIds.length, 1000);
	assert.equal(runtime.seenMessageIds[0], "m5");
});

test("an image item downloads from its CDN URL and decrypts with its AES key", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const messages: any[] = [];
	const keyHex = "00112233445566778899aabbccddeeff";
	const key = Buffer.from(keyHex, "hex");
	const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
	const cipher = createCipheriv("aes-128-ecb", key, null);
	const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
	const imageUrl = "https://cdn.example.test/img/1";
	let polls = 0;
	fake.replies.updates = () => {
		polls += 1;
		if (polls > 1) return { ret: 0, msgs: [] };
		return {
			ret: 0,
			get_updates_buf: "c1",
			msgs: [
				{
					from_user_id: "u1",
					message_id: "m1",
					item_list: [
						{
							type: 2,
							image_item: { media: { full_url: imageUrl, aes_key: Buffer.from(keyHex).toString("base64") } },
						},
						{ type: 4, file_item: { file_name: "notes.txt" } },
					],
				},
			],
		};
	};
	const flaky = {
		...env(fake, runtime),
		fetch: (url: any, init: any) => {
			if (String(url) === imageUrl) return Promise.resolve({ ok: true, arrayBuffer: async () => encrypted });
			return (globalThis.fetch as any)(url, init);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers([], messages));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => messages.length === 1);
	assert.equal(messages[0].images.length, 1);
	assert.equal(messages[0].images[0].mediaType, "image/jpeg");
	assert.deepEqual(Buffer.from(messages[0].images[0].data, "base64"), plain);
	// A file item without a media reference is reported by name only; nothing to fetch.
	assert.deepEqual(messages[0].files, [{ name: "notes.txt" }]);
});

// The reply as chat bubbles: a short cascade of lines is sent one per bubble, the way a
// person texts; everything with structure stays whole.
test("a short chat-like reply becomes one bubble per line", () => {
	assert.deepEqual(chunk("Sure thing\nI'll take a look\nGive me a minute", 1800), [
		"Sure thing",
		"I'll take a look",
		"Give me a minute",
	]);
});

test("a reply with structure stays one message", () => {
	const structured = "# Findings\n\n- first point that is quite long and explains something\n- second point";
	assert.deepEqual(chunk(structured, 1800), [structured]);
	// A heading-like first line means the block is a document, not chatter.
	const headed = "Here is what I found:\nthe file is there\nthe build passes";
	assert.deepEqual(chunk(headed, 1800), [headed]);
});

test("a long reply packs whole blocks and never splits a fence", () => {
	const code = "```js\n" + "const x = 1;\n".repeat(60) + "```";
	const text = `${"para ".repeat(200)}\n\n${code}\n\n${"tail ".repeat(200)}`;
	const parts = chunk(text, 500);
	assert.ok(parts.length > 1, "the reply is split");
	assert.ok(
		parts.some((part) => part.includes(code.slice(0, 20))),
		"the fence survives in one piece",
	);
	for (const part of parts) assert.ok([...part].length <= 500, `part exceeds the limit: ${[...part].length}`);
});

test("a long code block closes and reopens its fence in every bubble", () => {
	const body = `${"const value = 1;\n".repeat(200)}`;
	const parts = chunk("```js\n" + body + "```", 300);
	assert.ok(parts.length > 1, "the block is split");
	for (const [index, part] of parts.entries()) {
		const fences = part.split("\n").filter((line) => /^\s*```/.test(line)).length;
		assert.equal(fences % 2, 0, `bubble ${index} has balanced fences:\n${part}`);
	}
	// The language tag survives every reopening.
	for (const part of parts.slice(1)) assert.match(part, /^```js/);
});

test("an empty reply sends no bubble", () => {
	assert.deepEqual(chunk("", 1800), []);
	assert.deepEqual(chunk("   \n  ", 1800), []);
});

test("a limit counts visible characters, not UTF-16 units", () => {
	// Each emoji is two UTF-16 units but one character; a 10-character limit holds 10.
	const parts = chunk("🙂".repeat(25), 10);
	assert.ok(
		parts.every((part) => [...part].length <= 10),
		JSON.stringify(parts),
	);
	assert.equal(parts.join(""), "🙂".repeat(25));
});

// A quoted message travels to the model as part of the text.
test("a quoted text message is inlined before the reply", () => {
	assert.equal(
		withQuoted("好的", { title: "", message_item: { type: 1, text_item: { text: "明天几点出发？" } } }),
		"[引用: 明天几点出发？]\n好的",
	);
	assert.equal(
		withQuoted("收到", { title: "队长", message_item: { type: 1, text_item: { text: "看下这个" } } }),
		"[引用: 队长 | 看下这个]\n收到",
	);
});

test("a quoted image or file is named, not inlined", () => {
	assert.equal(
		withQuoted("这张不错", { title: "海边.jpg", message_item: { type: 2, image_item: {} } }),
		"[引用媒体: 海边.jpg]\n这张不错",
	);
	assert.equal(withQuoted("就这样", { title: "", message_item: { type: 4, file_item: {} } }), "[引用媒体]\n就这样");
});

test("a message with no quote is unchanged", () => {
	assert.equal(withQuoted("你好", undefined), "你好");
	assert.equal(withQuoted("你好", {}), "你好");
});

test("a file and a video download their bytes from the same CDN path", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const messages: any[] = [];
	const keyHex = "00112233445566778899aabbccddeeff";
	const plain = Buffer.from("the attachment");
	const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
	const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
	const fileUrl = "https://cdn.example.test/file/1";
	const videoUrl = "https://cdn.example.test/video/1";
	let polls = 0;
	fake.replies.updates = () => {
		polls += 1;
		if (polls > 1) return { ret: 0, msgs: [] };
		return {
			ret: 0,
			get_updates_buf: "c1",
			msgs: [
				{
					from_user_id: "u1",
					message_id: "m1",
					item_list: [
						{
							type: 4,
							file_item: {
								file_name: "report.txt",
								media: { full_url: fileUrl, aes_key: Buffer.from(keyHex).toString("base64") },
							},
						},
						// A video may carry its key as a plain hex field on the item.
						{ type: 5, video_item: { file_name: "clip.mp4", aeskey: keyHex, media: { full_url: videoUrl } } },
					],
				},
			],
		};
	};
	const flaky = {
		...env(fake, runtime),
		fetch: (url: any, init: any) => {
			if (String(url) === fileUrl || String(url) === videoUrl)
				return Promise.resolve({ ok: true, arrayBuffer: async () => encrypted });
			return (globalThis.fetch as any)(url, init);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers([], messages));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => messages.length === 1);
	assert.equal(messages[0].files.length, 2);
	assert.equal(messages[0].files[0].name, "report.txt");
	assert.deepEqual(messages[0].files[0].data, plain);
	assert.equal(messages[0].files[1].name, "clip.mp4");
	assert.deepEqual(messages[0].files[1].data, plain);
	assert.match(messages[0].text, /\[Video\]/);
});

test("a file answer uploads to the CDN and sends a file item", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	fake.replies["/ilink/bot/getuploadurl"] = { ret: 0, upload_param: "up-param-1" };
	const plain = Buffer.from("the report body");
	let uploaded: { url: string; body: Buffer } | undefined;
	const seen = env(fake, runtime);
	const wrapped = {
		...seen,
		fetch: async (url: any, init: any) => {
			if (String(url).startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload")) {
				uploaded = { url: String(url), body: Buffer.from(init.body) };
				return {
					ok: true,
					status: 200,
					headers: { get: (name: string) => (name === "x-encrypted-param" ? "download-param-1" : null) },
				};
			}
			return (seen.fetch as any)(url, init);
		},
	};
	const handle = weixin.connect(FIELDS, wrapped, noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => handle !== undefined);
	await handle.send(
		{ key: "u1", kind: "direct", title: "" },
		{ text: "", media: [{ kind: "file", name: "report.txt", data: plain }] },
	);
	assert.ok(uploaded !== undefined, "the file was uploaded");
	assert.match(uploaded!.url, /filekey=/);
	// What went to the CDN is the AES-128-ECB ciphertext of the file.
	const upload = fake.calls.find((call: any) => call.path === "/ilink/bot/getuploadurl");
	assert.ok(upload !== undefined);
	const key = Buffer.from(String(upload.params.aeskey), "hex");
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	assert.deepEqual(Buffer.concat([decipher.update(uploaded!.body), decipher.final()]), plain);
	const send = fake.calls.find((call: any) => call.path === "/ilink/bot/sendmessage");
	assert.ok(send !== undefined, "a message was sent");
	const item = send.params.msg.item_list[0];
	assert.equal(item.type, 4);
	assert.equal(item.file_item.file_name, "report.txt");
	assert.equal(item.file_item.media.encrypt_query_param, "download-param-1");
	assert.equal(item.file_item.len, String(plain.length));
});

test("typing stops with status 2 and a missing ticket is reported once", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {
		...contexts({ u1: { token: "tok-u1", seq: null, messageTimeMs: null, receivedAt: Date.now() } }),
	};
	const warns: any[] = [];
	const seen = env(fake, runtime);
	seen.log = { warn: (...args: any[]) => warns.push(args) } as any;
	fake.replies["/ilink/bot/getconfig"] = { ret: 0, typing_ticket: "ticket-1" };
	const handle = weixin.connect(FIELDS, seen, noopHandlers());
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await handle.typing({ key: "u1", kind: "direct", title: "" });
	await handle.stopTyping({ key: "u1", kind: "direct", title: "" });
	const typing = fake.calls.filter((call: any) => call.path === "/ilink/bot/sendtyping");
	assert.deepEqual(
		typing.map((call: any) => call.params.status),
		[1, 2],
	);
	assert.equal(warns.length, 0, "a working ticket does not warn");

	// A platform that hands out no ticket: the chat cannot show typing, and the adapter
	// says so once instead of retrying in silence.
	const quiet = await fakeIlink();
	const quietWarns: any[] = [];
	const quietEnv = env(quiet, runtime);
	quietEnv.log = { warn: (...args: any[]) => quietWarns.push(args) } as any;
	const second = weixin.connect(FIELDS, quietEnv, noopHandlers());
	t.after(() => {
		second.stop();
		return quiet.close();
	});
	await second.typing({ key: "u1", kind: "direct", title: "" });
	await second.typing({ key: "u1", kind: "direct", title: "" });
	assert.equal(quietWarns.length, 1, "the missing ticket is said once");
	assert.match(String(quietWarns[0][0]), /no typing ticket/);
});

// WeChat re-encodes what it carries: a PNG must not be announced as a JPEG, or the host
// refuses the prompt as IMAGE_TYPE_MISMATCH before the model ever sees it.
test("an image is announced with the media type its bytes have", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	const messages: any[] = [];
	const keyHex = "00112233445566778899aabbccddeeff";
	const key = Buffer.from(keyHex, "hex");
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const cipher = createCipheriv("aes-128-ecb", key, null);
	const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
	const imageUrl = "https://cdn.example.test/img/png";
	let polls = 0;
	fake.replies.updates = () => {
		polls += 1;
		if (polls > 1) return { ret: 0, msgs: [] };
		return {
			ret: 0,
			get_updates_buf: "c1",
			msgs: [
				{
					from_user_id: "u1",
					message_id: "m1",
					item_list: [
						{
							type: 2,
							image_item: { media: { full_url: imageUrl, aes_key: Buffer.from(keyHex).toString("base64") } },
						},
					],
				},
			],
		};
	};
	const flaky = {
		...env(fake, runtime),
		fetch: (url: any, init: any) => {
			if (String(url) === imageUrl) return Promise.resolve({ ok: true, arrayBuffer: async () => encrypted });
			return (globalThis.fetch as any)(url, init);
		},
	};
	const handle = weixin.connect(FIELDS, flaky, noopHandlers([], messages));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await until(() => messages.length === 1);
	assert.equal(messages[0].images[0].mediaType, "image/png");
});

// An audio file the Bot has is sent as a voice message (item type 3) and uploaded with
// the voice media type; a container the protocol does not name stays a file.
test("an mp3 is sent as a voice item, and an unnamed audio container as a file", async (t) => {
	const fake = await fakeIlink();
	const runtime: any = {};
	fake.replies["/ilink/bot/getuploadurl"] = { ret: 0, upload_param: "up-voice" };
	const seen = env(fake, runtime);
	const wrapped = {
		...seen,
		fetch: async (url: any, init: any) => {
			if (String(url).startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload")) {
				return {
					ok: true,
					status: 200,
					headers: { get: (name: string) => (name === "x-encrypted-param" ? "download-param-v" : null) },
				};
			}
			return (seen.fetch as any)(url, init);
		},
	};
	// Two MPEG-1 Layer III frames at 128 kbps / 44.1 kHz: 417 bytes each.
	const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
	const mp3 = Buffer.concat([frame, frame]);
	const handle = weixin.connect(FIELDS, wrapped, noopHandlers([], []));
	t.after(() => {
		handle.stop();
		return fake.close();
	});
	await handle.send(
		{ key: "u1", kind: "direct" },
		{ text: "", media: [{ kind: "file", name: "note.mp3", data: mp3, voice: true }] },
	);
	await handle.send(
		{ key: "u1", kind: "direct" },
		{ text: "", media: [{ kind: "file", name: "clip.wav", data: Buffer.from("wave bytes") }] },
	);
	const uploads = fake.calls.filter((call: any) => call.path === "/ilink/bot/getuploadurl");
	assert.equal(uploads[0].params.media_type, 4, "voice upload type");
	assert.equal(uploads[1].params.media_type, 3, "an unnamed container is uploaded as a file");
	const sends = fake.calls.filter((call: any) => call.path === "/ilink/bot/sendmessage");
	assert.equal(sends[0].params.msg.item_list[0].type, 3);
	const voice = sends[0].params.msg.item_list[0].voice_item;
	assert.equal(voice.encode_type, 7);
	// The bubble is drawn from the duration; two frames of 1152 samples at 44.1 kHz.
	assert.equal(voice.sample_rate, 44100);
	assert.equal(voice.playtime, 52);
	assert.equal(sends[1].params.msg.item_list[0].type, 4);
	assert.equal(sends[1].params.msg.item_list[0].file_item.file_name, "clip.wav");
});
