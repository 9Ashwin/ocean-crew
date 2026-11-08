// Updates: compare this package's version with the newest release where it was installed
// from (the npm registry, or a GitHub tag for a versioned git install) and, when the user
// asks, reinstall it through DSH's plugin manager. A new version runs from the next DSH
// start. A linked or local checkout is never offered one.
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "./runtime.ts";

/** The manifest fields the update path reads; `rt.packageInfo` may carry another one (tests, a repackaged host). */
export interface PackageInfo {
	name: string;
	version: string;
	repository?: string | { url?: string; directory?: string };
	homepage?: string;
	dsBot?: { verifiedDsh?: string; minBot?: string };
}

const MANIFEST: PackageInfo = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as PackageInfo;
	} catch {
		return { name: "ocean-crew", version: "0.0.0" };
	}
})();

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
export const MIRROR_REGISTRY = "https://registry.npmmirror.com/";
// Every window that opens asks; within this long the last answer stands.
export const CHECK_TTL_MS = 10 * 60_000;
export const FETCH_TIMEOUT_MS = 8000;
// The first check waits until the host has settled its own start.
const STARTUP_DELAY_MS = 15_000;
const VERSION = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.]+)?$/;

/** A release version without its `v` and build metadata, or null. */
export const cleanVersion = (value: unknown): string | null => VERSION.exec(String(value ?? "").trim())?.[1] ?? null;

/** Whether version `a` is newer than `b` (semver order, prereleases before their release). */
export function newer(a: unknown, b: unknown): boolean {
	const parse = (value: unknown): { nums: number[]; pre: string | null } => {
		const [core, pre] = (cleanVersion(value) ?? "0.0.0").split(/-(.*)/s);
		return { nums: core.split(".").map(Number), pre: pre ?? null };
	};
	const x = parse(a);
	const y = parse(b);
	for (let index = 0; index < 3; index++) if (x.nums[index] !== y.nums[index]) return x.nums[index] > y.nums[index];
	if (x.pre === y.pre) return false;
	if (x.pre === null) return true;
	if (y.pre === null) return false;
	return x.pre.localeCompare(y.pre, "en", { numeric: true }) > 0;
}

/** How the profile installed this package, from the plugin manager's `source` spec. */
export type InstallSource =
	| { kind: "registry" }
	| { kind: "git"; owner?: string; repo?: string; ref?: string; rest: string[] }
	| { kind: "path" }
	| { kind: "tarball" }
	| { kind: "unknown" };

/**
 * How the profile installed this package, from the plugin manager's `source` spec:
 * `registry` (name@range), `git` (with `owner`, `repo`, the version `ref` and the other
 * fragment parts when it pins a GitHub tag), `path` (link:, file: or a folder),
 * `tarball`, or `unknown`.
 */
export function sourceOf(spec: unknown): InstallSource {
	const text = typeof spec === "string" ? spec.trim() : "";
	if (text === "") return { kind: "unknown" };
	if (/^(link|file):/i.test(text) || /^([a-z]:[\\/]|[\\/]|~|\.)/i.test(text)) return { kind: "path" };
	const github =
		/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.*))?$/i.exec(
			text,
		);
	const gitLike = /^(git\+|git:|git@|github:|gitlab:|bitbucket:)/i.test(text) || /\.git(#|$)/i.test(text);
	if (github && (gitLike || !text.startsWith("@"))) {
		const parts = (github[3] ?? "").split("&").filter(Boolean);
		const ref = parts.find((part) => !part.includes(":")) ?? "";
		return {
			kind: "git",
			owner: github[1],
			repo: github[2],
			...(cleanVersion(ref) ? { ref } : {}),
			rest: parts.filter((part) => part !== ref),
		};
	}
	if (gitLike) return { kind: "git", rest: [] };
	if (/^https?:/i.test(text)) return { kind: "tarball" };
	return { kind: "registry" };
}

const normalizeRegistry = (url: unknown): string => `${String(url).trim().replace(/\/+$/, "")}/`;
export const encodeName = (name: string): string =>
	name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

export const fetchJson = async (url: string, headers: Record<string, string> = {}): Promise<any> => {
	const response = await fetch(url, {
		headers: { accept: "application/json", ...headers },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.json();
};

/** The registries the plugin manager installs from, in its order. */
export async function registryPlan(config: { updateRegistry?: string }, manager: any): Promise<string[]> {
	if (typeof config.updateRegistry === "string" && config.updateRegistry !== "")
		return [normalizeRegistry(config.updateRegistry)];
	const configured = await Promise.resolve(manager?.registries?.()).catch(() => null);
	if (!configured) return [OFFICIAL_REGISTRY, MIRROR_REGISTRY];
	const fallbacks: string[] = (configured.fallbackRegistries ?? []).map(normalizeRegistry);
	const own = configured.resolved ? normalizeRegistry(configured.resolved) : null;
	const first = configured.registry ? normalizeRegistry(configured.registry) : (own ?? OFFICIAL_REGISTRY);
	const isPublic = first === OFFICIAL_REGISTRY || fallbacks.includes(first);
	return isPublic ? [...new Set([first, ...fallbacks])] : [first];
}

// The plugin manager's `source` for this package; DSH releases before it reported one
// leave the profile's own dependency entry to say the same.
export async function installSpecOf(ctx: any, pkg: PackageInfo = MANIFEST): Promise<string | undefined> {
	const manager = ctx.get?.("pluginManager");
	const bundles = await Promise.resolve(manager?.listBundles?.()).catch(() => null);
	const own = Array.isArray(bundles) ? bundles.find((bundle: any) => bundle.name === pkg.name) : undefined;
	if (typeof own?.source === "string") return own.source;
	const dir = ctx.get?.("profileContext")?.dir;
	if (typeof dir !== "string") return undefined;
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies?.[pkg.name];
	} catch {
		return undefined;
	}
}

/** The public repository the releases live in, for tags and the "what's new" link. */
export const repoSlug = (pkg: PackageInfo = MANIFEST): string | null =>
	/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(
		String(pkg.repository && typeof pkg.repository === "object" ? pkg.repository.url : (pkg.repository ?? "")),
	)?.[1] ?? null;

const repoUrl = (pkg: PackageInfo): string | null => {
	const repo = repoSlug(pkg);
	return repo ? `https://github.com/${repo}` : null;
};
const releasesUrl = (pkg: PackageInfo): string | null => {
	const repo = repoUrl(pkg);
	return repo ? `${repo}/releases` : (pkg.homepage ?? null);
};

export const STARS_TTL_MS = 60 * 60_000;

// DSH serves each client bundle under the revision recorded when the graph was composed,
// and the browser keeps that response immutable. Replacing client.js on disk therefore
// needs the host to publish a new revision before an open window can see the new build;
// `clientModules` is the service DSH's own HMR watcher uses. A host without it reports
// false and the page falls back to a reload.
export function reloadClient(ctx: any): { rebuilt: boolean; revision?: string } {
	const clientModules = ctx?.get?.("clientModules");
	if (typeof clientModules?.rebuilt !== "function") return { rebuilt: false };
	const revision = clientModules.rebuilt(MANIFEST.name);
	return typeof revision === "string" && revision !== "" ? { rebuilt: true, revision } : { rebuilt: false };
}

/** The update view the client reads. */
export interface UpdateView {
	name: string;
	current: string;
	latest: string | null;
	source: string;
	notesUrl: string | null;
	repoUrl: string | null;
	enabled: boolean;
	checkedAt: number;
	phase: string;
	installed: string | null;
	error: string | null;
	available: boolean;
}

export function install(rt: Runtime): void {
	const { ctx, config } = rt;
	const pkg = (rt.packageInfo as PackageInfo | undefined) ?? MANIFEST;
	const enabled = config.updateCheck !== false;
	const manager = (): any => ctx.get?.("pluginManager");

	const status: {
		name: string;
		current: string;
		latest: string | null;
		source: string;
		notesUrl: string | null;
		checkedAt: number;
		phase: string;
		installed: string | null;
		error: string | null;
	} = {
		name: pkg.name,
		current: pkg.version,
		latest: null,
		source: "unknown",
		notesUrl: releasesUrl(pkg),
		checkedAt: 0,
		phase: "idle",
		installed: null,
		error: null,
	};
	// Where the newest version was found, and the spec that installs it.
	let target: { version: string; spec: string; registry?: string } | null = null;
	let checking: Promise<void> | null = null;

	// A remove-and-install update under hot reload drops this host with its bundle; a note
	// in the data folder carries the result to the start that follows it.
	const markerPath = typeof rt.home === "string" ? join(rt.home, "update.json") : null;
	if (markerPath !== null && existsSync(markerPath)) {
		let marker: any = null;
		try {
			marker = JSON.parse(readFileSync(markerPath, "utf8"));
		} catch (error) {
			rt.warn("ocean-crew: could not read the update note: %s", (error as Error)?.message ?? error);
		}
		if (marker === null) {
			try {
				unlinkSync(markerPath);
			} catch {
				// Gone is what we want.
			}
		} else if (marker.to === pkg.version) {
			Object.assign(status, { phase: "updated", installed: pkg.version });
			try {
				unlinkSync(markerPath);
			} catch {
				// Gone is what we want.
			}
		} else if (typeof marker.error === "string" || marker.from !== pkg.version) {
			rt.warn(
				"ocean-crew: the update to %s did not finish: %s",
				marker.to ?? "a newer version",
				typeof marker.error === "string" ? marker.error.slice(0, 600) : "the install did not complete",
			);
			try {
				unlinkSync(markerPath);
			} catch {
				// Gone is what we want.
			}
		}
		// A clean note on the version that wrote it stays: a reload can still be running the
		// old modules (the hoisted profile layout keeps one path), and the next start that
		// runs the new code reports the update then.
	}

	const view = (): UpdateView => ({
		name: status.name,
		current: status.current,
		latest: status.latest,
		source: status.source,
		notesUrl: status.notesUrl,
		repoUrl: repoUrl(pkg),
		enabled,
		checkedAt: status.checkedAt,
		phase: status.phase,
		installed: status.installed,
		error: status.error,
		available:
			status.phase !== "installed" &&
			status.phase !== "updated" &&
			target !== null &&
			status.latest !== null &&
			newer(status.latest, status.current),
	});

	// Asked only while the About page is open, so a closed page never calls GitHub. A
	// failed answer keeps the last count and is asked again next time.
	let stars: { count: number | null; at: number } = { count: null, at: 0 };
	let starring: Promise<void> | null = null;
	async function repoStars(): Promise<number | null> {
		const repo = repoSlug(pkg);
		if (repo === null) return null;
		if (Date.now() - stars.at < STARS_TTL_MS) return stars.count;
		starring ??= fetchJson(`https://api.github.com/repos/${repo}`, { "user-agent": `${pkg.name}/${pkg.version}` })
			.then((info: any) => {
				if (Number.isInteger(info?.stargazers_count))
					stars = { count: info.stargazers_count as number, at: Date.now() };
			})
			.catch((error: any) => rt.warn("ocean-crew: star count failed: %s", error?.message ?? error))
			.finally(() => {
				starring = null;
			});
		await starring;
		return stars.count;
	}

	async function newestFromRegistry(): Promise<{ version: string; spec: string; registry: string } | null> {
		for (const registry of await registryPlan(config, manager())) {
			try {
				const version = cleanVersion((await fetchJson(`${registry}${encodeName(pkg.name)}/latest`)).version);
				if (version) return { version, spec: `${pkg.name}@${version}`, registry };
			} catch {
				// Unreachable, or no copy there yet: ask the next one.
			}
		}
		return null;
	}

	async function newestFromGitHub(source: {
		owner?: string;
		repo?: string;
		ref?: string;
		rest: string[];
	}): Promise<{ version: string; spec: string } | null> {
		if (!source.ref) return null;
		const release = await fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, {
			"user-agent": `${pkg.name}/${pkg.version}`,
		});
		const version = cleanVersion(release?.tag_name);
		if (!version) return null;
		// The API answers through redirects, so the release's html_url names the
		// repository's current address; the install moves to it.
		const current = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\//.exec(release.html_url ?? "");
		const [owner, repo] = current ? [current[1], current[2]] : [source.owner, source.repo];
		const fragment = [release.tag_name, ...source.rest].join("&");
		return { version, spec: `github:${owner}/${repo}#${fragment}` };
	}

	async function runCheck(): Promise<void> {
		// The desktop app updates as a whole, with this package inside it.
		const source =
			process.env.MINI_BOT_APP === "1" ? ({ kind: "app" } as const) : sourceOf(await installSpecOf(ctx, pkg));
		status.source = source.kind;
		let found: { version: string; spec: string; registry?: string } | null = null;
		try {
			if (source.kind === "registry") found = await newestFromRegistry();
			else if (source.kind === "git")
				found = await newestFromGitHub(source as { owner?: string; repo?: string; ref?: string; rest: string[] });
		} catch (error) {
			rt.warn("ocean-crew: update check failed: %s", (error as Error)?.message ?? error);
		}
		status.checkedAt = Date.now();
		// Nothing found now (a linked checkout, a moved tag, an unreachable registry)
		// retires the version a check before it found; offering it would install over a
		// source that never updates.
		if (found === null) {
			status.latest = null;
			target = null;
			return;
		}
		status.latest = found.version;
		target = newer(found.version, status.current) ? found : null;
		// The note that reported the last update is a one-time message; a newer release
		// found later in the same run still offers itself.
		if (target !== null && status.phase === "updated") status.phase = "idle";
	}

	/** Ask where the package came from for its newest version; a fresh check ignores the last answer. */
	async function check({ fresh = false }: { fresh?: boolean } = {}): Promise<UpdateView> {
		if (!enabled) return view();
		if (checking) return checking.then(() => view());
		if (!fresh && Date.now() - status.checkedAt < CHECK_TTL_MS) return view();
		checking = runCheck().finally(() => {
			checking = null;
		});
		await checking;
		return view();
	}

	/** Start reinstalling the newest version; the answer comes back through `check`. */
	function start(): UpdateView {
		if (status.phase === "installing") return view();
		if (target === null) throw new Error("No Ocean Crew update is available");
		const chosen = target;
		const service = manager();
		if (typeof service?.installBundle !== "function")
			throw new Error("The DSH plugin manager is not available in this profile");
		Object.assign(status, { phase: "installing", error: null });
		const options = chosen.registry ? { registry: chosen.registry } : {};
		// Removing this bundle disposes our context before the promise answers, so the
		// continuation uses plain fs for the note and a guarded logger.
		const note = (template: string, ...args: unknown[]): void => {
			try {
				rt.warn(template, ...args);
			} catch {
				// Our context is disposed.
			}
		};
		const mark = (error?: unknown): void => {
			if (markerPath === null) return;
			try {
				writeFileSync(
					markerPath,
					JSON.stringify({
						from: pkg.version,
						to: chosen.version,
						spec: chosen.spec,
						startedAt: new Date().toISOString(),
						...(error === undefined ? {} : { error: String(error).slice(0, 600) }),
					}),
				);
			} catch {
				// A note that cannot be written just is not there.
			}
		};
		// A refused removal leaves this version running, with nothing for a later start to report.
		const unmark = (): void => {
			if (markerPath !== null) {
				try {
					unlinkSync(markerPath);
				} catch {
					// Already gone.
				}
			}
		};
		void Promise.resolve(service.installBundle(chosen.spec, options))
			.then(async (result: any) => {
				if (result?.error?.code !== "already-installed") return result;
				// With HMR the plugin manager refuses to install a package the profile already
				// depends on: remove the bundle (which unloads this host) and install it again.
				if (typeof service.removeBundle !== "function") return { error: { code: "not-removable" } };
				// Asked before removal drops this host: the spec that puts the old version back.
				// A registry spec is a range that can resolve to the failed release again, so pin
				// the version that is actually running.
				const oldSpec = await Promise.resolve(installSpecOf(ctx, pkg)).catch(() => undefined);
				const previous =
					typeof oldSpec === "string" && sourceOf(oldSpec).kind === "registry"
						? `${pkg.name}@${pkg.version}`
						: oldSpec;
				mark();
				const removed = await Promise.resolve(service.removeBundle(pkg.name)).catch((error: any) => {
					unmark();
					throw error;
				});
				if (removed?.error) {
					unmark();
					return { error: removed.error };
				}
				// The bundle is gone now; a failed install leaves no Ocean Crew unless the old one goes back.
				const restore = async (failed: string): Promise<string> => {
					if (typeof previous !== "string" || previous === "") return failed;
					const back = await Promise.resolve(
						service.installBundle(
							previous,
							sourceOf(previous).kind === "registry" && chosen.registry ? { registry: chosen.registry } : {},
						),
					).catch((error: any) => ({ error: { code: error?.message ?? "restore failed" } }));
					if (back?.error) {
						note(
							"ocean-crew: could not reinstall %s after the failed update: %s",
							previous,
							back.error.diagnostic ?? back.error.code,
						);
						return failed;
					}
					return `${failed}; ${previous} was reinstalled`;
				};
				try {
					const again = await service.installBundle(chosen.spec, options);
					// A failure also arrives as an application state with no error; the result
					// check below rejects every one of those, so restore sees the same failures.
					if (again?.error || !["applied", "restart-required"].includes(again?.application))
						mark(
							await restore(
								again?.error?.diagnostic ?? again?.error?.code ?? `install ${again?.application ?? "failed"}`,
							),
						);
					return again;
				} catch (error: any) {
					mark(await restore(error?.message ?? String(error)));
					throw error;
				}
			})
			.then((result: any) => {
				if (result?.error || !["applied", "restart-required"].includes(result?.application)) {
					throw new Error(
						result?.error?.diagnostic ?? result?.error?.code ?? `install ${result?.application ?? "failed"}`,
					);
				}
				Object.assign(status, { phase: "installed", installed: cleanVersion(result.version) ?? chosen.version });
			})
			.catch((error: any) => {
				note("ocean-crew: update to %s failed: %s", chosen.spec, error?.message ?? error);
				Object.assign(status, { phase: "failed", error: String(error?.message ?? error).slice(0, 600) });
			});
		return view();
	}

	if (enabled) {
		ctx.effect(() => {
			const timer = setTimeout(() => {
				void check();
			}, STARTUP_DELAY_MS);
			// A pending first check never keeps the process alive.
			timer.unref?.();
			return () => clearTimeout(timer);
		}, "ocean-crew: update check");
	}

	// A local install replaces client.js under a running host; publish the new bundle
	// revision once the writer has settled, so open windows swap it in without a DSH
	// restart. One file written rarely, so stat polling is enough.
	ctx.effect(() => {
		const bundle = new URL("../../../client.js", import.meta.url);
		const snapshot = (): string => {
			try {
				const info = statSync(bundle);
				return `${info.mtimeMs}:${info.size}`;
			} catch {
				return "";
			}
		};
		let seen = snapshot();
		let settle: ReturnType<typeof setTimeout> | undefined;
		const poll = setInterval(() => {
			const now = snapshot();
			if (now === "" || now === seen) return;
			seen = now;
			clearTimeout(settle);
			settle = setTimeout(() => {
				reloadClient(ctx);
			}, 500);
			settle.unref?.();
		}, 1_500);
		poll.unref?.();
		return () => {
			clearInterval(poll);
			clearTimeout(settle);
		};
	}, "ocean-crew: client bundle watch");

	Object.assign(rt, { updateCheck: check, updateStart: start, updateView: view, repoStars });
}
