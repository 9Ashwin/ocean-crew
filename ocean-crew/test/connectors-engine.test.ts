// Engine-level connector tests: the gateway on real node:http upstreams (always on
// 127.0.0.1), token refresh through fake fetches, custom connectors, the import scan,
// and the browser sign-in code path. No network leaves the test process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { format } from "node:util";
import { createGateway } from "../src/host/connectors/gateway.ts";
import { install } from "../src/host/connectors/index.ts";
import type * as oauth from "../src/host/connectors/oauth.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { emptyTeam } from "../src/shared/state.ts";
import { type FakeContext, fakeContext } from "./fake-ctx.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const notFound = (): Response => new Response("not found", { status: 404 });

const AS: oauth.AuthorizationServerMetadata = {
	issuer: "https://as.test",
	authorization_endpoint: "https://as.test/auth",
	token_endpoint: "https://as.test/token",
	registration_endpoint: "https://as.test/register",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
};

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

// --- gateway ---------------------------------------------------------------

test("gateway guards the nonce, injects credentials, streams SSE and Mcp-Session-Id", async (t) => {
	const seen: Array<Record<string, any>> = [];
	const upstream = createServer((req, res) => {
		seen.push({
			method: req.method,
			auth: req.headers.authorization,
			session: req.headers["mcp-session-id"],
			key: req.headers["x-api-key"],
		});
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
			res.write('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n');
			setTimeout(() => {
				res.write('event: message\ndata: {"more":true}\n\n');
				res.end();
			}, 10);
			return;
		}
		res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
		res.end('{"ok":true}');
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	const gw = createGateway({
		credential: () => ({
			url: `http://127.0.0.1:${port}/mcp`,
			headers: { Authorization: "Bearer REAL", "X-Api-Key": "K" },
		}),
		readOnly: () => false,
		onUnauthorized: async () => false,
	});
	await gw.listen();
	t.after(() => gw.close());
	const base = gw.urlFor("svc");
	assert.equal((await fetch(base)).status, 404);
	assert.equal((await fetch(base, { headers: { Authorization: "Bearer wrong" } })).status, 404);
	assert.equal(seen.length, 0);
	const post = await fetch(base, {
		method: "POST",
		headers: { Authorization: `Bearer ${gw.nonce}`, "content-type": "application/json", "mcp-session-id": "sess-1" },
		body: "{}",
	});
	assert.equal(post.status, 200);
	assert.equal(post.headers.get("mcp-session-id"), "sess-1");
	assert.equal(seen[0].auth, "Bearer REAL");
	assert.equal(seen[0].key, "K");
	const get = await fetch(base, { headers: { Authorization: `Bearer ${gw.nonce}`, "mcp-session-id": "sess-1" } });
	assert.equal(get.headers.get("mcp-session-id"), "sess-1");
	assert.match(await get.text(), /"more":true/);
});

test("gateway read-only filters tools/list and refuses write tools/call, including batches", async (t) => {
	const list = {
		jsonrpc: "2.0",
		id: 1,
		result: {
			tools: [
				{ name: "read_thing", annotations: { readOnlyHint: true } },
				{ name: "write_thing" },
				{ name: "maybe", annotations: {} },
			],
		},
	};
	const upstream = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const rpc = JSON.parse(raw);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify(rpc.method === "tools/list" ? list : { jsonrpc: "2.0", id: rpc.id, result: { ok: true } }),
			);
		});
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	const gw = createGateway({
		credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }),
		readOnly: () => true,
		onUnauthorized: async () => false,
	});
	await gw.listen();
	t.after(() => gw.close());
	const head = { Authorization: `Bearer ${gw.nonce}`, "content-type": "application/json" };
	const filtered = (await (
		await fetch(gw.urlFor("svc"), {
			method: "POST",
			headers: head,
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		})
	).json()) as any;
	assert.deepEqual(
		filtered.result.tools.map((tool: any) => tool.name),
		["read_thing"],
	);
	const refused = (await (
		await fetch(gw.urlFor("svc"), {
			method: "POST",
			headers: head,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "write_thing", arguments: {} },
			}),
		})
	).json()) as any;
	assert.match(refused.error.message, /read-only/);
	const allowed = (await (
		await fetch(gw.urlFor("svc"), {
			method: "POST",
			headers: head,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "read_thing", arguments: {} },
			}),
		})
	).json()) as any;
	assert.deepEqual(allowed.result, { ok: true });
	const batch = [
		{ jsonrpc: "2.0", id: 1, method: "tools/list" },
		{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_thing" } },
	];
	const batched = (await (
		await fetch(gw.urlFor("svc"), { method: "POST", headers: head, body: JSON.stringify(batch) })
	).json()) as any;
	assert.match(batched.error.message, /read-only/);
});

test("gateway retries once on a 401 after the credential hook refreshes", async (t) => {
	let hits = 0;
	const upstream = createServer((_req, res) => {
		hits += 1;
		if (hits === 1) {
			res.writeHead(401);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"ok":true}');
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	let refreshes = 0;
	const gw = createGateway({
		credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }),
		readOnly: () => false,
		onUnauthorized: async () => {
			refreshes += 1;
			return true;
		},
	});
	await gw.listen();
	t.after(() => gw.close());
	const response = await fetch(gw.urlFor("svc"), {
		method: "POST",
		headers: { Authorization: `Bearer ${gw.nonce}`, "content-type": "application/json" },
		body: "{}",
	});
	assert.equal(response.status, 200);
	assert.equal(hits, 2);
	assert.equal(refreshes, 1);
});

test("a 401 that refresh cannot fix answers the call with a sign-in reason", async (t) => {
	let hits = 0;
	const upstream = createServer((req, res) => {
		hits += 1;
		req.resume();
		req.on("end", () => {
			res.writeHead(401, { "www-authenticate": "Bearer" });
			res.end();
		});
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	let refreshes = 0;
	const gw = createGateway({
		credential: () => ({ url: `http://127.0.0.1:${port}/mcp`, headers: {} }),
		readOnly: () => false,
		onUnauthorized: async () => {
			refreshes += 1;
			return false;
		},
	});
	await gw.listen();
	t.after(() => gw.close());
	const response = await fetch(gw.urlFor("notion"), {
		method: "POST",
		headers: { ...gw.headers(), accept: "application/json, text/event-stream", "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "notion-search" } }),
	});
	assert.equal(response.status, 200);
	const answer = (await response.json()) as any;
	assert.equal(answer.id, 7);
	assert.match(answer.error.message, /notion connector needs sign-in again.*request_connector/);
	assert.equal(refreshes, 1);
	assert.equal(hits, 1);
});

test("gateway keeps the entry path and merges queries", async (t) => {
	const seen: string[] = [];
	const upstream = createServer((req, res) => {
		seen.push(req.url ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"ok":true}');
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	const gw = createGateway({
		credential: () => ({ url: `http://127.0.0.1:${port}/mcp?key=K1`, headers: {} }),
		readOnly: () => false,
		onUnauthorized: async () => false,
	});
	await gw.listen();
	t.after(() => gw.close());
	const head = { Authorization: `Bearer ${gw.nonce}`, "content-type": "application/json" };
	await fetch(gw.urlFor("svc"), { method: "POST", headers: head, body: "{}" });
	assert.equal(seen.at(-1), "/mcp?key=K1");
	await fetch(`${gw.urlFor("svc")}?x=1&y=2`, { method: "POST", headers: head, body: "{}" });
	assert.equal(seen.at(-1), "/mcp?key=K1&x=1&y=2");
});

test("gateway destroys the upstream stream when the client disconnects", async (t) => {
	let upstreamDestroyed = false;
	const upstream = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("event: message\ndata: {}\n\n");
		res.on("close", () => {
			upstreamDestroyed = true;
		});
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	const gw = createGateway({
		credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }),
		readOnly: () => false,
		onUnauthorized: async () => false,
	});
	await gw.listen();
	t.after(() => gw.close());
	const controller = new AbortController();
	const response = await fetch(gw.urlFor("svc"), {
		headers: { Authorization: `Bearer ${gw.nonce}` },
		signal: controller.signal,
	});
	controller.abort();
	await response.body?.cancel().catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(upstreamDestroyed, true);
});

test("an upstream stream error cannot crash the engine", async (t) => {
	const upstream = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: {}\n\n");
		setTimeout(() => res.destroy(), 10);
	});
	const port = await listen(upstream);
	t.after(() => upstream.close());
	const gw = createGateway({
		credential: () => ({ url: `http://127.0.0.1:${port}`, headers: {} }),
		readOnly: () => false,
		onUnauthorized: async () => false,
	});
	await gw.listen();
	t.after(() => gw.close());
	const response = await fetch(gw.urlFor("svc"), {
		headers: { Authorization: `Bearer ${gw.nonce}` },
		signal: AbortSignal.timeout(1000),
	});
	await assert.rejects(
		response.text(),
		(error: unknown) => (error as Error).name !== "TimeoutError" && (error as Error).name !== "AbortError",
	);
});

// --- the engine (a small in-memory runtime for store and secrets) ----------

interface Harness {
	ctx: FakeContext;
	rt: Runtime & Record<string, any>;
	state: Record<string, any>;
	secrets: Map<string, string>;
	mounts: Array<{ config: any; disposed: boolean }>;
	warnings: unknown[][];
}

function runtime(
	t: TestContext,
	options: { saved?: Record<string, unknown>; secrets?: Array<[string, string]>; github?: unknown } = {},
): Harness {
	const ctx = fakeContext();
	const state = emptyTeam() as Record<string, any>;
	state.bots.m1 = { id: "m1", sessionId: "m1", name: "Chief", role: "Chief of Staff", instructions: "", createdAt: 1 };
	state.connectors = options.saved ?? {};
	const secrets = new Map<string, string>(options.secrets ?? []);
	const mounts: Array<{ config: any; disposed: boolean }> = [];
	const warnings: unknown[][] = [];
	const plugin = { name: "mcp-client", apply() {} };
	ctx.get = ((name: string) =>
		name === "loader"
			? { import: async () => ({ default: plugin }), unwrapExports: (mod: any) => mod.default }
			: undefined) as FakeContext["get"];
	(ctx as any).plugin = (_given: unknown, config: any) => {
		const mount = { config, disposed: false };
		mounts.push(mount);
		return {
			await: async () => {},
			dispose: () => {
				mount.disposed = true;
			},
		};
	};
	const rt = {
		ctx,
		state,
		config: { github: options.github ?? false },
		warn: (...args: unknown[]) => warnings.push([format(...args)]),
		load: async () => {},
		save: async () => {},
		readOnly: () => undefined,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		selfOf: (id?: string) => (id === undefined ? undefined : id === "m1" ? "m1" : undefined),
		chatOwners: new Map([["m1", "m1"]]),
		groupOwners: new Map(),
		teamTools: [],
		loadSecrets: async () => {},
		secretValue: (name: string) => secrets.get(name),
		secretEndpoint: async (endpoint: string, body: any) => {
			if (endpoint === "secret-set") secrets.set(body.name, body.value);
			else if (endpoint === "secret-delete") secrets.delete(body.name);
		},
		deliver: async () => {},
		reapplyToolMasks: () => {},
		sessionFolder: () => undefined,
	} as unknown as Runtime & Record<string, any>;
	install(rt);
	t.after(async () => {
		await ctx.dispose();
	});
	return { ctx, rt, state, secrets, mounts, warnings };
}

test("refresh is single-flight, rotates the refresh token, and invalid_grant means sign-in again", async (t) => {
	const { rt, state, secrets, warnings } = runtime(t, {
		saved: {
			notion: {
				oauth: { authorizationServerUrl: "https://as.test", resource: "https://mcp.test/mcp", scope: "s" },
				client: { via: "dcr", clientId: "dcr-1" },
			},
		},
		secrets: [["CONNECTOR_NOTION_REFRESH", "RT-1"]],
	});
	let grants = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const wanted = String(url);
		if (wanted.includes("oauth-authorization-server")) return json(AS);
		if (wanted === "https://as.test/token") {
			grants += 1;
			return json({ access_token: `AT-${grants}`, refresh_token: `RT-${grants + 1}`, token_type: "Bearer" });
		}
		throw new Error(`unfaked ${wanted}`);
	};
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const internals = rt.connectorsInternals as any;
	const [a, b] = await Promise.all([internals.refreshConnector("notion"), internals.refreshConnector("notion")]);
	assert.equal(a, true, JSON.stringify(internals.statuses.get("notion")));
	assert.equal(b, true);
	assert.equal(grants, 1);
	assert.equal(secrets.get("CONNECTOR_NOTION_REFRESH"), "RT-2");
	assert.ok(warnings.some((args) => /connector notion token refresh succeeded.*dcr/.test(String(args))));
	assert.equal(JSON.stringify(warnings).includes("RT-2"), false);

	// invalid_grant on the next refresh: needs-sign-in, old secrets kept.
	globalThis.fetch = async (url) =>
		String(url) === "https://as.test/token" ? json({ error: "invalid_grant" }, 400) : json(AS);
	assert.equal(await internals.refreshConnector("notion"), false);
	assert.equal(
		internals.statuses.get("notion").state,
		"needs-sign-in",
		JSON.stringify(internals.statuses.get("notion")),
	);
	assert.equal(secrets.get("CONNECTOR_NOTION_REFRESH"), "RT-2");
	assert.ok(warnings.some((args) => /connector notion token refresh failed.*dcr/.test(String(args))));
	assert.equal(JSON.stringify(warnings).includes("RT-2"), false);
	assert.equal(state.connectors.notion.client.via, "dcr");
});

test("connector-set offFor yields deny prefixes for that Bot only", async (t) => {
	const { rt } = runtime(t);
	await rt.connectorEndpoint("connector-set", { id: "notion", offFor: ["m1"] });
	assert.deepEqual(rt.connectorOffFor("m1"), ["mcp__notion__"]);
	assert.deepEqual(rt.connectorOffFor("other"), []);
	await assert.rejects(rt.connectorEndpoint("connector-connect", { id: "nonexistent" }), /No such connector/);
});

test("custom connectors get unique ids that never collide with the catalog, and mount through the gateway", async (t) => {
	const { rt, mounts } = runtime(t);
	await rt.connectorEndpoint("connector-add", { name: "GitHub Mirror", url: "https://mcp.example.com/x" });
	const second = (await rt.connectorEndpoint("connector-add", {
		name: "Notion",
		url: "https://mcp.example.com/y",
	})) as any;
	const ids = second.connectors.filter((row: any) => row.custom).map((row: any) => row.id);
	assert.equal(ids.length, 2);
	assert.ok(!ids.includes("github") && !ids.includes("notion"));
	assert.equal(new Set(ids).size, 2);
	assert.ok(ids.every((id: string) => /^[a-z0-9-]{1,32}$/.test(id)));
	assert.ok(ids.every((id: string) => mounts.some((mount) => mount.config.serverName === id)));
});

test("import scan returns env names only and never writes the source files", async (t) => {
	const fakeHome = mkdtempSync(join(tmpdir(), "ocean-crew-fakehome-"));
	const appData = join(fakeHome, "AppData", "Roaming");
	const dirs = [
		join(fakeHome, "Library", "Application Support", "Claude"),
		join(fakeHome, ".config", "Claude"),
		join(appData, "Claude"),
	];
	for (const dir of dirs) mkdirSync(dir, { recursive: true });
	const configPath = join(dirs[0], "claude_desktop_config.json");
	const contents = JSON.stringify({
		mcpServers: {
			jira: { command: "npx", args: ["-y", "jira-mcp"], env: { JIRA_TOKEN: "RAW-SECRET" } },
			docs: { url: "https://docs.example.com/mcp" },
		},
	});
	for (const dir of dirs) writeFileSync(join(dir, "claude_desktop_config.json"), contents);
	const before = readFileSync(configPath, "utf8");
	const realHome = process.env.HOME;
	const realAppData = process.env.APPDATA;
	process.env.HOME = fakeHome;
	process.env.APPDATA = appData;
	t.after(() => {
		process.env.HOME = realHome;
		if (realAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = realAppData;
		rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5 });
	});
	const { rt, secrets } = runtime(t);
	const scanned = (await rt.connectorEndpoint("connector-import-scan", {})) as any[];
	const jira = scanned.find((entry) => entry.name === "jira");
	assert.deepEqual(jira?.envNames, ["JIRA_TOKEN"]);
	assert.equal(JSON.stringify(scanned).includes("RAW-SECRET"), false);
	const imported = (await rt.connectorEndpoint("connector-import", {
		items: [{ source: "claude", name: "jira" }],
	})) as any;
	assert.equal(imported.created.length, 1);
	assert.equal(secrets.get(`CONNECTOR_${String(imported.created[0]).toUpperCase()}_JIRA_TOKEN`), "RAW-SECRET");
	assert.equal(readFileSync(configPath, "utf8"), before);
});

test("connector-sign-in-code refuses a wrong state and accepts the pasted URL or bare code", async (t) => {
	const { rt, secrets } = runtime(t);
	const internals = rt.connectorsInternals as any;
	internals.pendings.set("notion", {
		kind: "browser",
		expectedState: "STATE1",
		codeVerifier: "v",
		redirectUri: "http://127.0.0.1:9/callback",
		discovery: { authorizationServerUrl: "https://as.test", metadata: AS, resource: "https://mcp.test/mcp" },
		clientInformation: { client_id: "c1" },
		timer: setTimeout(() => {}, 60_000),
		listener: { close: (callback?: () => void) => callback?.() },
	});
	await assert.rejects(
		rt.connectorEndpoint("connector-sign-in-code", { id: "notion", input: "http://x/?code=C&state=WRONG" }),
		/state/i,
	);
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) =>
		String(url) === "https://as.test/token" ? json({ access_token: "AT-9", token_type: "Bearer" }) : notFound();
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	await rt.connectorEndpoint("connector-sign-in-code", { id: "notion", input: "http://x/?code=C&state=STATE1" });
	assert.equal(secrets.get("CONNECTOR_NOTION_TOKEN"), "AT-9");
});
