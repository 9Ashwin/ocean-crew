// Computer use: the per-Bot switch and levels, protected apps, the guard before every
// provider call, consent cards, leases, the views and the channel endpoints.

// The provider mount runs against a fake Cordis plugin/loader; nothing touches a real
// desktop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { install, isProtectedApp } from "../src/host/computer/index.ts";
import { fakeContext } from "./fake-ctx.ts";

interface SetupOptions {
	services?: Record<string, any>;
	state?: any;
}

function setup({ services = {}, state: extra = {} }: SetupOptions = {}) {
	const ctx: any = fakeContext({ services });
	ctx.sessions = { flush: async () => {} };
	const state: any = {
		version: 1,
		mainBotIds: ["m1"],
		bots: {
			w1: { id: "w1", name: "Writer", sessionId: "w1", createdAt: 1 },
			m1: { id: "m1", name: "Chief", sessionId: "m1", createdAt: 1 },
		},
		rooms: {},
		computer: { enabled: true },
		...extra,
	};
	const saved = { count: 0 };
	const warnings: unknown[][] = [];
	const followed: any[] = [];
	const rt: any = {
		ctx,
		state,
		save: async () => {
			saved.count += 1;
		},
		load: async () => {},
		warn: (...args: unknown[]) => warnings.push(args),
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		selfOf: (sessionId?: string) =>
			sessionId !== undefined && state.bots[sessionId] !== undefined ? sessionId : undefined,
		isBotSession: (id?: string) => id !== undefined && state.bots[id] !== undefined,
		chatOf: (botId: string) => state.bots[botId]?.sessionId ?? botId,
		readOnly: () => undefined,
		ensureCapabilities: async () => {},
		resolveAgent: async (sessionId: string) => ({
			id: sessionId,
			session: { id: sessionId },
			followup: (message: any) => followed.push(message),
		}),
		stopChat: async () => {},
		stopMemberWork: async () => {},
		uiLanguage: () => "en",
		redactSecrets: (text: string) => text,
	};
	install(rt);
	const listener = (name: string, description: string): any => {
		const found = (ctx.listeners.get(name) ?? []).find((fn: any) => fn.name === description);
		assert.notEqual(found, undefined, `${name} ${description}`);
		return found;
	};
	return {
		ctx,
		state,
		rt,
		saved: () => saved.count,
		warnings,
		followed,
		gate: listener("tools/pre-execute", "computerGate"),
		track: listener("tools/execute", "computerTrack"),
		answerer: listener("user-questions/request", "computerConsent"),
	};
}

const allow = async () => "allowed";
const call =
	(gate: any) =>
	(sessionId: string, name: string, args: Record<string, unknown> = {}) =>
		gate({ name, arguments: args, agent: { id: sessionId }, callId: `c-${sessionId}` }, allow);
const handoffTrack = async (track: any, sessionId: string, args: Record<string, unknown>, value: unknown) =>
	track({ name: "cua", arguments: args, agent: { id: sessionId }, callId: `t-${sessionId}` }, async () => ({
		isError: false,
		value,
	}));

test("protected apps match by id, name and executable", () => {
	for (const app of [
		{ id: "com.apple.systempreferences" },
		{ id: "com.apple.keychainaccess" },
		{ name: "Ocean Crew" },
		{ name: "DSH Computer Use" },
		{ name: "DeepSeek Harness" },
		{ name: "Keychain Access" },
		{ name: "Credential Manager" },
		{ path: "/Applications/DSH Computer Use.app/Contents/MacOS/dsh-cua-native" },
		{ path: "C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe" },
	])
		assert.equal(isProtectedApp(app), true, JSON.stringify(app));
	assert.equal(isProtectedApp({ name: "Notes" }), false);
	assert.equal(isProtectedApp({ id: "com.apple.Notes" }), false);
	assert.equal(isProtectedApp({ name: "Mail", path: "/Applications/Mail.app" }), false);
});

test("the view and live payloads carry the switch, the provider and every Bot's level", async () => {
	const env = setup();
	env.rt.state.computer.enabled = false;
	assert.deepEqual(env.rt.computerStatus(), { state: "off" });
	assert.deepEqual(env.rt.computerView(), {
		enabled: false,
		provider: { state: "off" },
		macos: process.platform === "darwin",
		bots: {
			w1: { level: "background", apps: {} },
			m1: { level: "background", apps: {} },
		},
	});
	assert.deepEqual(env.rt.computerLive(), { bots: {}, leases: [], cursors: [], asks: {}, holds: {} });
	assert.equal(env.rt.computerLevelOf(env.rt.botOf("w1")), "background");
	assert.equal(env.rt.computerEnabled(), false);
	assert.equal(typeof env.rt.computerEndpoint, "function");
	assert.equal(env.rt.waitsForApproval("w1"), false);
	assert.equal(env.rt.isProtectedApp({ name: "Ocean Crew" }), true);
});

test("the guard refuses in order: switch, Bot, level, protected app, then the lease", async () => {
	const env = setup({ state: { computer: { enabled: false } } });
	const callGate = call(env.gate);
	// Off: refused before anything else.
	assert.equal((await callGate("w1", "cua", { method: "click", params: {} })).kind, "deny");
	await env.rt.computerEndpoint("set-enabled", { enabled: true });
	// A non-Bot Session is refused.
	assert.equal((await callGate("plain", "cua", { method: "click", params: {} })).kind, "deny");
	// View level: reads pass, input does not.
	await env.rt.computerEndpoint("set-level", { botId: "w1", level: "view" });
	assert.equal(await callGate("w1", "cua", { method: "getState", params: {} }), "allowed");
	assert.equal((await callGate("w1", "cua", { method: "click", params: {} })).kind, "deny");
	// Background: clicks pass, foreground does not; foreground level allows it.
	await env.rt.computerEndpoint("set-level", { botId: "w1", level: "background" });
	assert.equal(await callGate("w1", "cua", { method: "click", params: {} }), "allowed");
	assert.equal((await callGate("w1", "cua", { method: "activate", params: {} })).kind, "deny");
	await env.rt.computerEndpoint("set-level", { botId: "w1", level: "foreground" });
	assert.equal(await callGate("w1", "cua", { method: "activate", params: {} }), "allowed");
	// A protected app is refused at getApp, by name alone.
	const denied = await callGate("w1", "cua", { method: "getApp", params: { selector: "DSH Computer Use" } });
	assert.equal(denied.kind, "deny");
	assert.match(denied.reason, /protected/);
});

test("another Bot's app lease refuses the call and names the holder", async () => {
	const env = setup();
	const callGate = call(env.gate);
	await env.rt.computerEndpoint("set-level", { botId: "w1", level: "background" });
	await env.rt.computerEndpoint("set-level", { botId: "m1", level: "background" });
	// Both Bots already hold an Always grant for Notes, so getApp needs no card.
	for (const botId of ["w1", "m1"])
		env.state.bots[botId].computer = {
			apps: { "com.apple.Notes": { name: "Notes", id: "com.apple.Notes", grantedAt: 0 } },
		};
	await handoffTrack(
		env.track,
		"w1",
		{ method: "getApp", params: { selector: "Notes" } },
		{ appHandle: "h1", pid: 42, authorization: { id: "com.apple.Notes", name: "Notes" } },
	);
	assert.equal(await callGate("w1", "cua", { method: "click", params: { appHandle: "h1" } }), "allowed");
	await handoffTrack(
		env.track,
		"m1",
		{ method: "getApp", params: { selector: "Notes" } },
		{ appHandle: "h1", pid: 42, authorization: { id: "com.apple.Notes", name: "Notes" } },
	);
	const blocked = await callGate("m1", "cua", { method: "click", params: { appHandle: "h1" } });
	assert.equal(blocked.kind, "deny");
	assert.match(blocked.reason, /Writer is using Notes/);
	// The holder keeps working.
	assert.equal(await callGate("w1", "cua", { method: "click", params: { appHandle: "h1" } }), "allowed");
});

test("cua-driver consent: an unknown pid is refused, the card answers This time, a Deny sticks", async () => {
	const env = setup();
	const callGate = call(env.gate);
	await env.rt.computerEndpoint("set-level", { botId: "w1", level: "background" });
	// Unknown pid: refused until the Bot lists windows.
	const unknown = await callGate("w1", "cua_driver_native__click", { pid: 42 });
	assert.equal(unknown.kind, "deny");
	assert.match(unknown.reason, /list/i);
	// The list records the pid's app.
	await env.track(
		{ name: "cua_driver_native__list_windows", arguments: {}, agent: { id: "w1" }, callId: "list-1" },
		async () => ({
			windows: [{ pid: 42, name: "Notes", path: "/Applications/Notes.app" }],
		}),
	);
	// The first input call opens an ask; answering This time allows it.
	const pending = callGate("w1", "cua_driver_native__click", { pid: 42 });
	await new Promise((resolve) => setImmediate(resolve));
	const asks = env.rt.computerLive().asks;
	assert.equal(Object.keys(asks).length, 1);
	const ask = Object.values(asks)[0] as any;
	assert.equal(ask.appName, "Notes");
	assert.equal(await env.rt.computerEndpoint("app-answer", { id: ask.id, answer: "once" }), true);
	assert.equal(await pending, "allowed");
	// The same Session asks no more for that app; another app asks again and a Deny sticks.
	assert.equal(await callGate("w1", "cua_driver_native__click", { pid: 42 }), "allowed");
	await env.track(
		{ name: "cua_driver_native__list_windows", arguments: {}, agent: { id: "w1" }, callId: "list-2" },
		async () => ({
			windows: [{ pid: 43, name: "Mail" }],
		}),
	);
	const denied = callGate("w1", "cua_driver_native__type_text", { pid: 43 });
	await new Promise((resolve) => setImmediate(resolve));
	const ask2 = Object.values(env.rt.computerLive().asks)[0] as any;
	assert.notEqual(ask2, undefined);
	await env.rt.computerEndpoint("app-answer", { id: ask2.id, answer: "deny" });
	assert.equal((await denied).kind, "deny");
});

test("macOS consent answerer: grants allow, the card answers, Always records", async () => {
	const env = setup();
	const ask = (sessionId: string, name = "Notes") =>
		env.answerer(
			{
				agent: { id: sessionId },
				questions: [
					{
						id: "cua-app-access",
						intent: { subject: { name } },
						options: [{ label: "Allow for this session" }, { label: "Deny" }],
					},
				],
			},
			async () => "next",
		);
	// Non-Bot sessions pass through; a protected name denies without a card.
	assert.equal(await ask("plain"), "next");
	assert.deepEqual(await ask("w1", "Keychain Access"), { answers: [{ id: "cua-app-access", selected: ["Deny"] }] });
	// The card answers This time.
	const pending = ask("w1");
	await new Promise((resolve) => setImmediate(resolve));
	const shown = Object.values(env.rt.computerLive().asks)[0] as any;
	assert.equal(shown.appName, "Notes");
	await env.rt.computerEndpoint("app-answer", { id: shown.id, answer: "once" });
	assert.deepEqual(await pending, { answers: [{ id: "cua-app-access", selected: ["Allow for this session"] }] });
	// Always records the grant and still answers session-allow.
	const pending2 = ask("w1", "Mail");
	await new Promise((resolve) => setImmediate(resolve));
	const shown2 = Object.values(env.rt.computerLive().asks)[0] as any;
	await env.rt.computerEndpoint("app-answer", { id: shown2.id, answer: "always" });
	const answer2 = (await pending2) as any;
	assert.equal(answer2.answers[0].selected[0], "Allow for this session");
	assert.notEqual(answer2.answers[0].selected[0], "Always allow");
	// A later ask for the same app is auto-allowed by the grant.
	assert.deepEqual(await ask("w1", "Mail"), {
		answers: [{ id: "cua-app-access", selected: ["Allow for this session"] }],
	});
	assert.equal(env.state.bots.w1.computer.apps.mail?.name, "Mail");
});

test("the provider mounts when the switch comes on and shows its status", async () => {
	const services: Record<string, any> = {};
	const env = setup({ services });
	services.loader = { import: async (name: string) => ({ name }) };
	services.agents = { list: () => [] };
	const fibers: any[] = [];
	env.ctx.plugin = (module: any, config: any) => {
		const entry = { module, config };
		fibers.push(entry);
		if (String(module?.name ?? "").includes("experimental")) {
			services.computerUse ??= {};
			services.computerUse.providerName = "fake-provider";
		} else services.computerUse ??= {};
		return {
			await: async () => {},
			dispose: async () => {
				const index = fibers.indexOf(entry);
				if (index >= 0) fibers.splice(index, 1);
			},
		};
	};
	await env.rt.load();
	assert.deepEqual(env.rt.computerStatus().state, "off");
	await env.rt.computerEndpoint("set-enabled", { enabled: true });
	await env.rt.computerEndpoint("provider-retry", {});
	assert.deepEqual(env.rt.computerStatus(), { state: "ready", name: "fake-provider" });
	// Registry and provider mounted, the provider with the platform config.
	assert.equal(fibers.length, 2);
	assert.deepEqual(fibers[1].config, process.platform === "darwin" ? { agentPreset: false } : {});
	// Switching off disposes the provider.
	await env.rt.computerEndpoint("set-enabled", { enabled: false });
	assert.deepEqual(env.rt.computerStatus(), { state: "off" });
	assert.equal(fibers.length, 0);
});

test("endpoints validate their input and refuse unknown work", async () => {
	const env = setup();
	assert.match(
		await rejection(env.rt.computerEndpoint("set-level", { botId: "nobody", level: "view" })),
		/Unknown Bot/,
	);
	assert.match(
		await rejection(env.rt.computerEndpoint("set-level", { botId: "w1", level: "root" })),
		/Level must be one of/,
	);
	// A screenshot this module did not record is not readable through the endpoint.
	assert.equal(await env.rt.computerEndpoint("shot", { attachmentId: "anything" }), null);
	assert.equal(await env.rt.computerEndpoint("app-answer", { id: "nope", answer: "once" }), false);
	assert.match(await rejection(env.rt.computerEndpoint("wat", {})), /Unknown endpoint wat/);
	assert.match(await rejection(env.rt.computerEndpoint("takeover", { botId: "nobody" })), /Unknown Bot/);
	assert.match(await rejection(env.rt.computerEndpoint("handback", { botId: "nobody" })), /Unknown Bot/);
	// revoke-app forgets a grant and clears the Bot's session handle.
	env.state.bots.w1.computer = { apps: { notes: { name: "Notes", id: "com.apple.Notes", grantedAt: 0 } } };
	await env.rt.computerEndpoint("revoke-app", { botId: "w1", appKey: "notes" });
	assert.equal(env.state.bots.w1.computer.apps, undefined);
	// Stop with no work is a no-op that still answers.
	assert.equal(await env.rt.computerEndpoint("stop", { botId: "w1" }), true);
	assert.equal(await env.rt.computerEndpoint("user-active", { idleSeconds: 5 }), true);
	assert.equal(await env.rt.computerEndpoint("allow-foreground", { botId: "w1" }), true);
});

test("takeover and handback move the computer between the Bot and the user", async () => {
	const env = setup();
	await env.rt.computerEndpoint("takeover", { botId: "w1" });
	assert.equal(env.rt.computerLive().bots.w1.state, "user");
	// While the user has it, the Bot's calls are refused before any lease.
	await env.rt.computerEndpoint("set-level", { botId: "w1", level: "background" });
	const refused = await call(env.gate)("w1", "cua", { method: "click", params: {} });
	assert.equal(refused.kind, "deny");
	assert.match(refused.reason, /Wait until they hand it back/);
	// Handing back releases the user state and tells the Bot to look again.
	await env.rt.computerEndpoint("handback", { botId: "w1" });
	assert.equal(env.rt.computerLive().bots.w1?.state, "idle");
	assert.equal(env.followed.length, 1);
});

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		assert.fail("expected a refusal");
	} catch (error: any) {
		return String(error?.message ?? error);
	}
}
