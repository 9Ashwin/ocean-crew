#!/usr/bin/env node
// It boots the DSH from
// dev/harness with a throwaway home under the repository root, loads the
// ocean-crew build from ocean-crew/dist through a linked profile, starts the scripted
// mock model (dev/mock-llm.mjs), and checks the plugin end to end at the HTTP
// level:
//   - the composed profile graph resolves the plugin (dump-config),
//   - the plugin applies: POST /api/bot answers `state` and GET /api/bot/feed sends its
//     hello event,
//   - a Bot can be created, answers its greeting turn, and is deleted again.
// All data stays in <repo>/.dsh-test-<name>; the processes are stopped and the home is
// removed afterwards (--keep-data keeps it). Nothing here touches the real ~/.dsh or the
// running DSH Desktop. Local verification only; not shipped.
//
// Usage:
//   node ocean-crew/dev/smoke.mjs [--name smoke] [--port 3097] [--mock-port 3098]
//                                 [--harness <dir>] [--keep-data] [--skip-build-check]
//
// Before running: cd ocean-crew && npm run build   (dist/ and client.js must be current)
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(plugin);
const args = process.argv.slice(2);
const value = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);
const NAME = value("name", "plugin-smoke");
const WEB_PORT = Number(value("port", 3097));
const MOCK_PORT = Number(value("mock-port", 3098));
const HARNESS = resolve(value("harness", join(repo, "dev", "harness")));
const KEEP = flag("keep-data");
const QUIET_MS = 1500;
const STEP_TIMEOUT_MS = 120_000;

const home = join(repo, `.dsh-test-${NAME}`);
const profile = join(home, "profiles", "web");
const webLog = join(home, "web.log");
const mockOut = join(home, "mock.out");
const base = `http://127.0.0.1:${WEB_PORT}`;
const dshBin = join(HARNESS, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const mockScript = join(plugin, "dev", "mock-llm.mjs");

const results = [];
let cookie = "";
const children = [];
const say = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

const check = (ok, title, detail = "") => {
	results.push({ ok: Boolean(ok), title, detail });
	say(`${ok ? "ok" : "FAIL"}  ${title}${detail === "" ? "" : ` — ${detail}`}`);
	return Boolean(ok);
};

const spawnGroup = (command, argv, env, outFile) => {
	const child = spawn(command, argv, {
		detached: true,
		stdio: ["ignore", outFile, outFile],
		env: { ...process.env, ...env },
	});
	children.push(child);
	return child;
};

const stopGroup = async (child) => {
	if (child === undefined || child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		try {
			process.kill(-child.pid, 0);
		} catch {
			return;
		}
		await sleep(200);
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		/* already gone */
	}
};

const portOpen = (port) =>
	new Promise((done) => {
		const socket = connect({ host: "127.0.0.1", port }, () => {
			socket.destroy();
			done(true);
		});
		socket.on("error", () => done(false));
		socket.setTimeout(500, () => {
			socket.destroy();
			done(false);
		});
	});

const mockLogEntries = () => {
	try {
		return readFileSync(join(home, "mock.jsonl"), "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const stateFile = () => readJson(join(home, "bot", "state.json"));

async function waitFor(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function login() {
	const log = readFileSync(webLog, "utf8");
	const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${WEB_PORT}/\\?token=[^\\s]+`))?.[0];
	if (!url) throw new Error("no login URL in web.log");
	const response = await fetch(url, { redirect: "manual" });
	const cookies = response.headers.getSetCookie().map((entry) => entry.split(";")[0]);
	if (cookies.length === 0) throw new Error(`login returned no cookie (${response.status})`);
	return cookies.join("; ");
}

async function api(endpoint, payload = {}) {
	const response = await fetch(`${base}/api/bot`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ endpoint, payload }),
	});
	const result = await response.json();
	if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`);
	return result.value;
}

// The first SSE frames of the feed, until its hello event arrives.
async function feedHello(timeoutMs = 8000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${base}/api/bot/feed`, { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal });
		if (response.status !== 200) throw new Error(`feed answered ${response.status}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (text.length < 4096) {
			const { value: chunk, done } = await reader.read();
			if (done) break;
			text += decoder.decode(chunk, { stream: true });
			if (text.includes("event: hello")) break;
		}
		await reader.cancel().catch(() => {});
		return text;
	} finally {
		clearTimeout(timer);
	}
}

function prepareProfile() {
	mkdirSync(profile, { recursive: true });
	writeFileSync(
		join(profile, "package.json"),
		JSON.stringify(
			{
				name: "dsh-profile-web",
				private: true,
				dependencies: { "ocean-crew": `link:${plugin}` },
				dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ocean-crew"] } },
			},
			null,
			2,
		),
	);
	writeFileSync(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
	const installed = spawnSync("pnpm", ["install"], { cwd: profile, env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
	if (installed.status === 0) return true;
	// No package manager: a plain link is enough for DSH's module resolution.
	const target = join(profile, "node_modules", "ocean-crew");
	spawnSync("ln", ["-sfn", plugin, target]);
	say("smoke: pnpm install failed; linked the plugin by hand");
	const lines = String(installed.stderr ?? "").split("\n").slice(0, 3).join("\n");
	if (lines !== "") say(lines);
	return existsSync(target);
}

// node_modules); the reference checkout's installed copies are the same versions the JS
// build runs on. Link the ones the manifest declares that do not resolve, so the plugin
// imports them in the bench. Generated links only; nothing is copied or committed.
function ensurePluginDeps() {
	const manifest = readJson(join(plugin, "package.json"));
	const modules = join(plugin, "node_modules");
	mkdirSync(modules, { recursive: true });
	const missing = [];
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		let resolvable = false;
		try {
			createRequire(join(plugin, "package.json")).resolve(name);
			resolvable = true;
		} catch (error) {
			resolvable = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
		}
		if (resolvable) continue;
		const source = join(repo, "node_modules", name);
		const target = join(modules, name);
		if (!existsSync(source)) {
			missing.push(name);
			continue;
		}
		if (!existsSync(target)) {
			mkdirSync(dirname(target), { recursive: true });
			spawnSync("ln", ["-sfn", source, target]);
		}
	}
	return missing;
}

function newestMtime(dir) {
	let newest = 0;
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const at = join(dir, name.name);
		if (name.isDirectory()) newest = Math.max(newest, newestMtime(at));
		else newest = Math.max(newest, statSync(at).mtimeMs);
	}
	return newest;
}

function buildCheck() {
	const dist = join(plugin, "dist", "index.js");
	const client = join(plugin, "client.js");
	if (!existsSync(dist)) return { ok: false, detail: `no ${dist}; run: cd ocean-crew && npm run build` };
	if (!existsSync(client)) return { ok: false, detail: `no ${client}; run: cd ocean-crew && npm run build` };
	if (!existsSync(join(plugin, "cordis.patch.yml"))) say("smoke: warning: no cordis.patch.yml in the build (the profile patch may keep the old load)");
	if (flag("skip-build-check")) return { ok: true, detail: "skipped" };
	const hostAt = existsSync(join(plugin, "dist", "host")) ? newestMtime(join(plugin, "dist", "host")) : 0;
	const sourceAt = newestMtime(join(plugin, "src", "host"));
	return sourceAt > hostAt
		? { ok: false, detail: "dist is older than src/host; run: cd ocean-crew && npm run build" }
		: { ok: true, detail: "" };
}

// Quiet: no Bot shows an activity and the mock has taken no call for QUIET_MS.
async function settle() {
	const deadline = Date.now() + STEP_TIMEOUT_MS;
	let calls = mockLogEntries();
	let since = Date.now();
	while (Date.now() < deadline) {
		await sleep(400);
		const { activity = {} } = await api("state");
		const now = mockLogEntries();
		if (now !== calls || Object.keys(activity).length > 0) {
			calls = now;
			since = Date.now();
		} else if (Date.now() - since >= QUIET_MS) {
			return true;
		}
	}
	return false;
}

async function main() {
	if (!existsSync(dshBin)) {
		check(false, "the DSH harness is installed", `no ${dshBin}; run: npm run harness at the repository root`);
		return 1;
	}
	// A previous run that was killed keeps its home; a fresh bench starts clean.
	rmSync(home, { recursive: true, force: true });
	mkdirSync(home, { recursive: true });

	const built = buildCheck();
	if (!check(built.ok, "the plugin build is present and current", built.detail)) return 1;

	// 1. A fresh profile that links this build, exactly as bench.sh does for the JS one,
	// then the composed graph must resolve the plugin before anything boots.
	if (!check(prepareProfile(), "the smoke profile links the plugin build")) return 1;
	const missingDeps = ensurePluginDeps();
	if (!check(missingDeps.length === 0, "the plugin's runtime dependencies resolve", missingDeps.join(", "))) say("smoke: install them in the checkout or the bench will not load the plugin");
	const dump = spawnSync(process.execPath, [dshBin, "--profile", "web", "--dump-config"], {
		cwd: HARNESS,
		env: { ...process.env, DSH_HOME: home },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const dumpText = `${dump.stdout ?? ""}${dump.stderr ?? ""}`;
	if (!check(dump.status === 0 && dumpText.includes("ocean-crew"), "dump-config composes the ocean-crew plugin", String(dump.status))) {
		say(dumpText.split("\n").filter((line) => !line.includes("token=")).slice(-12).join("\n"));
		return 1;
	}

	// 2. Boot the mock model, then the DSH web server.
	const mockChild = spawnGroup(process.execPath, [mockScript, home], { MOCK_PORT: String(MOCK_PORT), MOCK_LOG: join(home, "mock.jsonl"), MOCK_DELAY_MS: "120" }, openSync(mockOut, "a"));
	await waitFor(() => portOpen(MOCK_PORT), 10_000, "the mock model to listen").catch(() => {});
	if (!check(mockChild.exitCode === null && (await portOpen(MOCK_PORT)), "the mock model is serving")) {
		say(readFileSync(mockOut, "utf8").split("\n").slice(-5).join("\n"));
		return 1;
	}

	const web = spawnGroup(
		process.execPath,
		[dshBin, "--profile", "web", "--no-open", "--port", String(WEB_PORT)],
		{ DSH_HOME: home, DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, DEEPSEEK_API_KEY: "mock-key" },
		openSync(webLog, "a"),
	);
	const started = await waitFor(() => existsSync(webLog) && /dsh web: http/.test(readFileSync(webLog, "utf8")), 120_000, "dsh web")
		.then(() => true)
		.catch((error) => {
			say(String(error.message ?? error));
			try {
				say(readFileSync(webLog, "utf8").split("\n").filter((line) => !line.includes("token=")).slice(-15).join("\n"));
			} catch {
				/* no log yet */
			}
			return false;
		});
	void web;
	if (!check(started, `dsh web is serving on 127.0.0.1:${WEB_PORT}`)) return 1;

	// 3. The plugin applies: login, `state`, and the feed's hello event.
	cookie = await login();
	const view = await api("state");
	check(typeof view?.revision === "number" && view.revision >= 0, "state answers with a revision", `revision ${view?.revision}`);
	check(view?.bots !== undefined && view?.rooms !== undefined, "state carries the Bot team view");
	// null when this host may write; a message naming the other host when it may not.
	check(view?.readOnly === null || typeof view?.readOnly === "string", "state reports the read-only gate", String(view?.readOnly));
	const hello = await feedHello();
	check(/event: hello/.test(hello), "the feed sends its hello event", hello.split("\n")[1] ?? "");

	// 4. Create a Bot, let its greeting turn run on the mock, then delete it.
	const before = Object.keys(stateFile().bots ?? {}).length;
	const created = await api("create-bot", { name: "Smoke Bot", role: "Tester", instructions: "Say hello." });
	const botId = created?.id;
	check(typeof botId === "string", "create-bot answers with the new Bot", String(botId));
	if (typeof botId !== "string") return 1;
	await waitFor(() => stateFile().bots?.[botId] !== undefined, STEP_TIMEOUT_MS, "the Bot in state.json");
	check(stateFile().bots?.[botId]?.name === "Smoke Bot", "state.json holds the created Bot");
	check(Object.keys(stateFile().bots ?? {}).length === before + 1, "the Bot count grew by one", `${before} -> ${before + 1}`);
	const quiet = await settle();
	check(quiet, "the greeting turn settles on the mock");
	await api("delete-bot", { id: botId });
	await waitFor(() => stateFile().bots?.[botId] === undefined, STEP_TIMEOUT_MS, "the Bot to be gone");
	check(stateFile().bots?.[botId] === undefined, "delete-bot removes it from state.json");
	return results.every((entry) => entry.ok) ? 0 : 1;
}

let code = 1;
try {
	code = await main();
} catch (error) {
	check(false, "smoke ran to the end", String(error?.message ?? error));
	code = 1;
} finally {
	for (const child of [...children].reverse()) await stopGroup(child);
	if (!KEEP) rmSync(home, { recursive: true, force: true });
	else say(`smoke: data kept at ${home}`);
	const passed = results.filter((entry) => entry.ok).length;
	say("");
	say(`smoke: ${passed}/${results.length} checks passed${KEEP ? "" : " (data removed)"}`);
}
process.exitCode = code === 0 && results.every((entry) => entry.ok) ? 0 : 1;
