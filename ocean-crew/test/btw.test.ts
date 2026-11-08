// Aside cards (btw): the saved card files, how a card is placed on the turn it belongs
// to, and the snapshot/model-call helpers side chats use.

// the module installed on it, and the published members asserted directly.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	install as installBtw,
	locatePrivate,
	openTurnAt,
	RESTART_ERROR,
	snapshotOf,
	trimToolBoundary,
} from "../src/host/chat/btw.ts";
import { fakeContext } from "./fake-ctx.ts";

interface Env {
	rt: any;
	home: string;
	ctx: ReturnType<typeof fakeContext>;
	saved: () => number;
	dropped: string[];
	writeCards(botId: string, partId: string, cards: unknown[]): void;
	readCards(botId: string, partId: string): any[];
	deleteBot(id: string): Promise<void>;
	stop(): Promise<void>;
}

const bots = () => ({ b1: { id: "b1", name: "Chief", sessionId: "s-now", createdAt: 1 } });

async function start({ readOnly = false, cards = {} as Record<string, unknown[]> } = {}): Promise<Env> {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-btw-"));
	const ctx = fakeContext();
	for (const [key, list] of Object.entries(cards)) {
		const [botId, partId] = key.split("/");
		mkdirSync(join(home, "btw", botId), { recursive: true });
		writeFileSync(join(home, "btw", botId, `${partId}.json`), JSON.stringify(list));
	}
	const state: any = { bots: bots(), exchangeTurns: {}, questions: {}, views: {}, closedCards: {}, switching: {} };
	const saved = { count: 0 };
	const dropped: string[] = [];
	const warnings: unknown[][] = [];
	const rt: any = {
		ctx,
		state,
		home,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		isMain: () => false,
		pastOwners: new Map(),
		chatOwners: new Map([["s-now", "b1"]]),
		groupOwners: new Map(),
		roomOwners: new Map(),
		roomOf: () => undefined,
		readOnly: () => (readOnly ? "another dsh holds the team" : undefined),
		save: async () => {
			saved.count += 1;
		},
		load: async () => {},
		warn: (...args: unknown[]) => warnings.push(args),
		deleteBot: async (id: string) => {
			dropped.push(id);
			delete state.bots[id];
		},
	};
	installBtw(rt);
	await rt.load();
	const writeCards = (botId: string, partId: string, list: unknown[]): void => {
		mkdirSync(join(home, "btw", botId), { recursive: true });
		writeFileSync(join(home, "btw", botId, `${partId}.json`), JSON.stringify(list));
	};
	const readCards = (botId: string, partId: string): any[] =>
		JSON.parse(readFileSync(join(home, "btw", botId, `${partId}.json`), "utf8"));
	const stop = async (): Promise<void> => {
		await rt.btwDispose();
		await ctx.dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return {
		rt,
		home,
		ctx,
		saved: () => saved.count,
		dropped,
		writeCards,
		readCards,
		deleteBot: (id) => rt.deleteBot(id),
		stop,
	};
}

const card = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	question: `q ${id}`,
	answer: "",
	status: "done",
	...extra,
});

test("a snapshot drops an unfinished tool batch and keeps a finished one", () => {
	const call = { role: "assistant", content: [{ type: "tool-call", id: "c1" }] };
	const unfinished = [{ role: "user", content: [] }, call];
	assert.deepEqual(trimToolBoundary(unfinished), [{ role: "user", content: [] }]);
	const finished = [...unfinished, { role: "tool", toolCallId: "c1", content: [] }];
	assert.deepEqual(trimToolBoundary(finished), finished);
	assert.deepEqual(trimToolBoundary([]), []);
	assert.deepEqual(trimToolBoundary(undefined as any), []);
});

test("a saved card rides the current part's view whole, and an earlier part's file is read on demand", async (t) => {
	const env = await start({ cards: { "b1/s-now": [card("c1")], "b1/s-old": [card("c0")] } });
	t.after(env.stop);
	assert.deepEqual(
		env.rt.btwView().b1.map((entry: any) => entry.id),
		["c1"],
	);
	assert.deepEqual([env.rt.btwView().b1[0].botId, env.rt.btwView().b1[0].partId], ["b1", "s-now"]);
	const earlier = await env.rt.btwPartCards("b1", "s-old");
	assert.deepEqual(
		earlier.map((entry: any) => entry.id),
		["c0"],
	);
	assert.equal(earlier[0].partId, "s-old");
});

test("a reading host keeps a card that was still answering as it was saved", async (t) => {
	const env = await start({ readOnly: true, cards: { "b1/s-now": [card("c1", { status: "answering" })] } });
	t.after(env.stop);
	const list = await env.rt.btwPartCards("b1", "s-now");
	assert.equal(list[0].status, "answering");
	assert.equal(env.readCards("b1", "s-now")[0].status, "answering");
});

test("a restart marks a card that was still answering as failed and rewrites the file", async (t) => {
	const env = await start({ cards: { "b1/s-now": [card("c1", { status: "answering" })] } });
	t.after(env.stop);
	const list = await env.rt.btwPartCards("b1", "s-now");
	assert.deepEqual([list[0].status, list[0].error], ["failed", RESTART_ERROR]);
	assert.equal(typeof list[0].finishedAt, "number");
	assert.equal(env.readCards("b1", "s-now")[0].status, "failed");
});

test("a user deletes a saved card, and a card that is not there changes nothing", async (t) => {
	const env = await start({ cards: { "b1/s-now": [card("c1"), card("c2")] } });
	t.after(env.stop);
	assert.deepEqual(await env.rt.btwDelete({ sessionId: "s-now", cardId: "c1" }), { deleted: true });
	assert.deepEqual(await env.rt.btwDelete({ sessionId: "s-now", cardId: "nope" }), { deleted: false });
	assert.deepEqual(
		env.readCards("b1", "s-now").map((entry) => entry.id),
		["c2"],
	);
	assert.deepEqual(
		env.rt.btwView().b1.map((entry: any) => entry.id),
		["c2"],
	);
});

test("concurrent deletes in one part keep both removals", async (t) => {
	const env = await start({ cards: { "b1/s-now": [card("c1"), card("c2"), card("c3")] } });
	t.after(env.stop);
	const [first, second] = await Promise.all([
		env.rt.btwDelete({ sessionId: "s-now", cardId: "c1" }),
		env.rt.btwDelete({ sessionId: "s-now", cardId: "c2" }),
	]);
	assert.deepEqual([first.deleted, second.deleted], [true, true]);
	assert.deepEqual(
		env.readCards("b1", "s-now").map((entry) => entry.id),
		["c3"],
	);
});

test("deleting a Bot removes its card files through the wrapped deleteBot", async (t) => {
	const env = await start({ cards: { "b1/s-now": [card("c1")] } });
	t.after(env.stop);
	assert.equal(existsSync(join(env.home, "btw", "b1")), true);
	await env.deleteBot("b1");
	assert.deepEqual(env.dropped, ["b1"]);
	assert.equal(existsSync(join(env.home, "btw", "b1")), false);
});

test("a card is placed on the turn it belongs to", () => {
	const projections = {
		stateOf: () => ({
			starts: [
				{ seq: 2, turn: 1 },
				{ seq: 8, turn: 2 },
			],
			turnStartSeq: 8,
			turn: 2,
			messageSeq: 9,
		}),
	};
	assert.equal(openTurnAt(projections, {}, 5), 1);
	assert.equal(openTurnAt(projections, {}, 8), 2);
	assert.equal(openTurnAt(projections, {}, 1), undefined);
	assert.equal(openTurnAt(projections, {}, undefined), undefined);
	const session = {
		id: "s-now",
		seq: 10,
		requestHeader: () => ({ config: { provider: "deepseek", model: "m" } }),
		deriveMessages: () => [{ role: "user", content: [] }],
		toolHistory: () => [],
	};
	assert.deepEqual(snapshotOf(session, projections), {
		header: { config: { provider: "deepseek", model: "m" } },
		messages: [{ role: "user", content: [] }],
		toolHistory: [],
		sessionId: "s-now",
		atSeq: 9,
		anchorSeq: 8,
		turn: 2,
	});
});

test("locatePrivate reads a Bot id or an earlier part as its current part, and refuses a group", () => {
	const state: any = { bots: bots() };
	const rt: any = {
		state,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		pastOwners: new Map<string, any>([
			["s-old", { botId: "b1" }],
			["g-old", { botId: "b1", roomId: "r1" }],
		]),
		chatOwners: new Map([["s-now", "b1"]]),
		groupOwners: new Map([["g-now", { botId: "b1", roomId: "r1" }]]),
		roomOf: (id?: string) => (id === "r1" || id === "g-now" ? { id: "r1" } : undefined),
	};
	assert.deepEqual(locatePrivate(rt, "b1", "no groups"), { sessionId: "s-now", botId: "b1" });
	assert.deepEqual(locatePrivate(rt, "s-old", "no groups"), { sessionId: "s-now", botId: "b1" });
	assert.throws(
		() => locatePrivate(rt, "g-now", "Side chat is only available in a Bot's private chat."),
		/only available/,
	);
	assert.throws(() => locatePrivate(rt, "nobody", "no groups"), /Unknown Bot/);
	assert.throws(
		() => locatePrivate(rt, "g-old", "Side chat is only available in a Bot's private chat."),
		/only available/,
	);
});
