#!/usr/bin/env node

//   - client.js is exactly what src/client/ builds to now (via scripts/build-client.mjs),
//   - dist/ is exactly what the pinned TypeScript emits from src/ (recompiled to a temp
//     directory and compared byte for byte, unlike a modification-time check), and it
//     carries no declarations or source maps,
//   - every file the package claims to ship is present (package.json "files").
// Local verification only; not shipped. Usage:
//   node ocean-crew/dev/check-bundle.mjs [--skip-client] [--skip-dist]
// Exits 1 on a mismatch.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const plugin = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const skipClient = args.includes("--skip-client");
const skipDist = args.includes("--skip-dist");
const say = (...parts) => console.log(...parts);
const fail = (message) => {
	say(`FAIL  ${message}`);
	process.exitCode = 1;
	return false;
};
const pass = (message) => {
	say(`ok    ${message}`);
	return true;
};

// The files under a directory, as paths relative to it, sorted.
const filesOf = (dir) => {
	const found = [];
	const visit = (path) => {
		for (const name of readdirSync(path)) {
			const child = join(path, name);
			if (statSync(child).isDirectory()) visit(child);
			else found.push(relative(dir, child).split("\\").join("/"));
		}
	};
	if (existsSync(dir)) visit(dir);
	return found.sort();
};

const manifest = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8"));
let ok = true;

if (!skipClient) {
	const { bundleClient } = await import(pathToFileURL(join(plugin, "scripts", "build-client.mjs")).href);
	let fresh;
	try {
		fresh = await bundleClient();
	} catch (error) {
		ok = fail(`client bundle could not be built: ${error?.message ?? error}`) && ok;
		fresh = undefined;
	}
	if (fresh !== undefined) {
		const shipped = readFileSync(join(plugin, "client.js"), "utf8");
		if (shipped === fresh) pass("client.js matches src/client (fresh build is byte-identical)");
		else {
			const at = [...shipped].findIndex((ch, index) => ch !== fresh[index]);
			ok = fail(`client.js differs from src/client at byte ${at === -1 ? "end (length differs)" : at}; run: cd ocean-crew && npm run build`) && ok;
		}
	}
}

if (!skipDist) {
	const tsc = join(plugin, "..", "node_modules", "typescript", "bin", "tsc");
	const dist = join(plugin, "dist");
	if (!existsSync(join(dist, "index.js"))) {
		ok = fail("dist/index.js is missing; run: cd ocean-crew && npm run build") && ok;
	} else if (tsc === undefined) {
		ok = fail("no pinned TypeScript found; run: npm install at the repository root") && ok;
	} else {
		// The slim build ships JavaScript only: a stale tree from the mapping/declaration
		// days must fail here, not silently ride along.
		const shipped = filesOf(dist);
		const extras = shipped.filter((file) => !file.endsWith(".js"));
		ok = (extras.length === 0
			? pass(`dist/ ships JavaScript only (${shipped.length} files)`)
			: fail(`dist/ carries non-JavaScript files (${extras.slice(0, 5).join(", ")}${extras.length > 5 ? ", …" : ""}); run: rm -rf dist && cd ocean-crew && npm run build`)) && ok;
		const temp = mkdtempSync(join(tmpdir(), "ocean-crew-dist-"));
		try {
			const built = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", temp], {
				cwd: plugin,
				encoding: "utf8",
			});
			if (built.status !== 0) {
				ok = fail(`dist could not be rebuilt: ${(built.stderr || built.stdout || "").trim().split("\n").slice(-3).join(" / ")}`) && ok;
			} else {
				const fresh = filesOf(temp);
				const missing = fresh.filter((file) => !shipped.includes(file));
				const stale = shipped.filter((file) => !fresh.includes(file));
				const differing = fresh.filter(
					(file) => shipped.includes(file) && !readFileSync(join(temp, file)).equals(readFileSync(join(dist, file))),
				);
				if (missing.length > 0 || stale.length > 0 || differing.length > 0) {
					const first = differing[0] ?? missing[0] ?? stale[0];
					const kind = differing.length > 0 ? "differ" : missing.length > 0 ? "are missing" : "are stale";
					ok = fail(`dist/ does not match src/ (${first} and ${Math.max(differing.length + missing.length + stale.length - 1, 0)} more ${kind}); run: cd ocean-crew && npm run build`) && ok;
				} else {
					ok = pass(`dist/ matches src (fresh build is byte-identical, ${fresh.length} files)`) && ok;
				}
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}
}

for (const entry of manifest.files ?? []) {
	try {
		statSync(join(plugin, entry));
		pass(`ships ${entry}`);
	} catch {
		ok = fail(`the package declares ${entry} but the checkout has no such path`) && ok;
	}
}

// The license files ship inside the package and are the repository's own copies, not a
// second version that can drift.
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
	const top = join(plugin, "..", name);
	const inside = join(plugin, name);
	if (!existsSync(top) || !existsSync(inside)) continue;
	if (readFileSync(top).equals(readFileSync(inside))) pass(`${name} matches the repository copy`);
	else ok = fail(`${name} differs from the repository copy; keep them identical`) && ok;
}

say("");
say(ok ? "bundle: consistent" : "bundle: NOT consistent");
process.exitCode = ok ? 0 : 1;
