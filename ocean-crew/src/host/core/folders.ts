// The DSH home and path helpers, the team workspace and the working-folder rules: where
// a Bot's Sessions run, which folders a Bot may use, and the folder endpoints the
// settings window calls. A Session's folder is fixed when it is made, so a change moves

// The plugin's default team
// workspace lies inside DSH's data, which is the one exception the data guards make.

import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { TeamState } from "../../shared/state.ts";
import type { Runtime } from "./runtime.ts";
import { unquote } from "./text.ts";

const PICK_TIMEOUT_MS = 10 * 60_000;

// Whether `inner` is `outer` or lies inside it.
export const within = (inner: string, outer: string): boolean =>
	inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

// `~` and `~/…` name the user's home folder; every other text is used as written.
export const expandHome = (text: string): string =>
	text === "~" ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text;

// Read as DSH reads it, so the team's data and the guarded folder are where DSH keeps
// its own: a blank value counts as unset.
export const dshHomeOf = (value: string | undefined): string =>
	resolve(expandHome(value?.trim() ? value : join(homedir(), ".dsh")));

// A part of a Session the foldering code reads: its id and its reported working folder.
interface SessionLike {
	id?: string;
	header?: { cwd?: string; [key: string]: unknown };
}

// Where one Bot speaks: its own chat or its conversation in one group.
interface Place {
	botId?: string;
	roomId?: string;
}

interface Workspace {
	id: string;
	path?: string;
	title?: string;
}

// The DSH services the folder rules read. They are DSH's own services, so the shapes here
// are only the members this file uses.
interface WorkspaceRegistryService {
	get?(workspaceId?: string): Workspace | undefined;
	list?(): Workspace[];
	resolveByPath(path: string): Promise<Workspace | undefined>;
	create(path: string, title: string): Promise<Workspace>;
}

interface WorkingDirectoryService {
	get?(session: SessionLike): string | undefined;
}

interface FolderListing {
	path?: string;
	home?: string;
	crumbs?: unknown;
	entries?: unknown;
	truncated?: boolean;
}

interface FolderPicker {
	kind?: string;
	pick?(signal: AbortSignal): Promise<unknown>;
	list?(path: string | undefined, signal: AbortSignal): Promise<FolderListing>;
}

interface DirectoryPickerService {
	capability(): FolderPicker | undefined;
}

interface SandboxPolicyService {
	resolve(options?: { session?: unknown }): { mode?: string };
}

interface ApprovalService {
	request(request: {
		agent: unknown;
		toolName: string;
		callId?: string;
		reason: string;
		displayReason: { en: string; zh: string };
		signal?: AbortSignal;
	}): Promise<string>;
}

interface AgentHandle {
	session?: unknown;
}

// The tool call a folder approval would be asked from.
interface FolderExec {
	name: string;
	callId?: string;
	signal?: AbortSignal;
	agent?: AgentHandle;
}

interface Who {
	en: string;
	zh: string;
}

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state: TeamState = rt.state;
	const registry = (): WorkspaceRegistryService => ctx.workspaceRegistry as unknown as WorkspaceRegistryService;
	const workingDirectory = (): WorkingDirectoryService | undefined =>
		ctx.get?.("workingDirectory") as WorkingDirectoryService | undefined;

	const teamFolder = (): string | undefined => registry().get?.(state.workspaceId)?.path;
	// The desktop app names the folder the user chose for the Bots' files.
	const defaultTeamFolder = (): string =>
		rt.config.workspace ?? (process.env.MINI_BOT_WORKSPACE?.trim() || join(rt.home, "workspace"));
	// A member's own pick inside one group, made with working_directory there: a path,
	// or null for the team workspace, which a missing entry would read as the Bot's
	// folder. A group's folder outranks it; without one the Bot's folder is the default.
	const workDirOf = ({ botId, roomId }: Place = {}): string | undefined => {
		const room = rt.roomOf(roomId);
		if (room?.workDir !== undefined) return room.workDir;
		if (room !== undefined && botId !== undefined && Object.hasOwn(room.memberDirs ?? {}, botId))
			return room.memberDirs?.[botId] ?? undefined;
		return rt.botOf(botId)?.workDir;
	};
	const isFolder = (path: string): Promise<boolean> =>
		stat(path).then(
			(info) => info.isDirectory(),
			() => false,
		);
	const real = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
	// The real path of the deepest part that exists, with the rest after it.
	const realBeyond = async (path: string): Promise<string> => {
		const rest: string[] = [];
		for (let at = path; ; at = dirname(at)) {
			const found = await realpath(at).catch(() => undefined);
			if (found !== undefined) return join(found, ...rest);
			if (dirname(at) === at) return path;
			rest.unshift(basename(at));
		}
	};
	// The registry keeps the team workspace as it was given; folders compare as real paths.
	const realTeam = async (): Promise<string | undefined> => {
		const team = teamFolder();
		return team === undefined ? undefined : real(team);
	};
	// Where `input` leads from `base`, as a real path, the way DSH's working_directory resolves
	// a change; undefined when nothing is there.
	const folderAt = (base: string, input: string): Promise<string | undefined> =>
		realpath(resolve(base, input)).catch(() => undefined);
	// Where a Session works: the folder DSH has for it, else the one Ocean Crew made it for.
	const sessionFolder = (session?: SessionLike): string | undefined => {
		const reported =
			session?.header === undefined ? undefined : (workingDirectory()?.get?.(session) ?? session.header.cwd);
		if (reported !== undefined) return reported;
		const id = session?.id;
		const room = rt.roomOf(id);
		if (room !== undefined) return workDirOf({ roomId: room.id }) ?? teamFolder();
		const group = id === undefined ? undefined : rt.groupOwners.get(id);
		return workDirOf({ botId: rt.selfOf(id), roomId: group?.roomId }) ?? teamFolder();
	};
	// The desktop app runs its own DSH and names the user's, which Bots must not write either.
	const dataRoots = (): string[] =>
		[rt.dshHome, rt.home, process.env.MINI_BOT_USER_DSH_HOME?.trim()].filter(
			(root): root is string => typeof root === "string" && root !== "",
		);

	// A Bot that could write where DSH or the team keeps its data could change its own
	// permissions or the team, so neither those folders nor one that holds them is allowed.
	// The workspace exception covers only a workspace lying inside the data root (the
	// plugin's default does): one that holds or is a data root does not open it up.
	async function guarded(path: string): Promise<boolean> {
		const team = await realTeam();
		for (const root of dataRoots()) {
			const data = await real(root);
			if (within(data, path)) return true;
			if (within(path, data) && !(team !== undefined && within(path, team) && team !== data && within(team, data)))
				return true;
		}
		return false;
	}

	// A file a Bot names to read into the team, such as a photo, may not come from DSH's or
	// the team's data; the team workspace, which can lie in it, is the exception, for the
	// same reason as in guarded().
	async function inData(path: string): Promise<boolean> {
		const team = await realTeam();
		for (const root of dataRoots()) {
			const data = await real(root);
			if (within(path, data) && !(team !== undefined && within(path, team) && team !== data && within(team, data)))
				return true;
		}
		return false;
	}

	// Saved as the real path, which is what a Session's cwd shows. Undefined means the
	// team workspace.
	async function cleanWorkDir(input: unknown): Promise<string | undefined> {
		const text = unquote(input);
		if (text === "") return undefined;
		const expanded = expandHome(text);
		if (!isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`);
		let path: string;
		try {
			path = await realpath(expanded);
		} catch {
			throw new Error(`There is no folder at ${text}`);
		}
		if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`);
		return workFolder(path);
	}

	// A folder, as a real path, as a working folder: undefined for the team workspace.
	async function workFolder(path: string): Promise<string | undefined> {
		if (await guarded(path)) throw new Error(`${path} holds DeepSeek Harness data, so Bots cannot work there`);
		return path === (await realTeam()) ? undefined : path;
	}

	// The user moves the team workspace. Bots and groups without a folder of their own move on
	// to a fresh part there at their next turn, as for any other change of folder; the old
	// folder and its files stay as they are.
	async function setTeamWorkspace(input: unknown): Promise<string> {
		const text = unquote(input);
		const expanded = expandHome(text);
		if (text === "" || !isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`);
		// The plugin's own default lies in DSH's data, and going back to it stays possible: that
		// folder itself, not where a link put in its place leads.
		const fallback = resolve(defaultTeamFolder());
		const own = join(await realBeyond(dirname(fallback)), basename(fallback));
		const holdsData = async (path: string): Promise<boolean> => {
			const roots = await Promise.all(dataRoots().map(real));
			if (roots.some((data) => within(data, path))) return true;
			if (path === own && (await realBeyond(fallback)) === own) return false;
			return roots.some((data) => within(path, data));
		};
		// A folder to be made counts where it would be made: a link above it can lead into the data.
		if (await holdsData(await realBeyond(resolve(expanded))))
			throw new Error(`${text} holds DeepSeek Harness data, so it cannot be the team workspace`);
		await mkdir(expanded, { recursive: true });
		const path = await realpath(expanded);
		if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`);
		if (await holdsData(path))
			throw new Error(`${text} holds DeepSeek Harness data, so it cannot be the team workspace`);
		if (path === (await realTeam())) return path;
		const clash = await (rt.privateClash as (path: string) => Promise<{ name: string } | undefined>)(path);
		if (clash)
			throw new Error(
				`${text} is in or around the folder of ${clash.name}, a private Bot, so it cannot be the team workspace`,
			);
		const workspace = (await registry().resolveByPath(path)) ?? (await registry().create(path, "Ocean Crew"));
		state.workspaceId = workspace.id;
		await rt.save();
		return path;
	}

	// Every Session of a Bot: its own chat and its conversation in each of its groups.
	const sessionsOfBot = (botId: string): string[] =>
		[
			rt.chatOf(botId),
			...Object.values(state.rooms)
				.filter((room) => room.members.includes(botId))
				.map((room) => room.sessions?.[botId]),
		].filter((id): id is string => typeof id === "string");

	// A folder outside the team workspace widens where a Bot may write, so a Bot that
	// sets one for Bots whose writes are bounded by their folder asks the user first.
	// `sessions` are the Sessions that would work there; the default policy counts too,
	// since the Sessions made there later start under it. Throws when it is not allowed.
	async function approveFolder(
		exec: FolderExec,
		{ path, sessions = [], who }: { path?: string; sessions?: string[]; who: Who },
	): Promise<void> {
		const team = await realTeam();
		const policy = ctx.get?.("sandboxPolicy") as SandboxPolicyService | undefined;
		if (path === undefined || (team !== undefined && within(path, team))) return;
		if (policy !== undefined) {
			const agents = await Promise.all(
				sessions.map((id) => rt.resolveAgent(id) as Promise<AgentHandle | undefined>),
			);
			const modes = [policy.resolve(), ...agents.map((agent) => policy.resolve({ session: agent?.session }))].map(
				(entry) => entry.mode,
			);
			if (!modes.includes("workspace-write")) return;
		}
		// With no policy service a Session's bounds cannot be checked, so a folder outside
		// the workspace asks like a bounded one would; when nobody can be asked it throws.
		const approval = ctx.get?.("approval") as ApprovalService | undefined;
		const agent = exec.agent;
		if (approval === undefined || agent?.session === undefined)
			throw new Error(
				`Working in ${path} needs the user's approval, and there is no way to ask for it here, so nothing changed. The user can make this change in the settings.`,
			);
		const outcome = await approval.request({
			agent,
			toolName: exec.name,
			...(exec.callId !== undefined ? { callId: exec.callId } : {}),
			reason: `Let ${who.en} work in ${path}? Files there can then be changed.`,
			displayReason: {
				en: `Let ${who.en} work in ${path}? Files there can then be changed.`,
				zh: `允许${who.zh}在 ${path} 中工作吗？之后可以修改这个文件夹里的文件。`,
			},
			...(exec.signal !== undefined ? { signal: exec.signal } : {}),
		});
		if (outcome === "allowed-once") return;
		// An approval policy that never asks answers 'rejected' as well.
		throw new Error(
			outcome === "rejected"
				? `Working in ${path} was not allowed, so nothing changed. The user can make this change in the settings.`
				: outcome === "cancelled"
					? "The approval was cancelled, so nothing changed."
					: `Working in ${path} needs the user's approval, and no one could answer, so nothing changed. The user can make this change in the settings.`,
		);
	}

	const picker = (): FolderPicker | undefined => {
		try {
			return (ctx.get?.("directoryPicker") as DirectoryPickerService | undefined)?.capability();
		} catch {
			return undefined;
		}
	};

	async function folderEndpoint(
		endpoint: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		switch (endpoint) {
			case "folders": {
				// A copied team has its workspace registered at its first turn; until then it is the default.
				const team = teamFolder() ?? resolve(defaultTeamFolder());
				const known = new Map<string, string | undefined>();
				for (const workspace of registry().list?.() ?? []) {
					if (workspace.path !== undefined && workspace.path !== team) known.set(workspace.path, workspace.title);
				}
				for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms)]) {
					if (entry.workDir && !known.has(entry.workDir))
						known.set(entry.workDir, basename(entry.workDir) || entry.workDir);
				}
				const present = await Promise.all(
					[...known].map(async ([path, title]) => ((await isFolder(path)) ? { path, title } : undefined)),
				);
				const kind = picker()?.kind;
				return {
					team,
					picker: kind === "native" || kind === "browse" ? kind : null,
					folders: present.filter(
						(folder): folder is { path: string; title: string | undefined } => folder !== undefined,
					),
				};
			}
			case "folder-pick": {
				const native = picker();
				if (native?.kind !== "native" || native.pick === undefined)
					throw new Error("This DeepSeek Harness has no folder chooser");
				return await native.pick(AbortSignal.any([signal, AbortSignal.timeout(PICK_TIMEOUT_MS)]));
			}
			case "folder-list": {
				const browse = picker();
				if (browse?.kind !== "browse" || browse.list === undefined)
					throw new Error("This DeepSeek Harness cannot list folders");
				const listing = await browse.list(
					typeof body.path === "string" && body.path !== "" ? body.path : undefined,
					signal,
				);
				return {
					path: listing.path,
					home: listing.home,
					crumbs: listing.crumbs,
					entries: listing.entries,
					truncated: listing.truncated,
				};
			}
			default:
				throw new Error(`Unknown endpoint ${endpoint}`);
		}
	}

	Object.assign(rt, {
		teamFolder,
		defaultTeamFolder,
		workDirOf,
		sessionFolder,
		isFolder,
		real,
		realBeyond,
		folderAt,
		cleanWorkDir,
		workFolder,
		inData,
		setTeamWorkspace,
		sessionsOfBot,
		approveFolder,
		folderEndpoint,
	});
}
