// OAuth sign-in pieces for connectors, on fake fetches: discovery (WWW-Authenticate,
// well-known, origin fallback), client resolution (catalog → CIMD → DCR), browser PKCE,
// exchange/refresh, and the GitHub device flow. No network leaves the test process.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as oauth from "../src/host/connectors/oauth.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const notFound = (): Response => new Response("not found", { status: 404 });
type Request = (url: string, init?: RequestInit) => Promise<Response>;
const asFetch =
	(request: Request): oauth.FetchFn =>
	(url, init) =>
		request(String(url), init);

const AS: oauth.AuthorizationServerMetadata = {
	issuer: "https://as.test",
	authorization_endpoint: "https://as.test/auth",
	token_endpoint: "https://as.test/token",
	registration_endpoint: "https://as.test/register",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
};

test("discovery follows WWW-Authenticate, well-known, and the MCP origin fallback", async () => {
	// WWW-Authenticate points at the PRM; the PRM names the AS.
	const request: Request = async (url, init = {}) => {
		if (url === "https://mcp.test/mcp" && init.headers === undefined)
			return new Response("", {
				status: 401,
				headers: {
					"WWW-Authenticate":
						'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="mcp:all"',
				},
			});
		if (url === "https://mcp.test/.well-known/oauth-protected-resource/mcp")
			return json({
				resource: "https://mcp.test/mcp",
				authorization_servers: ["https://as.test"],
				scopes_supported: ["mcp:all"],
			});
		if (url === "https://as.test/.well-known/oauth-authorization-server") return json(AS);
		throw new Error(`unfaked ${url}`);
	};
	const found = await oauth.discover("https://mcp.test/mcp", { fetch: asFetch(request) });
	assert.equal(found.authorizationServerUrl, "https://as.test");
	assert.equal(found.metadata?.token_endpoint, "https://as.test/token");
	assert.equal(found.scope, "mcp:all");
	assert.equal(found.resource, "https://mcp.test/mcp");

	// No challenge: well-known PRM on the origin still works.
	const request2: Request = async (url) => {
		if (url === "https://mcp.test/mcp") return new Response("", { status: 401 });
		if (url === "https://mcp.test/.well-known/oauth-protected-resource/mcp")
			return json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://as2.test"] });
		if (url === "https://as2.test/.well-known/oauth-authorization-server")
			return json({ ...AS, issuer: "https://as2.test" });
		throw new Error(`unfaked ${url}`);
	};
	const found2 = await oauth.discover("https://mcp.test/mcp", { fetch: asFetch(request2) });
	assert.equal(found2.authorizationServerUrl, "https://as2.test");

	// Older servers: no PRM at all — AS metadata on the MCP origin.
	const request3: Request = async (url) => {
		if (url === "https://mcp.test/mcp") return new Response("", { status: 401 });
		if (url.includes("oauth-protected-resource")) return notFound();
		if (url === "https://mcp.test/.well-known/oauth-authorization-server")
			return json({ ...AS, issuer: "https://mcp.test" });
		throw new Error(`unfaked ${url}`);
	};
	const found3 = await oauth.discover("https://mcp.test/mcp", { fetch: asFetch(request3) });
	assert.equal(found3.metadata?.issuer, "https://mcp.test");
});

test("an address that is not https is refused before any request", async () => {
	let asked = false;
	await assert.rejects(
		oauth.discover("http://mcp.test/mcp", {
			fetch: async () => {
				asked = true;
				return notFound();
			},
		}),
		/https/,
	);
	assert.equal(asked, false);
});

test("client resolution: CIMD only on the fixed port, DCR fallback, re-registration, needs-client", async () => {
	const discovery: oauth.Discovery = {
		authorizationServerUrl: "https://as.test",
		metadata: { ...AS, client_id_metadata_document_supported: true },
		scope: "s",
		resource: "r",
	};
	const entry = { auth: { kind: "oauth" as const } };
	const cimd = await oauth.resolveClient(entry, discovery, "http://127.0.0.1:38517/callback", true);
	assert.equal(cimd?.via, "cimd");
	assert.equal(cimd?.clientInformation.client_id, "https://dsbot.app/oauth/client.json");
	// A random port cannot use the metadata document: DCR.
	let persisted: oauth.StoredClient | undefined;
	const request: Request = async (url, init) => {
		if (url === "https://as.test/register")
			return json({
				client_id: "dcr-1",
				client_secret: "sec",
				redirect_uris: JSON.parse(String(init?.body)).redirect_uris,
			});
		throw new Error(`unfaked ${url}`);
	};
	const dcr = await oauth.resolveClient(entry, discovery, "http://127.0.0.1:9/callback", false, undefined, {
		fetch: asFetch(request),
		persist: async (info) => {
			persisted = info;
		},
	});
	assert.equal(dcr?.via, "dcr");
	assert.equal(dcr?.clientInformation.client_secret, "sec");
	assert.equal(persisted?.clientId, "dcr-1");
	assert.deepEqual(persisted?.redirectUris, ["http://127.0.0.1:9/callback"]);
	// Stored client is reused when the redirect URI matches…
	const stored: oauth.StoredClient = {
		via: "dcr",
		clientId: "dcr-1",
		redirectUris: ["http://127.0.0.1:9/callback"],
	};
	const reused = await oauth.resolveClient(entry, discovery, "http://127.0.0.1:9/callback", false, stored, {
		fetch: asFetch(request),
	});
	assert.equal(reused?.clientInformation.client_id, "dcr-1");
	// …and a new redirect URI re-registers.
	await oauth.resolveClient(entry, discovery, "http://127.0.0.1:22/callback", false, stored, {
		fetch: asFetch(request),
		persist: async (info) => {
			persisted = info;
		},
	});
	assert.equal(persisted?.redirectUris?.[0], "http://127.0.0.1:22/callback");
	// No CIMD and no DCR: needs-client.
	const none = await oauth.resolveClient(
		entry,
		{ ...discovery, metadata: { authorization_endpoint: "a", token_endpoint: "t" } },
		"http://127.0.0.1:9/callback",
		false,
	);
	assert.equal(none, null);
	// A catalog client always wins.
	const catalog = await oauth.resolveClient(
		{ auth: { kind: "oauth", client: { id: "ghc" } } },
		discovery,
		"http://x",
		false,
	);
	assert.equal(catalog?.clientInformation.client_id, "ghc");
});

test("a stored CIMD client is reused only with the fixed port", async () => {
	const discovery: oauth.Discovery = {
		authorizationServerUrl: "https://as.test",
		metadata: { ...AS, client_id_metadata_document_supported: true },
		resource: "r",
	};
	const entry = { auth: { kind: "oauth" as const } };
	const stored: oauth.StoredClient = {
		via: "cimd",
		clientId: "https://dsbot.app/oauth/client.json",
		redirectUris: [],
	};
	const fixed = await oauth.resolveClient(entry, discovery, "http://127.0.0.1:38517/callback", true, stored);
	assert.equal(fixed?.via, "cimd");
	const request: Request = async (url, init) =>
		url === "https://as.test/register"
			? json({ client_id: "dcr-9", redirect_uris: JSON.parse(String(init?.body)).redirect_uris })
			: notFound();
	const random = await oauth.resolveClient(entry, discovery, "http://127.0.0.1:9/callback", false, stored, {
		fetch: asFetch(request),
	});
	assert.equal(random?.via, "dcr");
});

test("browser PKCE carries state, challenge, and resource; tokens exchange and refresh", async () => {
	const discovery: oauth.Discovery = {
		authorizationServerUrl: "https://as.test",
		metadata: AS,
		scope: "mcp:all",
		resource: "https://mcp.test/mcp",
	};
	const client = { client_id: "dcr-1" };
	const { url, codeVerifier } = await oauth.beginBrowser(discovery, client, "http://127.0.0.1:9/callback", {
		state: "STATE",
	});
	const auth = new URL(url);
	assert.equal(auth.searchParams.get("state"), "STATE");
	assert.equal(auth.searchParams.get("client_id"), "dcr-1");
	assert.equal(auth.searchParams.get("redirect_uri"), "http://127.0.0.1:9/callback");
	assert.equal(auth.searchParams.get("resource"), "https://mcp.test/mcp");
	assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
	assert.ok((auth.searchParams.get("code_challenge") ?? "").length > 20);
	let grant: Record<string, string> = {};
	const request: Request = async (url2, init) => {
		if (url2 === "https://as.test/token") {
			grant = Object.fromEntries(new URLSearchParams(String(init?.body)));
			return json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" });
		}
		throw new Error(`unfaked ${url2}`);
	};
	const tokens = await oauth.exchange(
		discovery,
		client,
		{ code: "CODE", codeVerifier, redirectUri: "http://127.0.0.1:9/callback" },
		{ fetch: asFetch(request) },
	);
	assert.equal(tokens.access_token, "AT");
	assert.equal(grant.grant_type, "authorization_code");
	assert.equal(grant.code_verifier, codeVerifier);
	assert.equal(grant.resource, "https://mcp.test/mcp");
	const rotated = await oauth.refreshTokens(discovery, client, "RT", { fetch: asFetch(request) });
	assert.equal(rotated.access_token, "AT");
	assert.equal(grant.grant_type, "refresh_token");
	assert.equal(grant.refresh_token, "RT");
	// A token endpoint error carries the OAuth error code.
	await assert.rejects(
		oauth.refreshTokens(discovery, client, "RX", {
			fetch: async () => json({ error: "invalid_grant" }, 400),
		}),
		(error: unknown) => oauth.invalidGrant(error),
	);
});

test("rediscover reads the stored authorization server's metadata again", async () => {
	const request: Request = async (url) => {
		if (url === "https://as.test/.well-known/oauth-authorization-server") return json(AS);
		throw new Error(`unfaked ${url}`);
	};
	const found = await oauth.rediscover(
		{ authorizationServerUrl: "https://as.test", resource: "https://mcp.test/mcp", scope: "s" },
		{ fetch: asFetch(request) },
	);
	assert.equal(found.metadata?.token_endpoint, "https://as.test/token");
	assert.equal(found.resource, "https://mcp.test/mcp");
	assert.equal(found.scope, "s");
});

test("device flow: begin and poll honor authorization_pending and slow_down", async () => {
	let polls = 0;
	const request: Request = async (url) => {
		if (url === "https://fake.test/device/code")
			return json({
				device_code: "DC",
				user_code: "ABCD-1234",
				verification_uri: "https://fake.test/device",
				interval: 0.05,
				expires_in: 600,
			});
		if (url === "https://fake.test/token") {
			polls += 1;
			if (polls === 1) return json({ error: "authorization_pending" });
			if (polls === 2) return json({ error: "slow_down" });
			return json({ access_token: "GHT" });
		}
		throw new Error(`unfaked ${url}`);
	};
	const endpoints = { deviceCode: "https://fake.test/device/code", accessToken: "https://fake.test/token" };
	const device = await oauth.deviceBegin("test-gh-client", "repo read:org", { fetch: asFetch(request), endpoints });
	assert.equal(device.userCode, "ABCD-1234");
	assert.equal(
		(await oauth.devicePoll("test-gh-client", device, { fetch: asFetch(request), endpoints })).state,
		"pending",
	);
	assert.equal(
		(await oauth.devicePoll("test-gh-client", device, { fetch: asFetch(request), endpoints })).state,
		"slow_down",
	);
	const done = await oauth.devicePoll("test-gh-client", device, { fetch: asFetch(request), endpoints });
	assert.equal(done.state, "done");
	assert.equal(done.state === "done" ? done.token : undefined, "GHT");
	assert.equal(oauth.invalidGrant({ error: "invalid_grant" }), true);
	assert.equal(oauth.invalidGrant({ error: "temporarily_unavailable" }), false);
	assert.equal(oauth.invalidGrant(new Error("invalid_grant: token revoked")), true);
	assert.equal(oauth.invalidGrant(new Error("network down")), false);
});
