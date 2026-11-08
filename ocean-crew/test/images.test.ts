// Images for text-only models: which old images are offloaded, how a vision model is
// picked, the per-attachment cache in `<home>/ocr.json`, the text a member sees in a

import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OCR_PROMPT, OCR_RETRY_MS } from "../src/host/core/constants.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import type { ModelEntry } from "../src/host/team/models.ts";
import { install, offloadTargets } from "../src/host/work/images.ts";
import { fakeContext } from "./fake-ctx.ts";

type TestRuntime = Runtime & Record<string, any>;

interface StreamCall {
	provider?: string;
	model?: string;
	sessionId?: string;
	messages?: any[];
	maxTokens?: number;
}

interface Services {
	attachments: { imageHostPath?: (attachment: { attachmentId: string }) => string | undefined };
	fs: { processPathFromHostPath?: (path: string) => string | undefined };
}

interface Host {
	rt: TestRuntime;
	ctx: ReturnType<typeof fakeContext>;
	home: string;
	streams: StreamCall[];
	warnings: unknown[][];
	sessions: { flush(session: unknown): Promise<unknown>; messageProjections?: { type?: string }[] };
	emit(name: string, payload?: unknown): Promise<void>;
	stop(): Promise<unknown[]>;
}

const visionEntry = (ref: string, name: string, input?: string[], extra: Partial<ModelEntry> = {}): ModelEntry => ({
	ref,
	provider: ref.slice(0, ref.indexOf("/")),
	id: ref.slice(ref.indexOf("/") + 1),
	providerName: ref.slice(0, ref.indexOf("/")),
	name,
	input,
	...extra,
});

const attachment = (attachmentId: string, name?: string): { attachmentId: string; name?: string } => ({
	attachmentId,
	...(name === undefined ? {} : { name }),
});

function boot(
	t: TestContext,
	{
		catalog = [visionEntry("p/vision", "Vision", ["image"])],
		config = {},
		home: given,
	}: { catalog?: ModelEntry[]; config?: Record<string, unknown>; home?: string } = {},
): Host {
	const home = given ?? mkdtempSync(join(tmpdir(), "ocean-crew-images-"));
	if (given === undefined) t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	const streams: StreamCall[] = [];
	const warnings: unknown[][] = [];
	const services: Services = { attachments: {}, fs: {} };
	const ctx = fakeContext({ services: services as unknown as Record<string, any> });
	let reading = "A cat on a mat.";
	let failure: string | undefined;
	(ctx.llm as any).stream = async function* (options: StreamCall) {
		streams.push(options);
		if (failure !== undefined) {
			yield { type: "finish", reason: { kind: "error", failure: { message: failure } } };
			return;
		}
		yield { type: "text-delta", index: 0, text: reading };
		yield { type: "finish", reason: { kind: "stop" } };
	};
	const sessions: { flush(session: unknown): Promise<unknown>; messageProjections?: { type?: string }[] } = {
		flush: async () => undefined,
	};
	Object.assign(ctx, { sessions });
	const rt = {
		ctx,
		config,
		home,
		statePath: join(home, "state.json"),
		warn: (...args: unknown[]) => warnings.push(args),
		teamTools: [],
		catalog: async () => catalog,
		defaultRef: () => "p/vision",
		isLocalAgentRef: () => false,
		isBotSession: (id?: string) => id === "b1",
		roomOf: () => undefined,
		readOnly: () => undefined,
		load: async () => undefined,
	} as unknown as TestRuntime;
	install(rt);
	const host: Host = {
		rt,
		ctx,
		home,
		streams,
		warnings,
		sessions,
		async emit(name, payload) {
			for (const listener of ctx.listeners.get(name) ?? []) {
				if (listener.length < 2) listener(payload);
			}
			await delay(0);
		},
		stop: () => ctx.dispose(),
	};
	// The knobs below are read by the stream fake and the tests that change behavior.
	Object.assign(host, {
		setReading: (text: string) => {
			reading = text;
		},
		setFailure: (message: string | undefined) => {
			failure = message;
		},
		sessions,
	});
	return host;
}

test("offloadTargets selects live images from prior user and tool messages", () => {
	const events = [
		{ type: "user/message" },
		{ type: "assistant/message" },
		{ type: "tool/result" },
		{ type: "user/message" },
		{ type: "user/message" },
	];
	const messages = new Map<unknown, unknown>([
		[
			events[0],
			{
				content: [
					{ type: "image", attachment: { attachmentId: "a" } },
					{ type: "image", offloaded: true, attachment: { attachmentId: "b" } },
					{ type: "image", attachment: { attachmentId: "c" } },
				],
			},
		],
		[events[1], { content: [{ type: "image", attachment: { attachmentId: "ignored" } }] }],
		[events[2], { content: [{ type: "image", attachment: { attachmentId: "d" } }] }],
		[events[3], { content: [{ type: "text", text: "no image" }] }],
		[events[4], { content: [{ type: "image", attachment: { attachmentId: "new" } }] }],
	]);
	const session = {
		surface: { nodes: [0, 1, 2, 3, 4] },
		eventAt: (seq: number) => events[seq],
		deriveEventMessage: (event: unknown) => messages.get(event),
	};
	assert.deepEqual(offloadTargets(session as any, 4), [
		{ seq: 0, imageIndexes: [0, 2] },
		{ seq: 2, imageIndexes: [0] },
	]);
});

test("a vision model reads an image once, and the reading is kept in the home folder", async (t) => {
	const host = boot(t);
	const photo = attachment("sha256:abcdef0123456789", "photo.png");
	assert.deepEqual(await host.rt.imagesForGroup([photo], "s1"), [
		'[Image "photo.png", read by Vision:]\nA cat on a mat.\n[End of image "photo.png"]',
	]);
	// The request carried the image and the OCR prompt, and counts against the Session.
	const call = host.streams[0];
	assert.equal(call.provider, "p");
	assert.equal(call.model, "vision");
	assert.equal(call.sessionId, "s1");
	assert.equal(call.maxTokens, 8192);
	assert.deepEqual(call.messages?.[0].content, [
		{ type: "image", attachment: photo },
		{ type: "text", text: OCR_PROMPT },
	]);
	// A second look is the cached reading: the model is not asked again.
	await host.rt.imagesForGroup([photo], "s1");
	assert.equal(host.streams.length, 1);
	// The cache is written whole into the team folder, so a restart repeats the same
	// words; the write is queued, so wait for it to land.
	const cachePath = join(host.home, "ocr.json");
	for (let count = 0; count < 200 && !fs.existsSync(cachePath); count += 1) await delay(5);
	const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
	assert.deepEqual(saved["sha256:abcdef0123456789"], { text: "A cat on a mat.", model: "Vision" });
	await host.stop();
	const again = boot(t, { home: host.home });
	await again.rt.imagesForGroup([photo], "s2");
	assert.equal(again.streams.length, 0);
});

test("a nameless image is labelled by its attachment id, and a saved copy is named", async (t) => {
	const host = boot(t);
	(host.ctx.get("attachments") as Services["attachments"]).imageHostPath = () => "/host/photo.png";
	(host.ctx.get("fs") as Services["fs"]).processPathFromHostPath = (path: string) => `/proc${path}`;
	const lines = await host.rt.imagesForGroup([attachment("sha256:0123456789abcdef")], "s1");
	assert.equal(lines[0].startsWith("[Image sha256:01234567 (read-only copy saved at"), true);
	assert.ok(lines[0].includes('"/proc/host/photo.png"'));
	assert.ok(lines[0].includes("read by Vision"));
});

test("no vision model means the image cannot be read now, and the user is pointed at", async (t) => {
	const host = boot(t, { catalog: [] });
	const lines = await host.rt.imagesForGroup([attachment("sha256:aa", "pic.png")], "s1");
	assert.equal(
		lines[0],
		'[Image "pic.png": it could not be read right now. Ask the user what it shows if it matters.]',
	);
	assert.ok(host.warnings.some((args) => /could not read image/.test(String(args))));
});

test("a failed reading is not retried before the retry window passes", async (t) => {
	const host = boot(t);
	(host as any).setFailure("the vision model is rate limited");
	const photo = attachment("sha256:fail", "pic.png");
	assert.match((await host.rt.imagesForGroup([photo], "s1"))[0], /could not be read right now/);
	assert.equal(host.streams.length, 1);
	// Inside the window the model is not asked again.
	await host.rt.imagesForGroup([photo], "s1");
	assert.equal(host.streams.length, 1);
	// After the window it is tried again, and this time it succeeds.
	const now = Date.now();
	t.mock.method(Date, "now", () => now + OCR_RETRY_MS + 1);
	(host as any).setFailure(undefined);
	assert.match((await host.rt.imagesForGroup([photo], "s1"))[0], /read by Vision/);
	assert.equal(host.streams.length, 2);
});

test("the configured ocrModel wins, and models without a key or with a local agent are skipped", async (t) => {
	const host = boot(t, {
		catalog: [
			visionEntry("p/needs-key", "Needs key", ["image"], { needsKey: true }),
			visionEntry("p/local", "Local", ["image"]),
			visionEntry("p/ocr", "OCR pick"),
			visionEntry("p/vision", "Vision", ["image"]),
		],
	});
	host.rt.config.ocrModel = "p/ocr";
	(host.rt.isLocalAgentRef as (ref: string) => boolean) = (ref: string) => ref === "p/local";
	host.rt.defaultRef = () => "p/vision";
	await host.rt.imagesForGroup([attachment("sha256:pick")], "s1");
	assert.equal(host.streams[0].model, "ocr");
	// Without a configured OCR model the declared image models are used, the DSH default first.
	host.rt.config.ocrModel = undefined;
	await host.rt.imagesForGroup([attachment("sha256:pick2")], "s1");
	assert.equal(host.streams.at(-1)?.model, "vision");
});

test("a model that only claims image input but cannot take it is not used", async (t) => {
	const host = boot(t, {
		catalog: [visionEntry("p/fake", "Fake vision", ["image"]), visionEntry("p/vision", "Vision", ["image"])],
		config: { textOnlyModels: ["p/fake"] },
	});
	host.rt.defaultRef = () => "p/fake";
	(host.ctx.llm as any).resolveModelInfo = async (_provider: string, model: string) => ({
		inputModalities: model === "fake" ? ["text"] : ["text", "image"],
	});
	await host.rt.imagesForGroup([attachment("sha256:route")], "s1");
	assert.equal(host.streams[0].model, "vision");
});

test("a text-only model never sees an image: the message carries the reading instead", async (t) => {
	const host = boot(t);
	(host.ctx.llm as any).resolveModelInfo = async (_provider: string, model: string) => ({
		inputModalities: model === "vision" ? ["text", "image"] : ["text"],
	});
	const photo = attachment("sha256:rewrite", "pic.png");
	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", attachment: photo },
			],
		},
		{ role: "user", content: [{ type: "image", offloaded: true, attachment: attachment("sha256:old") }] },
		{ role: "user", content: [{ type: "text", text: "plain" }] },
	];
	const rewritten = await host.rt.withImagesAsText(messages, "s1");
	assert.deepEqual(rewritten[0].content, [
		{ type: "text", text: "look" },
		{
			type: "text",
			text: '[Image "pic.png". You cannot see images, so Vision read it for you:]\nA cat on a mat.\n[End of image "pic.png"]',
		},
	]);
	// An image already offloaded is left alone, and a message without images keeps its identity.
	assert.deepEqual(rewritten[1], messages[1]);
	assert.equal(rewritten[1], messages[1]);
	assert.equal(rewritten[2], messages[2]);
});

test("the llm/stream listener rewrites only for a model that cannot read images", async (t) => {
	const host = boot(t);
	const listener = host.ctx.listeners.get("llm/stream")?.at(-1) as any;
	assert.ok(listener !== undefined);
	const photo = attachment("sha256:listen", "pic.png");
	const options = {
		sessionId: "s1",
		provider: "p",
		model: "vision",
		messages: [{ role: "user", content: [{ type: "image", attachment: photo }] }],
	};
	const passed = async () => {
		for await (const chunk of listener(options, () =>
			(async function* () {
				yield { type: "passed" };
			})(),
		))
			return [chunk];
		return [];
	};
	// A model that reads images gets the request unchanged.
	assert.deepEqual(await passed(), [{ type: "passed" }]);
	// A text-only model gets a rewritten request with the image as text;
	// itself let through because it carries no image.
	(host.ctx.llm as any).resolveModelInfo = async (_provider: string, model: string) => ({
		inputModalities: model === "vision" ? ["text", "image"] : ["text"],
	});
	const textOnly = { ...options, model: "chat" };
	const events: any[] = [];
	for await (const chunk of listener(textOnly, () =>
		(async function* () {
			yield { type: "passed" };
		})(),
	))
		events.push(chunk);
	assert.equal(events.length, 2);
	// The reading was asked for first, then the rewritten request went to the provider.
	assert.equal(host.streams.length, 2);
	assert.deepEqual(host.streams[0].messages?.[0].content?.[0], { type: "image", attachment: photo });
	const rewritten = host.streams[1].messages as any[];
	assert.equal(rewritten[0].content[0].type, "text");
	assert.match(rewritten[0].content[0].text, /Vision read it for you/);
	// A group Session is composed by the group module and is let through as it is.
	host.rt.roomOf = () => ({ id: "r1", name: "Ops", members: [], mode: "everyone" });
	host.rt.ownRequest = () => false;
	const roomEvents: any[] = [];
	for await (const chunk of listener({ ...options, sessionId: "r1" }, () =>
		(async function* () {
			yield { type: "passed" };
		})(),
	))
		roomEvents.push(chunk);
	assert.deepEqual(roomEvents, [{ type: "passed" }]);
});

test("a stream the agent loop made itself is left alone", async (t) => {
	const host = boot(t);
	const listener = host.ctx.listeners.get("llm/stream")?.at(-1) as any;
	host.rt.ownRequest = () => true;
	const events: any[] = [];
	for await (const chunk of listener(
		{
			sessionId: "s1",
			provider: "p",
			model: "vision",
			messages: [{ role: "user", content: [{ type: "image", attachment: attachment("sha256:own") }] }],
		},
		() =>
			(async function* () {
				yield { type: "passed" };
			})(),
	))
		events.push(chunk);
	assert.deepEqual(events, [{ type: "passed" }]);
});

test("old images are marked offloaded once the Session goes idle", async (t) => {
	const host = boot(t);
	const appended: Array<{ type: string; data: unknown }> = [];
	const flushed: unknown[] = [];
	const session = {
		id: "b1",
		seq: 5,
		surface: { nodes: [0, 1] },
		eventAt: (seq: number) => [{ type: "user/message" }, { type: "user/message" }][seq],
		deriveEventMessage: () => ({
			content: [{ type: "image", attachment: attachment("sha256:old1") }],
		}),
		append: (type: string, data: unknown) => appended.push({ type, data }),
	};
	// Without the projection that reads `image/offload`, nothing is appended.
	await host.emit("agent/status", { agent: { id: "b1", session }, status: "idle" });
	assert.deepEqual(appended, []);
	host.sessions.messageProjections = [{ type: "image/offload" }];
	host.sessions.flush = async (flushedSession: unknown) => {
		flushed.push(flushedSession);
		return undefined;
	};
	// A turn that ended (not idle) is not touched.
	await host.emit("agent/status", { agent: { id: "b1", session }, status: "running" });
	assert.deepEqual(appended, []);
	// A Session the team does not know is not touched either.
	await host.emit("agent/status", { agent: { id: "other", session }, status: "idle" });
	assert.deepEqual(appended, []);
	// The idle Bot Session's old images are recorded, and the Session is flushed.
	await host.emit("agent/status", { agent: { id: "b1", session }, status: "idle" });
	assert.deepEqual(appended, [
		{
			type: "image/offload",
			data: {
				targets: [
					{ seq: 0, imageIndexes: [0] },
					{ seq: 1, imageIndexes: [0] },
				],
			},
		},
	]);
	assert.deepEqual(flushed, [session]);
});
