// Secrets: the card a Bot requests, the file the host keeps, the redaction of values
// from tool results and model requests, the shell variables, and the settings
// endpoints.
// so only the module's public surface is asserted.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import {
	canUse,
	encodeUrlComponent,
	install,
	normalizeName,
	redactDeep,
	redactor,
	SECRET_NAME,
	type SecretRequest,
	type SecretView,
} from "../src/host/work/secrets.ts";
import { emptyTeam, type TeamState } from "../src/shared/state.ts";

type TestRuntime = Runtime & Record<string, any>;

interface Contributor {
	name: string;
	variables: Record<string, { description: string }>;
	resolve: (execution: any) => Record<string, string>;
	live: boolean;
}

type Listener = (...args: any[]) => any;

// Test values are random on every run, so a leak can only come from this run.
const fresh = (): string => `t-${randomBytes(12).toString("hex")}`;

const team = (): TeamState => {
	const state = emptyTeam();
	state.mainBotIds = ["m1"];
	state.bots = {
		m1: { id: "m1", sessionId: "m1", name: "Chief", role: "Chief of Staff", createdAt: 1, capabilities: [] },
		b2: { id: "b2", sessionId: "b2", name: "Writer", role: "写作", createdAt: 2, capabilities: [] },
		c3: { id: "c3", sessionId: "c3", name: "Coder", role: "代码", createdAt: 3, capabilities: [] },
	};
	state.rooms = {
		r1: {
			id: "r1",
			name: "Team",
			named: true,
			members: ["m1", "b2"],
			admin: "m1",
			mode: "everyone",
			notice: "",
			sessions: { b2: "g-b2" },
			log: [],
		},
	};
	return state;
};

function start({ home = mkdtempSync(join(tmpdir(), "ocean-crew-secrets-")) }: { home?: string } = {}) {
	const state = team();
	writeFileSync(join(home, "state.json"), JSON.stringify(state));
	const contributors: Contributor[] = [];
	const shellEnv = {
		register(contributor: Omit<Contributor, "live">): () => void {
			const entry: Contributor = { ...contributor, live: true };
			contributors.push(entry);
			return () => {
				entry.live = false;
			};
		},
	};
	const listeners = new Map<string, Listener[]>();
	const disposers: Array<() => unknown> = [];
	const delivered: Array<Record<string, any>> = [];
	const streamed: Array<Record<string, any>> = [];
	const ctx = {
		on(name: string, listener: Listener) {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return () => {};
		},
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
			return () => {};
		},
		get: (name: string) => (name === "shellEnv" ? shellEnv : undefined),
		llm: {
			stream: (options: Record<string, any>) => {
				streamed.push(options);
				return (async function* () {})();
			},
		},
		logger: { warn: () => {} },
	};
	const chatOwners = new Map<string, string>();
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	for (const room of Object.values(state.rooms))
		for (const [botId, sessionId] of Object.entries(room.sessions ?? {}))
			groupOwners.set(sessionId, { botId, roomId: room.id });
	const botOf = (id?: string) => (id === undefined ? undefined : state.bots[id]);
	const selfOf = (id?: string) => (id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId));
	const rt = {
		ctx,
		home,
		state,
		teamTools: [] as Array<Record<string, any>>,
		warn: () => {},
		load: async () => {},
		save: async () => {
			writeFileSync(join(home, "state.json"), JSON.stringify(state));
		},
		readOnly: () => undefined as string | undefined,
		botOf,
		selfOf,
		isBotSession: (id?: string) => id !== undefined && (chatOwners.has(id) || groupOwners.has(id)),
		chatOwners,
		groupOwners,
		deliver: async (args: Record<string, any>) => {
			delivered.push(args);
		},
	} as unknown as TestRuntime;
	for (const bot of Object.values(state.bots)) chatOwners.set(bot.sessionId ?? bot.id, bot.id);
	install(rt);
	const tool = async (name: string, args: Record<string, any>, sessionId: string, extra: Record<string, any> = {}) => {
		const definition = rt.teamTools.find((candidate) => candidate.name === name);
		assert.ok(definition, `no tool ${name}`);
		let concluded = false;
		const run = definition.execute as (args: Record<string, any>, exec: Record<string, any>) => Promise<unknown>;
		const text = await run(args, {
			agent: { id: sessionId },
			callId: `call-${sessionId}-${name}`,
			concludeTurn: () => {
				concluded = true;
			},
			...extra,
		});
		return { text: String(text), concluded };
	};
	const call = (endpoint: string, body?: Record<string, any>) => rt.secretEndpoint(endpoint, body);
	const view = () => ({
		secrets: rt.secretsView() as SecretView[],
		secretRequests: (state.secretRequests ?? {}) as unknown as Record<string, SecretRequest[]>,
	});
	const env = (agentId: string, command = ""): Record<string, string> =>
		contributors
			.filter((entry) => entry.live)
			.at(-1)
			?.resolve({
				agent: { id: agentId, session: { header: { id: agentId } } },
				arguments: { command },
			}) ?? {};
	const stop = async (): Promise<void> => {
		for (const dispose of disposers.splice(0).reverse()) await dispose();
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	};
	return { rt, ctx, state, home, contributors, listeners, delivered, streamed, tool, call, view, env, stop };
}

test("names are normalized, then checked", () => {
	assert.equal(normalizeName(" github-token "), "GITHUB_TOKEN");
	assert.equal(normalizeName("$DSH_SECRET_demo_token"), "DEMO_TOKEN");
	assert.equal(normalizeName("$env:DSH_SECRET_X1"), "X1");
	assert.ok(SECRET_NAME.test("GITHUB_TOKEN"));
	for (const bad of ["", "1ABC", "_X", "A".repeat(65), "A B", "Ä"]) assert.ok(!SECRET_NAME.test(bad), bad);
});

test("scope is every Bot or a list", () => {
	assert.ok(canUse({ scope: "all" }, "b"));
	assert.ok(canUse({ scope: ["a", "b"] }, "b"));
	assert.ok(!canUse({ scope: ["a"] }, "b"));
	assert.ok(!canUse({ scope: [] }, "b"));
	assert.ok(!canUse(undefined, "b"));
	assert.ok(!canUse({ scope: "all" }, undefined));
});

test("redaction replaces the longest value first, JSON-escaped forms too, and skips short values", () => {
	const long = fresh();
	const inner = long.slice(0, 12);
	const quoted = `${fresh()}"\\x`;
	const redact = redactor([
		{ name: "INNER", value: inner },
		{ name: "LONG", value: long },
		{ name: "SHORT", value: "abc" },
		{ name: "Q", value: quoted },
	]);
	assert.equal(redact(`a ${long} b ${inner} c abc`), "a [secret:LONG] b [secret:INNER] c abc");
	assert.equal(redact(JSON.stringify({ text: quoted })), '{"text":"[secret:Q]"}');
	assert.equal((redact as unknown as (value: unknown) => unknown)(42), 42);
	const value = { list: ["x", { text: `see ${long}` }], n: 1 };
	const out = redactDeep(value, redact);
	assert.deepEqual(out, { list: ["x", { text: "see [secret:LONG]" }], n: 1 });
	assert.equal((value.list[1] as { text: string }).text, `see ${long}`);
	const clean = { list: ["x"] };
	assert.equal(redactDeep(clean, redact), clean);
});

test("redaction replaces URL-encoded values", () => {
	const value = `${fresh()} /+&?=#'!()* 中文`;
	const redact = redactor([{ name: "TOKEN", value }]);
	assert.equal(
		redact(`https://example.test/mcp?key=${encodeUrlComponent(value)}&mode=1`),
		"https://example.test/mcp?key=[secret:TOKEN]&mode=1",
	);
	assert.equal(
		redact(new URL(`https://example.test/mcp?key=${encodeUrlComponent(value)}`).href),
		"https://example.test/mcp?key=[secret:TOKEN]",
	);
	const broken = `${fresh()}\uD800`;
	assert.equal(redactor([{ name: "BROKEN", value: broken }])(`x ${broken}`), "x [secret:BROKEN]");
});

test("a short key (4 to 7 characters) is replaced only where it stands alone", () => {
	const redact = redactor([
		{ name: "PIN", value: "4821" },
		{ name: "PW", value: "cat$1" },
		{ name: "SECRET_WORD", value: "secret" },
	]);
	assert.equal(redact('pin 4821, again "4821"'), 'pin [secret:PIN], again "[secret:PIN]"');
	// Inside a longer number or word it is left alone.
	assert.equal(redact("order 148210 and x4821"), "order 148210 and x4821");
	assert.equal(redact("login cat$1@host"), "login [secret:PW]@host");
	assert.equal(redact("concat$12"), "concat$12");
	// A label already written is not matched again, even when it holds the value.
	assert.equal(redact("secret and 4821"), "[secret:SECRET_WORD] and [secret:PIN]");
	assert.equal(redact("中文4821中文"), "中文4821中文");
});

test("a card saves a key the Bot never sees, and the shell gets it", async (t) => {
	const bench = start();
	t.after(bench.stop);
	const value = fresh();

	const asked = await bench.tool("request_secret", { name: "demo_token", purpose: "测试" }, "b2");
	assert.equal(asked.concluded, true);
	assert.match(asked.text, /card asking the user for DEMO_TOKEN is on screen/);
	let teamView = bench.view();
	const request = teamView.secretRequests.b2[0];
	assert.equal(request.name, "DEMO_TOKEN");
	assert.equal(request.kind, "fill");
	assert.equal(request.status, "pending");
	assert.equal(request.callId, "call-b2-request_secret");
	assert.equal(request.sessionId, "b2");
	assert.equal(request.purpose, "测试");

	await assert.rejects(bench.call("secret-set", { requestId: request.id, value: "abc" }), /at least 4/);
	const saved = (await bench.call("secret-set", { requestId: request.id, value: `  ${value}\n` })) as SecretView;
	assert.deepEqual(Object.keys(saved).sort(), ["createdAt", "name", "purpose", "requestedBy", "scope", "updatedAt"]);
	assert.equal(saved.scope, "all");
	assert.equal(saved.requestedBy, "b2");
	await assert.rejects(bench.call("secret-set", { requestId: request.id, value }), /already answered/);

	const file = join(bench.home, "secrets.json");
	// Windows has no POSIX mode bits: a writable file always stats as 0o666 there.
	if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal((JSON.parse(readFileSync(file, "utf8")) as any).secrets[0].value, value);
	assert.deepEqual(
		readdirSync(bench.home).filter((name) => name.endsWith(".tmp")),
		[],
	);
	teamView = bench.view();
	assert.equal(teamView.secretRequests.b2[0].status, "saved");
	assert.deepEqual(
		teamView.secrets.map((secret) => secret.name),
		["DEMO_TOKEN"],
	);
	// Nothing the browser gets holds the value.
	assert.ok(!JSON.stringify(teamView).includes(value));
	assert.ok(!readFileSync(join(bench.home, "state.json"), "utf8").includes(value));

	const note = bench.delivered.at(-1) as Record<string, any>;
	assert.equal(note.toId, "b2");
	assert.equal(note.role, "secret");
	assert.match(
		String(note.text),
		/^The user saved DEMO_TOKEN for every Bot\. Use it as \$DSH_SECRET_DEMO_TOKEN in bash, or \$env:DSH_SECRET_DEMO_TOKEN in PowerShell\./,
	);
	assert.ok(!String(note.text).includes(value));

	// Every Bot (own chat or group Session) gets the variable; other Sessions do not.
	assert.deepEqual(bench.env("b2", "echo $DSH_SECRET_DEMO_TOKEN"), { DSH_SECRET_DEMO_TOKEN: value });
	assert.deepEqual(bench.env("g-b2"), { DSH_SECRET_DEMO_TOKEN: value });
	assert.deepEqual(bench.env("not-a-bot"), {});
	const live = bench.contributors.filter((entry) => entry.live);
	assert.equal(live.length, 1);
	assert.deepEqual(Object.keys(live[0].variables), ["DSH_SECRET_DEMO_TOKEN"]);
	assert.equal(live[0].variables.DSH_SECRET_DEMO_TOKEN.description, "Ocean Crew secret DEMO_TOKEN: 测试");

	// Asking again only names the variable.
	const again = await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "x" }, "b2");
	assert.equal(again.concluded, false);
	assert.match(again.text, /already saved and you may use it: \$DSH_SECRET_DEMO_TOKEN/);
	const listed = await bench.tool("list_secrets", {}, "c3");
	assert.match(listed.text, /- DEMO_TOKEN — 测试 — for every Bot — you may use it as \$DSH_SECRET_DEMO_TOKEN/);
	assert.ok(!listed.text.includes(value));
});

test("a Bot outside the scope gets an allow card, and allowing resolves it", async (t) => {
	const bench = start();
	t.after(bench.stop);
	const value = fresh();
	await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "测试" }, "b2");
	let request = bench.view().secretRequests.b2[0];
	const narrowed = (await bench.call("secret-set", { requestId: request.id, value, scope: "bot" })) as SecretView;
	assert.equal((narrowed.scope as string[]).join(), "b2");
	assert.deepEqual(bench.env("c3"), {});

	// Coder asks too, while a second Writer card would be superseded by the first answer.
	const asked = await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "build" }, "c3");
	assert.match(asked.text, /let you use DEMO_TOKEN/);
	request = bench.view().secretRequests.c3[0];
	assert.equal(request.kind, "allow");
	const listed = await bench.tool("list_secrets", {}, "c3");
	assert.match(listed.text, /for Writer — you may not use it/);

	const allowed = (await bench.call("secret-allow", { requestId: request.id })) as SecretView;
	assert.deepEqual(allowed.scope, ["b2", "c3"]);
	assert.equal(bench.view().secretRequests.c3[0].status, "allowed");
	assert.deepEqual(bench.env("c3"), { DSH_SECRET_DEMO_TOKEN: value });
	assert.match(String((bench.delivered.at(-1) as Record<string, any>).text), /^The user let you use DEMO_TOKEN\./);

	// Settings: narrow the scope, which turns a new card back into an allow card.
	await bench.call("secret-update", { name: "DEMO_TOKEN", scope: ["b2", "nope"] });
	assert.deepEqual(bench.view().secrets[0].scope, ["b2"]);
	await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "build" }, "c3");
	const pending = bench.view().secretRequests.c3.at(-1) as SecretRequest;
	assert.equal(pending.kind, "allow");
	// Widening it resolves the waiting card and tells Coder.
	await bench.call("secret-update", { name: "DEMO_TOKEN", scope: "all" });
	assert.equal(bench.view().secretRequests.c3.at(-1)?.status, "saved");
	assert.match(
		String((bench.delivered.at(-1) as Record<string, any>).text),
		/The user saved DEMO_TOKEN, and you may use it now\./,
	);

	// Replacing the value keeps the scope; the old value is no longer injected.
	const next = fresh();
	await bench.call("secret-set", { name: "demo_token", value: next });
	assert.deepEqual(bench.env("c3"), { DSH_SECRET_DEMO_TOKEN: next });
	assert.equal(bench.view().secrets[0].scope, "all");

	// Deleting turns a waiting allow card into a fill card and drops the variable.
	await bench.call("secret-update", { name: "DEMO_TOKEN", scope: ["b2"] });
	await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "build" }, "c3");
	await bench.call("secret-delete", { name: "DEMO_TOKEN" });
	const teamView = bench.view();
	assert.deepEqual(teamView.secrets, []);
	assert.equal(teamView.secretRequests.c3.at(-1)?.kind, "fill");
	assert.equal(bench.contributors.filter((entry) => entry.live).length, 0);
	assert.deepEqual((JSON.parse(readFileSync(join(bench.home, "secrets.json"), "utf8")) as any).secrets, []);
});

test("a key's purpose can be changed or cleared on its own", async (t) => {
	const bench = start();
	t.after(bench.stop);
	await bench.call("secret-set", { name: "DEMO_TOKEN", value: fresh(), purpose: "first", scope: "all" });

	const changed = (await bench.call("secret-update", { name: "DEMO_TOKEN", purpose: "renamed" })) as SecretView;
	assert.equal(changed.purpose, "renamed");
	assert.equal(changed.scope, "all");
	const cleared = (await bench.call("secret-update", { name: "DEMO_TOKEN", purpose: "" })) as SecretView;
	assert.equal(cleared.purpose, "");
	const scoped = (await bench.call("secret-update", { name: "DEMO_TOKEN", scope: ["b2"] })) as SecretView;
	assert.deepEqual(scoped.scope, ["b2"]);
	assert.equal(scoped.purpose, "");
	const both = (await bench.call("secret-update", {
		name: "DEMO_TOKEN",
		scope: "all",
		purpose: "kept",
	})) as SecretView;
	assert.equal(both.scope, "all");
	assert.equal(both.purpose, "kept");
	const saved = (JSON.parse(readFileSync(join(bench.home, "secrets.json"), "utf8")) as any).secrets[0];
	assert.equal(saved.purpose, "kept");
	assert.equal(saved.scope, "all");
});

test("cards stay in a Bot's own chat; canceling tells the Bot", async (t) => {
	const bench = start();
	t.after(bench.stop);
	const group = await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "x" }, "g-b2");
	assert.equal(group.concluded, false);
	assert.match(group.text, /only work in your own chat/);
	assert.match(
		(await bench.tool("request_secret", { name: "9bad", purpose: "x" }, "b2")).text,
		/capitals, digits, and underscores/,
	);
	assert.match((await bench.tool("request_secret", { name: "X_KEY", purpose: "x" }, "stranger")).text, /Only Bots/);

	await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "first" }, "b2");
	await bench.tool("request_secret", { name: "DEMO_TOKEN", purpose: "second" }, "b2");
	const [first, second] = bench.view().secretRequests.b2;
	assert.equal(first.status, "canceled");
	assert.equal(second.status, "pending");
	assert.equal(await bench.call("secret-cancel", { requestId: second.id }), true);
	assert.equal(bench.view().secretRequests.b2[1].status, "canceled");
	assert.match(
		String((bench.delivered.at(-1) as Record<string, any>).text),
		/^The user canceled your request for DEMO_TOKEN\./,
	);
	await assert.rejects(bench.call("secret-allow", { requestId: "gone" }), /request is gone/);
});

test("a deleted Bot leaves every scope list and takes its cards along", async (t) => {
	const bench = start();
	t.after(bench.stop);
	await bench.call("secret-set", { name: "API_KEY", value: fresh(), scope: ["b2", "c3"], purpose: "p" });
	await bench.tool("request_secret", { name: "OTHER_KEY", purpose: "x" }, "c3");
	await bench.rt.forgetBotSecrets("c3");
	const teamView = bench.view();
	assert.deepEqual(teamView.secrets[0].scope, ["b2"]);
	assert.equal(teamView.secretRequests.c3, undefined);
	assert.deepEqual((JSON.parse(readFileSync(join(bench.home, "secrets.json"), "utf8")) as any).secrets[0].scope, [
		"b2",
	]);
});

test("tool results and model requests lose the values", async (t) => {
	const bench = start();
	t.after(bench.stop);
	const value = fresh();
	await bench.call("secret-set", { name: "DEMO_TOKEN", value });
	const execute = bench.listeners.get("tools/execute")?.[0];
	assert.ok(execute);
	const ok = await execute({}, async () => ({
		isError: false,
		value: { kind: "foreground", stdout: { text: `${value}\n`, truncated: false } },
		content: [{ type: "text", text: value }],
		meta: { stdout: value },
	}));
	assert.equal(ok.isError, false);
	assert.deepEqual(ok.value, { kind: "foreground", stdout: { text: "[secret:DEMO_TOKEN]\n", truncated: false } });
	// The rest of a changed result stays whole and loses the values too: a wrapper further
	// out still reads its content and meta, and they are already redacted.
	assert.deepEqual(ok.content, [{ type: "text", text: "[secret:DEMO_TOKEN]" }]);
	assert.equal(ok.meta.stdout, "[secret:DEMO_TOKEN]");
	const logged = await execute({}, async () => ({
		isError: false,
		value: { text: value },
		content: [{ type: "text", text: `out ${value}` }],
		meta: { stdout: value },
		additionalContexts: [{ role: "user", content: [{ type: "text", text: value }] }],
	}));
	assert.equal(logged.content[0].text, "out [secret:DEMO_TOKEN]");
	assert.equal(logged.meta.stdout, "[secret:DEMO_TOKEN]");
	assert.equal(logged.additionalContexts[0].content[0].text, "[secret:DEMO_TOKEN]");
	const failed = await execute({}, async () => ({
		isError: true,
		error: { message: `bad ${value}` },
		content: [{ type: "text", text: `bad ${value}` }],
	}));
	assert.equal(failed.content[0].text, "bad [secret:DEMO_TOKEN]");
	assert.equal(failed.error.message, "bad [secret:DEMO_TOKEN]");
	const plain = { isError: false, value: "nothing here" };
	assert.equal(await execute({}, async () => plain), plain);

	const stream = bench.listeners.get("llm/stream")?.[0];
	assert.ok(stream);
	const passed: boolean[] = [];
	const next = () => {
		passed.push(true);
		return (async function* () {})();
	};
	const options = {
		provider: "p",
		model: "m",
		sessionId: "b2",
		system: `sys ${value}`,
		messages: [
			{ role: "user", content: [{ type: "text", text: `my key is ${value}` }] },
			{ role: "tool", content: [{ type: "text", text: value }] },
		],
	};
	stream(options, next);
	assert.equal(passed.length, 0);
	const sent = bench.streamed.at(-1) as Record<string, any>;
	assert.equal(sent.system, "sys [secret:DEMO_TOKEN]");
	assert.equal(sent.provider, "p");
	assert.ok(!JSON.stringify(sent).includes(value));
	assert.ok(JSON.stringify(options).includes(value));
	// The rewritten request passes through, even when a value sits inside its own label.
	stream(sent, next);
	assert.equal(passed.length, 1);
	stream({ ...options, system: "clean", messages: [] }, next);
	assert.equal(passed.length, 2);
});

test("a restarted host resolves its team Sessions and their keys before the first shell call", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-secrets-"));
	const value = fresh();
	writeFileSync(
		join(home, "secrets.json"),
		JSON.stringify({
			version: 1,
			secrets: [
				{ name: "DEMO_TOKEN", value, purpose: "p", scope: "all", requestedBy: "b2", createdAt: 1, updatedAt: 1 },
			],
		}),
	);
	const bench = start({ home });
	t.after(bench.stop);
	// install() has just returned: no endpoint or tool has run yet, but a restored
	// Session's first shell call already resolves its Bot and its variables.
	assert.deepEqual(bench.env("b2"), { DSH_SECRET_DEMO_TOKEN: value });
	assert.deepEqual(bench.env("g-b2"), { DSH_SECRET_DEMO_TOKEN: value });
	assert.deepEqual(bench.env("elsewhere"), {});
});

test("a secrets file that cannot be read blocks every write instead of being overwritten", async (t) => {
	// A directory reads as EISDIR on every platform; no chmod games needed. It has to
	// exist before the plugin loads, or the first read has already found the file empty.
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-secrets-"));
	mkdirSync(join(home, "secrets.json"));
	const bench = start({ home });
	t.after(bench.stop);
	const file = join(home, "secrets.json");
	await assert.rejects(
		bench.call("secret-set", { name: "TEST_TOKEN", value: "12345678" }),
		/secrets\.json could not be read \(EISDIR\)\. Ocean Crew does not change it/,
	);
	assert.ok(statSync(file).isDirectory());
	// While it stays unreadable, nothing is written; once it is gone, saving works.
	rmSync(file, { recursive: true });
	const saved = (await bench.call("secret-set", { name: "TEST_TOKEN", value: "12345678" })) as SecretView;
	assert.equal(saved.name, "TEST_TOKEN");
});

test("a secrets file that is not JSON is kept aside, and the store goes on", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-secrets-"));
	writeFileSync(join(home, "secrets.json"), "not a secrets file\n");
	const bench = start({ home });
	t.after(bench.stop);
	const saved = (await bench.call("secret-set", { name: "TEST_TOKEN", value: "12345678" })) as SecretView;
	assert.equal(saved.name, "TEST_TOKEN");
	const broken = readdirSync(home).filter((name) => name.startsWith("secrets.json.broken-"));
	assert.equal(broken.length, 1);
	assert.equal(readFileSync(join(home, broken[0]), "utf8"), "not a secrets file\n");
});
