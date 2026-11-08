// OAuth sign-in for connectors: protected-resource and authorization-server discovery,
// client resolution (catalog → CIMD → DCR), browser PKCE, token exchange and refresh,
// and the GitHub device flow.

// the GitHub device flow) on fetch and node:crypto, so the host carries no private
// dependency for sign-in.
import { createHash, randomBytes } from "node:crypto";

const TIMEOUT_MS = 20_000;
// The loopback port the client-metadata document at this address may name.
export const FIXED_CALLBACK_PORT = 38517;
export const CIMD_CLIENT_ID = "https://dsbot.app/oauth/client.json";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface AuthorizationServerMetadata {
	issuer?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	response_types_supported?: string[];
	grant_types_supported?: string[];
	code_challenge_methods_supported?: string[];
	client_id_metadata_document_supported?: boolean;
	[key: string]: unknown;
}

export interface ProtectedResourceMetadata {
	resource?: string;
	authorization_servers?: string[];
	scopes_supported?: string[];
	[key: string]: unknown;
}

export interface ClientInformation {
	client_id: string;
	client_secret?: string;
}

export interface Discovery {
	authorizationServerUrl: string;
	metadata?: AuthorizationServerMetadata;
	resourceMetadata?: ProtectedResourceMetadata;
	scope?: string;
	resource: string;
}

/** The connector client state saved on the row; `via` says how the client was found. */
/** The connector fields client resolution reads; catalog entries fit structurally. */
export interface ClientResolutionEntry {
	auth?: { kind?: string; client?: { id?: string } };
	[key: string]: unknown;
}

export interface StoredClient {
	via?: string;
	clientId?: string;
	clientSecret?: string;
	redirectUris?: string[];
	secretExpiresAt?: number;
}

export interface TokenSet {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	[key: string]: unknown;
}

const timed =
	(request: FetchFn = fetch): FetchFn =>
	(url, init) =>
		request(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) });

const https = (url: unknown, what: string): void => {
	if (!/^https:\/\//i.test(String(url))) throw new Error(`${what} addresses must start with https://`);
};

const isRecord = (value: unknown): value is Record<string, any> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const jsonOf = async (response: Response): Promise<Record<string, any> | undefined> => {
	try {
		const body: unknown = await response.json();
		return isRecord(body) ? body : undefined;
	} catch {
		return undefined;
	}
};

// A quoted parameter from a WWW-Authenticate header, e.g. resource_metadata="…".
const authParam = (header: string, name: string): string | undefined => {
	const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(header);
	return match?.[1];
};

const wellKnownProtected = (serverUrl: string): string[] => {
	const url = new URL(serverUrl);
	const path = url.pathname.replace(/\/$/, "");
	return [
		`${url.origin}/.well-known/oauth-protected-resource${path}`,
		`${url.origin}/.well-known/oauth-protected-resource`,
	];
};

const wellKnownAuthorizationServer = (asUrl: string): string[] => {
	const url = new URL(asUrl);
	const path = url.pathname.replace(/\/$/, "");
	const base = asUrl.replace(/\/$/, "");
	return [
		`${url.origin}/.well-known/oauth-authorization-server${path}`,
		`${url.origin}/.well-known/openid-configuration${path}`,
		`${base}/.well-known/oauth-authorization-server`,
		`${base}/.well-known/openid-configuration`,
	];
};

async function discoverProtectedResource(
	serverUrl: string,
	resourceMetadataUrl: string | undefined,
	send: FetchFn,
): Promise<ProtectedResourceMetadata | undefined> {
	const candidates = resourceMetadataUrl === undefined ? wellKnownProtected(serverUrl) : [resourceMetadataUrl];
	for (const candidate of candidates) {
		try {
			const response = await send(candidate, { headers: { Accept: "application/json" } });
			if (!response.ok) continue;
			const body = await jsonOf(response);
			if (body !== undefined) return body;
		} catch {
			// Try the next well-known address.
		}
	}
	return undefined;
}

// The AS metadata; a document whose issuer names another server is accepted only when
// nothing better was found, as the SDK's skipIssuerValidation retry did.
async function discoverAuthorizationServer(
	asUrl: string,
	send: FetchFn,
): Promise<AuthorizationServerMetadata | undefined> {
	let mismatched: AuthorizationServerMetadata | undefined;
	for (const candidate of wellKnownAuthorizationServer(asUrl)) {
		try {
			const response = await send(candidate, { headers: { Accept: "application/json" } });
			if (!response.ok) continue;
			const body = await jsonOf(response);
			if (body === undefined) continue;
			if (typeof body.issuer !== "string" || body.issuer.replace(/\/$/, "") === asUrl.replace(/\/$/, ""))
				return body;
			mismatched ??= body;
		} catch {
			// Try the next well-known address.
		}
	}
	return mismatched;
}

// Probes the MCP server and resolves the authorization server and its metadata.
export async function discover(
	serverUrl: string,
	{ fetch: request = fetch, originFallback = true }: { fetch?: FetchFn; originFallback?: boolean } = {},
): Promise<Discovery> {
	const send = timed(request);
	https(serverUrl, "Connector");
	let resourceMetadataUrl: string | undefined;
	let challengeScope: string | undefined;
	try {
		const probe = await send(serverUrl, {
			method: "POST",
			headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
			body: "{}",
		});
		if (probe.status === 401 || probe.status === 403) {
			const challenge = probe.headers.get("www-authenticate") ?? "";
			resourceMetadataUrl = authParam(challenge, "resource_metadata");
			challengeScope = authParam(challenge, "scope");
		}
	} catch {
		// Discovery below still tries the well-known paths.
	}
	const resourceMetadata = await discoverProtectedResource(serverUrl, resourceMetadataUrl, send);
	// Older servers publish AS metadata on the MCP origin with no protected-resource doc.
	const asUrl =
		resourceMetadata?.authorization_servers?.[0] ?? (originFallback ? new URL(serverUrl).origin : serverUrl);
	const metadata = await discoverAuthorizationServer(String(asUrl), send);
	const scope = challengeScope ?? resourceMetadata?.scopes_supported?.join(" ");
	return {
		authorizationServerUrl: String(asUrl),
		metadata,
		resourceMetadata,
		scope,
		// RFC 8707: the resource parameter always goes out; the PRM's own id wins.
		resource: resourceMetadata?.resource ?? String(serverUrl),
	};
}

async function registerClient(
	metadata: AuthorizationServerMetadata,
	clientMetadata: Record<string, unknown>,
	scope: string | undefined,
	send: FetchFn,
): Promise<{ client_id: string; client_secret?: string; redirect_uris?: string[]; client_secret_expires_at?: number }> {
	const registrationUrl = metadata.registration_endpoint;
	if (typeof registrationUrl !== "string") throw new Error("This service cannot register a client");
	const response = await send(registrationUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ ...clientMetadata, ...(scope !== undefined ? { scope } : {}) }),
	});
	const body = await jsonOf(response);
	if (!response.ok || typeof body?.client_id !== "string") {
		throw new Error(
			typeof body?.error_description === "string"
				? body.error_description
				: `Client registration was refused (${response.status})`,
		);
	}
	return body as {
		client_id: string;
		client_secret?: string;
		redirect_uris?: string[];
		client_secret_expires_at?: number;
	};
}

// Picks how this attempt identifies itself to the AS. Returns null when nothing works —
// the row then shows the client form. `stored` is the client state saved last time;
// `persist` writes DCR results.
export async function resolveClient(
	entry: ClientResolutionEntry,
	discovery: Discovery,
	redirectUri: string,
	fixedPort: boolean,
	stored?: StoredClient,
	{ fetch: request = fetch, persist }: { fetch?: FetchFn; persist?: (client: StoredClient) => Promise<void> } = {},
): Promise<{ via: string; clientInformation: ClientInformation } | null> {
	const catalogClient = entry.auth?.client?.id;
	if (catalogClient) return { via: "catalog", clientInformation: { client_id: catalogClient } };
	if (stored?.clientId) {
		const expired = Number.isFinite(stored.secretExpiresAt) && (stored.secretExpiresAt ?? 0) * 1000 <= Date.now();
		const uriMissing = Array.isArray(stored.redirectUris) && !stored.redirectUris.includes(redirectUri);
		// A stored CIMD client still needs the fixed port its document names.
		if (!expired && !uriMissing && stored.via === "cimd" && fixedPort)
			return { via: "cimd", clientInformation: { client_id: stored.clientId } };
		if (!expired && !uriMissing && stored.via !== "dcr" && stored.via !== "cimd")
			return { via: stored.via ?? "manual", clientInformation: { client_id: stored.clientId } };
		if (!expired && !uriMissing && stored.via === "dcr")
			return {
				via: "dcr",
				clientInformation: {
					client_id: stored.clientId,
					...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
				},
			};
	}
	const metadata = discovery.metadata;
	if (metadata?.client_id_metadata_document_supported === true && fixedPort) {
		return { via: "cimd", clientInformation: { client_id: CIMD_CLIENT_ID } };
	}
	if (typeof metadata?.registration_endpoint === "string") {
		const clientMetadata = {
			client_name: "Ocean Crew",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
		const full = await registerClient(metadata, clientMetadata, discovery.scope, timed(request));
		const info: StoredClient = {
			via: "dcr",
			clientId: full.client_id,
			clientSecret: full.client_secret,
			redirectUris: full.redirect_uris ?? [redirectUri],
			secretExpiresAt: full.client_secret_expires_at,
		};
		await persist?.(info);
		return {
			via: "dcr",
			clientInformation: {
				client_id: full.client_id,
				...(full.client_secret ? { client_secret: full.client_secret } : {}),
			},
		};
	}
	return null;
}

const pkce = (): { verifier: string; challenge: string } => {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

// Browser PKCE: the S256 verifier and the URL the browser opens.
export async function beginBrowser(
	discovery: Discovery,
	clientInformation: ClientInformation,
	redirectUri: string,
	{ state, scope }: { state?: string; scope?: string } = {},
): Promise<{ url: string; codeVerifier: string }> {
	const endpoint = discovery.metadata?.authorization_endpoint;
	if (typeof endpoint !== "string") throw new Error("This service does not publish an authorization endpoint");
	const { verifier, challenge } = pkce();
	const url = new URL(endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", clientInformation.client_id);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	const wantedScope = scope ?? discovery.scope;
	if (wantedScope !== undefined) url.searchParams.set("scope", wantedScope);
	if (state !== undefined) url.searchParams.set("state", state);
	if (discovery.resource !== undefined) url.searchParams.set("resource", discovery.resource);
	return { url: String(url), codeVerifier: verifier };
}

const tokenError = (
	body: Record<string, any> | undefined,
	status: number,
): Error & { error?: unknown; code?: unknown } => {
	const error = new Error(
		String(body?.error_description ?? body?.error ?? `Token request failed (${status})`),
	) as Error & { error?: unknown; code?: unknown };
	error.error = body?.error;
	error.code = body?.error;
	return error;
};

async function postToken(
	discovery: Discovery,
	clientInformation: ClientInformation,
	params: Record<string, string>,
	request: FetchFn,
): Promise<TokenSet> {
	const endpoint = discovery.metadata?.token_endpoint;
	if (typeof endpoint !== "string") throw new Error("This service does not publish a token endpoint");
	const response = await timed(request)(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			...params,
			client_id: clientInformation.client_id,
			...(clientInformation.client_secret !== undefined ? { client_secret: clientInformation.client_secret } : {}),
		}).toString(),
	});
	const body = await jsonOf(response);
	if (!response.ok || typeof body?.access_token !== "string") throw tokenError(body, response.status);
	return body as TokenSet;
}

export async function exchange(
	discovery: Discovery,
	clientInformation: ClientInformation,
	{ code, codeVerifier, redirectUri, iss }: { code: string; codeVerifier: string; redirectUri: string; iss?: string },
	{ fetch: request = fetch }: { fetch?: FetchFn } = {},
): Promise<TokenSet> {
	return postToken(
		discovery,
		clientInformation,
		{
			grant_type: "authorization_code",
			code,
			code_verifier: codeVerifier,
			redirect_uri: redirectUri,
			...(discovery.resource !== undefined ? { resource: discovery.resource } : {}),
			...(iss !== undefined ? { iss } : {}),
		},
		request,
	);
}

const invalidGrant = (error: unknown): boolean => {
	const candidate = error as { error?: unknown; code?: unknown; name?: unknown; message?: unknown } | undefined;
	for (const field of [candidate?.error, candidate?.code, candidate?.name]) {
		if (typeof field === "string" && /invalid_grant/i.test(field)) return true;
	}
	return /invalid_grant/i.test(String(candidate?.message ?? error));
};
export { invalidGrant };

export async function refreshTokens(
	discovery: Discovery,
	clientInformation: ClientInformation,
	refreshToken: string,
	{ scope, fetch: request = fetch }: { scope?: string; fetch?: FetchFn } = {},
): Promise<TokenSet> {
	const wantedScope = scope ?? discovery.scope;
	const metadata =
		discovery.metadata ?? (await discoverAuthorizationServer(discovery.authorizationServerUrl, timed(request)));
	return postToken(
		{ ...discovery, metadata },
		clientInformation,
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			...(wantedScope !== undefined ? { scope: wantedScope } : {}),
			...(discovery.resource !== undefined ? { resource: discovery.resource } : {}),
		},
		request,
	);
}

// Re-discovers AS metadata for a stored authorization server (after a restart).
export async function rediscover(
	stored: { authorizationServerUrl: string; resource?: string; scope?: string },
	{ fetch: request = fetch }: { fetch?: FetchFn } = {},
): Promise<Discovery> {
	const send = timed(request);
	const metadata = await discoverAuthorizationServer(stored.authorizationServerUrl, send);
	return {
		authorizationServerUrl: stored.authorizationServerUrl,
		metadata,
		resource: stored.resource ?? stored.authorizationServerUrl,
		scope: stored.scope,
	};
}

// --- GitHub device flow -------------------------------------------------

const post = async (
	send: FetchFn,
	url: string,
	params: Record<string, string>,
): Promise<{ status: number; body: Record<string, any> }> => {
	const response = await send(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(params).toString(),
	});
	const body = await jsonOf(response);
	return { status: response.status, body: body ?? {} };
};

export interface DeviceEndpoints {
	deviceCode?: string;
	accessToken?: string;
}

export interface DeviceStart {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	interval: number;
	expiresAt: number;
}

export interface DeviceDevice extends DeviceStart {}

export async function deviceBegin(
	clientId: string,
	scope: string,
	{ fetch: request = fetch, endpoints }: { fetch?: FetchFn; endpoints?: DeviceEndpoints } = {},
): Promise<DeviceStart> {
	const send = timed(request);
	const codeUrl = endpoints?.deviceCode ?? "https://github.com/login/device/code";
	const { status, body } = await post(send, codeUrl, { client_id: clientId, ...(scope ? { scope } : {}) });
	if (status !== 200 || typeof body.device_code !== "string")
		throw new Error(body.error_description ?? `Device sign-in was refused (${status})`);
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: body.verification_uri ?? "https://github.com/login/device",
		interval: Number(body.interval) || 5,
		expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
	};
}

/** One poll step: `pending`, `slow_down`, `done` with a token, or `error` with a reason. */
export type DeviceStep =
	| { state: "pending" }
	| { state: "slow_down" }
	| { state: "done"; token: string; refreshToken?: string; expiresIn?: number }
	| { state: "error"; error: string };

export async function devicePoll(
	clientId: string,
	device: DeviceDevice,
	{ fetch: request = fetch, endpoints }: { fetch?: FetchFn; endpoints?: DeviceEndpoints } = {},
): Promise<DeviceStep> {
	const send = timed(request);
	const tokenUrl = endpoints?.accessToken ?? "https://github.com/login/oauth/access_token";
	const { status, body } = await post(send, tokenUrl, {
		client_id: clientId,
		device_code: device.deviceCode,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
	});
	if (status === 200 && typeof body.access_token === "string")
		return {
			state: "done",
			token: body.access_token,
			refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
			expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
		};
	const error = body.error;
	if (error === "authorization_pending") return { state: "pending" };
	if (error === "slow_down") return { state: "slow_down" };
	return {
		state: "error",
		error:
			typeof body.error_description === "string"
				? body.error_description
				: typeof error === "string"
					? error
					: `Sign-in failed (${status})`,
	};
}
