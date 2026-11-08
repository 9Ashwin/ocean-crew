// Diagnostics behavior: every warning is cleaned of credentials and the home folder, kept
// in memory and in logs/diagnostics.jsonl, readable after a restart, reportable as a
// Markdown block, and safe to stop while a write is still queued.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearClientErrors,
	clientErrors,
	clientFacts,
	failureLabel,
	issueUrl,
	knownFailure,
	markNoted,
	noteClientError,
	quietly,
	WHAT_MAX,
} from "../src/client/core/diagnostics.ts";
import { DICTIONARY } from "../src/client/core/i18n.ts";
import { cleanText, install as installDiagnostics, reportMarkdown } from "../src/host/core/diagnostics.ts";

test("cleanText hides keys, tokens and the home folder", () => {
	const home = "/home/user";
	const text =
		'key sk-abcdef123456 and Bearer abc.def.ghi.jkl at http://h:1/?token=XYZ123&x=1 in /home/user/.dsh/bot, "api_key": "zzzzzzzzz", saved VALUE1234';
	const out = cleanText(text, { home, redact: (value) => value.replaceAll("VALUE1234", "[secret:DEMO]") });
	assert.equal(
		out,
		'key sk-[hidden] and Bearer [hidden] at http://h:1/?token=[hidden]&x=1 in ~/.dsh/bot, "api_key": "[hidden]", saved [secret:DEMO]',
	);
	assert.equal(cleanText("C:\\Users\\Shared\\x and C:/Users/Shared/y", { home: "C:\\Users\\Shared" }), "~\\x and ~/y");
	assert.ok(cleanText("x".repeat(5000)).length < 2100);
});

test("cleanText hides standalone credentials it was never given", () => {
	// Synthetic shapes only, built from parts so no string looks like a real key.
	const made = (...parts: string[]): string => parts.join("");
	const out = cleanText(
		[
			made("ghp_", "A1".repeat(12)),
			made("github_pat_", "B2".repeat(12)),
			made("AKIA", "0".repeat(16)),
			made("xoxb-", "1234", "-", "abcd".repeat(3)),
			made("AIza", "C3".repeat(12)),
			made("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "dGVzdC1zaWduYXR1cmUtcGFydA"),
		].join(" "),
		{ home: "" },
	);
	assert.equal(out, "[hidden] [hidden] [hidden] [hidden] [hidden] [hidden]");
});

// `stop()` runs the cleanups, as the plugin's stop does.
function host(home: string, extra: Record<string, unknown> = {}) {
	const warnings: unknown[][] = [];
	const cleanups: Array<() => unknown> = [];
	const effect = (execute: () => unknown): void => {
		const cleanup = execute();
		if (typeof cleanup === "function") cleanups.push(cleanup as () => unknown);
	};
	const rt: any = {
		ctx: { logger: { warn: (...args: unknown[]) => warnings.push(args) }, effect, get: () => undefined },
		home,
		config: {},
		state: { bots: { a: { id: "a", name: "Chief", model: "deepseek/deepseek-chat" } }, mainBotIds: ["a"], rooms: {} },
		readOnly: () => undefined,
		...extra,
	};
	installDiagnostics(rt);
	rt.stop = () => Promise.all(cleanups.map((cleanup) => cleanup()));
	return { rt, warnings };
}

test("warnings are kept, cleaned, written to the log, and read back after a restart", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-diag-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	const error = Object.assign(new Error(`cannot open ${homedir()}/x with sk-abcdefghij`), { code: "EACCES" });
	const quiet = t.mock.method(console, "error", () => {});
	const { rt } = host(home);
	rt.warn("ocean-crew: state write failed: %s", error);
	rt.noteFailure({
		source: "turn",
		text: "Rate limited",
		code: "RATE_LIMIT",
		status: 429,
		bot: "Chief",
		where: "own chat",
	});
	const [first, second] = await rt.diagnostics.entries();
	assert.equal(first.level, "warn");
	assert.equal(first.code, "EACCES");
	assert.equal(first.text, "state write failed: cannot open ~/x with sk-[hidden]");
	assert.match(first.stack, /^at /);
	assert.equal(second.code, "RATE_LIMIT");

	const report = await rt.diagnostics.report({
		client: { surface: "Web", language: "zh-CN", userAgent: "Test/1" },
		clientErrors: [{ time: 1, text: "state: HTTP 502" }],
	});
	assert.match(report.markdown, /\| Ocean Crew \| \d+\.\d+\.\d+ \|/);
	assert.match(report.markdown, /\| Surface \| Web \|/);
	assert.match(report.markdown, /\| Models \| deepseek\/deepseek-chat \|/);
	assert.match(report.markdown, /WARN host \[EACCES\] state write failed/);
	assert.match(report.markdown, /ERROR turn \(Chief · own chat\) \[RATE_LIMIT 429\] Rate limited/);
	assert.match(report.markdown, /ERROR browser state: HTTP 502/);
	assert.doesNotMatch(report.markdown, /sk-abc|\/home\//);
	assert.equal(report.entries[0].code, "RATE_LIMIT", "newest first");

	// Written as JSON lines; a new host reads them back.
	await rt.stop();
	assert.equal(
		readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8")
			.trim()
			.split("\n").length,
		2,
	);
	const again = host(home);
	assert.deepEqual(
		(await again.rt.diagnostics.entries()).map((entry: any) => entry.code),
		["EACCES", "RATE_LIMIT"],
	);
	assert.match(await again.rt.diagnostics.logText(), /\n {4}at /);
	await again.rt.diagnostics.clear();
	assert.deepEqual(await again.rt.diagnostics.entries(), []);
	assert.deepEqual(await host(home).rt.diagnostics.entries(), []);
	quiet.mock.restore();
});

test("warnings send only cleaned text to the logger and stderr", (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-diag-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	const values = ["synthetic-api-key-123456", "synthetic-bearer-token-12345", "synthetic-query-token-12345"];
	const error = new Error(`api_key=${values[0]} Bearer ${values[1]} https://example.invalid/?token=${values[2]}`);
	error.stack = `${error.name}: ${error.message}\n    at fake (https://example.invalid/?token=${values[2]}:1:1)`;
	const warnings: unknown[][] = [];
	const stderr: string[] = [];
	const quiet = t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args.join(" ")));
	const { rt } = host(home, { config: { diagnosticsFile: false } });
	rt.ctx.logger.warn = (...args: unknown[]) => warnings.push(args);
	rt.warn("ocean-crew: warning: %s", error);
	quiet.mock.restore();

	assert.equal(warnings[0][0], "%s");
	assert.match(String(warnings[0][1]), /\[hidden\]/);
	assert.match(stderr[0], /\[hidden\]/);
	assert.match(stderr[0], /at fake/);
	for (const value of values) {
		assert.equal(warnings.flat().join("\n").includes(value), false);
		assert.equal(stderr.join("\n").includes(value), false);
	}
});

test("diagnostics append fallback redacts an error message", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-diag-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	const value = "synthetic-api-key-append-123456";
	const stderr: string[] = [];
	const quiet = t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args.join(" ")));
	const { rt } = host(home);
	const originalAppend = fsp.appendFile;
	(fsp as any).appendFile = async (path: string, ...args: unknown[]) => {
		if (path === join(home, "logs", "diagnostics.jsonl"))
			throw new Error(`synthetic append failure api_key=${value}`);
		return (originalAppend as any)(path, ...args);
	};
	syncBuiltinESMExports();
	try {
		rt.noteFailure({ text: "synthetic entry" });
		await rt.diagnostics.clear();
	} finally {
		(fsp as any).appendFile = originalAppend;
		syncBuiltinESMExports();
		quiet.mock.restore();
	}
	assert.equal(stderr.join("\n").includes(value), false);
	assert.match(stderr.join("\n"), /api_key=\[hidden\]/);
});

test("a stop waits for the log writes queued before it, and nothing is written after it", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-diag-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	t.mock.method(console, "error", () => {});
	const log = join(home, "logs", "diagnostics.jsonl");
	const originalAppend = fsp.appendFile;
	let reached: () => void = () => {};
	const appending = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	(fsp as any).appendFile = async (...args: unknown[]) => {
		reached();
		await gate;
		return (originalAppend as any)(...args);
	};
	syncBuiltinESMExports();
	t.after(() => {
		(fsp as any).appendFile = originalAppend;
		syncBuiltinESMExports();
	});
	const { rt } = host(home);
	rt.warn("ocean-crew: before the stop");
	await appending;
	let stopped = false;
	const stopping = rt.stop().then(() => {
		stopped = true;
	});
	await Promise.resolve();
	assert.equal(stopped, false, "the stop waits for the write in progress");
	release();
	await stopping;
	assert.match(readFileSync(log, "utf8"), /before the stop/);

	rt.warn("ocean-crew: after the stop");
	await rt.diagnostics.clear();
	// A write queued after the stop would be part of what a second stop waits for.
	await rt.stop();
	const lines = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(lines.length, 1, "neither the warning nor the clear reached the file");
	assert.match(lines[0], /before the stop/);
	assert.equal((await rt.diagnostics.entries()).length, 0, "the clear still empties the list in memory");
});

test("reportMarkdown says when nothing went wrong", () => {
	const text = reportMarkdown({ facts: { botVersion: "0.1.0", os: "linux" } });
	assert.match(text, /No host errors recorded\./);
	assert.doesNotMatch(text, /DSH \|/);
});

// --- the browser half's failure record ---------------------------------------------

test("credential and account failures have short words, in both languages", () => {
	const labels: Record<string, string> = {
		MISSING_CREDENTIAL: "The model has no API key",
		INVALID_CREDENTIAL: "The API key is not in the right format",
		ACCOUNT_SIGN_IN_REQUIRED: "The DeepSeek account needs a sign-in",
		ACCOUNT_SIGNED_OUT: "The DeepSeek account is signed out",
		ACCOUNT_TOKEN_INVALID: "The DeepSeek account sign-in has expired",
	};
	for (const [code, label] of Object.entries(labels)) {
		assert.equal(failureLabel(code, "llm-deepseek: no API key for provider route"), label);
		assert.ok(Object.hasOwn(DICTIONARY.zh, label), label);
	}
});

test("an unknown code has no short words, and its label falls back to the message", () => {
	assert.equal(knownFailure("SOMETHING_NEW"), undefined);
	assert.equal(knownFailure(undefined), undefined);
	assert.equal(knownFailure("toString"), undefined);
	assert.equal(failureLabel("SOMETHING_NEW", "raw text"), "raw text");
	assert.equal(failureLabel("SOMETHING_NEW", ""), "SOMETHING_NEW");
});

test("issueUrl fills the issue form, keeps the versions when the errors are too long, and falls back to the clipboard", () => {
	const base = "https://github.com/9Ashwin/ocean-crew/issues/new";
	const short = issueUrl(base, { what: "Writer failed\nin the group", diagnostics: "| Ocean Crew | 0.1.0 |" });
	assert.equal(short.inline, true);
	const params = new URL(short.url).searchParams;
	assert.equal(params.get("template"), "bug.yml");
	assert.equal(params.get("title"), "Writer failed");
	assert.equal(params.get("what"), "Writer failed\nin the group");
	assert.equal(params.get("diagnostics"), "| Ocean Crew | 0.1.0 |");
	const long = issueUrl(base, { diagnostics: "错误".repeat(2000) });
	assert.equal(long.inline, false);
	assert.ok(long.url.length < 7000);
	assert.match(new URL(long.url).searchParams.get("diagnostics") as string, /clipboard/);
	assert.equal(new URL(long.url).searchParams.has("title"), false);
	const table = "| | |\n|---|---|\n| Ocean Crew | 0.1.2 |\n| DSH | 0.2.0 |";
	const errors = issueUrl(base, {
		what: "Writer failed",
		diagnostics: `${table}\n\nRecent host errors:\n${"错误".repeat(2000)}`,
	});
	assert.equal(errors.inline, false);
	assert.ok(errors.url.length < 7000);
	const kept = new URL(errors.url).searchParams.get("diagnostics") as string;
	assert.ok(kept.startsWith(`${table}\n\n`));
	assert.match(kept, /clipboard: paste them below this line/);
	assert.doesNotMatch(kept, /错误/);
	// A very long "what" is cut without crowding out the report.
	const cut = issueUrl(base, { what: "x".repeat(WHAT_MAX + 500), diagnostics: "| Ocean Crew | 0.1.0 |" });
	assert.equal(new URL(cut.url).searchParams.get("what")?.length, WHAT_MAX);
	assert.equal(new URL(cut.url).searchParams.get("title")?.length, 80);
});

test("a browser error is noted once, repeats are counted, and clear empties the list", () => {
	clearClientErrors();
	const shown = markNoted(new Error("Could not reach DSH."));
	noteClientError("menu", shown);
	assert.equal(clientErrors().length, 0);
	const failed = new Error("HTTP 502");
	noteClientError("state", failed);
	noteClientError("menu", failed);
	noteClientError("state", new Error("HTTP 502"));
	assert.deepEqual(
		clientErrors().map((entry) => entry.text),
		["state: HTTP 502 (×2)"],
	);
	clearClientErrors();
	assert.equal(clientErrors().length, 0);
});

test("the same failure outside the repeat window starts a new line", (t) => {
	clearClientErrors();
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	noteClientError("poll", new Error("offline"));
	now += 60_000;
	noteClientError("poll", new Error("offline"));
	assert.deepEqual(
		clientErrors().map((entry) => [entry.text, entry.count]),
		[["poll: offline (×2)", 2]],
	);
	now += 5 * 60_000;
	noteClientError("poll", new Error("offline"));
	assert.deepEqual(
		clientErrors().map((entry) => entry.text),
		["poll: offline (×2)", "poll: offline"],
	);
});

test("the record keeps at most 30 lines, with the code and a cut message", (t) => {
	clearClientErrors();
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	for (let index = 0; index < 31; index += 1) {
		now += 1;
		noteClientError(
			"tick",
			Object.assign(new Error(`failure ${index}`), { code: index === 30 ? "RATE_LIMIT" : undefined }),
		);
	}
	const list = clientErrors();
	assert.equal(list.length, 30);
	assert.equal(list[0].text, "tick: failure 1");
	assert.equal(list.at(-1)?.text, "tick: failure 30");
	assert.equal(list.at(-1)?.code, "RATE_LIMIT");
	// A message is cut at what the report shows of it.
	now += 1_000;
	noteClientError("tick", new Error("x".repeat(400)));
	assert.equal(clientErrors().at(-1)?.text, `tick: ${"x".repeat(300)}`);
	clearClientErrors();
});

test("a catch handler can keep a failure without bothering the user", () => {
	clearClientErrors();
	const swallow = quietly("preview");
	swallow(new Error("could not render"));
	assert.deepEqual(
		clientErrors().map((entry) => entry.text),
		["preview: could not render"],
	);
	clearClientErrors();
});

test("the report says which surface and language this browser is", () => {
	clearClientErrors();
	const globals = globalThis as any;
	globals.window = { dshDesktop: true };
	try {
		const facts = clientFacts();
		assert.equal(facts.surface, "DSH Desktop");
		assert.equal(facts.language, "en");
		assert.equal(facts.userAgent, navigator.userAgent);
		globals.window = { dshDesktop: false };
		assert.equal(clientFacts().surface, "DSH Web");
	} finally {
		delete globals.window;
		clearClientErrors();
	}
});
