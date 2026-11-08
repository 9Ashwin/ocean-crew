// Builds `client.js`, the half DSH loads into the desktop window, from `src/client/`.
//
//   node scripts/build-client.mjs           writes client.js
//   node scripts/build-client.mjs --check   exits 1 when client.js differs from a fresh build
//
// client.js is a local build product (git ignores it) copied into the profile by
// dev/install-local.mjs after a build. DSH loads it as a classic script; the wrapper
// matches the plugin client entry the desktop expects:
// `require` resolves the shell-seeded platform modules (react, react-dom,
// @deepseek-ai/dsh-client-ui-primitives), which therefore stay external.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));

// A git install has this package's own dependencies; the development checkout keeps
// them at the repository root, so resolve locally first and fall back there.
const parentRequire = createRequire(join(PLUGIN, "..", "package.json"));
const loadEsbuild = async () => {
	try {
		return await import("esbuild");
	} catch {
		return parentRequire("esbuild");
	}
};
const { build } = await loadEsbuild();

const OUTPUT = join(PLUGIN, "client.js");
const PLATFORM_MODULES = ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"];

// The blueprint views are a package dependency the plugin installs with; a development
// checkout keeps them at the repository root, so either place resolves the same files.
const DEEP_VIEW = [join(PLUGIN, "node_modules", "deep-view"), join(PLUGIN, "..", "node_modules", "deep-view")].find(
	(candidate) => existsSync(candidate),
);
const deepViewPlugin = {
	name: "deep-view",
	setup(builder) {
		builder.onResolve({ filter: /^deep-view\/(core|react)$/ }, (args) => ({
			path: join(DEEP_VIEW, "src", args.path.slice("deep-view/".length), "index.js"),
		}));
	},
};
// A plugin dependency resolves from this package first; the development checkout keeps
// the same version at the repository root.
const localPackage = createRequire(import.meta.url);
const installedPackage = {
	name: "installed-packages",
	setup(builder) {
		builder.onResolve({ filter: /^[a-z@][^/]*(\/[^/]+)?$/ }, (args) => {
			if (PLATFORM_MODULES.includes(args.path) || args.path.startsWith("deep-view/")) return undefined;
			try {
				return { path: localPackage.resolve(args.path) };
			} catch {
				try {
					return { path: parentRequire.resolve(args.path) };
				} catch {
					return undefined;
				}
			}
		});
	},
};

export async function bundleClient() {
	const result = await build({
		// Region comments name sources relative to the plugin, wherever the script runs from.
		absWorkingDir: PLUGIN,
		entryPoints: ["src/client/index.ts"],
		bundle: true,
		format: "cjs",
		platform: "browser",
		target: "es2022",
		external: PLATFORM_MODULES,
		// Every source declaration ships, used or not, as in the hand-written bundle.
		treeShaking: false,
		// Readable for debugging in the browser: no minification, and Chinese text stays text.
		charset: "utf8",
		write: false,
		logLevel: "silent",
		plugins: [deepViewPlugin, installedPackage],
	});
	if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join("\n")}`);
	return [
		"// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.",
		"// The bundle inlines Deep View (Apache-2.0); see THIRD_PARTY_NOTICES.md.",
		"window.__ModuleLoader__.load({",
		"  id: 'ocean-crew',",
		"  factory: (require) => {",
		"const module = { exports: {} }",
		result.outputFiles[0].text.trimEnd(),
		// The loader gets a plain exports object tagged as a module, as the desktop's own
		// preset emits, rather than esbuild's getter-based `__esModule` object.
		"return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })",
		"  },",
		"})",
		"",
	].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const next = await bundleClient();
	if (process.argv.includes("--check")) {
		let current = null;
		try {
			current = readFileSync(OUTPUT, "utf8");
		} catch {
			/* missing counts as stale */
		}
		if (current !== next) {
			console.error("client.js is stale: run `npm run build` and commit the result");
			process.exit(1);
		}
	} else {
		writeFileSync(OUTPUT, next);
	}
}
