// Private-Bot behaviour: who is private, which folders a private Bot's folder may not
// touch, what a change of `private` or of a folder may do, the group-member rule, and
// the kept-closed list a deleted private Bot leaves behind.
// build's public assertions.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { install as installFolders } from "../src/host/core/folders.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/team/privacy.ts";
import { type Bot, emptyTeam, type Room, type TeamState } from "../src/shared/state.ts";

type TestRuntime = Runtime & Record<string, any>;

interface Workspace {
	id: string;
	path: string;
	title: string;
}

interface SetupOptions {
	state?: Partial<TeamState>;
	services?: Record<string, any>;
	teamInHome?: boolean;
}

// A test home with the team workspace, DSH's data beside it, and empty folders a test
// names as Bot folders. The folder rules compare real paths, as the plugin saves them.
function setup(t: TestContext, { state: saved = {}, services = {}, teamInHome = false }: SetupOptions = {}) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocean-crew-privacy-")));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
	const dsh = join(root, "dsh");
	const home = join(dsh, "bot");
	const team = teamInHome ? join(home, "workspace") : join(root, "team");
	for (const dir of [team, home]) mkdirSync(dir, { recursive: true });
	const registry = new Map<string, Workspace>([["w1", { id: "w1", path: team, title: "Ocean Crew" }]]);
	const state: TeamState = { ...emptyTeam(), workspaceId: "w1", ...saved };
	const chatOwners = new Map<string, string>();
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	let saves = 0;
	const rt = {
		ctx: {
			get: (name: string) => services[name],
			workspaceRegistry: {
				get: (id?: string) => (id === undefined ? undefined : registry.get(id)),
				list: () => [...registry.values()],
				resolveByPath: async (path: string) => [...registry.values()].find((workspace) => workspace.path === path),
				create: async (path: string, title: string) => ({ id: `w-${path}`, path, title }),
			},
		},
		config: {},
		dshHome: dsh,
		home,
		statePath: join(home, "state.json"),
		state,
		warn: () => {},
		chatOwners,
		groupOwners,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		roomOf: (id?: string) => (id === undefined ? undefined : state.rooms[id]),
		isMain: (id?: string) => id !== undefined && state.mainBotIds.includes(id),
		chatOf: (id: string) => state.bots[id]?.sessionId ?? id,
		selfOf: (id?: string) => (id === undefined ? undefined : chatOwners.get(id)),
		groupSessionsOf: () => [],
		resolveAgent: async (sessionId: string) => ({ session: { id: sessionId } }),
		save: async () => {
			saves += 1;
		},
	} as unknown as TestRuntime;
	installFolders(rt);
	install(rt);
	return {
		root,
		dsh,
		home,
		team,
		state,
		rt,
		botOf: (id: string): Bot => state.bots[id],
		roomOf: (id: string): Room => state.rooms[id],
		saves: () => saves,
		folder: (...parts: string[]) => {
			const path = join(root, ...parts);
			mkdirSync(path, { recursive: true });
			return path;
		},
	};
}

// A team with a Main Bot, a Writer, a Diary with a folder of its own, and a group the
// first two are in.
function teamState({ privateBot = true, archives = [] as unknown[] } = {}): Partial<TeamState> {
	return {
		mainBotIds: ["a"],
		privateArchives: archives,
		bots: {
			a: { id: "a", name: "Chief", role: "Boss", sessionId: "a", createdAt: 1 },
			b: { id: "b", name: "Writer", role: "Write", sessionId: "b", createdAt: 2 },
			d: {
				id: "d",
				name: "Diary",
				role: "Notes",
				sessionId: "d",
				createdAt: 3,
				instructions: "Keep the diary of the user.",
				...(privateBot ? { private: true } : {}),
			},
		},
		rooms: {
			r1: { id: "r1", name: "Ops", members: ["a", "b"], mode: "admin", admin: "a", named: true } as Room,
		},
	};
}

const CLOSED = /private Bot/;

test("isPrivate is true only for a Bot the user made private", (t) => {
	const { rt } = setup(t, { state: teamState() });
	assert.equal(rt.isPrivate("d"), true);
	assert.equal(rt.isPrivate("b"), false);
	assert.equal(rt.isPrivate("gone"), false);
	assert.equal(rt.isPrivate(undefined), false);
});

test("a private Bot cannot be a member of a group", (t) => {
	const { rt } = setup(t, { state: teamState() });
	assert.throws(() => rt.checkNoPrivate(["a", "d"]), /Diary is a private Bot and cannot be in a group chat/);
	// A Bot that is not private passes.
	assert.doesNotThrow(() => rt.checkNoPrivate(["a", "b"]));
	assert.doesNotThrow(() => rt.checkNoPrivate([]));
});

test("a folder that is in or around a private Bot's folder clashes with it", async (t) => {
	const { rt, folder, botOf } = setup(t, { state: teamState({ privateBot: false }) });
	const diary = folder("diary");
	botOf("d").workDir = diary;
	botOf("d").private = true;
	assert.equal((await rt.privateClash(diary))?.name, "Diary");
	assert.equal((await rt.privateClash(folder("diary", "inside")))?.name, "Diary");
	// A folder that holds the private folder is around it too.
	assert.equal((await rt.privateClash(join(diary, "..")))?.name, "Diary");
	assert.equal(await rt.privateClash(folder("other")), undefined);
	// A Bot's own folder is not a clash when the check says to except it.
	assert.equal(await rt.privateClash(diary, { except: "d" }), undefined);
	// Without a folder there is nothing to clash with.
	const plain = setup(t);
	assert.equal(await plain.rt.privateClash(plain.team), undefined);
});

test("a Bot becomes private only with a folder of its own that no one else works in", async (t) => {
	const { rt, folder, team, botOf, roomOf } = setup(t, { state: teamState({ privateBot: false }) });
	const diary = folder("diary");
	const bot = botOf("d");
	bot.workDir = diary;
	// The Bot's own folder is enough; a Bot with no folder cannot be private.
	assert.doesNotThrow(() => rt.checkPrivacyChange(bot, { flag: true }));
	await assert.rejects(rt.checkPrivacyChange(botOf("b"), { flag: true }), /needs a folder of its own to be private/);
	// A Main Bot is no private Bot.
	await assert.rejects(rt.checkPrivacyChange(botOf("a"), { flag: true }), /is a Main Bot, so it cannot be private/);
	// A group chat is read by every member, so a member cannot turn private.
	botOf("b").workDir = folder("writer");
	await assert.rejects(
		rt.checkPrivacyChange(botOf("b"), { flag: true }),
		/is in a group chat, where every member reads what is said/,
	);
	// The team workspace is everyone's.
	bot.workDir = team;
	await assert.rejects(rt.checkPrivacyChange(bot, { flag: true }), /is in or around the team workspace/);
	// Another Bot's folder, a group's folder and a member's pick in a group are closed too.
	bot.workDir = folder("writer", "inside");
	await assert.rejects(
		rt.checkPrivacyChange(bot, { flag: true }),
		/is in or around the folder of Writer, so Diary cannot be private there/,
	);
	const room = roomOf("r1");
	room.workDir = folder("group");
	bot.workDir = folder("group", "inside");
	await assert.rejects(rt.checkPrivacyChange(bot, { flag: true }), /is in or around the folder of "Ops"/);
	delete room.workDir;
	room.memberDirs = { b: folder("picked") };
	bot.workDir = folder("picked", "inside");
	await assert.rejects(rt.checkPrivacyChange(bot, { flag: true }), /is in or around the folder of Writer in "Ops"/);
	// A null member pick means the team workspace, so it is no folder.
	room.memberDirs = { b: null };
	bot.workDir = diary;
	assert.doesNotThrow(() => rt.checkPrivacyChange(bot, { flag: true }));
});

test("a private Bot's folder is closed to a Bot that stays public or moves", async (t) => {
	const { rt, folder, botOf } = setup(t, { state: teamState() });
	const diary = folder("diary");
	botOf("d").workDir = diary;
	const writer = botOf("b");
	writer.workDir = folder("writer");
	// Moving into or around the closed folder is refused.
	await assert.rejects(rt.checkPrivacyChange(writer, { moving: true, workDir: folder("diary", "inside") }), CLOSED);
	await assert.rejects(rt.checkPrivacyChange(writer, { moving: true, workDir: diary }), CLOSED);
	// Moving where nothing closed is fine.
	assert.doesNotThrow(() => rt.checkPrivacyChange(writer, { moving: true, workDir: folder("other") }));
	// Setting no folder (back to the team workspace) never clashes.
	assert.doesNotThrow(() => rt.checkPrivacyChange(writer, { moving: true, workDir: undefined }));
});

test("a deleted private Bot's kept folder stays closed until the user releases it", async (t) => {
	const { rt, folder, state } = setup(t, { state: teamState({ privateBot: false }) });
	const diary = folder("diary");
	state.privateArchives = [{ id: "d", name: "Diary", workDir: diary, sessionIds: [], archivePath: folder("archive") }];
	assert.equal((await rt.privateClash(diary))?.name, "Diary");
	assert.equal((await rt.privateClash(folder("diary", "inside")))?.name, "Diary");
	assert.deepEqual(rt.archivesView(), [{ id: "d", name: "Diary", workDir: diary }]);
	await rt.releaseArchive("d");
	assert.deepEqual(rt.archivesView(), []);
	assert.equal((await rt.privateClash(diary))?.name, undefined);
	// Only a Bot kept closed can be released.
	await assert.rejects(rt.releaseArchive("d"), /Nothing kept closed for this Bot/);
});

test("the archives view names each kept Bot and keeps the host-only fields on the host", (t) => {
	const { rt } = setup(t, {
		state: teamState({
			privateBot: false,
			archives: [
				{
					id: "d",
					name: "Diary",
					workDir: "/diary",
					sessionIds: ["d", "g"],
					archivePath: "/archive",
					archiving: true,
				},
				{ id: "e", name: "Ledger" },
			],
		}),
	});
	assert.deepEqual(rt.archivesView(), [
		{ id: "d", name: "Diary", workDir: "/diary" },
		{ id: "e", name: "Ledger" },
	]);
});

test("releasing an archive saves the list without that Bot", async (t) => {
	const { rt, state, saves } = setup(t, {
		state: teamState({
			privateBot: false,
			archives: [
				{ id: "d", name: "Diary", workDir: "/diary" },
				{ id: "e", name: "Ledger", workDir: "/ledger" },
			],
		}),
	});
	await rt.releaseArchive("d");
	assert.deepEqual(
		(state.privateArchives as Array<{ id: string }>).map((entry) => entry.id),
		["e"],
	);
	assert.equal(saves(), 1);
	assert.deepEqual(
		rt.archivesView().map((entry: { id: string }) => entry.id),
		["e"],
	);
});

test("a private Bot that is also archived counts once, under its Bot name", async (t) => {
	const { rt, folder, state, botOf } = setup(t, { state: teamState() });
	const diary = folder("diary");
	state.privateArchives = [{ id: "d", name: "Diary (archived)", workDir: diary }];
	botOf("d").workDir = diary;
	// The live Bot's record wins over the archive entry for the same id.
	assert.equal((await rt.privateClash(diary))?.name, "Diary");
});

test("with no private Bot nothing is closed", async (t) => {
	const { rt, folder } = setup(t, { state: teamState({ privateBot: false }) });
	assert.deepEqual(rt.archivesView(), []);
	assert.equal(await rt.privateClash(folder("anything")), undefined);
	assert.doesNotThrow(() => rt.checkNoPrivate(["a", "b", "d"]));
});

test("the privacy rules run against the real paths of links and the folder's parent", async (t) => {
	const { rt, root, botOf } = setup(t, { state: teamState({ privateBot: false }) });
	const real = join(root, "real-diary");
	mkdirSync(real);
	botOf("d").workDir = real;
	botOf("d").private = true;
	// tmpdir can itself be a link (macOS /var -> /private/var); the checks compare the
	// resolved path, so the folder is found from either spelling.
	assert.equal((await rt.privateClash(join(root, ".", "real-diary")))?.name, "Diary");
	// A folder that holds the closed one is around it, so it is closed too.
	assert.equal((await rt.privateClash(root))?.name, "Diary");
});
