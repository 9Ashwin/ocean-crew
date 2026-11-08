// Working-folder behaviour: the DSH home helpers, the team workspace, which paths are
// data (and so closed to Bots), how a Session's folder is chosen, and the folder
// endpoints the settings window calls.
// assertions and extended for the paths the roster and tools call.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { dshHomeOf, install, within } from "../src/host/core/folders.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { emptyTeam, type Room, type TeamState } from "../src/shared/state.ts";

type TestRuntime = Runtime & Record<string, any>;

interface Workspace {
	id: string;
	path: string;
	title: string;
}

interface SetupOptions {
	workspaces?: Workspace[];
	services?: Record<string, any>;
	state?: Partial<TeamState>;
	config?: Record<string, unknown>;
	// The team workspace inside DSH's data, as the plugin's own default is.
	teamInHome?: boolean;
}

// A test home: DSH_HOME with the team's data inside it, the team workspace, and a
// project folder beside them. Every folder is a real path, as the plugin saves them.
function setup(
	t: TestContext,
	{ workspaces = [], services = {}, state: saved = {}, config = {}, teamInHome = false }: SetupOptions = {},
) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocean-crew-folders-")));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
	const dsh = join(root, "dsh");
	const home = join(dsh, "bot");
	const team = teamInHome ? join(home, "workspace") : join(root, "team");
	const project = join(root, "project");
	for (const dir of [team, project, home]) mkdirSync(dir, { recursive: true });
	const registry = new Map<string, Workspace>([
		["w1", { id: "w1", path: team, title: "Ocean Crew" }],
		...workspaces.map((workspace) => [workspace.id, workspace] as [string, Workspace]),
	]);
	const state: TeamState = { ...emptyTeam(), workspaceId: "w1", ...saved };
	const chatOwners = new Map<string, string>();
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	for (const bot of Object.values(state.bots)) chatOwners.set(bot.sessionId ?? bot.id, bot.id);
	for (const room of Object.values(state.rooms))
		for (const [botId, sessionId] of Object.entries(room.sessions ?? {}))
			groupOwners.set(sessionId, { botId, roomId: room.id });
	let saves = 0;
	const rt = {
		ctx: {
			get: (name: string) => services[name],
			workspaceRegistry: {
				get: (id?: string) => (id === undefined ? undefined : registry.get(id)),
				list: () => [...registry.values()],
				resolveByPath: async (path: string) => [...registry.values()].find((workspace) => workspace.path === path),
				create: async (path: string, title: string) => {
					const workspace = { id: `w-new-${registry.size}`, path, title };
					registry.set(workspace.id, workspace);
					return workspace;
				},
			},
		},
		config,
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
		selfOf: (id?: string) => (id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId)),
		groupSessionsOf: () => [],
		resolveAgent: async (sessionId: string) => ({ session: { id: sessionId } }),
		save: async () => {
			saves += 1;
		},
		privateClash: async () => undefined,
	} as unknown as TestRuntime;
	install(rt);
	return {
		root,
		dsh,
		home,
		team,
		project,
		registry,
		services,
		state,
		rt,
		saves: () => saves,
	};
}

const folderAt = (...parts: string[]): string => {
	const path = join(...parts);
	mkdirSync(path, { recursive: true });
	return path;
};

function env(t: TestContext, values: Record<string, string | undefined>): void {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	const restore = (): void => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	restore();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) process.env[key] = value;
	}
	t.after(restore);
}

test("dshHomeOf reads a blank value as unset and expands the home shorthand", () => {
	const dsh = join(homedir(), ".dsh");
	assert.equal(dshHomeOf(undefined), dsh);
	assert.equal(dshHomeOf("  "), dsh);
	assert.equal(dshHomeOf("~"), homedir());
	assert.equal(dshHomeOf("~/dsh-x"), join(homedir(), "dsh-x"));
	assert.equal(dshHomeOf("~\\dsh-x"), join(homedir(), "dsh-x"));
	assert.equal(dshHomeOf("dsh-x"), resolve("dsh-x"));
});

test("within names a folder and what lies below it, never a parent", () => {
	const base = resolve("/tmp", "a");
	assert.equal(within(base, base), true);
	assert.equal(within(join(base, "b"), base), true);
	assert.equal(within(base, join(base, "b")), false);
	assert.equal(within(join(base, "b"), join(base, "b")), true);
});

test("a working folder is a full path to a folder outside the DeepSeek Harness data", async (t) => {
	const { rt, root, dsh, home, team, project } = setup(t);
	const error = async (input: unknown): Promise<string | undefined> => {
		try {
			await rt.cleanWorkDir(input);
			return undefined;
		} catch (failure) {
			return (failure as Error).message;
		}
	};
	assert.equal(await error("project"), "Give the full path of the folder, not project");
	const missing = join(root, "missing");
	assert.equal(await error(missing), `There is no folder at ${missing}`);
	const file = join(project, "notes.txt");
	writeFileSync(file, "x");
	assert.equal(await error(file), `${file} is a file, not a folder`);
	// DSH_HOME, the team's data, and any folder that holds them are refused.
	for (const guarded of [dsh, home, root])
		assert.equal(await error(guarded), `${guarded} holds DeepSeek Harness data, so Bots cannot work there`);
	// The team workspace and a folder inside it are fine; the workspace itself is no setting.
	assert.equal(await error(team), undefined);
	const site = folderAt(team, "site");
	assert.equal(await error(site), undefined);
	// A quoted path and a trailing separator name the same folder.
	assert.equal(await rt.cleanWorkDir(`"${project}/"`), project);
	assert.equal(await rt.cleanWorkDir(project), project);
});

test("a folder that is the team workspace is no working folder, and data folders are never work folders", async (t) => {
	const { rt, team, home } = setup(t);
	assert.equal(await rt.workFolder(team), undefined);
	assert.equal(await rt.workFolder(folderAt(team, "sub")), join(team, "sub"));
	await assert.rejects(rt.workFolder(home), /holds DeepSeek Harness data/);
});

test("inData tells the team's data from the team workspace lying inside it", async (t) => {
	const outside = setup(t);
	assert.equal(await outside.rt.inData(join(outside.home, "state.json")), true);
	assert.equal(await outside.rt.inData(join(outside.dsh, "sessions", "x.jsonl")), true);
	assert.equal(await outside.rt.inData(join(outside.project, "a.txt")), false);
	// The team workspace can lie inside the data folder (the plugin's own default does);
	// files a Bot names from there are how images enter the team.
	const inside = setup(t, { teamInHome: true });
	assert.equal(await inside.rt.inData(join(inside.team, "a.png")), false);
	assert.equal(await inside.rt.inData(join(inside.home, "state.json")), true);
});

test("the team folder is the registered workspace, else the configured or default workspace", async (t) => {
	const { rt, home, team } = setup(t);
	assert.equal(rt.teamFolder(), team);
	assert.equal(rt.defaultTeamFolder(), join(home, "workspace"));
	const configured = setup(t, { config: { workspace: "/configured" } });
	assert.equal(configured.rt.defaultTeamFolder(), "/configured");
	env(t, { MINI_BOT_WORKSPACE: " /from-env " });
	assert.equal(rt.defaultTeamFolder(), "/from-env");
	const missing = setup(t, { state: { workspaceId: undefined } });
	assert.equal(missing.rt.teamFolder(), undefined);
});

test("workDirOf reads the group's folder, then a member's pick there, then the Bot's", (t) => {
	const { rt, state } = setup(t, {
		state: {
			mainBotIds: ["a"],
			bots: {
				a: { id: "a", name: "Chief", workDir: "/bots/a" },
				b: { id: "b", name: "Writer", workDir: "/bots/b" },
			},
			rooms: {
				r1: { id: "r1", name: "Ops", members: ["a", "b"], mode: "admin", workDir: "/groups/ops" },
				r2: {
					id: "r2",
					name: "Lab",
					members: ["a", "b"],
					mode: "admin",
					memberDirs: { a: "/members/a-in-lab", b: null },
				},
			} as Record<string, Room>,
		},
	});
	assert.equal(rt.workDirOf({ roomId: "r1", botId: "b" }), "/groups/ops");
	assert.equal(rt.workDirOf({ roomId: "r2", botId: "a" }), "/members/a-in-lab");
	// null means the team workspace, not the Bot's own folder.
	assert.equal(rt.workDirOf({ roomId: "r2", botId: "b" }), undefined);
	assert.equal(rt.workDirOf({ botId: "a" }), "/bots/a");
	assert.equal(rt.workDirOf({}), undefined);
	assert.equal(state.rooms.r2.workDir, undefined);
});

test("a Session works in the folder DSH reports, else the one Ocean Crew made for it", (t) => {
	const { rt, team, services } = setup(t, {
		state: {
			mainBotIds: ["a"],
			bots: {
				a: { id: "a", name: "Chief", sessionId: "a-chat", workDir: "/bots/a" },
				b: { id: "b", name: "Writer" },
			},
			rooms: {
				r1: {
					id: "r1",
					name: "Ops",
					members: ["a", "b"],
					mode: "admin",
					workDir: "/groups/ops",
					sessions: { b: "gb" },
				},
			} as Record<string, Room>,
		},
	});
	// What DSH has for the Session wins, then the group folder, then a Bot's folder, then the workspace.
	assert.equal(rt.sessionFolder({ id: "a-chat", header: { cwd: "/from-dsh" } }), "/from-dsh");
	assert.equal(rt.sessionFolder({ id: "gb" }), "/groups/ops");
	assert.equal(rt.sessionFolder({ id: "a-chat" }), "/bots/a");
	assert.equal(rt.sessionFolder({ id: "b-chat" }), team);
	// The DSH workingDirectory service is read first when it has a folder.
	services.workingDirectory = { get: () => "/reported" };
	assert.equal(rt.sessionFolder({ id: "a-chat", header: { cwd: "/from-dsh" } }), "/reported");
});

test("isFolder, real, realBeyond and folderAt follow links to the deepest real path", async (t) => {
	const { rt, team, project } = setup(t);
	assert.equal(await rt.isFolder(project), true);
	assert.equal(await rt.isFolder(join(project, "gone")), false);
	writeFileSync(join(project, "a.txt"), "x");
	assert.equal(await rt.isFolder(join(project, "a.txt")), false);
	const link = join(project, "link");
	try {
		symlinkSync(team, link, "dir");
	} catch {
		t.skip("no links here");
		return;
	}
	assert.equal(await rt.real(link), team);
	// The file does not exist yet: the link above it still resolves.
	assert.equal(await rt.realBeyond(join(link, "new.txt")), join(team, "new.txt"));
	assert.equal(await rt.folderAt(project, "link"), team);
	assert.equal(await rt.folderAt(project, "no-such-folder"), undefined);
});

test("sessionsOfBot is a Bot's own chat and its conversation in each group", (t) => {
	const { rt } = setup(t, {
		state: {
			mainBotIds: ["a"],
			bots: {
				a: { id: "a", name: "Chief", sessionId: "a-chat" },
				b: { id: "b", name: "Writer", sessionId: "b-chat" },
			},
			rooms: {
				r1: { id: "r1", name: "Ops", members: ["a", "b"], mode: "admin", sessions: { b: "gb" } },
				r2: { id: "r2", name: "Lab", members: ["b"], mode: "admin" },
			} as Record<string, Room>,
		},
	});
	assert.deepEqual(rt.sessionsOfBot("a"), ["a-chat"]);
	assert.deepEqual(rt.sessionsOfBot("b"), ["b-chat", "gb"]);
});

test("moving the team workspace makes it, registers it and saves the change", async (t) => {
	const { rt, root, home, team, registry, state, saves } = setup(t);
	const next = join(root, "new-team");
	assert.equal(await rt.setTeamWorkspace(next), next);
	assert.equal(state.workspaceId, `w-new-${registry.size - 1}`);
	assert.equal(registry.get(state.workspaceId as string)?.path, next);
	assert.equal(saves(), 1);
	// The plugin's own default lies in DSH's data, and going back to it stays possible.
	const fallback = join(home, "workspace");
	assert.equal(await rt.setTeamWorkspace(fallback), fallback);
	assert.equal(rt.teamFolder(), fallback);
	// The current workspace is returned as it is, with no new registration or save.
	assert.equal(await rt.setTeamWorkspace(fallback), fallback);
	assert.equal(saves(), 2);
	// A relative or blank folder is refused.
	await assert.rejects(rt.setTeamWorkspace("project"), /Give the full path of the folder, not project/);
	await assert.rejects(rt.setTeamWorkspace(""), /Give the full path of the folder, not/);
	// A folder that holds the data is refused.
	await assert.rejects(rt.setTeamWorkspace(root), /holds DeepSeek Harness data, so it cannot be the team workspace/);
	// The registered workspace is returned as it is.
	assert.equal(await rt.setTeamWorkspace(team), team);
});

test("a team workspace inside a private Bot's folder is refused", async (t) => {
	const { rt, root } = setup(t);
	const diary = folderAt(root, "diary");
	rt.privateClash = async () => ({ name: "Diary" });
	await assert.rejects(
		rt.setTeamWorkspace(diary),
		/is in or around the folder of Diary, a private Bot, so it cannot be the team workspace/,
	);
});

interface ApprovalRequest {
	agent: unknown;
	toolName: string;
	callId?: string;
	reason: string;
	displayReason: { en: string; zh: string };
	signal?: AbortSignal;
}

test("a folder inside the team workspace needs no approval", async (t) => {
	const requests: ApprovalRequest[] = [];
	const { rt, team } = setup(t, {
		services: {
			approval: {
				request: async (request: ApprovalRequest) => {
					requests.push(request);
					return "allowed-once";
				},
			},
		},
	});
	const site = folderAt(team, "site");
	await rt.approveFolder({ name: "update_bot" }, { path: undefined, who: { en: "Writer", zh: "Writer " } });
	await rt.approveFolder({ name: "update_bot" }, { path: site, who: { en: "Writer", zh: "Writer " } });
	assert.equal(requests.length, 0);
});

test("a bounded Session asks before it works outside the team workspace", async (t) => {
	const requests: ApprovalRequest[] = [];
	const { rt, project, team } = setup(t, {
		services: {
			sandboxPolicy: { resolve: () => ({ mode: "workspace-write" }) },
			approval: {
				request: async (request: ApprovalRequest) => {
					requests.push(request);
					return "allowed-once";
				},
			},
		},
	});
	const exec = {
		name: "update_bot",
		callId: "c1",
		signal: AbortSignal.timeout(60_000),
		agent: { session: { id: "a@" } },
	};
	await rt.approveFolder(exec, { path: project, sessions: ["a-chat"], who: { en: "Writer", zh: "Writer " } });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].toolName, "update_bot");
	assert.equal(requests[0].callId, "c1");
	assert.equal(requests[0].reason, `Let Writer work in ${project}? Files there can then be changed.`);
	assert.deepEqual(requests[0].displayReason, {
		en: `Let Writer work in ${project}? Files there can then be changed.`,
		zh: `允许Writer 在 ${project} 中工作吗？之后可以修改这个文件夹里的文件。`,
	});
	assert.equal(requests[0].signal, exec.signal);
	// A folder inside the team workspace still widens nothing.
	await rt.approveFolder(exec, {
		path: folderAt(team, "site"),
		sessions: ["a-chat"],
		who: { en: "Writer", zh: "Writer " },
	});
	assert.equal(requests.length, 1);
});

test("no Session that would work there may write, so nobody is asked", async (t) => {
	const requests: ApprovalRequest[] = [];
	const { rt, project } = setup(t, {
		services: {
			sandboxPolicy: {
				resolve: ({ session }: { session?: { id?: string } } = {}) => ({
					mode: session?.id === "writes" ? "workspace-write" : "read-only",
				}),
			},
			approval: {
				request: async (request: ApprovalRequest) => {
					requests.push(request);
					return "allowed-once";
				},
			},
		},
	});
	// The default policy is read-only and every listed Session is read-only too.
	await rt.approveFolder(
		{ name: "update_bot" },
		{ path: project, sessions: ["reads"], who: { en: "Writer", zh: "Writer " } },
	);
	assert.equal(requests.length, 0);
	// One Session that may write is enough to ask.
	await rt.approveFolder(
		{ name: "update_bot", agent: { session: { id: "writes" } } },
		{ path: project, sessions: ["reads", "writes"], who: { en: "Writer", zh: "Writer " } },
	);
	assert.equal(requests.length, 1);
});

test("an approval that is rejected, cancelled or unanswerable refuses the change", async (t) => {
	const outcomes: Array<{ outcome: string; message: (path: string) => string }> = [
		{
			outcome: "rejected",
			message: (path) =>
				`Working in ${path} was not allowed, so nothing changed. The user can make this change in the settings.`,
		},
		{ outcome: "cancelled", message: () => "The approval was cancelled, so nothing changed." },
		{
			outcome: "expired",
			message: (path) =>
				`Working in ${path} needs the user's approval, and no one could answer, so nothing changed. The user can make this change in the settings.`,
		},
	];
	for (const { outcome, message } of outcomes) {
		const { rt, project } = setup(t, { services: { approval: { request: async () => outcome } } });
		await assert.rejects(
			rt.approveFolder(
				{ name: "update_bot", agent: { session: { id: "a@" } } },
				{ path: project, who: { en: "Writer", zh: "Writer " } },
			),
			(error: Error) => error.message === message(project),
		);
	}
	// With no way to ask, nothing changes either.
	const { rt, project } = setup(t);
	await assert.rejects(
		rt.approveFolder({ name: "update_bot" }, { path: project, who: { en: "Writer", zh: "Writer " } }),
		/needs the user's approval, and there is no way to ask for it here/,
	);
});

test("the folders endpoint lists the team's folders and the picker kind", async (t) => {
	const other = { id: "w2", path: "/known/other", title: "Other" };
	const { rt, team, project, state } = setup(t, {
		workspaces: [other],
		services: { directoryPicker: { capability: () => ({ kind: "native" }) } },
		state: {
			mainBotIds: ["a"],
			bots: { a: { id: "a", name: "Chief", workDir: "/gone" }, b: { id: "b", name: "Writer" } },
		},
	});
	state.bots.a.workDir = project;
	const answer = await rt.folderEndpoint("folders", {}, AbortSignal.timeout(1000));
	assert.equal(answer.team, team);
	assert.equal(answer.picker, "native");
	assert.deepEqual(answer.folders, [{ path: project, title: "project" }]);
	// With no folder chooser the kind is null.
	const plain = setup(t);
	assert.deepEqual((await plain.rt.folderEndpoint("folders", {}, AbortSignal.timeout(1000))).picker, null);
});

test("folder-pick and folder-list use the DSH directory picker", async (t) => {
	const picked = { path: "/picked" };
	const listed = { path: "/listed", home: "/home", crumbs: [], entries: [], truncated: false };
	const { rt, services } = setup(t, {
		services: {
			directoryPicker: {
				capability: () => ({
					kind: "native",
					pick: async (signal: AbortSignal) => {
						assert.equal(signal.aborted, false);
						return picked;
					},
				}),
			},
		},
	});
	const signal = AbortSignal.timeout(60_000);
	assert.deepEqual(await rt.folderEndpoint("folder-pick", {}, signal), picked);
	await assert.rejects(rt.folderEndpoint("folder-list", {}, signal), /cannot list folders/);
	const browseSignal = new AbortController();
	services.directoryPicker = {
		capability: () => ({
			kind: "browse",
			list: async (path: string | undefined, listSignal: AbortSignal) => {
				assert.equal(listSignal, browseSignal.signal);
				return { ...listed, path: path ?? listed.path };
			},
		}),
	};
	assert.deepEqual(await rt.folderEndpoint("folder-list", {}, browseSignal.signal), listed);
	assert.deepEqual(await rt.folderEndpoint("folder-list", { path: "/asked" }, browseSignal.signal), {
		...listed,
		path: "/asked",
	});
	// The chooser is a native one here, so picking is fine and listing is not.
	services.directoryPicker = { capability: () => ({ kind: "native", pick: async () => picked }) };
	await assert.rejects(rt.folderEndpoint("folder-list", {}, signal), /cannot list folders/);
	const none = setup(t);
	await assert.rejects(none.rt.folderEndpoint("folder-pick", {}, signal), /no folder chooser/);
	await assert.rejects(none.rt.folderEndpoint("unknown", {}, signal), /Unknown endpoint unknown/);
});
