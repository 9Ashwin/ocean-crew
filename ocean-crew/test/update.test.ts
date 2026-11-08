// Update behavior: where the package came from decides where a newer version is looked
// for; a check is cached, a reinstall runs through DSH's plugin manager, and a note in the
// data folder carries the result across the reload that removes this host. The DSH update
// offers only the release this bot verified, and swaps it with npm on an npm install.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { install as installDshUpdate } from "../src/host/core/dsh-update.ts";
import { cleanVersion, install, newer, type PackageInfo, reloadClient, sourceOf } from "../src/host/core/update.ts";
import { fakeContext } from "./fake-ctx.ts";

const PKG: PackageInfo = {
	name: "ocean-crew",
	version: "0.4.0",
	repository: { url: "git+https://github.com/9Ashwin/ocean-crew.git" },
};
const APP_BOOT = "@deepseek-ai/dsh-app-boot";
const flush = async (): Promise<void> => {
	for (let index = 0; index < 16; index += 1) await Promise.resolve();
};
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function scriptFetch(answers: Record<string, any>) {
	const fetched: string[] = [];
	globalThis.fetch = (async (url: any) => {
		fetched.push(String(url));
		const answer = answers[String(url)];
		if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) };
		if (answer instanceof Error) throw answer;
		return { ok: true, status: 200, json: async () => answer };
	}) as any;
	return fetched;
}

interface StartOptions {
	source?: string;
	registries?: any;
	answers?: Record<string, any>;
	result?: any;
	remove?: any;
	config?: Record<string, unknown>;
	profileDir?: string;
	home?: string;
	pkg?: PackageInfo;
}

// The update module alone, on a stub plugin manager and a scripted fetch.
function start({
	source,
	registries,
	answers = {},
	result = { application: "restart-required" },
	remove = { application: "applied" },
	config = {},
	profileDir,
	home,
	pkg = PKG,
}: StartOptions = {}) {
	const fetched = scriptFetch(answers);
	const installs: any[] = [];
	const removes: string[] = [];
	const warnings: unknown[][] = [];
	const pluginManager = {
		listBundles: async () => [
			{ name: "other", source: "other@^1.0.0" },
			...(source === undefined ? [] : [{ name: PKG.name, source }]),
		],
		registries: async () =>
			registries ?? {
				registry: null,
				fallbackRegistries: ["https://registry.npmmirror.com/"],
				resolved: "https://registry.npmjs.org/",
			},
		installBundle: async (spec: string, options: any) => {
			installs.push([spec, options]);
			return typeof result === "function" ? result(installs.length) : result;
		},
		removeBundle: async (name: string) => {
			removes.push(name);
			return typeof remove === "function" ? remove() : remove;
		},
	};
	const services: Record<string, any> = { pluginManager };
	if (profileDir !== undefined) services.profileContext = { dir: profileDir };
	const ctx = fakeContext({ services }) as any;
	ctx.effect = () => {};
	const rt: any = { ctx, config, home, warn: (...args: unknown[]) => warnings.push(args), packageInfo: pkg };
	install(rt);
	return { rt, fetched, installs, removes, warnings };
}

test("versions compare in semver order and lose their v and build metadata", () => {
	assert.equal(cleanVersion("v1.2.3+build.5"), "1.2.3");
	assert.equal(cleanVersion("latest"), null);
	assert.equal(newer("0.2.0", "0.1.9"), true);
	assert.equal(newer("0.10.0", "0.9.0"), true);
	assert.equal(newer("1.0.0", "1.0.0"), false);
	assert.equal(newer("1.0.0", "1.0.0-beta.2"), true);
	assert.equal(newer("1.0.0-beta.10", "1.0.0-beta.2"), true);
	assert.equal(newer("0.1.0", "0.2.0"), false);
});

test("the install source decides where a newer version is looked for", () => {
	assert.deepEqual(sourceOf("ocean-crew@^0.1.0"), { kind: "registry" });
	assert.deepEqual(sourceOf("@scope/ocean-crew@latest"), { kind: "registry" });
	// A profile's own dependency entry says the same without the package name.
	assert.deepEqual(sourceOf("^0.1.0"), { kind: "registry" });
	assert.deepEqual(sourceOf("npm:ocean-crew@^0.1.0"), { kind: "registry" });
	assert.deepEqual(sourceOf("link:E:/项目库/My Bots/ocean-crew"), { kind: "path" });
	assert.deepEqual(sourceOf("/home/user/ocean-crew"), { kind: "path" });
	assert.deepEqual(sourceOf("github:9Ashwin/ocean-crew#v0.1.0&path:/earlier"), {
		kind: "git",
		owner: "9Ashwin",
		repo: "ocean-crew",
		ref: "v0.1.0",
		rest: ["path:/earlier"],
	});
	assert.deepEqual(sourceOf("git+https://github.com/9Ashwin/ocean-crew.git#main"), {
		kind: "git",
		owner: "9Ashwin",
		repo: "ocean-crew",
		rest: [],
	});
	assert.deepEqual(sourceOf("https://example.com/ocean-crew-0.1.0.tgz"), { kind: "tarball" });
	assert.deepEqual(sourceOf(undefined), { kind: "unknown" });
});

test("a registry install finds the newest version on the next registry and installs it from there", async () => {
	const { rt, fetched, installs } = start({
		source: `${PKG.name}@^${PKG.version}`,
		answers: {
			[`https://registry.npmjs.org/${PKG.name}/latest`]: new Error("offline"),
			[`https://registry.npmmirror.com/${PKG.name}/latest`]: { version: "9.0.0" },
		},
		result: { application: "restart-required", version: "9.0.0" },
	});
	const view = await rt.updateCheck();
	assert.deepEqual(fetched, [
		`https://registry.npmjs.org/${PKG.name}/latest`,
		`https://registry.npmmirror.com/${PKG.name}/latest`,
	]);
	assert.equal(view.available, true);
	assert.equal(view.latest, "9.0.0");
	assert.equal(view.current, PKG.version);
	assert.equal(view.source, "registry");
	assert.equal(view.notesUrl, "https://github.com/9Ashwin/ocean-crew/releases");
	assert.equal(rt.updateStart().phase, "installing");
	await flush();
	assert.deepEqual(installs, [[`${PKG.name}@9.0.0`, { registry: "https://registry.npmmirror.com/" }]]);
	const done = await rt.updateCheck();
	assert.equal(done.phase, "installed");
	assert.equal(done.installed, "9.0.0");
	assert.equal(done.available, false);
});

test("a private registry of pnpm's own is asked alone, and an answer stands for a while", async () => {
	const { rt, fetched } = start({
		source: `${PKG.name}@^${PKG.version}`,
		registries: {
			registry: null,
			fallbackRegistries: ["https://registry.npmmirror.com/"],
			resolved: "https://npm.corp.example/",
		},
		answers: { [`https://npm.corp.example/${PKG.name}/latest`]: { version: PKG.version } },
	});
	assert.equal((await rt.updateCheck()).available, false);
	assert.deepEqual(fetched, [`https://npm.corp.example/${PKG.name}/latest`]);
	await rt.updateCheck();
	assert.equal(fetched.length, 1);
	await rt.updateCheck({ fresh: true });
	assert.equal(fetched.length, 2);
});

test("a versioned GitHub install follows the latest release tag and keeps its path", async () => {
	const { rt, installs } = start({
		source: "github:9Ashwin/ocean-crew#v0.1.0&path:/earlier",
		answers: { "https://api.github.com/repos/9Ashwin/ocean-crew/releases/latest": { tag_name: "v9.1.0" } },
	});
	const view = await rt.updateCheck();
	assert.equal(view.available, true);
	assert.equal(view.latest, "9.1.0");
	rt.updateStart();
	await flush();
	assert.deepEqual(installs, [["github:9Ashwin/ocean-crew#v9.1.0&path:/earlier", {}]]);
});

test("a versioned GitHub install follows the release to the repository's current address", async () => {
	const { rt, installs } = start({
		source: "github:old-owner/retired-dsbot#v0.1.0&path:/earlier",
		answers: {
			"https://api.github.com/repos/old-owner/retired-dsbot/releases/latest": {
				tag_name: "v9.1.0",
				html_url: "https://github.com/9Ashwin/ocean-crew/releases/tag/v9.1.0",
			},
		},
	});
	assert.equal((await rt.updateCheck()).latest, "9.1.0");
	rt.updateStart();
	await flush();
	assert.deepEqual(installs, [["github:9Ashwin/ocean-crew#v9.1.0&path:/earlier", {}]]);
});

test("a linked checkout, an unversioned git install, or a disabled check never asks the network", async () => {
	for (const source of [`link:/work/${PKG.name}`, "github:9Ashwin/ocean-crew#main", undefined]) {
		const { rt, fetched } = start({ source });
		const view = await rt.updateCheck();
		assert.equal(view.available, false);
		assert.deepEqual(fetched, []);
		assert.throws(() => rt.updateStart(), /No Ocean Crew update/);
	}
	const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, config: { updateCheck: false } });
	assert.equal((await rt.updateCheck({ fresh: true })).available, false);
	assert.deepEqual(fetched, []);
});

test("in the desktop app, which updates as a whole, it never asks the network and offers nothing", async (t) => {
	process.env.MINI_BOT_APP = "1";
	t.after(() => {
		delete process.env.MINI_BOT_APP;
	});
	const { rt, fetched } = start({
		source: `${PKG.name}@^${PKG.version}`,
		answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: "9.0.0" } },
	});
	const view = await rt.updateCheck({ fresh: true });
	assert.equal(view.source, "app");
	assert.equal(view.available, false);
	assert.deepEqual(fetched, []);
	assert.throws(() => rt.updateStart(), /No Ocean Crew update/);
});

test("the star count comes from the repository, is kept for an hour, and survives a failed answer", async () => {
	const repo = "https://api.github.com/repos/9Ashwin/ocean-crew";
	const answers: Record<string, any> = { [repo]: new Error("offline") };
	const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, answers });
	assert.equal(rt.updateView().repoUrl, "https://github.com/9Ashwin/ocean-crew");
	assert.equal(await rt.repoStars(), null);
	answers[repo] = { stargazers_count: 42 };
	assert.equal(await rt.repoStars(), 42);
	answers[repo] = new Error("offline");
	assert.equal(await rt.repoStars(), 42);
	assert.deepEqual(fetched, [repo, repo]);
});

test("without a source from the plugin manager, the profile's own dependency entry decides", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ocean-crew-update-"));
	t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [PKG.name]: `^${PKG.version}` } }));
	const { rt } = start({
		profileDir: dir,
		answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: "9.0.0" } },
	});
	const view = await rt.updateCheck();
	assert.equal(view.source, "registry");
	assert.equal(view.available, true);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [PKG.name]: "link:/work/ocean-crew" } }));
	assert.equal((await rt.updateCheck({ fresh: true })).source, "path");
});

test("a check that finds nothing clears the version a check before it found", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ocean-crew-update-"));
	t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	const setSource = (source: string) =>
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [PKG.name]: source } }));
	setSource(`^${PKG.version}`);
	const latest = `https://registry.npmjs.org/${PKG.name}/latest`;
	const answers: Record<string, any> = { [latest]: { version: "9.0.0" } };
	const { rt } = start({ profileDir: dir, answers });
	const offered = await rt.updateCheck();
	assert.equal(offered.available, true);
	assert.equal(offered.latest, "9.0.0");
	// The profile now links a local checkout: the old registry offer must go.
	setSource("link:/work/ocean-crew");
	const linked = await rt.updateCheck({ fresh: true });
	assert.equal(linked.available, false);
	assert.equal(linked.latest, null);
	assert.throws(() => rt.updateStart(), /No Ocean Crew update/);
	// Back on the registry with no copy answering: the offer stays cleared.
	delete answers[latest];
	setSource(`^${PKG.version}`);
	const gone = await rt.updateCheck({ fresh: true });
	assert.equal(gone.available, false);
	assert.equal(gone.latest, null);
});

test("a failed install reports why and can be tried again", async () => {
	let attempt = 0;
	const { rt, installs } = start({
		source: `${PKG.name}@^${PKG.version}`,
		config: { updateRegistry: "https://registry.example" },
		answers: { [`https://registry.example/${PKG.name}/latest`]: { version: "9.0.0" } },
		result: () =>
			++attempt === 1
				? { application: "failed", error: { code: "incompatible-version", diagnostic: "needs a newer DSH" } }
				: { application: "restart-required", version: "9.0.0" },
	});
	await rt.updateCheck();
	rt.updateStart();
	await flush();
	const failed = await rt.updateCheck();
	assert.equal(failed.phase, "failed");
	assert.equal(failed.error, "needs a newer DSH");
	assert.equal(failed.available, true);
	rt.updateStart();
	await flush();
	assert.equal((await rt.updateCheck()).phase, "installed");
	assert.equal(installs.length, 2);
	assert.deepEqual(installs[0][1], { registry: "https://registry.example/" });
});

// Under HMR the manager refuses a spec the profile already depends on with
// 'already-installed'; the update then removes the bundle and installs it again, leaving a
// note at <home>/update.json for the start that reloads the new copy.
const NOTE = `${PKG.name}@9.0.0`;
const newHome = (t: any): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-update-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};
const noteIn = (home: string): any => JSON.parse(readFileSync(join(home, "update.json"), "utf8"));

test("a plain refusal or success needs no removal and writes no note", async (t) => {
	const home = newHome(t);
	const { rt, installs, removes } = start({
		source: `${PKG.name}@^${PKG.version}`,
		config: { updateRegistry: "https://registry.example" },
		answers: { [`https://registry.example/${PKG.name}/latest`]: { version: "9.0.0" } },
		result: { application: "restart-required", version: "9.0.0" },
		home,
	});
	await rt.updateCheck();
	rt.updateStart();
	await flush();
	assert.equal((await rt.updateCheck()).phase, "installed");
	assert.equal(installs.length, 1);
	assert.deepEqual(removes, []);
	assert.equal(existsSync(join(home, "update.json")), false);
});

test("an already-installed refusal removes the bundle, reinstalls and leaves a note", async (t) => {
	const home = newHome(t);
	const calls: string[] = [];
	const { rt, installs, removes } = start({
		source: `${PKG.name}@^${PKG.version}`,
		config: { updateRegistry: "https://registry.example" },
		answers: { [`https://registry.example/${PKG.name}/latest`]: { version: "9.0.0" } },
		result: (count: number) => {
			calls.push(`install${count}`);
			return count === 1 ? { error: { code: "already-installed" } } : { application: "applied", version: "9.0.0" };
		},
		remove: { application: "applied" },
		home,
	});
	await rt.updateCheck();
	rt.updateStart();
	await flush();
	assert.deepEqual(calls, ["install1", "install2"]);
	assert.deepEqual(installs, [
		[NOTE, { registry: "https://registry.example/" }],
		[NOTE, { registry: "https://registry.example/" }],
	]);
	assert.deepEqual(removes, [PKG.name]);
	// The note was written before the removal — and still carries no error on success.
	const note = noteIn(home);
	assert.equal(note.from, PKG.version);
	assert.equal(note.to, "9.0.0");
	assert.equal(note.spec, NOTE);
	assert.equal(typeof note.startedAt, "string");
	assert.equal(note.error, undefined);
	assert.equal((await rt.updateCheck()).phase, "installed");
});

test("a failed removal fails the update without a second install", async (t) => {
	const home = newHome(t);
	const { rt, installs, removes } = start({
		source: `${PKG.name}@^${PKG.version}`,
		config: { updateRegistry: "https://registry.example" },
		answers: { [`https://registry.example/${PKG.name}/latest`]: { version: "9.0.0" } },
		result: (count: number) =>
			count === 1 ? { error: { code: "already-installed" } } : { application: "applied", version: "9.0.0" },
		remove: { error: { code: "bundle-in-use" } },
		home,
	});
	await rt.updateCheck();
	rt.updateStart();
	await flush();
	assert.equal(installs.length, 1);
	assert.deepEqual(removes, [PKG.name]);
	const view = await rt.updateCheck();
	assert.equal(view.phase, "failed");
	assert.equal(view.error, "bundle-in-use");
	assert.equal(existsSync(join(home, "update.json")), false);
});

test("a failed reinstall writes its reason into the note", async (t) => {
	const home = newHome(t);
	const { rt } = start({
		source: `${PKG.name}@^${PKG.version}`,
		config: { updateRegistry: "https://registry.example" },
		answers: { [`https://registry.example/${PKG.name}/latest`]: { version: "9.0.0" } },
		result: (count: number) =>
			count === 1
				? { error: { code: "already-installed" } }
				: { error: { code: "operation-error", diagnostic: "pnpm: tarball 500" } },
		home,
	});
	await rt.updateCheck();
	rt.updateStart();
	await flush();
	assert.equal((await rt.updateCheck()).phase, "failed");
	const note = noteIn(home);
	assert.equal(note.to, "9.0.0");
	assert.equal(note.error, "pnpm: tarball 500");
});

test("a reinstall refused by an application state also puts the old version back", async (t) => {
	const home = newHome(t);
	const { rt, installs } = start({
		source: `${PKG.name}@^${PKG.version}`,
		config: { updateRegistry: "https://registry.example" },
		answers: { [`https://registry.example/${PKG.name}/latest`]: { version: "9.0.0" } },
		result: (count: number) =>
			count === 1
				? { error: { code: "already-installed" } }
				: count === 2
					? { application: "failed" }
					: { application: "applied", version: PKG.version },
		home,
	});
	await rt.updateCheck();
	rt.updateStart();
	await flush();
	assert.equal(installs.length, 3);
	assert.equal(installs[2][0], `${PKG.name}@${PKG.version}`);
	const note = noteIn(home);
	assert.equal(note.error, `install failed; ${PKG.name}@${PKG.version} was reinstalled`);
	assert.equal((await rt.updateCheck()).phase, "failed");
});

test("a newer release is offered in the run that reported the last update", async (t) => {
	const home = newHome(t);
	writeFileSync(
		join(home, "update.json"),
		JSON.stringify({
			from: "0.2.0",
			to: PKG.version,
			spec: `${PKG.name}@${PKG.version}`,
			startedAt: new Date().toISOString(),
		}),
	);
	const { rt } = start({
		home,
		source: `${PKG.name}@^${PKG.version}`,
		answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: "9.0.0" } },
	});
	assert.equal(rt.updateView().phase, "updated");
	const view = await rt.updateCheck({ fresh: true });
	assert.equal(view.available, true);
	assert.equal(view.phase, "idle");
});

test("the note for the version now running shows the update once and is consumed", async (t) => {
	const home = newHome(t);
	writeFileSync(
		join(home, "update.json"),
		JSON.stringify({
			from: "0.2.0",
			to: PKG.version,
			spec: `${PKG.name}@${PKG.version}`,
			startedAt: new Date().toISOString(),
		}),
	);
	const { rt, warnings } = start({ home });
	const view = rt.updateView();
	assert.equal(view.phase, "updated");
	assert.equal(view.installed, PKG.version);
	assert.equal(view.available, false);
	assert.equal(existsSync(join(home, "update.json")), false);
	assert.deepEqual(warnings, []);
});

test("a note for another version warns and is consumed", async (t) => {
	const home = newHome(t);
	writeFileSync(
		join(home, "update.json"),
		JSON.stringify({
			from: "0.2.0",
			to: "9.0.0",
			spec: NOTE,
			startedAt: new Date().toISOString(),
			error: "pnpm: tarball 500",
		}),
	);
	const { rt, warnings } = start({ home });
	assert.equal(rt.updateView().phase, "idle");
	assert.equal(warnings.length, 1);
	assert.match(String(warnings[0][1] ?? warnings[0][0]), /9\.0\.0|pnpm/);
	assert.equal(existsSync(join(home, "update.json")), false);
});

test("a clean note on the version that wrote it waits for a start that runs the target", async (t) => {
	const home = newHome(t);
	writeFileSync(
		join(home, "update.json"),
		JSON.stringify({ from: PKG.version, to: "9.0.0", spec: NOTE, startedAt: new Date().toISOString() }),
	);
	const { rt, warnings } = start({ home });
	assert.equal(rt.updateView().phase, "idle");
	assert.deepEqual(warnings, []);
	assert.equal(existsSync(join(home, "update.json")), true);
});

test("a note that cannot be read is warned about and deleted", async (t) => {
	const home = newHome(t);
	writeFileSync(join(home, "update.json"), "not json {");
	const { rt, warnings } = start({ home });
	assert.equal(rt.updateView().phase, "idle");
	assert.equal(warnings.length, 1);
	assert.equal(existsSync(join(home, "update.json")), false);
});

test("a rebuilt client bundle publishes a new revision through clientModules", () => {
	const calls: string[] = [];
	const ctx = {
		get: (name: string) =>
			name === "clientModules"
				? {
						rebuilt: (id: string) => {
							calls.push(id);
							return "rev-2";
						},
					}
				: undefined,
	};
	assert.deepEqual(reloadClient(ctx), { rebuilt: true, revision: "rev-2" });
	assert.deepEqual(calls, ["ocean-crew"]);
});

test("without a clientModules service the reload reports that a page reload is needed", () => {
	assert.deepEqual(reloadClient({ get: () => undefined }), { rebuilt: false });
	assert.deepEqual(reloadClient(undefined), { rebuilt: false });
	assert.deepEqual(reloadClient({ get: () => ({ rebuilt: () => undefined }) }), { rebuilt: false });
});

// --- the DSH update -----------------------------------------------------------------

function fakeChild(code: number) {
	const child: any = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	queueMicrotask(() => child.emit("close", code));
	return child;
}

interface DshStartOptions {
	current?: string | null;
	source?: string;
	answers?: Record<string, any>;
	app?: boolean;
	spawn?: any;
	config?: Record<string, unknown>;
	profileDir?: string;
}

// The dsh-update module alone: a stub loader says the running DSH version, a stub plugin
// manager says how the bot was installed, and fetch is scripted.
function startDsh({
	current = "0.1.0",
	source,
	answers = {},
	app = false,
	spawn,
	config = {},
	profileDir,
}: DshStartOptions = {}) {
	const fetched = scriptFetch(answers);
	const spawns: any[][] = [];
	const warnings: unknown[][] = [];
	const loader =
		current === null
			? undefined
			: {
					import: async (name: string) => (name === APP_BOOT ? { getDshRuntimeVersion: () => current } : {}),
					unwrapExports: (exports: any) => exports,
				};
	const profileContext = app ? { dir: profileDir, packageManager: { command: "pnpm" } } : { dir: profileDir };
	const pluginManager = {
		listBundles: async () => (source === undefined ? [] : [{ name: PKG.name, source }]),
		registries: async () => ({
			registry: null,
			fallbackRegistries: ["https://registry.npmmirror.com/"],
			resolved: "https://registry.npmjs.org/",
		}),
	};
	const services: Record<string, any> = { loader, pluginManager, profileContext };
	const ctx = fakeContext({ services }) as any;
	ctx.effect = () => {};
	const rt: any = {
		ctx,
		config,
		warn: (...args: unknown[]) => warnings.push(args),
		packageInfo: PKG,
		dshSpawn:
			spawn ??
			((command: string, argv: string[]) => {
				spawns.push([command, argv]);
				return fakeChild(0);
			}),
	};
	installDshUpdate(rt);
	return { rt, fetched, spawns, warnings };
}

const registryLatest = (dsBot: any) => ({
	[`https://registry.npmjs.org/${PKG.name}/latest`]: { version: PKG.version, dsBot },
});
const githubLatest = (tag: string, manifest: any) => ({
	"https://api.github.com/repos/9Ashwin/ocean-crew/releases/latest": { tag_name: tag },
	[`https://raw.githubusercontent.com/9Ashwin/ocean-crew/${tag}/ocean-crew/package.json`]: manifest,
});

test("dsh update: the newest released bot declares the verified DSH, offered to an older npm install", async () => {
	const { rt, spawns } = startDsh({
		source: `${PKG.name}@^${PKG.version}`,
		answers: registryLatest({ verifiedDsh: "9.9.9" }),
	});
	const view = await rt.dshUpdateCheck();
	assert.equal(view.current, "0.1.0");
	assert.equal(view.verified, "9.9.9");
	assert.equal(view.kind, "npm");
	assert.equal(view.available, true);
	assert.equal(rt.dshUpdateStart().phase, "installing");
	await flush();
	assert.deepEqual(
		spawns.map(([, argv]) => argv),
		[["install", "-g", "@deepseek-ai/dsh@9.9.9"]],
	);
	assert.equal((await rt.dshUpdateCheck()).phase, "installed");
	assert.equal((await rt.dshUpdateCheck()).installed, "9.9.9");
});

test("dsh update: a verified version older than the running one is still offered, for a broken release", async () => {
	const { rt } = startDsh({
		current: "9.9.9",
		source: `${PKG.name}@^${PKG.version}`,
		answers: registryLatest({ verifiedDsh: "0.2.1-alpha.1" }),
	});
	const view = await rt.dshUpdateCheck();
	assert.equal(view.verified, "0.2.1-alpha.1");
	assert.equal(view.available, true);
});

test("dsh update: without a verified version nothing is offered, and the running one offers nothing", async () => {
	const none = startDsh({ source: `${PKG.name}@^${PKG.version}` });
	const view = await none.rt.dshUpdateCheck();
	assert.equal(view.verified, null);
	assert.equal(view.available, false);
	const same = startDsh({ source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: "0.1.0" }) });
	assert.equal((await same.rt.dshUpdateCheck()).available, false);
	assert.throws(() => same.rt.dshUpdateStart(), /No DSH update/);
});

test("dsh update: a minBot newer than the running bot gates the update until the bot goes first", async () => {
	const { rt } = startDsh({
		source: `${PKG.name}@^${PKG.version}`,
		answers: registryLatest({ verifiedDsh: "9.9.9", minBot: "9.9.9" }),
	});
	const view = await rt.dshUpdateCheck();
	assert.equal(view.available, false);
	assert.equal(view.blockedBy, "9.9.9");
	assert.throws(() => rt.dshUpdateStart(), /No DSH update/);
});

test("dsh update: a git or local install asks the public repository's latest release for its declaration", async () => {
	for (const source of ["github:9Ashwin/ocean-crew#v0.1.0&path:/earlier", "link:/work/ocean-crew", undefined]) {
		const { rt, fetched } = startDsh({
			source,
			answers: githubLatest("v9.0.0", { dsBot: { verifiedDsh: "8.8.8" } }),
		});
		assert.equal((await rt.dshUpdateCheck()).verified, "8.8.8");
		assert.deepEqual(fetched, [
			"https://api.github.com/repos/9Ashwin/ocean-crew/releases/latest",
			"https://raw.githubusercontent.com/9Ashwin/ocean-crew/v9.0.0/ocean-crew/package.json",
		]);
	}
});

test("dsh update: a bundled package manager means the app owns the runtime: report only, never install", async () => {
	const { rt } = startDsh({
		app: true,
		source: `${PKG.name}@^${PKG.version}`,
		answers: registryLatest({ verifiedDsh: "9.9.9" }),
	});
	const view = await rt.dshUpdateCheck();
	assert.equal(view.kind, "app");
	assert.equal(view.available, true);
	assert.throws(() => rt.dshUpdateStart(), /updates with its app/);
});

test("dsh update: the desktop app pins its DSH: it reports the running version, asks no network and offers nothing", async (t) => {
	process.env.MINI_BOT_APP = "1";
	t.after(() => {
		delete process.env.MINI_BOT_APP;
	});
	const { rt, fetched } = startDsh({
		app: true,
		source: `${PKG.name}@^${PKG.version}`,
		answers: registryLatest({ verifiedDsh: "9.9.9" }),
	});
	const view = await rt.dshUpdateCheck({ fresh: true });
	assert.equal(view.current, "0.1.0");
	assert.equal(view.kind, "app");
	assert.equal(view.verified, null);
	assert.equal(view.available, false);
	assert.deepEqual(fetched, []);
});

test("dsh update: without a running version there is nothing to compare against", async () => {
	const { rt } = startDsh({ current: null, source: `${PKG.name}@^${PKG.version}` });
	const view = await rt.dshUpdateCheck();
	assert.equal(view.current, null);
	assert.equal(view.available, false);
});

test("dsh update: a failed npm install reports why and can be tried again", async () => {
	let attempt = 0;
	const { rt } = startDsh({
		source: `${PKG.name}@^${PKG.version}`,
		answers: registryLatest({ verifiedDsh: "9.9.9" }),
		spawn: () => {
			attempt += 1;
			return fakeChild(attempt === 1 ? 1 : 0);
		},
	});
	await rt.dshUpdateCheck();
	rt.dshUpdateStart();
	await flush();
	const failed = await rt.dshUpdateCheck();
	assert.equal(failed.phase, "failed");
	assert.match(failed.error, /npm exited 1/);
	assert.equal(failed.available, true);
	rt.dshUpdateStart();
	await flush();
	assert.equal((await rt.dshUpdateCheck()).phase, "installed");
});
