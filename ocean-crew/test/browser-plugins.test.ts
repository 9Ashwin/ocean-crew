// The browser plugin half of the host: the one plugin the whole team shares, the Chrome
// it drives, the app relay, the handoff hold, and the tool registration install performs.
// the window channel is browser.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserChannel } from "../src/host/browser/browser.ts";
import {
	appBrowserEndpoint,
	browserPlugins,
	defaultBrowserHeadless,
	handoffHold,
	install,
} from "../src/host/browser/browser-plugins.ts";
import type { Runtime, TeamTool } from "../src/host/core/runtime.ts";
import { fakeContext } from "./fake-ctx.ts";

interface FakeRuntime {
	rt: Runtime & Record<string, any>;
	home: string;
	ctx: ReturnType<typeof fakeContext>;
	stop(): void;
}

function browserRuntime(
	options: {
		config?: Record<string, any>;
		channel?: ReturnType<typeof createBrowserChannel>;
		deleteBot?: (id: string) => Promise<unknown>;
	} = {},
): FakeRuntime {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-browser-plugins-test-"));
	const ctx = fakeContext({ services: options.config?.services ?? {} });
	const bots: Record<string, any> = { b2: { id: "b2", name: "Writer" }, m1: { id: "m1", name: "Chief" } };
	const rt = {
		ctx,
		home,
		config: options.config ?? {},
		teamTools: [] as TeamTool[],
		chatOwners: new Map<string, string>([
			["b2", "b2"],
			["room-b2", "b2"],
			["m1", "m1"],
		]),
		load: async () => {},
		teamFolder: () => "/team",
		workDirOf: () => "/team/b2",
		isFolder: async () => false,
		selfOf: (id: unknown) => (id === "b2" || id === "m1" ? id : undefined),
		botOf: (id: string) => bots[id],
		deleteBot: options.deleteBot,
		browserChannel: options.channel,
	} as unknown as Runtime & Record<string, any>;
	return { rt, home, ctx, stop: () => rmSync(home, { recursive: true, force: true }) };
}

const toolNamed = (rt: Runtime, name: string): TeamTool => {
	const definition = rt.teamTools.find((tool) => tool.name === name);
	assert.ok(definition, `tool ${name} is registered`);
	assert.ok(definition.execute, `tool ${name} has an execute`);
	return definition;
};

// The app relay: process.send has to exist while the endpoint asks the app for a URL.
async function withAppRelay<T>(
	run: (sent: any[], answer: (index: number, message: Record<string, any>) => void) => Promise<T>,
): Promise<T> {
	const saved = { on: process.on, off: process.off, send: (process as any).send };
	const listeners: Array<(message: any) => void> = [];
	const sent: any[] = [];
	process.on = ((event: string, listener: (message: any) => void) => {
		if (event === "message") listeners.push(listener);
		return process;
	}) as typeof process.on;
	process.off = ((event: string, listener: (message: any) => void) => {
		const at = listeners.indexOf(listener);
		if (event === "message" && at !== -1) listeners.splice(at, 1);
		return process;
	}) as typeof process.off;
	(process as any).send = (message: any, callback?: (error: Error | null) => void) => {
		sent.push(message);
		callback?.(null);
		return true;
	};
	const answer = (index: number, message: Record<string, any>): void => {
		for (const listener of listeners) {
			listener({ type: "ocean-crew:browser-endpoint-response", id: sent[index]?.id, ...message });
		}
	};
	try {
		return await run(sent, answer);
	} finally {
		process.on = saved.on;
		process.off = saved.off;
		if (saved.send === undefined) delete (process as any).send;
		else (process as any).send = saved.send;
	}
}

test("headless defaults only on Linux without a display", () => {
	assert.equal(defaultBrowserHeadless("linux", { DISPLAY: ":0" }), false);
	assert.equal(defaultBrowserHeadless("linux", { WAYLAND_DISPLAY: "wayland-0" }), false);
	assert.equal(defaultBrowserHeadless("linux", {}), true);
	assert.equal(defaultBrowserHeadless("darwin", {}), false);
	assert.equal(defaultBrowserHeadless("win32", {}), false);
});

test("the app relay asks the app for a browser endpoint and resolves its URL", async () => {
	await withAppRelay(async (sent, answer) => {
		const endpoint = appBrowserEndpoint("b2", ["/workspace/b2", "/workspace"]);
		assert.equal(sent.length, 1);
		assert.deepEqual(
			{ ...sent[0], id: undefined },
			{
				type: "ocean-crew:browser-endpoint",
				id: undefined,
				botId: "b2",
				downloadRoots: ["/workspace/b2", "/workspace"],
			},
		);
		answer(0, { url: "ws://127.0.0.1:1234/devtools/browser/token" });
		assert.equal(await endpoint, "ws://127.0.0.1:1234/devtools/browser/token");
	});
});

test("the app relay rejects what the app reports", async () => {
	await withAppRelay(async (_sent, answer) => {
		const failed = appBrowserEndpoint("b2");
		answer(0, { error: "no app" });
		await assert.rejects(failed, /no app/);
		const nameless = appBrowserEndpoint("b2");
		// A message with neither a URL nor an error still fails with the relay's text.
		answer(1, {});
		await assert.rejects(nameless, /The app browser relay is unavailable\./);
	});
});

test("the app relay refuses to run without an IPC channel", async () => {
	const saved = (process as any).send;
	delete (process as any).send;
	try {
		assert.throws(() => appBrowserEndpoint("b2"), /The app browser relay is unavailable\./);
	} finally {
		if (saved !== undefined) (process as any).send = saved;
	}
});

test("handoffHold keeps a call id only for a card in the Bot's own chat", () => {
	const { rt } = browserRuntime();
	assert.deepEqual(handoffHold(rt, "b2", { sessionId: "b2", callId: "call-1", reason: "login" }), {
		reason: "login",
		callId: "call-1",
	});
	assert.deepEqual(handoffHold(rt, "b2", { sessionId: "room-b2", callId: "call-1" }), {
		callId: "call-1",
	});
	// A group turn has no card: the hold keeps no call and the panel clears it silently.
	assert.deepEqual(handoffHold(rt, "b2", { sessionId: "group-session", callId: "call-1" }), {});
	// A hold without a call id is passed through as it came.
	assert.deepEqual(handoffHold(rt, "b2", { sessionId: "b2" }), {});
	assert.deepEqual(handoffHold(rt, "b2", { by: "user" }), { by: "user" });
});

test("no plugin is mounted unless the team selects one", () => {
	const { rt, ctx, stop } = browserRuntime();
	try {
		install(rt);
		assert.equal(rt.browserPlugin, undefined);
		assert.deepEqual(rt.teamTools, []);
		assert.equal(ctx.calls.includes("effect ocean-crew: browser plugin"), false);
	} finally {
		stop();
	}
});

test("an unknown plugin name is refused with the names to choose from", () => {
	const { rt, stop } = browserRuntime({ config: { browserPlugin: "nope" } });
	try {
		assert.throws(
			() => install(rt),
			(error: Error) =>
				/Unknown browser plugin "nope"/.test(error.message) && /refs, script, task/.test(error.message),
		);
	} finally {
		stop();
	}
});

test("the selected built-in plugin registers its tools for every Bot", () => {
	const { rt, ctx, stop } = browserRuntime({ config: { browserPlugin: "refs" } });
	try {
		install(rt);
		assert.equal(rt.browserPlugin, "refs");
		assert.ok(ctx.calls.includes("effect ocean-crew: browser plugin"));
		const names = rt.teamTools.map((tool) => tool.name);
		for (const name of ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_tabs"])
			assert.ok(names.includes(name), `${name} is registered`);
		assert.equal(names.includes("read_browser"), false);
	} finally {
		stop();
	}
});

test("an injected plugin's tools see the Bot, its profile directory, and the completion route", async () => {
	const { rt, home, stop } = browserRuntime({
		config: {
			browserPluginApi: {
				id: "fake",
				tools: [
					{
						name: "browser_where",
						description: "Where",
						parameters: {},
						needsBrowser: false,
						execute: (_args: unknown, toolCtx: any) => `${toolCtx.botId} ${toolCtx.profileDir}`,
					},
					{
						name: "browser_complete",
						description: "Complete",
						parameters: {},
						needsBrowser: false,
						execute: (_args: unknown, toolCtx: any) => toolCtx.complete({ model: "route" }),
					},
				],
			},
			browserComplete: async (request: any) => `answer from ${request.model}`,
		},
	});
	try {
		install(rt);
		assert.equal(rt.browserPlugin, "fake");
		const where = await toolNamed(rt, "browser_where").execute?.({}, { agent: { id: "b2" } });
		assert.equal(where, `b2 ${join(home, "browser-profiles", "b2")}`);
		const chief = await toolNamed(rt, "browser_where").execute?.({}, { agent: { id: "m1" } });
		assert.equal(chief, `m1 ${join(home, "browser-profiles", "m1")}`);
		assert.equal(await toolNamed(rt, "browser_complete").execute?.({}, { agent: { id: "b2" } }), "answer from route");
	} finally {
		stop();
	}
});

test("a tool for a session that is not a Bot on the team is refused", async () => {
	const { rt, stop } = browserRuntime({
		config: {
			browserPluginApi: {
				id: "fake",
				tools: [
					{
						name: "browser_where",
						description: "Where",
						parameters: {},
						needsBrowser: false,
						execute: () => "ran",
					},
				],
			},
		},
	});
	try {
		install(rt);
		assert.equal(
			await toolNamed(rt, "browser_where").execute?.({}, { agent: { id: "stranger" } }),
			"Only Bots on the team have a browser.",
		);
	} finally {
		stop();
	}
});

test("the browser channel's hold reaches the tools before a browser opens", async () => {
	const channel = createBrowserChannel();
	const { rt, stop } = browserRuntime({
		config: {
			browserPluginApi: {
				id: "fake",
				tools: [
					{
						name: "browser_open",
						description: "Open",
						parameters: {},
						needsBrowser: true,
						execute: () => "opened",
					},
				],
			},
		},
	});
	try {
		rt.browserChannel = channel;
		install(rt);
		// The user holds the browser: the call is refused before a session is opened.
		channel.setHold("b2", { by: "user" });
		await assert.rejects(
			toolNamed(rt, "browser_open").execute?.({}, { agent: { id: "b2" } }),
			/The user has taken over this browser/,
		);
		channel.setHold("b2", null);
	} finally {
		channel.dispose();
		stop();
	}
});

test("deleting a Bot drops its browser profile through the wrapped deleteBot", async () => {
	const deleted: string[] = [];
	const { rt, home, stop } = browserRuntime({
		config: { browserPluginApi: { id: "fake", tools: [] } },
		deleteBot: async (id: string) => {
			deleted.push(id);
			return { id };
		},
	});
	try {
		const profile = join(home, "browser-profiles", "b2");
		mkdirSync(profile, { recursive: true });
		install(rt);
		await rt.deleteBot("b2");
		assert.deepEqual(deleted, ["b2"]);
		// The profile directory is gone, and the original delete ran exactly once.
		assert.equal(existsSync(profile), false);
	} finally {
		stop();
	}
});

test("a malformed playwright URL is a config error", () => {
	const { rt, stop } = browserRuntime({ config: { browserPluginApi: { id: "fake", tools: [] }, playwrightUrl: 7 } });
	try {
		assert.throws(() => install(rt), /playwrightUrl must be a string/);
	} finally {
		stop();
	}
});

test("the plugin table is the three plugins the build ships", () => {
	assert.deepEqual(Object.keys(browserPlugins).sort(), ["refs", "script", "task"]);
	for (const [name, plugin] of Object.entries(browserPlugins)) {
		assert.equal(plugin.id, name);
		assert.ok(Array.isArray(plugin.tools), `${name} has tools`);
		assert.ok((plugin.tools as unknown[]).length > 0);
		assert.equal(plugin.tools, plugin.toolDefs);
	}
});
