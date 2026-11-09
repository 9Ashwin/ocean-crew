// Text to speech: the call the host makes to the configured provider, without the network.
// The module only knows how to speak; the provider contract is what these tests pin.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { install } from "../src/host/work/tts.ts";

const home = (): string => mkdtempSync(join(tmpdir(), "ocean-crew-tts-"));

const runtime = (home: string, config: any, secrets: Record<string, string> = {}) => {
	const rt: any = {
		home,
		config: { tts: config },
		secretValue: (name: string) => secrets[name],
		warn: () => {},
	};
	install(rt);
	return rt;
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

test("speak posts the text with the secret and returns the provider's audio", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls: Array<{ url: string; init: any }> = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		return new Response(Buffer.from("mp3-bytes"), { status: 200 });
	}) as any;
	t.after(() => {
		globalThis.fetch = original;
	});
	const rt = runtime(dir, { voice: "voc_1", model: "breeze-tts-2", language: "zh" }, { BREEZE_API_KEY: "brz_test" });
	const audio = await rt.speak("你好");
	assert.equal(audio.name, "voice.mp3");
	assert.deepEqual(audio.bytes, Buffer.from("mp3-bytes"));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.breeze.blue/v1/text-to-speech/voc_1?output_format=mp3");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers["xi-api-key"], "brz_test");
	assert.deepEqual(JSON.parse(calls[0].init.body), {
		text: "你好",
		model_id: "breeze-tts-2",
		language_code: "zh",
	});
});

test("a missing voice falls back to the account's first one, cached", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: any) => {
		calls.push(String(url));
		if (String(url).endsWith("/v1/voices")) return jsonResponse({ voices: [{ voice_id: "voc_first" }] });
		return new Response(Buffer.from("audio"), { status: 200 });
	}) as any;
	t.after(() => {
		globalThis.fetch = original;
	});
	const rt = runtime(dir, {}, { BREEZE_API_KEY: "brz_test" });
	await rt.speak("one");
	await rt.speak("two");
	assert.equal(calls.filter((url) => url.endsWith("/v1/voices")).length, 1, "the voice list is cached");
	assert.match(calls[1], /text-to-speech\/voc_first/);
});

test("speak refuses clearly without a secret and passes the provider's refusal through", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const rt = runtime(dir, { voice: "voc_1" });
	await assert.rejects(rt.speak("hello"), (error: any) => {
		assert.equal(error.code, "bot/unavailable");
		assert.match(error.message, /BREEZE_API_KEY secret is not set/);
		return true;
	});
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as any;
	t.after(() => {
		globalThis.fetch = original;
	});
	const withKey = runtime(dir, { voice: "voc_1" }, { BREEZE_API_KEY: "brz_test" });
	await assert.rejects(withKey.speak("hello"), (error: any) => {
		assert.equal(error.code, "bot/refused");
		assert.match(error.message, /refused \(401\): bad key/);
		return true;
	});
});

test("long text is spoken in sentence-sized requests and joined", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bodies: any[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init: any) => {
		bodies.push(JSON.parse(init.body));
		return new Response(Buffer.from("x"), { status: 200 });
	}) as any;
	t.after(() => {
		globalThis.fetch = original;
	});
	const rt = runtime(dir, { voice: "voc_1" }, { BREEZE_API_KEY: "brz_test" });
	const sentence = `${"a".repeat(300)}. `;
	const audio = await rt.speak(sentence.repeat(4));
	assert.ok(bodies.length > 1, "the text was split");
	for (const body of bodies) assert.ok(body.text.length <= 1000);
	assert.equal(audio.bytes.byteLength, bodies.length, "the parts are joined in order");
});

test("a caller can ask for the container the chat can play", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const urls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: any) => {
		urls.push(String(url));
		return new Response(Buffer.from("opus-bytes"), { status: 200 });
	}) as any;
	t.after(() => {
		globalThis.fetch = original;
	});
	const rt = runtime(dir, { voice: "voc_1", format: "mp3" }, { BREEZE_API_KEY: "brz_test" });
	const audio = await rt.speak("hello", "opus");
	assert.equal(audio.name, "voice.opus");
	assert.match(urls[0], /output_format=opus$/);
});

// The settings page saves into the team state, which wins over the profile's defaults.
test("saved settings override the profile and the view reports them", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const rt = runtime(dir, { model: "breeze-tts-2", format: "mp3" }, { BREEZE_API_KEY: "brz_test" });
	(rt as any).state = {};
	(rt as any).load = async () => {};
	(rt as any).save = async () => {};
	// The view and setter are published by install above; re-read through the runtime.
	const before = rt.ttsSettingsView();
	assert.equal(before.model, "breeze-tts-2");
	assert.equal(before.hasSecret, true);
	const next = await rt.ttsSettingsSet({ model: "breeze-tts-2-multilingual", voice: "voc_9", autoReply: true });
	assert.equal(next.model, "breeze-tts-2-multilingual");
	assert.equal(next.voice, "voc_9");
	assert.equal(next.autoReply, true);
	// A value the page cannot edit is ignored rather than stored.
	await rt.ttsSettingsSet({ baseUrl: 42, enabled: false });
	assert.equal((rt as any).state.tts.enabled, false);
	assert.equal((rt as any).state.tts.model, "breeze-tts-2-multilingual");
});

test("the voice list and the test both refuse without a secret", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const rt = runtime(dir, {});
	(rt as any).state = {};
	(rt as any).load = async () => {};
	(rt as any).save = async () => {};
	await assert.rejects(rt.ttsVoices(), (error: any) => error.code === "bot/unavailable");
	await assert.rejects(rt.ttsTest(), (error: any) => error.code === "bot/unavailable");
});

test("the voice list names the account's voices", async (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ voices: [{ voice_id: "voc_1", name: "Narrator" }] }), { status: 200 })) as any;
	t.after(() => {
		globalThis.fetch = original;
	});
	const rt = runtime(dir, {}, { BREEZE_API_KEY: "brz_test" });
	assert.deepEqual(await rt.ttsVoices(), [{ id: "voc_1", name: "Narrator" }]);
});
