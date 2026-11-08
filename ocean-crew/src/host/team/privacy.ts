// Private Bots. A private Bot reads the team like any Bot, but no other Bot reads it, and
// what it sends out waits for the user.
// privacy rules is here (who is private, which folders clash, what a change may make
// private, the kept-closed list), while the tool fence that checks file paths, shells and

import { resolve } from "node:path";
import type { Bot, BotId, TeamState } from "../../shared/state.ts";
import { within } from "../core/folders.ts";
import type { Runtime } from "../core/runtime.ts";

// What a deleted private Bot left behind: its id and the places kept closed. Stored in

interface PrivateArchive {
	id: BotId;
	name: string;
	workDir?: string;
	sessionIds?: string[];
	archivePath?: string;
	archiving?: boolean;
}

// The part of a closed Bot the checks here need.
interface ProtectedBot {
	id: BotId;
	name: string;
	workDir?: string;
}

// Windows and macOS file systems ignore case.
const fold = (text: string): string => (process.platform === "linux" ? text : text.toLowerCase());
const overlap = (a: string, b: string): boolean => within(a, b) || within(b, a);

export function install(rt: Runtime): void {
	const state: TeamState = rt.state;

	const isPrivate = (id?: string): boolean => rt.botOf(id)?.private === true;
	const archives = (): PrivateArchive[] => (state.privateArchives ?? []) as PrivateArchive[];
	const privateBots = (): Bot[] => Object.values(state.bots).filter((bot) => bot.private === true);
	// Deleting a private Bot does not make the files and memory it leaves behind public.
	const protectedBots = (): ProtectedBot[] => [
		...new Map<string, ProtectedBot>([...archives(), ...privateBots()].map((bot) => [bot.id, bot])).values(),
	];

	// The folder the team works in; `defaultTeamFolder` is always there to fall back to.
	const teamFolder = (): string => rt.teamFolder() ?? resolve(rt.defaultTeamFolder());

	// A path as it is and as the file system resolves it, folded for comparing. realBeyond
	// also resolves a link above a file that does not exist yet.
	const spellings = async (path: string): Promise<string[]> => [
		...new Set([fold(resolve(path)), fold(await rt.realBeyond(resolve(path)))]),
	];

	// A folder that a private Bot's folder would overlap, or that overlaps one.
	async function privateClash(
		path: string,
		{ except }: { except?: string } = {},
	): Promise<{ name: string } | undefined> {
		const keys = await spellings(path);
		for (const bot of protectedBots()) {
			if (bot.id === except || bot.workDir === undefined) continue;
			const dirs = await spellings(bot.workDir);
			if (keys.some((key) => dirs.some((dir) => overlap(key, dir)))) return { name: bot.name };
		}
		return undefined;
	}

	// Checks a change of `private` or of the folder of a Bot before it is written. A
	// private Bot's folder is no other Bot's, no group's and not the team workspace —
	// a member's own pick in a group counts as that member's folder — because DSH
	// cannot be told which files of a shared folder to hide.
	async function checkChange(
		bot: Bot,
		{ flag, moving = false, workDir }: { flag?: boolean; moving?: boolean; workDir?: string },
	): Promise<void> {
		const makes = flag === undefined ? bot.private === true : flag;
		const dir = moving ? workDir : bot.workDir;
		if (!makes) {
			const clash = moving && dir !== undefined ? await privateClash(dir, { except: bot.id }) : undefined;
			if (clash)
				throw new Error(
					`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`,
				);
			return;
		}
		if (rt.isMain(bot.id)) throw new Error(`${bot.name} is a Main Bot, so it cannot be private`);
		if (dir === undefined) throw new Error(`${bot.name} needs a folder of its own to be private`);
		if (Object.values(state.rooms).some((room) => room.members.includes(bot.id)))
			throw new Error(
				`${bot.name} is in a group chat, where every member reads what is said. Remove it from its groups first`,
			);
		const clash = await privateClash(dir, { except: bot.id });
		if (clash)
			throw new Error(
				`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`,
			);
		const keys = await spellings(dir);
		const others: Array<[string, string | undefined]> = [
			["the team workspace", teamFolder()],
			...Object.values(state.bots)
				.filter((other) => other.id !== bot.id && other.workDir !== undefined)
				.map((other): [string, string | undefined] => [`the folder of ${other.name}`, other.workDir]),
			...Object.values(state.rooms)
				.filter((room) => room.workDir !== undefined)
				.map((room): [string, string | undefined] => [`the folder of "${room.name}"`, room.workDir]),
			...Object.values(state.rooms).flatMap((room) =>
				Object.entries(room.memberDirs ?? {})
					.filter(([member, dir]) => room.members.includes(member) && dir !== null)
					.map(([member, dir]): [string, string | undefined] => [
						`the folder of ${rt.botOf(member)?.name ?? "a member"} in "${room.name}"`,
						dir ?? undefined,
					]),
			),
		];
		for (const [what, path] of others) {
			if (path === undefined) continue;
			const spelled = await spellings(path);
			if (keys.some((key) => spelled.some((other) => overlap(key, other))))
				throw new Error(
					`${dir} is in or around ${what}, so ${bot.name} cannot be private there. Give it a folder of its own`,
				);
		}
	}

	const checkNoPrivate = (ids: BotId[]): void => {
		const found = ids.map((id) => rt.botOf(id)).find((bot) => bot?.private === true);
		if (found)
			throw new Error(
				`${found.name} is a private Bot and cannot be in a group chat: what is said in a group is read by every member`,
			);
	};

	// Deleting a private Bot keeps its places closed (see roster.ts deleteBot); only the
	// user opens them again, one Bot at a time. The files stay where they are.
	async function releaseArchive(id: string): Promise<void> {
		const kept = archives();
		if (!kept.some((entry) => entry.id === id)) throw new Error("Nothing kept closed for this Bot");
		state.privateArchives = kept.filter((entry) => entry.id !== id);
		await rt.save();
	}

	// What the settings list shows. Session ids stay on the host.
	const archivesView = (): Array<{ id: BotId; name: string; workDir?: string }> =>
		archives().map(({ id, name, workDir }) => ({ id, name, ...(workDir === undefined ? {} : { workDir }) }));

	Object.assign(rt, {
		isPrivate,
		privateClash,
		checkPrivacyChange: checkChange,
		checkNoPrivate,
		releaseArchive,
		archivesView,
	});
}
