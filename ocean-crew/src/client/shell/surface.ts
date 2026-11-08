// The plugin's surface mode: 'bot' paints the whole team interface over the shell, 'agent'
// withdraws every replacement so the shell's own interface comes back. `plain` marks a
// Bot-mode view whose main view is a plain session — only the conversation replacements
// come off then, the shell stays.
import { STORAGE } from "../core/storage.ts";

export type SurfaceMode = "bot" | "agent";
export type SurfaceGroupName = "shell" | "conversation";

export interface SurfaceGroups {
	shell: boolean;
	conversation: boolean;
}

export function groupsFor({ mode, plain = false }: { mode: SurfaceMode; plain?: boolean }): SurfaceGroups {
	return { shell: mode === "bot", conversation: mode === "bot" && !plain };
}

const GROUPS: readonly SurfaceGroupName[] = ["shell", "conversation"];

type Disposer = () => unknown;
/** A step mounts one thing when called and returns that thing's disposer. */
type Step = () => Disposer | undefined;

/** Lists the steps of one group; each step mounts one thing and returns its disposer. */
export type SurfaceInstall = Record<SurfaceGroupName, () => ReadonlyArray<Step | undefined>>;

export interface SurfaceApi {
	reconcile(wanted: Partial<Record<SurfaceGroupName, boolean>>): void;
	remount(group: string, wanted?: Partial<Record<SurfaceGroupName, boolean>>): void;
	dispose(): void;
}

// Runs every disposer even when one throws, last installed first: later entries lean on

function disposeAll(disposers: Array<Disposer | undefined>, label: string): void {
	for (const dispose of [...disposers].reverse()) {
		try {
			dispose?.();
		} catch (error) {
			console.warn(`[ocean-crew] ${label}`, error);
		}
	}
}

// Keeps the mounted groups in step with `groupsFor`. The conversation group sits on the
// shell's styles and tokens, so it comes off before the shell and goes on after. A group's
// list is cleared before it is disposed, so a throw never makes a later reconcile believe
// the group is mounted.
//
// A group goes on whole or not at all: when a step throws, the steps before it are
// withdrawn, so Agent mode never keeps a half-installed Bot skin.
export function surfaceGroups(
	install: SurfaceInstall,
	{ onError }: { onError?: (group: string, error: unknown) => void } = {},
): SurfaceApi {
	const mounted: Record<SurfaceGroupName, Array<Disposer | undefined>> = { shell: [], conversation: [] };
	const withdraw = (group: SurfaceGroupName): void => {
		const disposers = mounted[group];
		mounted[group] = [];
		disposeAll(disposers, `withdraw ${group}`);
	};
	const mount = (group: SurfaceGroupName): boolean => {
		const disposers: Array<Disposer | undefined> = [];
		try {
			for (const step of install[group]()) {
				const dispose = step?.();
				if (dispose !== undefined) disposers.push(dispose);
			}
			mounted[group] = disposers;
			return true;
		} catch (error) {
			disposeAll(disposers, `roll back ${group}`);
			console.warn(`[ocean-crew] install ${group}`, error);
			onError?.(group, error);
			return false;
		}
	};
	let lastWanted: Partial<Record<SurfaceGroupName, boolean>> = {};
	const api: SurfaceApi = {
		reconcile(wanted) {
			lastWanted = wanted;
			for (const group of [...GROUPS].reverse()) if (!wanted[group]) withdraw(group);
			for (const group of GROUPS) {
				if (!wanted[group] || mounted[group].length > 0) continue;
				if (!mount(group)) break;
			}
		},
		// A step can go on with nothing actually contributed — a slot inject whose callback
		// threw inside the host still returns its disposer. remount takes the group off and
		// lets the reconcile put it back, so a caller that notices the contribution is
		// missing can retry instead of trusting `mounted`. Groups that lean on it (the
		// conversation on the shell's styles) come off first and go back only through the
		// reconcile — a failed remount never leaves one stranded.
		remount(group, wanted = lastWanted) {
			if (!GROUPS.includes(group as SurfaceGroupName)) return;
			for (const later of GROUPS.slice(GROUPS.indexOf(group as SurfaceGroupName) + 1)) withdraw(later);
			withdraw(group as SurfaceGroupName);
			api.reconcile(wanted);
		},
		dispose() {
			for (const group of [...GROUPS].reverse()) withdraw(group);
		},
	};
	return api;
}

/** A slot/source entry as the shell lists it. */
export interface PriorityEntry {
	options?: { priority?: number; key?: string; id?: string };
}

// The priority that puts an entry below every other entry of its cell (lowest renders).
// Another plugin that shadows the same cell at the same priority would make the
// registration throw; in a Bot surface the cell is Ocean Crew's.
export function freePriority(
	entries: readonly PriorityEntry[],
	{ priority, key, id }: { priority?: number; key?: string; id?: string },
): number | undefined {
	if (priority === undefined) return undefined;
	const taken = entries
		.filter(
			(entry) => (key === undefined || entry.options?.key === key) && (id === undefined || entry.options?.id === id),
		)
		.map((entry) => (entry.options?.priority ?? 0) - 1);
	return Math.min(priority, ...taken);
}

/** The slice of `localStorage` this module uses. */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const defaultStorage = (): StorageLike | undefined =>
	(globalThis as unknown as { localStorage?: StorageLike }).localStorage;

export function readMode(storage?: StorageLike): SurfaceMode {
	try {
		return (storage ?? defaultStorage())?.getItem(STORAGE.surface) === "agent" ? "agent" : "bot";
	} catch {
		return "bot";
	}
}

export function writeMode(mode: SurfaceMode, storage?: StorageLike): void {
	try {
		(storage ?? defaultStorage())?.setItem(STORAGE.surface, mode);
	} catch {
		/* storage unavailable */
	}
}
