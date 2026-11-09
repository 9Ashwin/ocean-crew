// Companion mode: the character card and the relationship it keeps, the line the model reads
// at the head of a turn, and the prompt a companion renders.
import assert from "node:assert/strict";
import { test } from "node:test";
import { install as installPrompt } from "../src/host/team/prompt.ts";
import { install as installCompanion } from "../src/host/work/companion.ts";
import { COMPANION_EXAMPLE } from "../src/shared/companion.ts";
import { emptyTeam } from "../src/shared/state.ts";
import { fakeContext } from "./fake-ctx.ts";

const DAY = 24 * 60 * 60 * 1000;

function start(t: any, options: { now?: number; events?: any[] } = {}) {
	let now = options.now ?? 1_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const ctx = fakeContext() as any;
	const state = emptyTeam();
	state.bots = {
		a: { id: "a", name: "Chief" } as any,
		b: { id: "b", name: "Dev" } as any,
	};
	const saves = { count: 0 };
	const created: Array<[string, any]> = [];
	const rt = {
		ctx,
		config: {},
		state,
		chatOwners: new Map([["sess-a", "a"]]),
		chatOf: (id: string) => `sess-${id}`,
		botOf: (id?: string) => state.bots[id ?? ""],
		roomOf: () => undefined,
		selfOf: (id?: string) => (id === "sess-a" || id === "a" ? "a" : id),
		isBotSession: () => true,
		isMain: () => false,
		load: async () => {},
		save: async () => {
			saves.count += 1;
		},
		warn: () => {},
		scheduleEndpoint: async (endpoint: string, body: any) => {
			created.push([endpoint, body]);
			if (endpoint === "schedules") return { available: true, tasks: [] };
			if (endpoint === "schedule-create")
				return {
					available: true,
					tasks: [{ id: `task-${created.length}`, title: body.title, botId: "a", sessionId: "sess-a" }],
				};
			return { available: true, tasks: [] };
		},
		async *eventsBackwards() {
			yield* [...(options.events ?? [])].reverse();
		},
	} as any;
	installCompanion(rt);
	const step = (decision: any = { kind: "enter", messages: [] }, agent: any = { id: "sess-a" }) => {
		const hook = (ctx.listeners.get("agent/pre-step") ?? [])[0];
		return hook({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => decision);
	};
	const advance = (ms: number) => {
		now += ms;
	};
	return { rt, ctx, state, saves, created, step, advance, now: () => now };
}

test("a Bot starts as the example character, and the page can change the card", async (t) => {
	const { rt } = start(t);
	const view: any = rt.companionView();
	assert.equal(view.bots.length, 2);
	assert.equal(view.bots[0].companion, null, "companion mode starts off");
	assert.equal(view.example.character.name, "阿鱼");
	await rt.companionSet("a", { enabled: true });
	const enabled: any = rt.companionOf("a");
	assert.equal(enabled.enabled, true);
	assert.equal(enabled.character.name, "阿鱼");
	assert.equal(enabled.interactions, 0);
	await rt.companionSet("a", {
		character: { name: "  小海  ", bio: "听人说话", style: "短句", likes: ["气泡"], dislikes: [] },
		voiceId: "voc_1",
	});
	const changed: any = rt.companionOf("a");
	assert.equal(changed.character.name, "小海");
	assert.deepEqual(changed.character.likes, ["气泡"]);
	assert.equal(changed.voiceId, "voc_1");
	// Disabling keeps the card but stops the prompt and the mood.
	await rt.companionSet("a", { enabled: false });
	assert.equal(rt.companionOf("a"), undefined);
	await rt.companionSet("a", { enabled: true, reset: true });
	assert.equal(rt.companionOf("a").character.name, "小海", "reset keeps the card");
	assert.equal(rt.companionOf("a").affection, COMPANION_EXAMPLE.affection);
});

test("the character card keeps its limits", async (t) => {
	const { rt } = start(t);
	await rt.companionSet("b", {
		enabled: true,
		character: {
			name: "x".repeat(40),
			bio: "b".repeat(500),
			style: "s".repeat(500),
			likes: ["a", "b", "c", "d", "e", "f", "g"],
			dislikes: ["  "],
		},
	});
	const companion: any = rt.companionOf("b");
	assert.equal(companion.character.name.length, 20);
	assert.equal(companion.character.bio.length, 200);
	assert.equal(companion.character.style.length, 200);
	assert.equal(companion.character.likes.length, 5);
	assert.deepEqual(companion.character.dislikes, []);
});

test("each message moves the mood and the closeness a little, and absence cools it", async (t) => {
	const { rt, advance } = start(t);
	await rt.companionSet("a", { enabled: true });
	const base = rt.companionOf("a").affection;
	await rt.companionTouch("sess-a", "谢谢你，今天很开心");
	const praised = rt.companionOf("a");
	assert.equal(praised.affection, base + 2);
	assert.equal(praised.mood, "excited");
	assert.equal(praised.interactions, 1);
	await rt.companionTouch("sess-a", "你这个笨蛋");
	const scolded = rt.companionOf("a");
	assert.equal(scolded.affection, base - 4, "praise and scolding are each small steps");
	assert.equal(scolded.mood, "pout");
	await rt.companionTouch("sess-a", "为什么今天这么安静？");
	assert.equal(rt.companionOf("a").mood, "warm");
	// The relationship does not go below zero.
	for (let index = 0; index < 30; index += 1) await rt.companionTouch("sess-a", "讨厌你");
	assert.equal(rt.companionOf("a").affection, 0);
	// Coming back after four days cools what was saved, by two a day at most.
	await rt.companionSet("a", { enabled: true, reset: true });
	advance(5 * DAY);
	await rt.companionTouch("sess-a", "好久不见");
	assert.ok(rt.companionOf("a").affection <= COMPANION_EXAMPLE.affection + 1);
});

test("a companion's turn reads the mood once, and only for its own chat", async (t) => {
	const { rt, step } = start(t);
	await rt.companionSet("a", { enabled: true });
	const decision = { kind: "enter", messages: [] as any[] };
	const result = await step(decision);
	assert.equal(result.messages.length, 1);
	const injected = result.messages[0];
	assert.equal(injected.source.kind, "ocean-crew-companion");
	assert.match(injected.content[0].text, /How things stand right now/);
	assert.match(injected.content[0].text, /阿鱼/);
	// Not another time in the same turn.
	const repeated = await step({ kind: "enter", messages: [injected] });
	assert.equal(repeated.messages.length, 1);
	// Another Bot's session, and a group session, stay untouched.
	const other = await step({ kind: "enter", messages: [] }, { id: "sess-b" });
	assert.equal(other.messages.length, 0);
	const group = await step({ kind: "enter", messages: [] }, { id: "room-a" });
	assert.equal(group.messages.length, 0);
});

test("a companion's identity prompt carries the character card", async (t) => {
	const { rt, ctx } = start(t);
	await rt.companionSet("a", { enabled: true });
	installPrompt(rt);
	const identity: any = ctx.sections.get("bot-identity");
	const text = identity.text({ agent: { id: "sess-a" } });
	assert.match(text, /# Your character/);
	assert.match(text, /阿鱼/);
	assert.match(text, /# Your identity/);
	// A Bot without companion mode renders the plain identity prompt.
	const plain = identity.text({ agent: { id: "sess-b" } });
	assert.doesNotMatch(plain, /# Your character/);
});

test("the window's play button gets mp3 audio in the character's voice", async (t) => {
	const { rt } = start(t);
	await rt.companionSet("a", { enabled: true, voiceId: "voc_fish" });
	const calls: Array<{ text: string; format?: string; voice?: string }> = [];
	rt.speak = async (text: string, format?: string, voice?: string) => {
		calls.push({ text, format, voice });
		return { bytes: Buffer.from("mp3"), name: "voice.mp3" };
	};
	const answer = await rt.companionAudio("a", "  你好呀  ");
	assert.deepEqual(calls, [{ text: "你好呀", format: "mp3", voice: "voc_fish" }]);
	assert.equal(answer.name, "voice.mp3");
	assert.equal(answer.mime, "audio/mpeg");
	assert.equal(Buffer.from(answer.data, "base64").toString(), "mp3");
	await assert.rejects(rt.companionAudio("a", "   "), (error: any) => error.code === "bot/invalid");
});

test("a daily check-in becomes a DSH schedule, and leaving turns it off", async (t) => {
	const { rt, created } = start(t);
	await rt.companionSet("a", { enabled: true });
	created.length = 0;
	await rt.companionSet("a", { reminder: { time: "09:00" } });
	const create = created.find(([endpoint]) => endpoint === "schedule-create");
	assert.ok(create, "the reminder is a scheduled task");
	assert.equal(create[1].target, "a");
	assert.equal(create[1].when.kind, "daily");
	assert.equal(create[1].when.time, "09:00");
	assert.match(create[1].prompt, /主动关心/);
	assert.equal(rt.companionOf("a").reminder.time, "09:00");
	assert.equal(rt.companionOf("a").reminderId, "task-1");
	// A new time replaces the old task instead of adding a second one.
	created.length = 0;
	await rt.companionSet("a", { reminder: { time: "21:30" } });
	assert.equal(created[1][0], "schedule-create");
	assert.equal(created[1][1].when.time, "21:30");
	// Disabling the companion removes the task.
	created.length = 0;
	await rt.companionSet("a", { enabled: false });
	assert.equal(rt.companionOf("a"), undefined);
});

test("a schedule that cannot be created fails the change instead of pretending", async (t) => {
	const { rt } = start(t);
	await rt.companionSet("a", { enabled: true });
	rt.scheduleEndpoint = async (endpoint: string) => {
		if (endpoint === "schedule-create")
			throw Object.assign(new Error("Automation tasks are off in DSH"), { code: "bot/invalid" });
		return { available: true, tasks: [] };
	};
	await assert.rejects(rt.companionSet("a", { reminder: { time: "09:00" } }), (error: any) => {
		assert.equal(error.code, "bot/refused");
		assert.match(error.message, /daily reminder was not created/);
		return true;
	});
});
