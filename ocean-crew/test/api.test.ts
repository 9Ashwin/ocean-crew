// API client behavior: one POST to /api/bot, the result value on success, and the error
// codes the interface acts on — a refusal shown where the user acted, a host fault noted
// for the report, and a network failure said in the user's language.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type ApiError, call } from "../src/client/core/api.ts";
import { clearClientErrors, clientErrors, noteClientError } from "../src/client/core/diagnostics.ts";
import { installLocale } from "../src/client/core/i18n.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	clearClientErrors();
});

interface FetchCall {
	url: string;
	init: any;
}

function stubFetch(reply: (url: string, init: any) => any): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		return reply(String(url), init);
	}) as any;
	return calls;
}

const jsonReply = (body: any, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) => ({
	ok,
	status,
	json: async () => body,
});

test("a successful call posts the endpoint and payload and answers the result value", async () => {
	const calls = stubFetch(() => jsonReply({ ok: true, value: { bots: [], revision: 7 } }));
	const signal = new AbortController().signal;
	assert.deepEqual(await call("state", { revision: 3 }, signal), { bots: [], revision: 7 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "api/bot");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.credentials, "same-origin");
	assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
	assert.equal(calls[0].init.signal, signal);
	assert.deepEqual(JSON.parse(calls[0].init.body), { endpoint: "state", payload: { revision: 3 } });
	// A call with nothing to send says null, not undefined.
	await call("states");
	assert.deepEqual(JSON.parse(calls[1].init.body), { endpoint: "states", payload: null });
	assert.deepEqual(clientErrors(), []);
});

test("an HTTP failure is a host fault with its status code, noted for the report", async () => {
	stubFetch(() => jsonReply({}, { ok: false, status: 500 }));
	await assert.rejects(call("state"), (error: ApiError) => {
		assert.equal(error.code, "HTTP_500");
		assert.equal(error.message, "HTTP 500");
		return true;
	});
	assert.deepEqual(
		clientErrors().map((entry) => [entry.text, entry.code]),
		[["state: HTTP 500", "HTTP_500"]],
	);
});

test("a refusal is shown where the user acted and is not noted", async () => {
	stubFetch(() => jsonReply({ ok: false, error: { code: "bot/invalid", message: "Unknown Bot" } }));
	await assert.rejects(call("create-bot"), (error: ApiError) => {
		assert.equal(error.code, "bot/invalid");
		assert.equal(error.message, "Unknown Bot");
		return true;
	});
	assert.deepEqual(clientErrors(), []);
});

test("a host fault is noted once and points at the feedback page", async () => {
	stubFetch(() => jsonReply({ ok: false, error: { code: "bot/internal", message: "boom" } }));
	let thrown: ApiError | undefined;
	await assert.rejects(call("state"), (error: ApiError) => {
		thrown = error;
		assert.equal(error.code, "bot/internal");
		assert.equal(error.message, "boom Settings → Feedback has the details.");
		return true;
	});
	assert.deepEqual(
		clientErrors().map((entry) => [entry.text, entry.code]),
		[["state: boom", "bot/internal"]],
	);
	// The interface showing the same error again does not add a second line.
	noteClientError("menu", thrown);
	assert.equal(clientErrors().length, 1);
});

test("a network failure says what happened, keeps its cause, and is noted once", async () => {
	const failure = new TypeError("Failed to fetch");
	stubFetch(() => {
		throw failure;
	});
	let thrown: ApiError | undefined;
	await assert.rejects(call("state"), (error: ApiError) => {
		thrown = error;
		assert.equal(error.code, "NETWORK");
		assert.equal(error.message, "Could not reach DSH. Check that it is still running.");
		assert.equal(error.cause, failure);
		return true;
	});
	assert.deepEqual(
		clientErrors().map((entry) => entry.text),
		["state: network error: Failed to fetch"],
	);
	noteClientError("menu", thrown);
	assert.equal(clientErrors().length, 1);
});

test("a cancelled call is not an error", async () => {
	const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
	stubFetch(() => {
		throw aborted;
	});
	await assert.rejects(call("state"), (error: unknown) => error === aborted);
	assert.deepEqual(clientErrors(), []);
});

test("the copy follows the interface language", async () => {
	const dictionaries = new Map<string, Record<string, string>>();
	const locale = {
		register: (namespace: string, language: string, dictionary: Record<string, string>) => {
			dictionaries.set(`${namespace}:${language}`, dictionary);
			return () => dictionaries.delete(`${namespace}:${language}`);
		},
		bind: (namespace: string) => (key: string, params?: Record<string, unknown>) => {
			const text = dictionaries.get(`${namespace}:zh`)?.[key] ?? key;
			return params
				? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
				: text;
		},
		getLocale: () => ({ active: "zh" }),
	};
	const off = installLocale(locale);
	try {
		stubFetch(() => jsonReply({}, { ok: false, status: 500 }));
		await assert.rejects(
			call("state"),
			(error: ApiError) => error.code === "HTTP_500" && error.message === "请求失败（HTTP 500）",
		);
		stubFetch(() => {
			throw new TypeError("Failed to fetch");
		});
		await assert.rejects(call("state"), (error: ApiError) => error.message === "连不上 DSH，请确认它还在运行。");
		stubFetch(() => jsonReply({ ok: false, error: { code: "bot/not-found", message: "Unknown Bot" } }));
		await assert.rejects(call("bot"), (error: ApiError) => error.message === "找不到这个 Bot");
	} finally {
		off();
		clearClientErrors();
	}
});
