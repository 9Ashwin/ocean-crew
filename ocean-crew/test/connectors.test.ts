// Connector engine behavior: token sign-in asks GitHub, a connected service mounts its
// MCP server through the local gateway, credentials stay in Secrets (never in the mount
// config or the saved team), and disconnecting or dropping the secret unmounts. The

// installs in parallel.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { install, signIn } from "../src/host/connectors/index.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { emptyTeam } from "../src/shared/state.ts";
import { type FakeContext, fakeContext } from "./fake-ctx.ts";

const answer = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Harness {
	ctx: FakeContext;
	rt: Runtime & Record<string, any>;
	state: Record<string, any>;
	secrets: Map<string, string>;
	mounts: Array<{ config: any; disposed: boolean }>;
	warnings: unknown[][];
}

function runtime(t: TestContext, options: { github?: unknown; failMount?: boolean } = {}): Harness {
	const ctx = fakeContext();
	const state = emptyTeam() as Record<string, any>;
	state.bots.m1 = { id: "m1", sessionId: "m1", name: "Chief", role: "Chief of Staff", instructions: "", createdAt: 1 };
	const secrets = new Map<string, string>();
	const mounts: Array<{ config: any; disposed: boolean }> = [];
	const warnings: unknown[][] = [];
	const chatOwners = new Map([["m1", "m1"]]);
	const groupOwners = new Map<string, { botId: string; roomId: string }>();
	const plugin = { name: "mcp-client", apply() {} };
	ctx.get = ((name: string) =>
		name === "loader"
			? { import: async () => ({ default: plugin }), unwrapExports: (mod: any) => mod.default }
			: undefined) as FakeContext["get"];
	(ctx as any).plugin = (_given: unknown, config: any) => {
		const mount = { config, disposed: false };
		mounts.push(mount);
		return {
			await: async () => {
				if (options.failMount === true) throw new Error(`refused ${config.headers?.Authorization ?? ""}`);
			},
			dispose: () => {
				mount.disposed = true;
			},
		};
	};
	const rt = {
		ctx,
		state,
		config: { github: options.github ?? false },
		warn: (...args: unknown[]) => warnings.push(args),
		load: async () => {},
		save: async () => {},
		readOnly: () => undefined,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		selfOf: (id?: string) => (id === undefined ? undefined : (chatOwners.get(id) ?? groupOwners.get(id)?.botId)),
		chatOwners,
		groupOwners,
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

const settle = async (check: () => boolean): Promise<void> => {
	for (let index = 0; index < 100; index += 1) {
		if (check()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("the connector engine did not settle");
};

const freshToken = (): string => `ghp_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;

test("signIn asks GitHub who owns the token", async () => {
	const token = freshToken();
	let seen: { url: string; init: RequestInit } | undefined;
	const user = await signIn(token, {
		api: "https://gh.test/",
		fetch: async (url, init) => {
			seen = { url: String(url), init: init ?? {} };
			return answer(200, { login: "octo" });
		},
	});
	assert.deepEqual(user, { login: "octo" });
	assert.equal(seen?.url, "https://gh.test/user");
	const headers = seen?.init.headers as Record<string, string>;
	assert.equal(headers.Authorization, `Bearer ${token}`);
	await assert.rejects(signIn(token, { fetch: async () => answer(401, {}) }), /did not accept/);
	await assert.rejects(signIn(token, { fetch: async () => answer(500, {}) }), /GitHub answered 500/);
	await assert.rejects(
		signIn(token, {
			fetch: async () => {
				throw new Error(`boom ${token}`);
			},
		}),
		/^Error: Could not reach GitHub$/,
	);
});

test("connecting saves the token, kept out of every mount, and mounts GitHub MCP; disconnecting undoes both", async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	globalThis.fetch = async () => answer(200, { login: "octo" });
	const { rt, state, secrets, mounts } = runtime(t, { github: { api: "https://gh.test" } });
	const token = freshToken();
	assert.equal((rt.connectorsView() as any).connectors.find((row: any) => row.id === "github").state, "off");
	const connected = (await rt.connectorEndpoint("connector-connect", { id: "github", token: ` ${token} ` })) as any;
	const github = connected.connectors.find((row: any) => row.id === "github");
	assert.equal(github.state, "ready");
	assert.equal(github.account, "octo");
	assert.equal(mounts.length, 1);
	// The mount points at the local gateway; the token never reaches its config.
	assert.equal(mounts[0].config.transport, "streamable-http");
	assert.equal(mounts[0].config.serverName, "github");
	assert.match(String(mounts[0].config.url), /^http:\/\/127\.0\.0\.1:\d+\/c\/github$/);
	assert.equal(JSON.stringify(mounts[0].config).includes(token), false);
	assert.match(String(mounts[0].config.headers.Authorization), /^Bearer /);
	assert.equal(String(mounts[0].config.headers.Authorization).includes(token), false);
	assert.equal(secrets.get("GITHUB_TOKEN"), token);
	assert.equal(JSON.stringify(state).includes(token), false);

	const off = (await rt.connectorEndpoint("connector-disconnect", { id: "github" })) as any;
	assert.equal(off.connectors.find((row: any) => row.id === "github").state, "off");
	assert.equal(mounts[0].disposed, true);
	assert.equal(secrets.size, 0);
});

test("a token GitHub refuses is not saved", async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	globalThis.fetch = async () => answer(401, {});
	const { rt, secrets, mounts } = runtime(t, { github: { api: "https://gh.test" } });
	await assert.rejects(
		rt.connectorEndpoint("connector-connect", { id: "github", token: freshToken() }),
		/did not accept/,
	);
	assert.equal(mounts.length, 0);
	assert.equal(secrets.size, 0);
});

test("a failed MCP connection shows the error without the token, and Try again mounts again", async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	globalThis.fetch = async () => answer(200, { login: "octo" });
	const { rt, mounts } = runtime(t, { github: { api: "https://gh.test" }, failMount: true });
	const token = freshToken();
	const view = (await rt.connectorEndpoint("connector-connect", { id: "github", token })) as any;
	const github = view.connectors.find((row: any) => row.id === "github");
	assert.equal(github.state, "error");
	assert.equal(String(github.error).includes(token), false);
	assert.match(String(github.error), /refused/);
	await rt.connectorEndpoint("connector-retry", { id: "github" });
	assert.equal(mounts.length, 2);
});

test("deleting GITHUB_TOKEN on the Secrets page unmounts GitHub", async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	globalThis.fetch = async () => answer(200, { login: "octo" });
	const { rt, secrets, mounts } = runtime(t, { github: { api: "https://gh.test" } });
	await rt.connectorEndpoint("connector-connect", { id: "github", token: freshToken() });
	assert.equal(mounts.length, 1);
	secrets.delete("GITHUB_TOKEN");
	rt.secretsChanged?.();
	await settle(() => mounts[0].disposed);
	const view = rt.connectorsView() as any;
	assert.equal(view.connectors.find((row: any) => row.id === "github").state, "off");
});

test("github: false hides only the GitHub connector", async (t) => {
	const { rt } = runtime(t);
	const rows = (rt.connectorsView() as any).connectors;
	assert.equal(
		rows.find((row: any) => row.id === "github"),
		undefined,
	);
	assert.ok(rows.length > 0);
});

test("a GitHub address without https refuses to send the token", async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	let asked = false;
	globalThis.fetch = async () => {
		asked = true;
		return answer(200, { login: "octo" });
	};
	const { rt, mounts } = runtime(t, { github: { url: "http://mcp.test/", api: "https://gh.test" } });
	await assert.rejects(rt.connectorEndpoint("connector-connect", { id: "github", token: freshToken() }), /https/);
	assert.equal(asked, false);
	assert.equal(mounts.length, 0);
});
