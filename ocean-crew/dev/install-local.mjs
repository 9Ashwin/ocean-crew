#!/usr/bin/env node
// Copy this checkout's build into the running DSH profile's ocean-crew plugin.
//
// DSH boots plugins from the profile's node_modules, so the published release keeps
// winning until its files are replaced. This script copies the publishable files of
// ocean-crew/ (package.json "files") after backing the installed copy up, and touches
// the profile patch so a running DSH recomposes the plugin graph. It never edits the
// profile's package.json, never restarts DSH and never touches bot state or secrets.
//
// it is not shipped.
//
// Usage:
//   node ocean-crew/dev/install-local.mjs [--profile <profile dir>] [--dry-run] [--no-reload] [--json]
//
// Defaults: DSH_PROFILE_DIR, else $DSH_HOME/profiles/${DSH_PROFILE:-desktop}, else

//
// Before installing, build the checkout: `cd ocean-crew && npm run build`.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
};
const dryRun = flag("dry-run");
const json = flag("json");
const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileByName = (name) => join(home, "profiles", name);
const defaultProfile =
	process.env.DSH_PROFILE_DIR ?? profileByName(process.env.DSH_PROFILE === undefined ? "desktop" : process.env.DSH_PROFILE);
const profile = resolve(value("profile", defaultProfile));
const target = join(profile, "node_modules", "ocean-crew");

const say = (...parts) => {
	if (!json) console.log(...parts);
};
const fail = (message) => {
	console.error(`install-local: ${message}`);
	process.exit(1);
};
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = async (path) => stat(path).then(() => true, () => false);

if (!(await exists(join(profile, "package.json")))) fail(`no DSH profile at ${profile} (set --profile or DSH_PROFILE_DIR)`);

const manifest = await readJson(join(plugin, "package.json"));
if (manifest.name !== "ocean-crew") fail(`${plugin} is not the ocean-crew package`);

// The checkout must be built first: the profile loads package.json "main" and the
// client bundle beside it, and neither is in git.
const main = join(plugin, String(manifest.main ?? "./dist/index.js"));
if (!(await exists(main))) fail(`no build at ${main}; run: cd ocean-crew && npm run build`);
if (!(await exists(join(plugin, "client.js")))) fail("no client.js; run: cd ocean-crew && npm run build");

// A profile installed before the package was renamed has no directory under the new
// name. The profile dependency must already point at `ocean-crew`; this script only
// creates the directory it copies into, it never edits profile/package.json.
const fresh = !(await exists(target));
let installed;
if (fresh) {
	installed = { version: "none (new install)" };
	if (!dryRun) await mkdir(target, { recursive: true });
	say(`install-local: no installed copy at ${target}; creating it`);
} else {
	installed = await readJson(join(target, "package.json"));
	if (installed.name !== "ocean-crew") fail(`${target} is not the ocean-crew plugin`);
	// The installed copy is a release tarball; a symlink here would mean a package
	// manager link and replacing its files would write into the package store.
	if ((await stat(target)).isSymbolicLink()) fail(`${target} is a symlink; update the profile dependency instead`);
}

const files = ["package.json", ...(manifest.files ?? [])];
let branch = "unknown";
try {
	branch = execFileSync("git", ["-C", plugin, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
	/* not a git checkout: the copy still works */
}
say(`install-local: ${plugin} @ ${branch} -> ${target}`);
say(`install-local: installed ${installed.version}, this checkout ${manifest.version}${dryRun ? " (dry run)" : ""}`);

if (!dryRun && !fresh) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const backup = `${target}.bak-${stamp}`;
	await cp(target, backup, { recursive: true, verbatimSymlinks: true });
	say(`install-local: backed up to ${backup}`);
}

// Publishable files only: the plugin never loads test/ or dev/ from the profile.
const missing = [];
for (const entry of files) {
	const from = join(plugin, entry);
	if (!(await exists(from))) {
		missing.push(entry);
		continue;
	}
	const to = join(target, entry);
	if (!dryRun) {
		await rm(to, { recursive: true, force: true });
		await mkdir(dirname(to), { recursive: true });
		await cp(from, to, { recursive: true, verbatimSymlinks: true });
	}
	say(`install-local: copied ${entry}`);
}

// Dependencies ship with the profile's install, not with this checkout: say which ones
// the installed plugin may not resolve, and how to add them, instead of copying a

const unresolved = [];
for (const name of Object.keys(manifest.dependencies ?? {})) {
	const from = join(plugin, "node_modules", name);
	if (!(await exists(from))) unresolved.push(name);
}
if (unresolved.length > 0) {
	say(`install-local: dependencies not in this checkout: ${unresolved.join(", ")}`);
	say(`install-local: add them to the profile if the plugin fails to load:`);
	say(`install-local:   cd "${profile}" && pnpm add ${unresolved.join(" ")}`);
}

// DSH's HMR watches this profile patch file and recomposes the plugin graph when it
// changes, which is also when it replaces plugins whose files changed on disk. Writing
// the same bytes triggers that recomposition, so a running DSH serves the changed
// client bundle; host modules still load at start.
const patchFile = join(profile, "cordis.patch.yml");
if (flag("no-reload")) {
	say("install-local: skipped the plugin reload (--no-reload); restart DSH to load this build");
} else if (await exists(patchFile)) {
	if (!dryRun) {
		const bytes = await readFile(patchFile);
		await writeFile(patchFile, bytes);
	}
	say("install-local: touched the profile patch; DSH should reload the plugin within a few seconds");
} else {
	say(`install-local: no ${patchFile}; restart DSH to load this build`);
}

if (!dryRun) {
	// A quick sanity check: the entry point the profile loader imports must be there.
	const entry = String(manifest.main ?? "./dist/index.js").replace(/^\.\//, "");
	if (!(await exists(join(target, entry)))) fail(`${entry} is missing after the copy`);
	if (missing.length > 0) say(`install-local: warning: the checkout has no ${missing.join(", ")} (build it first)`);
}

if (json) {
	console.log(JSON.stringify({ branch, profile, target, copied: files.length, unresolved, dryRun }));
} else {
	say("");
	say("install-local: done. Restart DSH Desktop to load this build.");
	say(`install-local: profile: ${profile}`);
	say(`install-local: plugin:  ${target}`);
	if (fresh) say("install-local: fresh install; the profile dependency must be ocean-crew, then reload the window.");
	else say(`install-local: backups are next to the plugin: ${target}.bak-<timestamp>`);
	if (dryRun) say("install-local: dry run only; nothing was written");
}
