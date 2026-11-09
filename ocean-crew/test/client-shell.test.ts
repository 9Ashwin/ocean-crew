// The client shell's pure logic: observable sources and the roster index, the surface groups
// and their install order, the frame geometry rules, the shared browser maps, the right-panel
// rules and the "@" menu rows. The h() components are covered by tsc and the bundle; this
// file needs no DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	atSources,
	BOTS_SOURCE,
	CHATS_SOURCE,
	chatRows,
	mentionRows,
	sessionMention,
} from "../src/client/shell/at-menu.ts";
import {
	dragColumn,
	FALLBACK_SIDEBAR_WIDTH,
	frameLayout,
	PANEL_DETAILS_MAX,
	PANEL_DETAILS_WIDTH,
	panelWidth,
	RAIL_SNAP,
	RESIZE_SETTLE_MS,
	readSidebar,
	SIDEBAR_MAX,
	SIDEBAR_MIN,
	toggledPref,
	userSidebarToggle,
	writeSidebar,
} from "../src/client/shell/frame-layout.ts";
import {
	columnOpened,
	createSwitchWindow,
	drawerOpened,
	RIGHTBAR_ATTRIBUTES,
	rightColumnOpen,
} from "../src/client/shell/right-panel.ts";
import { noteLeft, setEntry, setUnread, sharedMap, toggleReaction } from "../src/client/shell/shared-map.ts";
import {
	countCards,
	createSource,
	EMPTY_ROSTER,
	heldCardKey,
	indexRoster,
	isAgentSession,
	isMainOf,
} from "../src/client/shell/sources.ts";
import { freePriority, groupsFor, readMode, surfaceGroups, writeMode } from "../src/client/shell/surface.ts";
import { quoteDraft, teamActions } from "../src/client/shell/team-actions.ts";

interface FakeStorage {
	map: Map<string, string>;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function storage(entries: Record<string, string> = {}): FakeStorage {
	const map = new Map(Object.entries(entries));
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

function roster(bots: any[], rooms: any[] = [], agents: any[] = []) {
	return indexRoster({ ...EMPTY_ROSTER, bots, rooms, agents } as any);
}

test("a source notifies only on change and unsubscribes", () => {
	const source = createSource(1);
	let calls = 0;
	const off = source.subscribe(() => {
		calls += 1;
	});
	assert.equal(source.getSnapshot(), 1);
	source.set(1);
	assert.equal(calls, 0, "an equal value is not a change");
	source.set((value) => value + 1);
	assert.equal(source.getSnapshot(), 2);
	assert.equal(calls, 1);
	off();
	source.set(3);
	assert.equal(calls, 1);
});

test("EMPTY_ROSTER is an empty team that is not ready yet", () => {
	assert.equal(EMPTY_ROSTER.revision, -1);
	assert.equal(EMPTY_ROSTER.ready, false);
	assert.deepEqual(EMPTY_ROSTER.bots, []);
	assert.equal(EMPTY_ROSTER.mainBotId, null);
	assert.equal(EMPTY_ROSTER.defaultModel, null);
	assert.equal(isMainOf(EMPTY_ROSTER, "a"), false);
	assert.equal(isMainOf({ mainBotIds: ["a", "b"] }, "b"), true);
});

test("indexRoster maps every part id to its Bot and room, and every Agent Session", () => {
	const value = roster(
		[
			{ id: "chief", name: "Chief", sessionId: "chief-2", parts: ["chief-1"] },
			{ id: "dev", name: "Dev", role: "Engineer" },
		],
		[{ id: "r1", name: "Ops", members: ["chief", "dev"], sessionId: "r1-2", ownParts: ["r1-1"] }],
		[{ id: "agent-1", sessions: ["agent-s1"] }],
	);
	assert.equal(value.ready, true);
	assert.equal(value.byId.chief?.id, "chief");
	assert.equal(value.byId["chief-1"]?.id, "chief");
	assert.equal(value.byId["chief-2"]?.id, "chief");
	assert.equal(value.byId.dev?.id, "dev");
	assert.equal(value.roomsById.r1?.id, "r1");
	assert.equal(value.roomsById["r1-1"]?.id, "r1");
	assert.equal(value.roomsById["r1-2"]?.id, "r1");
	assert.equal(value.agentsById["agent-1"]?.id, "agent-1");
	assert.equal(value.agentOf["agent-s1"], "agent-1");
	assert.deepEqual(value.agents, [{ id: "agent-1", sessions: ["agent-s1"] }]);
});

test("isAgentSession falls back to the cached ids before the roster arrives", () => {
	const cache = new Set(["agent-cached"]);
	assert.equal(isAgentSession(EMPTY_ROSTER, cache, "agent-cached"), true);
	assert.equal(isAgentSession(EMPTY_ROSTER, cache, "other"), false);
	assert.equal(isAgentSession(EMPTY_ROSTER, cache, ""), false);
	assert.equal(isAgentSession(EMPTY_ROSTER, cache, null), false);
	const ready = roster([], [], [{ id: "agent-1", sessions: ["agent-s1"] }]);
	// A ready roster answers from its own index; the cache no longer matters.
	assert.equal(isAgentSession(ready, cache, "agent-s1"), true);
	assert.equal(isAgentSession(ready, cache, "agent-cached"), false);
});

test("held cards are keyed by kind, and the counters drop at zero", () => {
	assert.notEqual(heldCardKey("question", "x"), heldCardKey("secret", "x"));
	const one = countCards({}, "s1", ["a", "b"], 1);
	assert.deepEqual(one, { s1: { a: 1, b: 1 } });
	const two = countCards(one, "s1", ["a"], 1);
	assert.deepEqual(two.s1, { a: 2, b: 1 });
	const back = countCards(two, "s1", ["a", "b"], -1);
	assert.deepEqual(back.s1, { a: 1 });
	const none = countCards(back, "s1", ["a"], -1);
	assert.deepEqual(none, { s1: {} });
});

test("surface mode picks the groups, and groups install shell-first, withdraw last-first", () => {
	assert.deepEqual(groupsFor({ mode: "bot" }), { shell: true, conversation: true });
	assert.deepEqual(groupsFor({ mode: "bot", plain: true }), { shell: true, conversation: false });
	assert.deepEqual(groupsFor({ mode: "agent" }), { shell: false, conversation: false });
	const log: string[] = [];
	const surface = surfaceGroups({
		shell: () => [
			() => {
				log.push("shell+");
				return () => log.push("shell-");
			},
		],
		conversation: () => [
			() => {
				log.push("conv+");
				return () => log.push("conv-");
			},
		],
	});
	surface.reconcile(groupsFor({ mode: "bot" }));
	assert.deepEqual(log, ["shell+", "conv+"]);
	surface.reconcile(groupsFor({ mode: "agent" }));
	assert.deepEqual(log, ["shell+", "conv+", "conv-", "shell-"]);
	surface.dispose();
	assert.deepEqual(log, ["shell+", "conv+", "conv-", "shell-"]);
});

test("a group whose step throws rolls back and reports instead of half-mounting", () => {
	const log: string[] = [];
	const errors: string[] = [];
	const surface = surfaceGroups(
		{
			shell: () => [
				() => {
					log.push("shell+");
					return () => log.push("shell-");
				},
			],
			conversation: () => [
				() => {
					log.push("conv+");
					return () => log.push("conv-");
				},
				() => {
					throw new Error("inject failed");
				},
			],
		},
		{ onError: (group) => errors.push(group) },
	);
	surface.reconcile(groupsFor({ mode: "bot" }));
	assert.deepEqual(log, ["shell+", "conv+", "conv-"]);
	assert.deepEqual(errors, ["conversation"]);
	// The shell stays mounted; dispose only takes the shell down.
	surface.dispose();
	assert.deepEqual(log, ["shell+", "conv+", "conv-", "shell-"]);
});

test("remount withdraws the group and everything after it, then reconciles", () => {
	const log: string[] = [];
	const surface = surfaceGroups({
		shell: () => [
			() => {
				log.push("shell+");
				return () => log.push("shell-");
			},
		],
		conversation: () => [
			() => {
				log.push("conv+");
				return () => log.push("conv-");
			},
		],
	});
	surface.reconcile(groupsFor({ mode: "bot" }));
	log.length = 0;
	surface.remount("shell");
	assert.deepEqual(log, ["conv-", "shell-", "shell+", "conv+"]);
	surface.remount("nope");
	surface.dispose();
});

test("freePriority lands strictly below every same-cell entry", () => {
	assert.equal(freePriority([], { priority: 20 }), 20, "with no peers the wanted priority stands");
	assert.equal(freePriority([], { priority: undefined }), undefined);
	assert.equal(freePriority([], { priority: 0 }), 0);
	assert.equal(
		freePriority(
			[
				{ options: { priority: 10, key: "k" } },
				{ options: { priority: 10, key: "k" } },
				{ options: { priority: 2, key: "other" } },
			],
			{ priority: 20, key: "k" },
		),
		9,
	);
	assert.equal(freePriority([{ options: { priority: -5, key: "k" } }], { priority: 3, key: "k" }), -6);
});

test("the frame opens, rails, hides and draws the panel in the room it has", () => {
	assert.deepEqual(frameLayout({ viewport: 1400, sidebarWidth: 300, pref: "open" }), {
		left: "open",
		panel: "none",
		room: 1100,
	});
	assert.deepEqual(frameLayout({ viewport: 700, sidebarWidth: 300, pref: "open" }), {
		left: "rail",
		panel: "none",
		room: 612,
	});
	assert.deepEqual(frameLayout({ viewport: 700, sidebarWidth: 300, pref: "open", drawer: true }), {
		left: "drawer",
		panel: "none",
		room: 612,
	});
	assert.deepEqual(frameLayout({ viewport: 800, sidebarWidth: 300, pref: "open" }), {
		left: "open",
		panel: "none",
		room: 500,
	});
	assert.deepEqual(frameLayout({ viewport: 1400, sidebarWidth: 300, pref: "hidden" }), {
		left: "hidden",
		panel: "none",
		room: 1400,
	});
	const shown = frameLayout({
		viewport: 1400,
		sidebarWidth: 300,
		pref: "open",
		panel: { view: "details", yielded: false },
	});
	assert.equal(shown.panel, "shown");
	assert.equal(shown.room, 1100);
	const folded = frameLayout({
		viewport: 1000,
		sidebarWidth: 300,
		pref: "open",
		panel: { view: "browser", yielded: false },
	});
	assert.equal(folded.panel, "folded");
	const yielded = frameLayout({
		viewport: 1000,
		sidebarWidth: 300,
		pref: "open",
		panel: { view: "details", yielded: true },
	});
	assert.deepEqual(yielded, { left: "rail", panel: "shown", room: 912 });
	const overlay = frameLayout({
		viewport: 700,
		sidebarWidth: 300,
		pref: "open",
		panel: { view: "details", yielded: true },
	});
	assert.equal(overlay.panel, "overlay");
	assert.equal(overlay.left, "rail");
});

test("a drag snaps to the rail or docks an open column, floating it when the chat cannot fit", () => {
	assert.deepEqual(dragColumn(RAIL_SNAP - 1, 1400), { left: "rail", width: 88 });
	assert.deepEqual(dragColumn(300, 1400), { left: "open", width: 300 });
	assert.deepEqual(dragColumn(300, 700), { left: "open", width: 280 });
	assert.deepEqual(dragColumn(900, 1400), { left: "open", width: SIDEBAR_MAX });
	assert.deepEqual(dragColumn(300, 600), { left: "drawer", width: 300 });
	assert.deepEqual(dragColumn(500, 600), { left: "drawer", width: 420 });
	assert.deepEqual(dragColumn(10, 600), { left: "rail", width: 88 });
});

test("the sidebar switch restores the column it hid, and only a settled flip is the user's", () => {
	assert.equal(toggledPref("open", "open"), "hidden");
	assert.equal(toggledPref("rail", "rail"), "hidden");
	assert.equal(toggledPref("hidden", "rail"), "rail");
	const at = (collapsed: boolean, viewport: number) => ({ collapsed, viewport });
	// A settled flip on the same side of the narrow line is the user's.
	assert.equal(
		userSidebarToggle({ before: at(false, 1400), after: at(true, 1400), sinceResize: RESIZE_SETTLE_MS }),
		true,
	);
	// Crossing the shell's own auto-collapse line is the shell's rule, not a gesture.
	assert.equal(
		userSidebarToggle({ before: at(false, 1400), after: at(true, 900), sinceResize: RESIZE_SETTLE_MS }),
		false,
	);
	assert.equal(userSidebarToggle({ before: at(false, 1400), after: at(true, 1400), sinceResize: 100 }), false);
	assert.equal(
		userSidebarToggle({ before: at(false, 1400), after: at(true, 1400), requested: true, sinceResize: 900 }),
		false,
	);
	assert.equal(userSidebarToggle({ before: at(true, 1400), after: at(true, 1300), sinceResize: 900 }), false);
});

test("the saved sidebar defaults, clamps and round-trips", () => {
	assert.deepEqual(readSidebar(storage()), { pref: "open", shown: "open", width: FALLBACK_SIDEBAR_WIDTH });
	const saved = storage({ "ocean-crew:sidebar": JSON.stringify({ pref: "rail", shown: "rail", width: 500 }) });
	assert.deepEqual(readSidebar(saved), { pref: "rail", shown: "rail", width: SIDEBAR_MAX });
	const tiny = storage({ "ocean-crew:sidebar": JSON.stringify({ pref: "nope", shown: "nope", width: 10 }) });
	assert.deepEqual(readSidebar(tiny), { pref: "open", shown: "open", width: SIDEBAR_MIN });
	assert.deepEqual(readSidebar(storage({ "ocean-crew:sidebar": "{" })), {
		pref: "open",
		shown: "open",
		width: FALLBACK_SIDEBAR_WIDTH,
	});
	const target = storage();
	writeSidebar({ pref: "hidden", shown: "open", width: 300 }, target);
	assert.deepEqual(readSidebar(target), { pref: "hidden", shown: "open", width: 300 });
	writeSidebar({ pref: "open", shown: "open", width: 280 }, null as any);
});

test("the surface mode is saved and read back", () => {
	const target = storage();
	assert.equal(readMode(target), "bot");
	writeMode("agent", target);
	assert.equal(readMode(target), "agent");
	assert.equal(readMode(storage({ "ocean-crew:surface": "anything" })), "bot");
});

test("one shared map edits the stored object, not the window's old copy", () => {
	const target = storage();
	const first = sharedMap<Record<string, unknown>>("k", target);
	assert.deepEqual(first.read(), {});
	first.update((base) => ({ ...base, a: 1 }));
	// A second window edits the object as stored: both entries survive.
	const second = sharedMap<Record<string, unknown>>("k", target);
	second.update((base) => ({ ...base, b: 2 }));
	assert.deepEqual(JSON.parse(target.map.get("k") ?? "{}"), { a: 1, b: 2 });
	// A change that returns its input writes nothing.
	const before = target.map.get("k");
	second.update((base) => base);
	assert.equal(target.map.get("k"), before);
	assert.deepEqual(sharedMap("missing", target).read(), {}, "an absent key reads as an empty object");
	// The fallback is the window's own copy, used only when storage cannot be read.
	assert.deepEqual(sharedMap("k", storage({ k: "{" })).read({ fallback: true }), { fallback: true });
	const broken = storage({ k: "[1]" });
	assert.deepEqual(sharedMap("k", broken).read(), {});
});

test("the unread, reaction and seen maps only change what differs", () => {
	const reactions = toggleReaction({}, "m1", 0, "👍");
	assert.deepEqual(reactions, { m1: { 0: ["👍"] } });
	const more = toggleReaction(reactions, "m1", 0, "❤️");
	assert.deepEqual(more.m1[0], ["👍", "❤️"]);
	const fewer = toggleReaction(more, "m1", 0, "👍");
	assert.deepEqual(fewer.m1[0], ["❤️"]);
	assert.deepEqual(toggleReaction(fewer, "m1", 0, "❤️"), {});
	const unread = setUnread({}, "a", true);
	assert.deepEqual(unread, { a: true });
	assert.equal(setUnread(unread, "a", true), unread, "an unchanged map is returned as-is");
	assert.deepEqual(setUnread(unread, "a", false), {});
	const seen = noteLeft({}, ["a", "b"], 1000);
	assert.deepEqual(seen, { a: 1000, b: 1000 });
	assert.deepEqual(noteLeft(seen, ["a"], 900), { a: 1000, b: 1000 }, "seen time never goes back");
	assert.deepEqual(noteLeft(seen, ["a"], 1200), { a: 1200, b: 1000 });
	assert.deepEqual(setEntry({ a: 1 }, "a", undefined), {});
	const same = { a: 1 };
	assert.equal(setEntry(same, "b", undefined), same);
	assert.deepEqual(setEntry({ a: 1 }, "b", 2), { a: 1, b: 2 });
});

test("the right column reads open, collapsed or fullscreen and yields to the drawer", () => {
	assert.deepEqual(RIGHTBAR_ATTRIBUTES, ["data-rightbar-collapsed", "data-rightbar-fullscreen"]);
	const doc = (...selectors: string[]) => ({
		querySelector: (selector: string) => (selectors.includes(selector) ? {} : null),
	});
	assert.equal(rightColumnOpen(doc("[data-rightbar-col]")), true);
	assert.equal(rightColumnOpen(doc("[data-rightbar-collapsed]")), false, "a collapsed frame has no open column");
	assert.equal(rightColumnOpen(doc("[data-rightbar-collapsed]", "[data-rightbar-col]")), false);
	assert.equal(rightColumnOpen(doc("[data-rightbar-fullscreen]")), true);
	assert.equal(rightColumnOpen(doc()), false);
	assert.equal(drawerOpened(true), "collapse-column");
	assert.equal(drawerOpened(false), null);
	assert.equal(columnOpened(false, false), null);
	assert.equal(columnOpened(true, true), "collapse-column");
	assert.equal(columnOpened(true, false), "close-drawer");
});

test("a switch window flags the move and ignores a stale settle", () => {
	const settles: Array<() => void> = [];
	const window = createSwitchWindow((done) => settles.push(done));
	assert.equal(window.pending, false);
	window.moved();
	assert.equal(window.pending, true);
	settles[0]();
	assert.equal(window.pending, false);
	// A newer move restarts the window: the first settle no longer clears it.
	window.moved();
	window.moved();
	// The first move's settle is stale once the second move restarted the window.
	settles[1]();
	assert.equal(window.pending, true);
	settles[2]();
	assert.equal(window.pending, false);
});

test("@ mentions list a group's members or every other Bot, and never outside the team", () => {
	const empty = EMPTY_ROSTER;
	assert.equal(mentionRows(empty, "chief"), null, "an unprepared roster offers nothing");
	const value = roster(
		[
			{ id: "chief", name: "Chief" },
			{ id: "dev", name: "Dev", role: "Engineer" },
			{ id: "writer", name: "Writer" },
		],
		[{ id: "r1", name: "Ops", members: ["chief", "dev", "writer"], mode: "admin", admin: "chief" }],
	);
	const own = mentionRows(value, "chief");
	assert.deepEqual(
		own?.map((row) => row.text),
		["@Dev ", "@Writer "],
		"a Bot's own chat mentions every other Bot",
	);
	assert.equal(
		own?.some((row) => row.room),
		false,
		"no everyone row in a Bot's own chat",
	);
	const filtered = mentionRows(value, "chief", "wr");
	assert.deepEqual(
		filtered?.map((row) => row.text),
		["@Writer "],
	);
	const room = mentionRows(value, "r1");
	assert.deepEqual(
		room?.map((row) => row.text),
		["@Chief ", "@Dev ", "@Writer ", "@Everyone "],
	);
	const everyone = mentionRows(value, "r1", "every");
	assert.equal(everyone?.at(-1)?.room?.id, "r1");
	assert.equal(mentionRows(value, "r1", "zzz")?.length, 0);
	// A group with one member has no one to call as everyone.
	const single = roster(
		[
			{ id: "solo", name: "Solo" },
			{ id: "dev", name: "Dev" },
		],
		[{ id: "r2", name: "Pair", members: ["dev"], mode: "admin", admin: "dev" }],
	);
	assert.equal(
		mentionRows(single, "r2")?.some((row) => row.room),
		false,
	);
});

test("@ chats list other Bots and outside conversations, newest first", () => {
	const value = roster(
		[
			{ id: "chief", name: "Chief" },
			{ id: "dev", name: "Dev", sessionId: "dev-current" },
		],
		[{ id: "r1", name: "Ops", members: ["chief", "dev"], mode: "admin", admin: "chief", sessionId: "room-current" }],
	);
	const list = {
		ids: ["s-old", "s-new", "s-sub", "s-blank", "dev-current", "room-current"],
		byId: {
			"s-old": { id: "s-old", title: "Old", updatedAt: 100 },
			"s-new": { id: "s-new", displayTitle: "New", updatedAt: 300 },
			"s-sub": { id: "s-sub", title: "Sub", origin: "subagent", updatedAt: 900 },
			"s-blank": { id: "s-blank", title: "Blank", blank: true, updatedAt: 1000 },
			"dev-current": { id: "dev-current", title: "Dev", updatedAt: 500 },
			"room-current": { id: "room-current", title: "Room", updatedAt: 600 },
		},
	};
	const rows = chatRows(value, list, "chief");
	const labels = rows.map((row) => row.label);
	assert.deepEqual(labels.slice(0, 2), ["Chat with Dev", "New"], "Bots first, then outside chats newest first");
	assert.equal(labels.includes("Old"), true);
	assert.equal(labels.includes("Sub"), false, "subagent sessions stay out");
	assert.equal(labels.includes("Blank"), false, "blank sessions stay out");
	assert.equal(labels.includes("Room"), false, "team sessions stay out");
	assert.equal(
		rows.some((row) => row.sessionId === "chief"),
		false,
		"the current chat is not a target",
	);
	assert.deepEqual(chatRows(EMPTY_ROSTER, list, "chief"), []);
});

test("a session mention is DSH's canonical encoded label", () => {
	assert.equal(sessionMention("s1", "Chat"), "@[Chat](dsh-session:InMxIg)");
	assert.equal(sessionMention("s1", "A]B"), "@[A\\]B](dsh-session:InMxIg)");
	assert.equal(sessionMention("长", "标签").startsWith("@[标签](dsh-session:"), true);
});

test("the two at-sources answer from the roster, and chats only when launched", async () => {
	const value = roster(
		[
			{ id: "chief", name: "Chief" },
			{ id: "dev", name: "Dev" },
		],
		[{ id: "r1", name: "Ops", members: ["chief", "dev"], mode: "admin", admin: "chief" }],
	);
	const rosterSource = createSource(value);
	const sessions = { list: createSource({ ids: ["s1"], byId: { s1: { id: "s1", title: "Other", updatedAt: 1 } } }) };
	let launched = false;
	const sources = atSources({
		roster: rosterSource,
		sessions,
		launched: () => launched,
		iconFor: () => "icon",
	});
	assert.deepEqual(
		sources.map((source) => [source.name, source.trigger, source.order]),
		[
			[BOTS_SOURCE, "@", -20],
			[CHATS_SOURCE, "@", -10],
		],
	);
	const bots = sources[0];
	const candidates = await bots.candidates({ sessionId: "chief" }, { query: "d" });
	assert.deepEqual(
		candidates.map((row) => [row.name, row.value]),
		[["Dev", "@Dev "]],
	);
	assert.equal(candidates[0].section, "Bots");
	assert.deepEqual(bots.onPick({ candidate: candidates[0] }), { text: "@Dev " });
	assert.deepEqual(await sources[1].candidates({ sessionId: "chief" }), [], "chats stay out of a typed @");
	launched = true;
	const chats = await sources[1].candidates({ sessionId: "chief" });
	assert.deepEqual(
		chats.map((row) => row.name),
		["Dev", "Other"],
		"the other Bot's chat, then an outside Session with no team membership",
	);
	const picked = sources[1].onPick({ candidate: chats[0] });
	assert.equal(picked?.insert?.source, CHATS_SOURCE);
	assert.equal(picked?.insert?.label, "Chat with Dev");
	assert.equal(picked?.insert?.appearance, "session");
	assert.equal(sources[1].codec?.clipboardText?.("ref"), "ref");
});

// The panel takes its width from the room it shares with the conversation: the chat keeps
// MIN_CHAT, the panel stays between the details width and its maximum, and a panel that
// has to cover the conversation keeps its details width.
test("the panel width follows the room it shares with the chat", () => {
	assert.equal(panelWidth(1198), PANEL_DETAILS_MAX);
	assert.equal(panelWidth(900), 480);
	assert.equal(panelWidth(740), PANEL_DETAILS_WIDTH);
	assert.equal(panelWidth(600), PANEL_DETAILS_WIDTH);
	assert.equal(panelWidth(0), PANEL_DETAILS_WIDTH);
});

// The reply arrow: the quote goes into the draft through the composer's own insertion
// actions, at the caret the user left, across a Bot's chat parts, and it never disappears
// silently when no composer can take it.
function composerActions(value: Record<string, any> = {}) {
	const bots = value.bots ?? [{ id: "chief", name: "Chief", sessionId: "chief-2", parts: ["chief-1"] }];
	const rooms = value.rooms ?? [{ id: "r1", name: "Ops", members: ["chief"], sessionId: "r1-2", ownParts: ["r1-1"] }];
	const ui = createSource<any>({ quote: null, toast: null });
	const actions = teamActions({
		call: async () => ({}),
		after: async (promise: any) => promise,
		partFor: (id: string) => id,
		roster: createSource(roster(bots, rooms)),
		ui,
		live: createSource({}),
		cards: createSource({}),
		heldCards: createSource({}),
		turnClock: createSource({}),
	});
	return { actions, ui };
}

const recorder = () => {
	const calls: any[] = [];
	const input = {
		captureInsertion: () => ({ from: 2, to: 5 }),
		insertText: (text: string, span: any) => calls.push({ text, span }),
	};
	return { calls, input };
};

test("quoteDraft quotes up to three trimmed lines and leaves a blank line to type on", () => {
	assert.equal(quoteDraft("one"), "> one\n\n");
	assert.equal(quoteDraft("  one  \r\ntwo\n\nthree\nfour"), "> one\n> two\n> three\n\n");
	assert.equal(quoteDraft("\n \n"), "");
	assert.equal(quoteDraft(undefined), "");
	assert.equal(quoteDraft(42), "> 42\n\n");
});

test("quote inserts the draft at the caret the composer captured", () => {
	const { actions, ui } = composerActions();
	const { calls, input } = recorder();
	actions.registerComposer("chief-2", input);
	actions.quote("chief-2", "the answer\nwas 42");
	assert.deepEqual(calls, [{ text: "> the answer\n> was 42\n\n", span: { from: 2, to: 5 } }]);
	assert.equal(ui.getSnapshot().quote.sessionId, "chief-2");
	assert.equal(ui.getSnapshot().toast, null, "a landed quote shows no error");
});

test("a quote pressed on an older part lands in the part the composer types in", () => {
	const { actions } = composerActions();
	// Both the Bot id and its older part resolve to the current part registered by the composer.
	for (const sessionId of ["chief-1", "chief"]) {
		const { calls, input } = recorder();
		actions.registerComposer("chief-2", input);
		actions.quote(sessionId, "quoted");
		assert.deepEqual(calls, [{ text: "> quoted\n\n", span: { from: 2, to: 5 } }], sessionId);
	}
	// A group's own older part resolves the same way.
	const { calls, input } = recorder();
	actions.registerComposer("r1-2", input);
	actions.quote("r1-1", "group quote");
	assert.equal(calls[0].text, "> group quote\n\n");
});

test("a quote with no composer is kept for the next one and says it did not land", () => {
	const { actions, ui } = composerActions();
	assert.doesNotThrow(() => actions.quote("chief-2", "later"));
	assert.match(ui.getSnapshot().toast.text, /message box/);
	// The composer mounting later flushes the kept quote instead of dropping it.
	const { calls, input } = recorder();
	actions.registerComposer("chief-2", input);
	assert.deepEqual(calls, [{ text: "> later\n\n", span: { from: 2, to: 5 } }]);
	// It lands once: a second mount has nothing left to flush.
	const second = recorder();
	actions.registerComposer("chief-2", second.input);
	assert.equal(second.calls.length, 0);
});

test("an insertion that throws keeps the quote pending and reports instead of throwing", () => {
	const { actions, ui } = composerActions();
	const calls: any[] = [];
	actions.registerComposer("chief-2", {
		captureInsertion: () => {
			throw new Error("no caret");
		},
		insertText: (text: string) => calls.push(text),
	});
	assert.doesNotThrow(() => actions.quote("chief-2", "stubborn"));
	assert.match(ui.getSnapshot().toast.text, /message box/);
	assert.equal(calls.length, 0);
	const { calls: landed, input } = recorder();
	actions.registerComposer("chief-2", input);
	assert.equal(landed.length, 1, "the retry after the composer mounts inserts it");
});

test("unregistering the composer stops quotes from reaching it", () => {
	const { actions } = composerActions();
	const { calls, input } = recorder();
	actions.registerComposer("chief-2", input);
	actions.registerComposer("chief-2", undefined);
	actions.quote("chief-2", "gone");
	assert.equal(calls.length, 0);
});

test("the reply arrow keeps the composer's focus and the shell registers the composer", () => {
	const cells = readFileSync(new URL("../src/client/chat/cells.ts", import.meta.url), "utf8");
	assert.match(cells, /onMouseDown: keepComposerFocus,\s*\n\s*onClick: \(\) => actions\.quote\(sessionId, text\)/);
	const composer = readFileSync(new URL("../src/client/shell/composer.ts", import.meta.url), "utf8");
	assert.match(composer, /actions\.registerComposer\?\.\(sessionId, inputActions\)/);
	assert.match(composer, /actions\.registerComposer\?\.\(sessionId, undefined\)/);
});
