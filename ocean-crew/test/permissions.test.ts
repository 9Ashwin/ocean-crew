// Permissions behaviour: a Bot's preset reaches its own chat and its group Sessions, a
// group's preset replaces a member's there, and a superseded or failed change never
// leaves a Session on a preset that lost.
// assertions.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/team/permissions.ts";

const PRESETS: Record<string, unknown> = { "workspace-write": {}, "danger-full-access": {} };
const SESSION_ONLY = ["auto"];

type TestRuntime = Runtime & Record<string, any>;
type TestBot = { id: string; name?: string; permission?: string };
type TestRoom = { id?: string; name: string; sessions?: Record<string, string>; permission?: string };

interface Release {
	sessionId: string;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
}

interface Options {
	presets?: boolean;
	auto?: boolean;
	fail?: boolean;
	hold?: boolean;
	failOn?: string[];
}

function runtime({ presets = true, auto = false, fail = false, hold = false, failOn = [] }: Options = {}) {
	const writes: string[] = [];
	const releases: Release[] = [];
	const bots: Record<string, TestBot> = {};
	const invalidated: string[][] = [];
	const chatOwners = new Map<string, string>();
	const control = { fail };
	const service = {
		catalog: () => ({
			options: [...Object.keys(PRESETS), ...(auto ? SESSION_ONLY : [])].map((value) => ({ value, name: value })),
			defaultOptions: [],
			defaultPreset: "workspace-write",
		}),
		resolve: (name: string) => {
			if (!(name in PRESETS) && !(auto && SESSION_ONLY.includes(name)))
				throw new Error(`permission: unknown preset "${name}"`);
			return PRESETS[name];
		},
		set: (session: string, name: string) => {
			if (control.fail || failOn.includes(session)) throw new Error("permission: rejected");
			writes.push(`${session}=${name}`);
		},
	};
	const ctx = { get: (name: string) => (presets && name === "permissionPresets" ? service : undefined) };
	const rt = {
		ctx,
		chatOf: (id: string) => `${id}-chat`,
		groupSessionsOf: (id: string) => [`${id}-group`],
		groupOwners: new Map<string, { botId: string; roomId: string }>(),
		chatOwners,
		invalidateApprovals: (sessions: string[]) => invalidated.push([...sessions]),
		roomOf: () => undefined,
		botOf: (id: string) => bots[id],
		resolveAgent: (sessionId: string) =>
			hold
				? new Promise((resolve, reject) => releases.push({ sessionId, resolve, reject }))
				: Promise.resolve({ session: sessionId }),
		warn() {},
	} as unknown as TestRuntime;
	install(rt);
	// With `hold`, every Session's agent resolves only when its index here is settled,

	const settle = async (index: number): Promise<void> => {
		const [{ sessionId, resolve }] = releases.splice(index, 1);
		resolve({ session: sessionId });
		await new Promise<void>((done) => setImmediate(done));
	};
	const drop = async (index: number): Promise<void> => {
		const [{ reject }] = releases.splice(index, 1);
		reject(new Error("permission: session went away"));
		await new Promise<void>((done) => setImmediate(done));
	};
	return { rt, writes, releases, bots, settle, drop, control, invalidated, chatOwners };
}

test("a Bot's preset is set on its chat and its group Sessions", async () => {
	const { rt, writes } = runtime();
	const bot: TestBot = { id: "b1", name: "Ada" };
	await rt.setPermission(bot, "danger-full-access");
	assert.equal(bot.permission, "danger-full-access");
	assert.deepEqual(writes, ["b1-chat=danger-full-access", "b1-group=danger-full-access"]);
});

test("a fresh Session gets the Bot's preset, and a Bot without one keeps the default", async () => {
	const { rt, writes } = runtime();
	await rt.applyPermission({ id: "b1" }, "fresh");
	await rt.applyPermission({ id: "b1", permission: "workspace-write" }, "fresh");
	assert.deepEqual(writes, ["fresh=workspace-write"]);
});

test("an unknown preset is refused and the Bot keeps its own", async () => {
	const { rt, writes } = runtime();
	const bot: TestBot = { id: "b1", permission: "workspace-write" };
	await assert.rejects(rt.setPermission(bot, "everything"), /unknown preset/);
	assert.equal(bot.permission, "workspace-write");
	assert.deepEqual(writes, []);
});

test("the catalog lists the presets DSH offers, or nothing without the presets service", () => {
	assert.deepEqual(runtime().rt.permissionCatalog(), {
		options: [
			{ value: "workspace-write", name: "workspace-write" },
			{ value: "danger-full-access", name: "danger-full-access" },
		],
		defaultPreset: "workspace-write",
	});
	assert.equal(runtime({ presets: false }).rt.permissionCatalog(), undefined);
});

test("Auto review is not offered or kept as a Bot's preset", async () => {
	const { rt, writes } = runtime({ auto: true });
	assert.deepEqual(
		rt.permissionCatalog().options.map((option: { value: string }) => option.value),
		["workspace-write", "danger-full-access"],
	);
	const bot: TestBot = { id: "b1" };
	await assert.rejects(rt.setPermission(bot, "auto"), /one Session only/);
	assert.equal(bot.permission, undefined);
	assert.deepEqual(writes, []);
});

test("a preset the Bot's own chat refuses is not kept", async () => {
	const { rt } = runtime({ fail: true });
	const bot: TestBot = { id: "b1", permission: "workspace-write" };
	await assert.rejects(rt.setPermission(bot, "danger-full-access"), /rejected/);
	assert.equal(bot.permission, "workspace-write");
});

test("the last preset asked for wins when two Bot changes overlap", async () => {
	const { rt, writes, releases, settle } = runtime({ hold: true });
	const bot: TestBot = { id: "b1", name: "Ada" };
	const first = rt.setPermission(bot, "workspace-write");
	const second = rt.setPermission(bot, "danger-full-access");
	assert.equal(releases.length, 2);
	await settle(1); // the later request applies to the chat, then to the group Session
	await settle(1);
	while (releases.length) await settle(0); // the earlier request writes nothing more
	await first;
	await second;
	assert.equal(bot.permission, "danger-full-access");
	assert.deepEqual(writes, ["b1-chat=danger-full-access", "b1-group=danger-full-access"]);
});

test("a failed change does not roll back a newer one that already applied", async () => {
	const { rt, releases, settle, drop } = runtime({ hold: true });
	const bot: TestBot = { id: "b1", name: "Ada", permission: "workspace-write" };
	// Two windows ask for the same preset; the newer applies everywhere first.
	const first = rt.setPermission(bot, "danger-full-access");
	const second = rt.setPermission(bot, "danger-full-access");
	assert.equal(releases.length, 2);
	await settle(1); // the newer request applies to the chat, then to the group Session
	await settle(1);
	await second;
	const refused = assert.rejects(first, /went away/);
	await drop(0); // the older request's apply resolves only now, and fails
	await refused;
	assert.equal(bot.permission, "danger-full-access");
});

test("a failed change rolls back to the last applied preset, not to a failed request", async () => {
	const { rt, releases, settle, drop, control } = runtime({ hold: true });
	const bot: TestBot = { id: "b1", name: "Ada", permission: "workspace-write" };
	const first = rt.setPermission(bot, "danger-full-access");
	const second = rt.setPermission(bot, "danger-full-access");
	const firstFails = assert.rejects(first, /went away/);
	await drop(0); // the superseded request fails and leaves the field to the newer one
	await firstFails;
	control.fail = true;
	const secondFails = assert.rejects(second, /rejected/);
	while (releases.length) await settle(0); // the newest one fails too and rolls back
	await secondFails;
	assert.equal(bot.permission, "workspace-write");
});

test("a superseded change leaves no Session on a preset that lost", async () => {
	const { rt, writes, releases, settle, control } = runtime({ hold: true });
	const bot: TestBot = { id: "b1", name: "Ada" };
	const first = rt.setPermission(bot, "workspace-write");
	await settle(0); // the older request sets the chat, then waits on the group Session
	const second = rt.setPermission(bot, "danger-full-access");
	assert.equal(releases.length, 2);
	await settle(0); // the older request's group apply resolves: a newer one owns it now
	control.fail = true;
	const refused = assert.rejects(second, /rejected/);
	await settle(0); // the newer request's chat apply fails and rolls the field back
	control.fail = false;
	while (releases.length) await settle(0); // the rollback puts the restored preset back
	await refused;
	await first;
	assert.equal(bot.permission, "workspace-write");
	assert.deepEqual(writes, ["b1-chat=workspace-write", "b1-chat=workspace-write", "b1-group=workspace-write"]);
});

test("the last preset asked for wins when two group changes overlap", async () => {
	const { rt, writes, releases, bots, settle } = runtime({ hold: true });
	bots.b1 = { id: "b1", name: "Ada" };
	bots.b2 = { id: "b2", name: "Ben" };
	const room: TestRoom = { name: "Ops", sessions: { b1: "s1", b2: "s2" } };
	const first = rt.setRoomPermission(room, "workspace-write");
	const second = rt.setRoomPermission(room, "danger-full-access");
	assert.equal(releases.length, 2);
	await settle(1); // the later request reaches s1, then s2, before the earlier one does
	await settle(1);
	await settle(0); // the earlier request applies last and must not win
	await settle(0);
	await first;
	await second;
	assert.equal(room.permission, "danger-full-access");
	assert.equal(writes.length, 4);
	assert.ok(writes.every((write) => write.endsWith("=danger-full-access")));
});

test("a group preset set and cleared reaches the members' Sessions and goes back to the default", async () => {
	const { rt, writes, bots } = runtime();
	bots.b1 = { id: "b1", name: "Ada", permission: "danger-full-access" };
	const room: TestRoom = { name: "Ops", sessions: { b1: "s1" } };
	assert.equal(await rt.setRoomPermission(room, "workspace-write"), true);
	assert.equal(room.permission, "workspace-write");
	assert.deepEqual(writes, ["s1=workspace-write"]);
	// The member's own preset is not touched; clearing the group puts the member's back.
	assert.equal(bots.b1.permission, "danger-full-access");
	assert.equal(await rt.setRoomPermission(room, null), true);
	assert.equal(room.permission, undefined);
	assert.deepEqual(writes, ["s1=workspace-write", "s1=danger-full-access"]);
	// Setting the same preset again is no change.
	assert.equal(await rt.setRoomPermission(room, null), false);
});

test("a group preset is refused when DSH does not offer it", () => {
	const { rt } = runtime();
	assert.equal(rt.cleanRoomPermission(null), null);
	assert.equal(rt.cleanRoomPermission(""), null);
	assert.equal(rt.cleanRoomPermission("workspace-write"), "workspace-write");
	assert.throws(() => rt.cleanRoomPermission("auto"), /one Session only/);
	assert.throws(() => rt.cleanRoomPermission("everything"), /unknown preset/);
});

test("the audit names the desired preset, the revision that applied it and each Session's real preset", async () => {
	const { rt, bots, chatOwners } = runtime();
	bots.b1 = { id: "b1", name: "Ada" };
	chatOwners.set("b1-chat", "b1");
	await rt.setPermission(bots.b1, "danger-full-access");
	const state = rt.permissionState("b1");
	assert.deepEqual(
		[state.bots.b1.desired, state.bots.b1.applyRevision, state.bots.b1.partial],
		["danger-full-access", 1, false],
	);
	const chat = state.bots.b1.sessions.find((session: any) => session.sessionId === "b1-chat");
	const group = state.bots.b1.sessions.find((session: any) => session.sessionId === "b1-group");
	assert.deepEqual([chat.preset, chat.source, chat.applied], ["danger-full-access", "bot", true]);
	assert.deepEqual([group.preset, group.source, group.applied], ["danger-full-access", "bot", true]);
	assert.equal(typeof state.revision, "number");
});

test("a change the Bot's chat refuses is partial and visible as such", async () => {
	const { rt, bots } = runtime({ fail: true });
	bots.b1 = { id: "b1", name: "Ada", permission: "workspace-write" };
	await assert.rejects(rt.setPermission(bots.b1, "danger-full-access"), /rejected/);
	const state = rt.permissionState("b1");
	assert.equal(state.bots.b1.desired, "danger-full-access");
	assert.equal(state.bots.b1.partial, true);
	assert.match(state.bots.b1.lastError, /rejected/);
	assert.equal(state.bots.b1.sessions.find((session: any) => session.sessionId === "b1-chat").applied, false);
	assert.equal(bots.b1.permission, "workspace-write");
});

test("the permission revision moves with every change, before a Session applies it", async () => {
	const { rt, bots, chatOwners } = runtime();
	bots.b1 = { id: "b1", name: "Ada" };
	chatOwners.set("b1-chat", "b1");
	const before = rt.permissionRevision("b1-chat");
	await rt.setPermission(bots.b1, "danger-full-access");
	const after = rt.permissionRevision("b1-chat");
	assert.notEqual(after, before);
	assert.match(before, /^b0:r0:s0$/);
	assert.match(after, /^b1:r0:s\d+$/);
	// Another Bot's change does not move this Session's revision.
	const other = rt.permissionRevision("b1-chat");
	await rt.applyPermission({ id: "b2" }, "fresh");
	assert.equal(rt.permissionRevision("b1-chat"), other);
});

test("a permission change invalidates the approvals asked under the old authority", async () => {
	const { rt, bots, invalidated } = runtime();
	bots.b1 = { id: "b1", name: "Ada" };
	await rt.setPermission(bots.b1, "workspace-write");
	assert.deepEqual(invalidated.at(-1), ["b1-chat", "b1-group"]);
	const room: TestRoom = { name: "Ops", sessions: { b1: "s1", b2: "s2" } };
	await rt.setRoomPermission(room, "danger-full-access");
	assert.deepEqual(invalidated.at(-1), ["s1", "s2"]);
	// Setting the same preset again changes nothing, so nothing is invalidated.
	const count = invalidated.length;
	assert.equal(await rt.setRoomPermission(room, "danger-full-access"), false);
	assert.equal(invalidated.length, count);
});

test("a group's preset is the effective source for its members' Sessions, and clearing it falls back", async () => {
	const { rt, bots } = runtime();
	bots.b1 = { id: "b1", name: "Ada", permission: "danger-full-access" };
	const room: TestRoom = { id: "r1", name: "Ops", sessions: { b1: "s1" } };
	await rt.setRoomPermission(room, "workspace-write");
	assert.deepEqual(rt.effectivePermission("s1").source, "room");
	assert.deepEqual(rt.effectivePermission("s1").preset, "workspace-write");
	await rt.setRoomPermission(room, null);
	assert.equal(rt.effectivePermission("s1").source, "bot");
	assert.equal(rt.effectivePermission("s1").preset, "danger-full-access");
	assert.equal(rt.permissionState().rooms.r1.permission, undefined);
	assert.equal(rt.permissionState().rooms.r1.partial, false);
});

test("a group change that misses one Session is partial and says so", async () => {
	const { rt, bots } = runtime({ failOn: ["s2"] });
	bots.b1 = { id: "b1", name: "Ada" };
	bots.b2 = { id: "b2", name: "Ben" };
	const room: TestRoom = { id: "r1", name: "Ops", sessions: { b1: "s1", b2: "s2" } };
	assert.equal(await rt.setRoomPermission(room, "workspace-write"), true);
	const state = rt.permissionState();
	assert.equal(state.rooms.r1.partial, true);
	assert.match(state.rooms.r1.lastError, /not applied to 1 Session/);
	assert.equal(rt.effectivePermission("s1").applied, true);
	assert.equal(rt.effectivePermission("s2").applied, false);
});
