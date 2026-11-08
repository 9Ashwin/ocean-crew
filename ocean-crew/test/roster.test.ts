// Roster behaviour: creating, renaming and deleting Bots and group chats, Main Bots,
// the first Main Bot of a new team, held greetings, and the settings a group accepts.

// keep the same observable promises. Roster runs on the team store alone; the slices it
// calls (models, folders, permissions, privacy, delivery, parts, memory) are stubbed
// here, so this file tests roster and not another slice.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { test } from "node:test";
import { format } from "node:util";
import type { DshContext, Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";
import { install as installRoster } from "../src/host/team/roster.ts";
import type { Bot, Room } from "../src/shared/state.ts";

// The greeting texts roster sends;
const OWN_RULES = "Where your instructions say otherwise, follow them.";
const AFTER_USER =
	"You were just set up as the user's Main Bot. The user wrote to you before your model could answer; their message above has no answer yet. Answer it now, and say in one short sentence that you run their Bot team.";

interface Delivered {
	fromId?: string;
	toId: string;
	text?: string;
	role?: string;
	[key: string]: unknown;
}

interface ModelReasoning {
	efforts: Array<{ id: string; name: string }>;
	defaultEffort?: string;
}

interface TestOptions {
	models?: string[];
	reasoning?: Record<string, ModelReasoning>;
	selection?: { provider: string; model: string; reasoningEffort?: string };
	uiLanguage?: string;
	archiveError?: unknown;
	memoryPath?: string;
	// Names of dependencies installed after roster, as the plugin's module order has it.
	lateDeps?: string[];
}

interface WorkspaceRecord {
	id: string;
	path: string;
}

interface TestRuntime {
	rt: Runtime & Record<string, any>;
	ctx: DshContext;
	home: string;
	statePath: string;
	// The Session controller and title service the runtime was built with; a test may
	// replace `controller.create` to hold or fail Session creation.
	controller: { create(request: Record<string, unknown>): Promise<{ sessionId: string }> };
	sessionTitle: { rename(session: unknown, title: string): Promise<unknown> };
	// Every create the roster asked of the Session controller, in order.
	requests: Array<Record<string, unknown>>;
	sent: Delivered[];
	selected: unknown[];
	applied: Array<{ botId: string; model?: string; effort?: string; force?: boolean }>;
	archived: Array<{ sessionId: string; options?: { stopActivity?: boolean } }>;
	renamed: Array<{ sessionId: string; title: string }>;
	warnings: string[];
	workspaces: Map<string, WorkspaceRecord>;
	models: string[];
	unread: Map<string, unknown[]>;
	released: Array<{ botId: string; sessionIds: string[] }>;
	forgotten: string[];
	droppedLines: string[];
	memoryArchived: string[];
	followed: Array<{ botId?: string; roomId?: string }>;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
// A greeting goes out after the team is saved, which can take longer than one settle()
// on a busy machine.
const until = async (check: () => boolean): Promise<void> => {
	const end = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > end) throw new Error("until: the condition did not hold within 2 s");
		await settle();
	}
};

const overlap = (one: string, other: string): boolean =>
	one === other || one.startsWith(other + sep) || other.startsWith(one + sep);

// Session machinery. Everything a test needs to observe is recorded on the runtime.
async function runtime(
	t: { after(fn: () => Promise<void> | void): void },
	saved?: unknown,
	options: TestOptions = {},
): Promise<TestRuntime> {
	const home = fs.mkdtempSync(join(tmpdir(), "ocean-crew-roster-"));
	const statePath = join(home, "state.json");
	if (saved !== undefined) fs.writeFileSync(statePath, JSON.stringify(saved));

	const models = [...(options.models ?? [])];
	const warnings: string[] = [];
	const disposers: Array<() => unknown> = [];
	const workspaces = new Map<string, WorkspaceRecord>();
	const archived: TestRuntime["archived"] = [];
	const renamed: TestRuntime["renamed"] = [];
	const sent: Delivered[] = [];
	const selected: unknown[] = [];
	const applied: TestRuntime["applied"] = [];
	const released: TestRuntime["released"] = [];
	const forgotten: string[] = [];
	const droppedLines: string[] = [];
	const memoryArchived: string[] = [];
	const followed: TestRuntime["followed"] = [];
	const unread = new Map<string, unknown[]>();
	let sessions = 0;

	const requests: Array<Record<string, unknown>> = [];
	const controller = {
		create: async (request: Record<string, unknown>): Promise<{ sessionId: string }> => {
			requests.push(request);
			return { sessionId: `s${++sessions}` };
		},
	};
	const sessionTitle = {
		rename: async (session: unknown, title: string): Promise<unknown> => {
			renamed.push({ sessionId: (session as { id?: string } | undefined)?.id ?? "", title });
			return undefined;
		},
	};
	const workspaceRegistry = {
		get: (id?: string) => workspaces.get(id ?? ""),
		resolveByPath: async (path: string) => [...workspaces.values()].find((workspace) => workspace.path === path),
		create: async (path: string, _name?: string) => {
			const workspace = { id: `w${workspaces.size + 1}`, path };
			workspaces.set(workspace.id, workspace);
			return workspace;
		},
		archiveSession: async (sessionId: string, archiveOptions?: { stopActivity?: boolean }) => {
			if (options.archiveError !== undefined) throw options.archiveError;
			archived.push({ sessionId, options: archiveOptions });
		},
	};
	const services: Record<string, unknown> = {};
	const ctx = {
		logger: { warn: (...args: unknown[]) => warnings.push(format(...args)), info: () => {} },
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
		on: () => () => {},
		get: (name: string) => services[name],
		workspaceRegistry,
		sessionController: {
			create: (request: Record<string, unknown>) => controller.create(request),
			resolveAgent: async (sessionId: string) => ({ agent: { session: { id: sessionId } } }),
		},
		sessionTitle,
	} as unknown as DshContext;

	const rt = {
		ctx,
		config: { home },
		dshHome: join(home, "dsh"),
		home,
		statePath,
		teamTools: [],
		defaults: { mainName: "Chief", mainRole: "Chief of Staff" },
		warn: (...args: unknown[]) => warnings.push(format(...args)),
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);

	const state = () => rt.state;
	const resolveModel = async (text: unknown): Promise<string> => {
		const wanted = String(text ?? "").trim();
		const exact = models.find((ref) => ref === wanted);
		if (exact !== undefined) return exact;
		const named = models.filter((ref) => ref.endsWith(`/${wanted}`));
		if (named.length === 1) return named[0];
		throw new Error(`Model ${wanted} is not available. Available models: ${models.join(", ") || "none"}`);
	};
	const resolveEffort = async (ref: string, text: unknown): Promise<string | undefined> => {
		const wanted = String(text ?? "").trim();
		if (wanted === "") return undefined;
		const efforts = options.reasoning?.[ref]?.efforts ?? [];
		if (efforts.length === 0) throw new Error(`Model ${ref} has no thinking levels`);
		const named = efforts.filter(
			(effort) => effort.id === wanted || effort.name.toLowerCase() === wanted.toLowerCase(),
		);
		if (named.length === 1) return named[0].id;
		throw new Error(
			`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map((effort) => effort.name).join(", ")}`,
		);
	};
	const cleanWorkDir = async (input: unknown): Promise<string | undefined> => {
		const text = String(input ?? "").trim();
		if (text === "") return undefined;
		if (!isAbsolute(text)) throw new Error(`Give the full path of the folder, not ${text}`);
		let real: string;
		try {
			real = fs.realpathSync(text);
		} catch {
			throw new Error(`There is no folder at ${text}`);
		}
		if (!fs.statSync(real).isDirectory()) throw new Error(`${text} is a file, not a folder`);
		return real;
	};
	const privateClash = async (dir: string): Promise<Bot | undefined> =>
		Object.values(rt.state.bots).find(
			(bot) => bot.private === true && bot.workDir !== undefined && overlap(dir, bot.workDir),
		);
	const checkPrivacyChange = async (
		bot: Bot,
		change: { flag?: boolean; moving: boolean; workDir?: string },
	): Promise<void> => {
		const makes = change.flag === undefined ? bot.private === true : change.flag;
		const dir = change.moving ? change.workDir : bot.workDir;
		if (!makes) {
			const clash = change.moving && dir !== undefined ? await privateClash(dir) : undefined;
			if (clash !== undefined)
				throw new Error(
					`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`,
				);
			return;
		}
		if (rt.isMain(bot.id)) throw new Error(`${bot.name} is a Main Bot, so it cannot be private`);
		if (dir === undefined) throw new Error(`${bot.name} needs a folder of its own to be private`);
		if (Object.values(rt.state.rooms).some((room) => room.members.includes(bot.id)))
			throw new Error(
				`${bot.name} is in a group chat, where every member reads what is said. Remove it from its groups first`,
			);
		const clash = await privateClash(dir);
		if (clash !== undefined)
			throw new Error(
				`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`,
			);
	};
	const checkNoPrivate = (ids: string[]): void => {
		const found = ids.map((id) => rt.botOf(id)).find((bot) => bot?.private === true);
		if (found !== undefined)
			throw new Error(
				`${found.name} is a private Bot and cannot be in a group chat: what is said in a group is read by every member`,
			);
	};
	const setRoomPermission = async (room: Room, name: string | null | undefined): Promise<boolean> => {
		const wanted = name ?? undefined;
		if (wanted === room.permission) return false;
		if (wanted === undefined) delete room.permission;
		else room.permission = wanted;
		return true;
	};

	const dependencies: Record<string, unknown> = {
		teamFolder: () => [...workspaces.values()].find((workspace) => workspace.id === state().workspaceId)?.path,
		defaultTeamFolder: () => join(home, "workspace"),
		isFolder: async (path: string) => {
			try {
				return fs.statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
		resolveModel,
		defaultBotModel: async () => models[0],
		resolveEffort,
		defaultEffort: async (ref: string) => {
			const wanted = options.selection?.reasoningEffort;
			if (wanted === undefined) return undefined;
			return resolveEffort(ref, wanted).catch(() => undefined);
		},
		cleanWorkDir,
		privateClash,
		checkPrivacyChange,
		checkNoPrivate,
		catalog: async () => models.map((ref) => ({ ref })),
		isUsable: (ref?: string) => ref !== undefined && models.includes(ref),
		applyModel: async (bot: Bot, applyOptions?: { force?: boolean }) => {
			applied.push({ botId: bot.id, model: bot.model, effort: bot.effort, force: applyOptions?.force });
			if (bot.model === undefined) delete bot.appliedModel;
			else bot.appliedModel = bot.model;
			if (bot.effort === undefined) delete bot.appliedEffort;
			else bot.appliedEffort = bot.effort;
		},
		waitForModel: async (bot: Bot) => bot.model,
		deliver: async (message: Delivered) => {
			sent.push(message);
		},
		unreadOf: (sessionId: string) => unread.get(sessionId) ?? [],
		archiveBotMemory: async (botId: string) => {
			memoryArchived.push(`bot:${botId}`);
			return options.memoryPath;
		},
		archiveGroupMemory: async (room: Room) => {
			memoryArchived.push(`room:${room.id}`);
			return options.memoryPath;
		},
		releaseBot: async (botId: string, sessionIds: string[]) => {
			released.push({ botId, sessionIds });
		},
		forgetBotSecrets: async (botId: string) => {
			forgotten.push(botId);
		},
		dropGroupLines: (roomId: string) => {
			droppedLines.push(roomId);
		},
		dropOrphanCapabilities: () => undefined,
		setPermission: async (bot: Bot, name: unknown) => {
			bot.permission = String(name);
		},
		cleanRoomPermission: (name: unknown) => (name === null || name === "" ? null : String(name ?? "").trim() || null),
		setRoomPermission,
		followFolder: (owner: { botId?: string; roomId?: string }) => {
			followed.push(owner);
		},
		followEngine: () => undefined,
		roomProgress: new Map(),
		roomInbox: new Map(),
		syncModels: () => undefined,
		...(options.uiLanguage === undefined ? {} : { uiLanguage: () => options.uiLanguage }),
	};
	// The plugin installs roster before folders, privacy, resume, groups and memory; the
	// cases keep that order so a function looked up too early shows up here.
	const late = new Set(options.lateDeps ?? []);
	const early = Object.fromEntries(Object.entries(dependencies).filter(([name]) => !late.has(name)));
	const delayed = Object.fromEntries(Object.entries(dependencies).filter(([name]) => late.has(name)));
	Object.assign(rt, early);
	installRoster(rt);
	Object.assign(rt, delayed);
	await rt.load();

	const dispose = async (): Promise<void> => {
		await Promise.allSettled(disposers.splice(0).map((cleanup) => cleanup()));
	};
	t.after(async () => {
		await dispose();
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	});
	return {
		rt,
		ctx,
		home,
		statePath,
		controller,
		sessionTitle,
		requests,
		sent,
		selected,
		applied,
		archived,
		renamed,
		warnings,
		workspaces,
		models,
		unread,
		released,
		forgotten,
		droppedLines,
		memoryArchived,
		followed,
	};
}

// Holds every new Session until `release`, so creates that start together are all
// waiting on it at once, as with a slow DSH.
function holdSessions(test: TestRuntime): { waiting: () => number; release: () => void } {
	const create = test.controller.create;
	let open = (): void => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let waiting = 0;
	test.controller.create = async (request: Record<string, unknown>) => {
		waiting += 1;
		await gate;
		return create(request);
	};
	return {
		waiting: () => waiting,
		release: () => {
			test.controller.create = create;
			open();
		},
	};
}

const botOf = (test: TestRuntime, id: string): Bot | undefined => test.rt.botOf(id);
const kickoffs = (test: TestRuntime): Delivered[] => test.sent.filter((message) => message.role === "kickoff");
const botsNamed = (test: TestRuntime, name: string): Bot | undefined =>
	Object.values(test.rt.state.bots).find((bot) => bot.name === name);

// ---------------------------------------------------------------------------
// The first Main Bot and the greeting it holds.

test("the first Main Bot waits for the user to pick a model, then greets", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"] });
	await test.rt.bootstrap();
	const main = botOf(test, test.rt.state.mainBotIds[0]) as Bot;
	assert.equal(main.name, "Chief");
	assert.equal(main.role, "Chief of Staff");
	assert.equal(main.model, undefined);
	assert.deepEqual(main.avatar, { shape: "marine-whale" });
	assert.equal(main.color, "deepseek");
	assert.notEqual(main.kickoff, undefined);
	assert.equal(kickoffs(test).length, 0);
	assert.equal(test.applied.length, 0);

	await test.rt.updateBot(main.id, { model: "deepseek/deepseek-v4-pro" });
	await until(() => kickoffs(test).length > 0);
	const greeting = kickoffs(test)[0];
	assert.equal(greeting.fromId, undefined);
	assert.equal(greeting.toId, main.id);
	assert.match(String(greeting.text), /Greet the user in one or two short messages/);
	assert.equal(botOf(test, main.id)?.model, "deepseek/deepseek-v4-pro");
	assert.equal(botOf(test, main.id)?.kickoff, undefined);
	assert.equal(main.appliedModel, "deepseek/deepseek-v4-pro");

	// A later model change does not greet again.
	await test.rt.updateBot(main.id, { model: "deepseek/deepseek-v4-flash" });
	await settle();
	assert.equal(kickoffs(test).length, 1);
});

test("a new team's Main Bot is made once, also when bootstrap runs twice at once", async (t) => {
	const test = await runtime(t, undefined, { models: [] });
	await Promise.all([test.rt.bootstrap(), test.rt.bootstrap()]);
	assert.deepEqual(test.rt.state.mainBotIds.length, 1);
	const main = botOf(test, test.rt.state.mainBotIds[0]) as Bot;
	assert.equal(main.name, "Chief");
	assert.deepEqual(main.avatar, { shape: "marine-whale" });
	// The greeting is held: no model is served yet, and the user picks one.
	assert.notEqual(main.kickoff, undefined);
	assert.equal(kickoffs(test).length, 0);

	// A team that already has a Main Bot is not given another one.
	await test.rt.bootstrap();
	assert.equal(Object.keys(test.rt.state.bots).length, 1);
});

test("other Bots start on the default model and greet at once", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const writer = await test.rt.createBot({ name: "Writer" });
	await until(() => kickoffs(test).some((message) => message.toId === writer.id));
	assert.equal(writer.model, "deepseek/deepseek-v4-flash");
	const greeting = kickoffs(test).find((message) => message.toId === writer.id) as Delivered;
	assert.match(String(greeting.text), /The user just created you\. Greet the user in one short message/);
	assert.match(String(greeting.text), /Where your instructions say otherwise, follow them\./);
});

test("the roster uses a slice installed after it, as the plugin's module order does", async (t) => {
	// folders, privacy, resume, groups and memory install after roster in the plugin.
	const test = await runtime(t, undefined, {
		models: ["deepseek/deepseek-v4-flash"],
		lateDeps: ["deliver", "cleanWorkDir", "isFolder", "unreadOf", "teamFolder"],
	});
	await test.rt.bootstrap();
	const folder = join(test.home, "work");
	fs.mkdirSync(folder);
	const writer = await test.rt.createBot({ name: "Writer", workDir: folder });
	// The working folder was resolved by the real folder slice, not left as typed.
	assert.equal(botOf(test, writer.id)?.workDir, fs.realpathSync(folder));
	assert.equal(test.requests.at(-1)?.cwd, fs.realpathSync(folder));
	// The greeting went through the delivery slice that was installed after roster.
	await until(() => kickoffs(test).some((message) => message.toId === writer.id));
	// And the greeting-out read came from the resume slice that was installed after it.
	test.unread.set(test.rt.chatOf(writer.id), [{ role: "kickoff" }]);
	assert.equal(test.rt.greetingOut(writer.id), true);
});

test("the first Main Bot inherits the profile's thinking level, and a new Bot takes its own", async (t) => {
	const reasoning = {
		"deepseek/deepseek-v4-flash": {
			efforts: [
				{ id: "low", name: "Low" },
				{ id: "high", name: "High" },
			],
			defaultEffort: "high",
		},
	};
	const test = await runtime(t, undefined, {
		models: ["deepseek/deepseek-v4-flash"],
		reasoning,
		selection: { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high" },
	});
	const writer = await test.rt.createBot({ name: "Writer" });
	assert.equal(writer.effort, "high");
	const coder = await test.rt.createBot({ name: "Coder", effort: "low" });
	assert.equal(coder.effort, "low");
	// An explicit Default pick stays on the model's own level.
	const plain = await test.rt.createBot({ name: "Plain", effort: null });
	assert.equal(plain.effort, undefined);
	// A level the model does not serve is refused before the Bot is made.
	await assert.rejects(test.rt.createBot({ name: "Phantom", effort: "max" }), /Thinking level max is not available/);
	assert.equal(botsNamed(test, "Phantom"), undefined);
	// A level needs a model to resolve against.
	const bare = await runtime(t, undefined, { models: [] });
	await assert.rejects(
		bare.rt.createBot({ name: "Phantom", effort: "low" }),
		/Pick a model before choosing a thinking level/,
	);
	assert.equal(botsNamed(bare, "Phantom"), undefined);
	// Clearing the level returns the Bot to the model's own.
	await test.rt.updateBot(writer.id, { effort: null });
	assert.equal(botOf(test, writer.id)?.effort, undefined);
});

// ---------------------------------------------------------------------------
// Names.

test("a new name must be one '@' can call; a name saved before the rule still saves", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	for (const name of ["a@b", "All", "所有人"]) {
		await assert.rejects(test.rt.createBot({ name }), Error, name);
	}
	const writer = await test.rt.createBot({ name: "Writer 2" });
	await assert.rejects(test.rt.updateBot(writer.id, { name: "Writer@home" }), /cannot contain @/);
	await test.rt.updateBot(writer.id, { name: "新 Writer" });
	assert.equal(botOf(test, writer.id)?.name, "新 Writer");
});

test("a Bot cannot be named or renamed like the user; one named so before keeps working", async (t) => {
	const saved = {
		version: 1,
		mainBotIds: ["a"],
		bots: {
			a: { id: "a", name: "Chief", role: "", instructions: "", sessionId: "a", createdAt: 1 },
			u: { id: "u", name: "User", role: "", instructions: "", sessionId: "u", createdAt: 2 },
		},
		rooms: {},
		agents: {},
		exchanges: [],
		exchangeTurns: {},
		questions: {},
		prefs: {},
		revision: 0,
	};
	const test = await runtime(t, saved);
	await assert.rejects(test.rt.createBot({ name: "user" }), /stands for the user in a chat/);
	await assert.rejects(test.rt.updateBot("a", { name: "You" }), /stands for the user in a chat/);
	// The name it already has stays allowed.
	await test.rt.updateBot("u", { name: "User", role: "Tester" });
	assert.equal(botOf(test, "u")?.role, "Tester");
	await test.rt.updateBot("u", { name: "Helper" });
	assert.equal(botOf(test, "u")?.name, "Helper");
});

test("a create that fails at the Session makes no Bot and lets its name go", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const create = test.controller.create;
	test.controller.create = async () => {
		throw new Error("dsh is busy");
	};
	await assert.rejects(test.rt.createBot({ name: "Coder" }), /dsh is busy/);
	assert.equal(botsNamed(test, "Coder"), undefined);
	test.controller.create = create;
	const coder = await test.rt.createBot({ name: "Coder" });
	assert.equal(coder.name, "Coder");
});

test("Bots created with one name at the same time: one is made, the others are refused", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const sessions = holdSessions(test);
	const creates: Array<Promise<Bot>> = [1, 2, 3].map(() => test.rt.createBot({ name: "Coder" }));
	const settled = Promise.allSettled(creates);
	// A rename to a name a create is still working on is refused too.
	const rename = assert.rejects(test.rt.updateBot(chief, { name: "coder" }), /Name coder is not available/);
	sessions.release();
	const results = await settled;
	assert.deepEqual(
		results.map((result) => result.status),
		["fulfilled", "rejected", "rejected"],
	);
	const refused = results[1] as PromiseRejectedResult;
	assert.match(String(refused.reason), /A Bot named Coder already exists/);
	await rename;
	const names = Object.values(test.rt.state.bots).map((bot) => bot.name);
	assert.equal(names.filter((name) => name.toLowerCase() === "coder").length, 1);
});

test("copies of one Bot made at the same time get different names", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const writer = await test.rt.createBot({ name: "Writer" });
	const sessions = holdSessions(test);
	const copies: Array<Promise<Bot>> = [1, 2, 3].map(() => test.rt.duplicateBot(writer.id));
	const settled = Promise.all(copies);
	await until(() => sessions.waiting() === 3);
	sessions.release();
	const results = await settled;
	assert.deepEqual(results.map((copy) => copy.name).sort(), ["Writer copy", "Writer copy 2", "Writer copy 3"]);
});

// ---------------------------------------------------------------------------
// Main Bots.

test("another Bot takes the Main Bot place in one step", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	await test.rt.setMain(writer.id, true, { replace: chief });
	assert.deepEqual(test.rt.state.mainBotIds, [writer.id]);
	// The whale stays with the Bot it was given to.
	assert.deepEqual(botOf(test, chief)?.avatar, { shape: "marine-whale" });
	// The old Main Bot can now be deleted, and no new Chief is made in its place.
	await test.rt.deleteBot(chief);
	assert.deepEqual(test.rt.state.mainBotIds, [writer.id]);
	assert.deepEqual(
		Object.values(test.rt.state.bots).map((bot) => bot.id),
		[writer.id],
	);
});

test("a Main Bot moves to the front and the others keep their order", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const reader = await test.rt.createBot({ name: "Reader" });
	await test.rt.setMain(writer.id, true);
	assert.deepEqual(test.rt.state.mainBotIds, [chief, writer.id]);
	await test.rt.setMain(writer.id, true, { primary: true });
	assert.deepEqual(test.rt.state.mainBotIds, [writer.id, chief]);
	await test.rt.setMain(reader.id, true);
	assert.deepEqual(test.rt.state.mainBotIds, [writer.id, chief, reader.id]);
	// Replacing a Main Bot that is not first keeps its place.
	await test.rt.setMain(reader.id, true, { replace: chief });
	assert.deepEqual(test.rt.state.mainBotIds, [writer.id, reader.id]);
	// Demoting a Main Bot leaves the others in order.
	await test.rt.setMain(writer.id, false);
	assert.deepEqual(test.rt.state.mainBotIds, [reader.id]);
});

test("set-main keeps one Main Bot and replaces only a Main Bot", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const reader = await test.rt.createBot({ name: "Reader" });
	await assert.rejects(test.rt.setMain(chief, false), /The team needs at least one Main Bot/);
	await assert.rejects(test.rt.setMain(writer.id, true, { replace: reader.id }), /Only a Main Bot can be replaced/);
	await assert.rejects(test.rt.setMain("nope", true), /Unknown Bot/);
	await test.rt.setMain(reader.id, false);
	assert.deepEqual(test.rt.state.mainBotIds, [chief]);
});

test("a hidden Bot made Main Bot shows again, and a replaced Chief drops its held greeting", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	await until(() => kickoffs(test).some((message) => message.toId === writer.id));
	await test.rt.setFlags(writer.id, { hidden: true });
	const toChief = (): number => kickoffs(test).filter((message) => message.toId === chief).length;
	const greeted = toChief();
	await test.rt.setMain(writer.id, true, { replace: chief });
	assert.equal(botOf(test, writer.id)?.hidden, undefined);
	assert.equal(botOf(test, chief)?.kickoff, undefined);
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-flash" });
	await settle();
	assert.equal(toChief(), greeted);
});

// ---------------------------------------------------------------------------
// Greetings.

test("a greeting held for a Bot without a model goes out once it has one", async (t) => {
	const test = await runtime(t, undefined, { models: [] });
	await test.rt.bootstrap();
	const writer = await test.rt.createBot({ name: "Writer" });
	assert.notEqual(botOf(test, writer.id)?.kickoff, undefined);
	assert.equal(test.rt.greetingOut(writer.id), false);
	assert.equal(kickoffs(test).length, 0);

	test.models.push("deepseek/deepseek-v4-flash");
	// The Bot has no model of its own yet, so releaseKickoff leaves the greeting held.
	assert.equal(await test.rt.releaseKickoff(botOf(test, writer.id) as Bot), false);
	await test.rt.updateBot(writer.id, { model: "deepseek/deepseek-v4-flash" });
	await until(() => kickoffs(test).length === 1);
	const greeting = kickoffs(test)[0];
	assert.equal(greeting.toId, writer.id);
	assert.match(String(greeting.text), /The user just created you\. Greet the user in one short message/);
	assert.equal(test.rt.greetingOut(writer.id), false);
	assert.equal(botOf(test, writer.id)?.kickoff, undefined);

	// A greeting sent but not yet taken up by a turn is still out.
	test.unread.set(test.rt.chatOf(writer.id), [{ role: "kickoff" }]);
	assert.equal(test.rt.greetingOut(writer.id), true);
});

test("the user writing in the first Main Bot's chat makes its greeting answer them", async (t) => {
	const test = await runtime(t, undefined, { models: [], uiLanguage: "Chinese (简体中文)" });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	test.rt.userWrote(chief);
	const held = botOf(test, chief)?.kickoff as { afterUser?: boolean } | undefined;
	assert.equal(held?.afterUser, true);
	test.models.push("deepseek/deepseek-v4-flash");
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-flash" });
	await until(() => kickoffs(test).length === 1);
	const text = String(kickoffs(test)[0].text);
	assert.ok(text.startsWith(AFTER_USER));
	assert.match(text, /Write in Chinese \(简体中文\)\./);
	assert.ok(text.endsWith(OWN_RULES));
});

test("a greeting the user's turn answered is not sent, and a Bot that can answer drops its own", async (t) => {
	// The first Main Bot: the user wrote while it had no model, then a turn answered it.
	const test = await runtime(t, undefined, { models: [] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	test.rt.userWrote(chief);
	test.rt.userAnswered(chief);
	assert.equal(botOf(test, chief)?.kickoff, undefined);
	test.models.push("deepseek/deepseek-v4-flash");
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-flash" });
	await settle();
	assert.equal(kickoffs(test).length, 0);

	// Another Bot that can answer drops its held greeting when the user writes.
	const other = await runtime(t, undefined, { models: [] });
	const writer = await other.rt.createBot({ name: "Writer" });
	assert.notEqual(botOf(other, writer.id)?.kickoff, undefined);
	other.rt.userWrote(writer.id);
	assert.equal(botOf(other, writer.id)?.kickoff, undefined);
	other.models.push("deepseek/deepseek-v4-flash");
	await other.rt.updateBot(writer.id, { model: "deepseek/deepseek-v4-flash" });
	await settle();
	assert.equal(kickoffs(other).length, 0);
});

test("a failed greeting is held again and goes out only once the block clears", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-flash" });
	await until(() => kickoffs(test).length === 1);
	const first = kickoffs(test)[0];
	// The turn that carried the greeting failed on a missing key: turns.ts holds it again.
	(test.rt.state.bots[chief] as Bot).blocked = { code: "MISSING_CREDENTIAL", message: "no key" };
	test.rt.holdKickoffAgain(chief);
	assert.notEqual(botOf(test, chief)?.kickoff, undefined);
	// Setting the same model again fixes nothing, so the greeting stays held.
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-flash" });
	await settle();
	assert.equal(kickoffs(test).length, 1);
	assert.notEqual(botOf(test, chief)?.kickoff, undefined);
	// Once the key is fixed (turns.ts clears the block) the greeting goes out again.
	delete (test.rt.state.bots[chief] as Bot).blocked;
	assert.equal(await test.rt.releaseKickoff(botOf(test, chief) as Bot), true);
	await until(() => kickoffs(test).length === 2);
	assert.equal(kickoffs(test)[1].text, first.text);
});

test("a new model lifts what blocked a Bot; a new thinking level alone fixes nothing", async (t) => {
	const test = await runtime(t, undefined, {
		models: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
		reasoning: { "deepseek/deepseek-v4-flash": { efforts: [{ id: "low", name: "Low" }] } },
	});
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-flash" });
	await until(() => kickoffs(test).length === 1);
	// A greeting on its way is held again; the old model was the failure's.
	(test.rt.state.bots[chief] as Bot).blocked = { code: "QUOTA", message: "no balance" };
	test.rt.holdKickoffAgain(chief);
	await test.rt.updateBot(chief, { effort: "low" });
	assert.notEqual(botOf(test, chief)?.blocked, undefined);
	await test.rt.updateBot(chief, { model: "deepseek/deepseek-v4-pro" });
	assert.equal(botOf(test, chief)?.blocked, undefined);
	await until(() => kickoffs(test).length === 2);
});

// ---------------------------------------------------------------------------
// Deleting a Bot.

test("deleting a Bot or group chat stops its Session, so its tasks are removed", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const room = await test.rt.createRoom({ members: [chief, writer.id], admin: writer.id });
	await until(() => kickoffs(test).some((message) => message.toId === writer.id));
	test.archived.length = 0;
	await test.rt.deleteBot(writer.id);
	await test.rt.deleteRoom(room.id);
	// `stopActivity` lets DSH's session-stop hook drop the Session's armed scheduled
	// tasks; without it the archive is refused and they keep delivering into the
	// deleted Session.
	assert.deepEqual(
		test.archived.map((entry) => [entry.sessionId, entry.options]),
		[
			[writer.id, { stopActivity: true }],
			[room.id, { stopActivity: true }],
		],
	);
	assert.equal(test.rt.greetingOut(writer.id), false);
});

test("deleting a Bot also stops its past parts' Sessions, where tasks can stay armed", async (t) => {
	const saved = {
		version: 1,
		mainBotIds: ["m1"],
		revision: 2,
		bots: {
			m1: { id: "m1", sessionId: "m1", name: "Chief", role: "Chief of Staff", instructions: "", createdAt: 1 },
			w1: {
				id: "w1",
				sessionId: "w2",
				name: "Writer",
				role: "",
				instructions: "",
				createdAt: 2,
				segments: [{ sessionId: "w1", endedAt: 3 }],
			},
		},
		rooms: {},
		exchanges: [],
		exchangeTurns: {},
		questions: {},
	};
	const test = await runtime(t, saved, { models: ["deepseek/deepseek-v4-flash"] });
	test.archived.length = 0;
	await test.rt.deleteBot("w1");
	assert.deepEqual(
		test.archived.map((entry) => [entry.sessionId, entry.options]),
		[
			["w1", { stopActivity: true }],
			["w2", { stopActivity: true }],
		],
	);
	assert.deepEqual(test.released, [{ botId: "w1", sessionIds: ["w1", "w2"] }]);
});

test("an archive failure on delete is warned instead of passing silently", async (t) => {
	const test = await runtime(t, undefined, {
		models: ["deepseek/deepseek-v4-flash"],
		archiveError: new Error("archive refused"),
	});
	const writer = await test.rt.createBot({ name: "Writer" });
	await test.rt.deleteBot(writer.id);
	await settle();
	assert.equal(test.warnings.filter((text) => text.includes("not archived")).length, 1);
});

test("a delete that cannot be saved still stops the Sessions, and the next save writes it", async (t) => {
	const saved = {
		version: 1,
		mainBotIds: ["m1"],
		revision: 2,
		bots: {
			m1: { id: "m1", sessionId: "m1", name: "Chief", instructions: "", createdAt: 1 },
			w1: { id: "w1", sessionId: "w1", name: "Writer", instructions: "", createdAt: 2 },
		},
		rooms: {},
		exchanges: [],
		exchangeTurns: {},
		questions: {},
	};
	const test = await runtime(t, saved, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.load();
	test.archived.length = 0;
	// A directory takes the state file's temp path, so the write fails.
	const blocker = join(test.home, `state.json.${process.pid}.tmp`);
	fs.mkdirSync(blocker);
	await assert.rejects(test.rt.deleteBot("w1"));
	// The Bot is gone from the team, so nothing could stop its tasks later.
	assert.deepEqual(
		test.archived.map((entry) => entry.sessionId),
		["w1"],
	);
	fs.rmSync(blocker, { recursive: true });
	await test.rt.save();
	const savedTeam = JSON.parse(fs.readFileSync(test.statePath, "utf8"));
	assert.equal(savedTeam.bots.w1, undefined);
});

test("a Bot deleted while in a group leaves it, and an unnamed group follows its name", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const room = await test.rt.createRoom({ members: [chief, writer.id] });
	assert.equal(room.name, "You, Chief, Writer");
	await test.rt.deleteBot(writer.id);
	const after = test.rt.state.rooms[room.id] as Room;
	assert.deepEqual(after.members, [chief]);
	assert.equal(after.name, "You, Chief");
	assert.ok(test.renamed.some((entry) => entry.sessionId === room.id && entry.title === "You, Chief"));
	assert.deepEqual(test.forgotten, [writer.id]);
	// The Bot's sessions/questions/exchange turns leave the team with it.
	assert.equal(test.rt.state.bots[writer.id], undefined);
});

test("a private Bot's deletion keeps its folder and memory closed to the others", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"], memoryPath: "archive/kept" });
	await test.rt.bootstrap();
	const folder = join(test.home, "private");
	fs.mkdirSync(folder);
	const writer = await test.rt.createBot({ name: "Writer", workDir: folder });
	await test.rt.updateBot(writer.id, { private: true });
	await test.rt.deleteBot(writer.id);
	const kept = (test.rt.state.privateArchives as Array<Record<string, unknown>>).find(
		(entry) => entry.id === writer.id,
	);
	assert.notEqual(kept, undefined);
	assert.equal(kept?.archiving, undefined);
	assert.equal(kept?.archivePath, "archive/kept");
	assert.equal(kept?.workDir, fs.realpathSync(folder));
	assert.deepEqual(test.memoryArchived, [`bot:${writer.id}`]);
});

// ---------------------------------------------------------------------------
// Creating and changing a Bot.

test("a Bot stores what a create and an update give it, and a profile change is delivered", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({
		name: " Writer ",
		role: "Writing",
		instructions: " Write clearly. ",
		color: "red",
		brief: "Review the notes.",
		createdBy: chief,
	});
	assert.equal(writer.name, "Writer");
	assert.equal(writer.role, "Writing");
	assert.equal(writer.instructions, "Write clearly.");
	assert.equal(writer.color, "red");
	assert.equal(writer.createdBy, chief);
	assert.deepEqual(writer.capabilities, []);
	await until(() => kickoffs(test).some((message) => message.toId === writer.id));
	// The greeting says who made it and why.
	const greeting = kickoffs(test).find((message) => message.toId === writer.id) as Delivered;
	assert.match(String(greeting.text), /Chief just created you for the user\. Why you exist: Review the notes\./);

	// An update stores the fields it names and tells the Bot's chat what changed.
	test.sent.length = 0;
	await test.rt.updateBot(writer.id, {
		name: "Editor",
		role: "Editing",
		instructions: "Edit.",
		color: null,
		avatar: { shape: "fox" },
	});
	const updated = botOf(test, writer.id) as Bot;
	assert.equal(updated.name, "Editor");
	assert.equal(updated.role, "Editing");
	assert.equal(updated.color, undefined);
	assert.deepEqual(updated.avatar, { shape: "fox" });
	const notice = test.sent.find((message) => message.role === "update") as Delivered;
	assert.match(String(notice.text), /Your role is now "Editing"/);
	assert.match(String(notice.text), /Your instructions now read:\nEdit\./);
});

test("a Bot's avatar and thinking level are checked before anything is written", async (t) => {
	const test = await runtime(t, undefined, {
		models: ["deepseek/deepseek-v4-flash"],
		reasoning: { "deepseek/deepseek-v4-flash": { efforts: [{ id: "low", name: "Low" }] } },
	});
	await test.rt.bootstrap();
	const writer = await test.rt.createBot({ name: "Writer", effort: "low", avatar: { shape: "fox" } });
	assert.equal(writer.effort, "low");
	assert.deepEqual(writer.avatar, { shape: "fox" });
	await assert.rejects(test.rt.updateBot(writer.id, { avatar: { image: "http://example.com/x.png" } }), /PNG/);
	await assert.rejects(test.rt.updateBot(writer.id, { effort: "max" }), /Thinking level max is not available/);
	// The refusals left the Bot as it was.
	assert.equal(botOf(test, writer.id)?.effort, "low");
	assert.deepEqual(botOf(test, writer.id)?.avatar, { shape: "fox" });
	// A photo may be stored and cleared.
	const image = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;
	await test.rt.updateBot(writer.id, { avatar: { shape: "fox", image } });
	assert.deepEqual(botOf(test, writer.id)?.avatar, { shape: "fox", image });
	await test.rt.updateBot(writer.id, { avatar: null });
	assert.equal(botOf(test, writer.id)?.avatar, undefined);
});

test("a Bot cannot be made private by another Bot, and a private Bot cannot be a Main Bot", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const folder = join(test.home, "private");
	fs.mkdirSync(folder);
	const writer = await test.rt.createBot({ name: "Writer", workDir: folder });
	await assert.rejects(test.rt.updateBot(writer.id, { private: true }, chief), /Only the user can make/);
	await test.rt.updateBot(writer.id, { private: true });
	assert.equal(botOf(test, writer.id)?.private, true);
	await assert.rejects(test.rt.setMain(writer.id, true), /is private, so it cannot be a Main Bot/);
});

test("a private Bot cannot be copied; a copy keeps a served model and a lost folder falls back", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const folder = join(test.home, "work");
	fs.mkdirSync(folder);
	const writer = await test.rt.createBot({ name: "Writer", workDir: folder });
	await until(() => kickoffs(test).some((message) => message.toId === writer.id));
	await test.rt.updateBot(writer.id, { private: true });
	await assert.rejects(test.rt.duplicateBot(writer.id), /is private, so it cannot be copied/);
	await test.rt.updateBot(writer.id, { private: false });
	const copy = await test.rt.duplicateBot(writer.id);
	assert.equal(copy.name, "Writer copy");
	assert.equal(copy.model, "deepseek/deepseek-v4-flash");
	assert.equal(copy.workDir, fs.realpathSync(folder));
	await until(() => kickoffs(test).some((message) => message.toId === copy.id));
	const greeting = kickoffs(test).find((message) => message.toId === copy.id) as Delivered;
	assert.match(String(greeting.text), /copy of Writer/);

	// A folder that went away since leaves the copy in the team workspace.
	fs.rmSync(folder, { recursive: true });
	const second = await test.rt.duplicateBot(writer.id);
	assert.equal(second.workDir, undefined);
	assert.equal(second.name, "Writer copy 2");
});

test("creating a Bot writes the team workspace once, and makes the folder again if it is gone", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const first = test.rt.state.workspaceId as string;
	const workspace = test.workspaces.get(first) as WorkspaceRecord;
	assert.equal(workspace.path, join(test.home, "workspace"));
	assert.equal(fs.statSync(workspace.path).isDirectory(), true);
	const _writer = await test.rt.createBot({ name: "Writer" });
	assert.equal(test.rt.state.workspaceId, first);
	fs.rmSync(workspace.path, { recursive: true });
	await test.rt.createBot({ name: "Reader" });
	assert.equal(fs.statSync(workspace.path).isDirectory(), true);
});

test("a host that lost the team makes no Session and no Bot", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const readOnly = test.rt.readOnly;
	test.rt.readOnly = () => "The Bot team is open in another dsh.";
	let created = 0;
	const create = test.controller.create;
	test.controller.create = async (request) => {
		created += 1;
		return create(request);
	};
	await assert.rejects(test.rt.createBot({ name: "Phantom" }), /open in another dsh/);
	assert.equal(created, 0);
	assert.equal(botsNamed(test, "Phantom"), undefined);
	test.rt.readOnly = readOnly;
});

// ---------------------------------------------------------------------------
// Group chats.

test("a group chat checks its members, admin, mode, name and notice", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	await assert.rejects(test.rt.createRoom({ members: [chief] }), /at least two Bots/);
	await assert.rejects(test.rt.createRoom({ members: [chief, "ghost"] }), /at least two Bots/);
	await assert.rejects(
		test.rt.createRoom({ members: [chief, writer.id], admin: "ghost" }),
		/The admin must be a member of the group/,
	);
	await assert.rejects(
		test.rt.createRoom({ members: [chief, writer.id], mode: "nobody" }),
		/Reply mode must be one of everyone, admin/,
	);
	// The limit is counted on the Bots that exist.
	for (let index = 0; index < 12; index += 1) {
		test.rt.state.bots[`x${index}`] = { id: `x${index}`, name: `X${index}`, instructions: "", capabilities: [] };
	}
	const thirteen = [chief, ...Array.from({ length: 12 }, (_, index) => `x${index}`)];
	await assert.rejects(test.rt.createRoom({ members: thirteen }), /at most 12 Bots/);
	// A notice past the limit is refused with its real length.
	const long = "x".repeat(2001);
	await assert.rejects(
		test.rt.createRoom({ members: [chief, writer.id], notice: long }),
		/at most 2000 characters; this one has 2001/,
	);
	// A name is cut to the limit; two groups cannot share one.
	const room = await test.rt.createRoom({ members: [chief, writer.id], name: "N".repeat(70) });
	assert.equal(room.name.length, 60);
	assert.equal(room.mode, "admin");
	assert.equal(room.notice, "");
	await assert.rejects(
		test.rt.createRoom({ members: [chief, writer.id], name: room.name }),
		/Another group chat is already called/,
	);
	// A private Bot cannot join any group.
	const folder = join(test.home, "private");
	fs.mkdirSync(folder);
	const secret = await test.rt.createBot({ name: "Secret", workDir: folder });
	await test.rt.updateBot(secret.id, { private: true });
	await assert.rejects(test.rt.createRoom({ members: [chief, secret.id] }), /is a private Bot/);
});

test("a group the user makes is led by a Main Bot member; a group a Main Bot makes by itself", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const reader = await test.rt.createBot({ name: "Reader" });
	// Made by the user: a Main Bot member leads it.
	const userRoom = await test.rt.createRoom({ members: [writer.id, chief] });
	assert.equal(userRoom.admin, chief);
	// Made by a Bot: that Bot leads it.
	const botRoom = await test.rt.createRoom({ members: [chief, writer.id], createdBy: writer.id });
	assert.equal(botRoom.admin, writer.id);
	// A deleted Bot's place is taken by a Main Bot member.
	const third = await test.rt.createRoom({ members: [writer.id, reader.id], admin: writer.id });
	await test.rt.deleteBot(writer.id);
	assert.equal((test.rt.state.rooms[third.id] as Room).admin, null);
});

test("changing a group chat reports what changed and needs the user, a Main Bot or the admin", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const reader = await test.rt.createBot({ name: "Reader" });
	const room = await test.rt.createRoom({
		members: [chief, writer.id],
		name: "Docs",
		mode: "everyone",
		admin: writer.id,
		notice: "old",
	});
	// A Bot that is neither a Main Bot nor the admin cannot change it.
	await assert.rejects(
		test.rt.updateRoom(room.id, { notice: "nope" }, reader.id),
		/Only the user, a Main Bot, or the admin/,
	);
	const changed = await test.rt.updateRoom(
		room.id,
		{ add: [reader.id], remove: [chief], mode: "admin", notice: "new", name: "Ops" },
		writer.id,
	);
	assert.deepEqual((test.rt.state.rooms[room.id] as Room).members.sort(), [reader.id, writer.id].sort());
	assert.deepEqual(changed.changes, [
		"added Reader",
		"removed Chief",
		"plain messages now go to the admin first",
		"updated the notice",
		`renamed it "Ops"`,
	]);
	assert.equal((test.rt.state.rooms[room.id] as Room).name, "Ops");
	assert.ok(test.renamed.some((entry) => entry.sessionId === room.id && entry.title === "Ops"));
	// The admin may not hand its role away, leave the group without one, or change the
	// group's folder and permissions.
	const led = await test.rt.createRoom({ members: [chief, writer.id, reader.id], admin: writer.id });
	await assert.rejects(
		test.rt.updateRoom(led.id, { admin: null }, writer.id),
		/Hand the admin role to another member instead of leaving the group without one/,
	);
	await assert.rejects(
		test.rt.updateRoom(led.id, { remove: [writer.id] }, writer.id),
		/Hand the admin role to another member before leaving the group/,
	);
	await assert.rejects(
		test.rt.updateRoom(led.id, { workDir: join(test.home, "work") }, writer.id),
		/Only the user or a Main Bot can set the folder/,
	);
	await assert.rejects(
		test.rt.updateRoom(led.id, { permission: "acceptEdits" }, writer.id),
		/Only the user can set the permissions/,
	);
});

test("a group left with one Bot by a deletion can still change its other settings", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const room = await test.rt.createRoom({ members: [chief, writer.id], name: "Docs" });
	await test.rt.deleteBot(writer.id);
	assert.deepEqual((test.rt.state.rooms[room.id] as Room).members, [chief]);
	const changed = await test.rt.updateRoom(room.id, { notice: "still here" });
	assert.deepEqual(changed.changes, ["updated the notice"]);
	assert.equal((test.rt.state.rooms[room.id] as Room).notice, "still here");
});

test("a group without a chosen name follows its members' names", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const room = await test.rt.createRoom({ members: [chief, writer.id] });
	assert.equal(room.name, "You, Chief, Writer");
	await test.rt.updateBot(writer.id, { name: "Editor" });
	assert.equal((test.rt.state.rooms[room.id] as Room).name, "You, Chief, Editor");
	assert.ok(test.renamed.some((entry) => entry.sessionId === room.id && entry.title === "You, Chief, Editor"));
	// A named group keeps its name when a member is renamed.
	const named = await test.rt.createRoom({ members: [chief, writer.id], name: "Docs" });
	await test.rt.updateBot(writer.id, { name: "Writer 2" });
	assert.equal((test.rt.state.rooms[named.id] as Room).name, "Docs");
	// Clearing the name makes it follow again.
	await test.rt.updateRoom(named.id, { name: "" });
	assert.equal((test.rt.state.rooms[named.id] as Room).name, "You, Chief, Writer 2");
});

test("a group name taken while a create runs cannot be taken by a rename", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const other = await test.rt.createRoom({ members: [chief, writer.id], name: "Docs" });
	const sessions = holdSessions(test);
	const creates: Array<Promise<Room>> = [1, 2].map(() =>
		test.rt.createRoom({ members: [chief, writer.id], name: "Ops" }),
	);
	const settled = Promise.allSettled(creates);
	const rename = assert.rejects(
		test.rt.updateRoom(other.id, { name: "ops" }),
		/Another group chat is already called "ops"/,
	);
	sessions.release();
	const results = await settled;
	assert.deepEqual(
		results.map((result) => result.status),
		["fulfilled", "rejected"],
	);
	const refused = results[1] as PromiseRejectedResult;
	assert.match(String(refused.reason), /Another group chat is already called "Ops"/);
	await rename;
	assert.deepEqual(
		Object.values(test.rt.state.rooms)
			.map((room) => room.name)
			.sort(),
		["Docs", "Ops"],
	);
	// Once the create ends, its name is no longer held for anyone else.
	const later = await test.rt.createRoom({ members: [chief, writer.id], name: "Ops 2" });
	assert.equal(later.name, "Ops 2");
});

test("deleting a group chat archives its Session and drops its lines", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	const writer = await test.rt.createBot({ name: "Writer" });
	const room = await test.rt.createRoom({ members: [chief, writer.id], name: "Docs" });
	(test.rt.state.rooms[room.id] as Room).sessions = { [writer.id]: "gs1" };
	test.archived.length = 0;
	await test.rt.deleteRoom(room.id);
	assert.equal(test.rt.state.rooms[room.id], undefined);
	assert.equal(test.rt.state.switching[room.id], undefined);
	assert.deepEqual(test.droppedLines, [room.id]);
	assert.deepEqual(test.memoryArchived, [`room:${room.id}`]);
	assert.deepEqual(
		test.archived.map((entry) => [entry.sessionId, entry.options]),
		[
			["gs1", { stopActivity: true }],
			[room.id, { stopActivity: true }],
		],
	);
});

// ---------------------------------------------------------------------------
// Flags.

test("set-flags marks a Bot, a group chat or the team's agent, and refuses an unknown one", async (t) => {
	const test = await runtime(t, undefined, { models: ["deepseek/deepseek-v4-flash"] });
	await test.rt.bootstrap();
	const chief = test.rt.state.mainBotIds[0];
	await test.rt.setFlags(chief, { pinned: true, hidden: true });
	assert.equal(botOf(test, chief)?.pinned, true);
	assert.equal(botOf(test, chief)?.hidden, true);
	const writer = await test.rt.createBot({ name: "Writer" });
	const room = await test.rt.createRoom({ members: [chief, writer.id] });
	await test.rt.setFlags(room.id, { pinned: false });
	assert.equal((test.rt.state.rooms[room.id] as Room).pinned, false);
	test.rt.state.agents.a1 = { id: "a1", title: "DSH Agent" };
	await test.rt.setFlags("a1", { hidden: true });
	assert.equal(test.rt.state.agents.a1.hidden, true);
	await assert.rejects(test.rt.setFlags("nope", { pinned: true }), /Unknown conversation/);
});
