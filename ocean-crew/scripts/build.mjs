#!/usr/bin/env node
// Builds the plugin. `npm run build` type-checks and emits dist/ with the repository
// toolchain; `npm run prepare` (git installs) runs the same emit without the type check,
// because a plugin install has no DSH harness declarations to resolve.
//
//   node scripts/build.mjs            dist/ (tsc -p tsconfig.build.json) + client.js
//   node scripts/build.mjs --install  dist/ (tsc -p tsconfig.install.json) + client.js
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const install = process.argv.includes("--install");

// The compiler is a devDependency of this package and, in the development checkout, of
// the repository root; a git install only has the first.
const locate = (name, ...rest) => {
	const local = join(PLUGIN, "node_modules", name, ...rest);
	if (existsSync(local)) return local;
	const shared = join(PLUGIN, "..", "node_modules", name, ...rest);
	return existsSync(shared) ? shared : undefined;
};
const tsc = locate("typescript", "bin", "tsc");
if (tsc === undefined) {
	console.error("no TypeScript compiler found; run npm install (or the repository root's npm install)");
	process.exit(1);
}
const config = install ? "tsconfig.install.json" : "tsconfig.build.json";
const compiled = spawnSync(process.execPath, [tsc, "-p", config], { cwd: PLUGIN, stdio: "inherit" });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const { bundleClient } = await import(pathToFileURL(join(PLUGIN, "scripts", "build-client.mjs")).href);
writeFileSync(join(PLUGIN, "client.js"), await bundleClient());
