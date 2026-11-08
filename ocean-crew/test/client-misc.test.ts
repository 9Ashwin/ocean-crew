// The remaining small client modules: their pure logic, plus the text and CSS the
// React components carry. React is provided by the shell at run time and is not
// installed for Node tests, so the component files (connector-marks, connectors-page,
// capability-settings, avatar-library, card-hold, exchange) are verified by tsc and by
// the text checks here instead of being imported.
// task; group-replies has its own test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noticeApprovals } from "../src/client/chat/approval-notices.ts";
import { rectsOverlap } from "../src/client/shell/browser-overlap.ts";

const CLIENT = new URL("../src/client/", import.meta.url);
// The client tree is grouped by feature; keep the test's short names.
const GROUPS: Record<string, string> = {
	"connector-marks.ts": "pages/connector-marks.ts",
	"connectors-page.ts": "pages/connectors-page.ts",
	"avatar-library.ts": "pages/avatar-library.ts",
	"capability-settings.ts": "pages/capability-settings.ts",
	"exchange.ts": "chat/exchange.ts",
	"card-hold.ts": "chat/card-hold.ts",
	"browser-overlap.ts": "shell/browser-overlap.ts",
};
const source = (name: string): string => readFileSync(new URL(GROUPS[name] ?? name, CLIENT), "utf8");

interface FakeNote {
	title: string;
	options: { body?: string; tag?: string };
	onclick?: () => void;
	closed: boolean;
	close(): void;
}

function fakeNotification() {
	const notes: FakeNote[] = [];
	class Fake {
		static permission = "granted";
		title: string;
		options: { body?: string; tag?: string };
		onclick?: () => void;
		closed = false;
		constructor(title: string, options: { body?: string; tag?: string }) {
			this.title = title;
			this.options = options;
			notes.push(this as unknown as FakeNote);
		}
		close(): void {
			this.closed = true;
		}
	}
	return { Fake, notes };
}

test("rectsOverlap treats touching edges and zero sizes as no overlap", () => {
	const a = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };
	assert.equal(rectsOverlap(a, { left: 50, top: 50, width: 100, height: 100, right: 150, bottom: 150 }), true);
	// Touching edges do not overlap.
	assert.equal(rectsOverlap(a, { left: 100, top: 0, width: 10, height: 10, right: 110, bottom: 10 }), false);
	assert.equal(rectsOverlap(a, { left: 0, top: 100, width: 10, height: 10, right: 10, bottom: 110 }), false);
	// Something with no area covers nothing, nor is anything covered.
	assert.equal(rectsOverlap(a, { left: 10, top: 10, width: 0, height: 10, right: 10, bottom: 20 }), false);
	assert.equal(rectsOverlap({ left: 10, top: 10, width: 10, height: 0, right: 20, bottom: 10 }, a), false);
	// Apart on either axis.
	assert.equal(rectsOverlap(a, { left: 101, top: 0, width: 10, height: 10, right: 111, bottom: 10 }), false);
	assert.equal(rectsOverlap(a, { left: 0, top: 101, width: 10, height: 10, right: 10, bottom: 111 }), false);
});

test("an approval that starts waiting notifies once, and one already waiting before the window opened does not", () => {
	const { Fake, notes } = fakeNotification();
	const globals = globalThis as any;
	const saved = { Notification: globals.Notification, document: globals.document, window: globals.window };
	globals.Notification = Fake;
	globals.document = { visibilityState: "hidden" };
	const focused: boolean[] = [];
	globals.window = { focus: () => focused.push(true) };
	const opened: string[] = [];
	try {
		let approvals: { id: string; at?: number; botId?: string; tool?: string; roomId?: string }[] = [
			{ id: "a1", at: 200, botId: "b1", tool: "Shell", roomId: "r1" },
			{ id: "a2", at: 50, botId: "b1", tool: "Read" },
		];
		let listener: (() => void) | undefined;
		const work = {
			getSnapshot: () => ({ approvals }),
			subscribe: (next: () => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
		};
		const roster = {
			getSnapshot: () => ({ byId: { b1: { name: "Chief" } }, roomsById: { r1: { name: "Ops" } } }),
		};
		const stop = noticeApprovals({
			work,
			roster,
			shownSession: () => "s-else",
			openSession: (place) => opened.push(place),
			since: 100,
		});
		// The first approval notifies; the one that waited before `since` is no news.
		assert.deepEqual(
			notes.map((note) => [note.title, note.options.body, note.options.tag]),
			[["Chief is waiting for your approval", "Ops · Shell", "ocean-crew-approval-a1"]],
		);
		// A second tick does not repeat it; a new approval does.
		listener?.();
		assert.equal(notes.length, 1);
		approvals = [...approvals, { id: "a3", at: 300, botId: "b1", tool: "Write" }];
		listener?.();
		assert.equal(notes.length, 2);
		// The whole notification opens the conversation it belongs to and closes itself.
		notes[1].onclick?.();
		assert.deepEqual(opened, ["b1"]);
		assert.equal(notes[1].closed, true);
		// While the window shows that very chat, the approval that belongs to it does not
		// pop up; the ones that belong to other conversations still do.
		approvals = [...approvals, { id: "a4", at: 400, botId: "b1", tool: "Delete" }];
		globals.document = { visibilityState: "visible" };
		const stopVisible = noticeApprovals({
			work,
			roster,
			shownSession: () => "r1",
			openSession: (place) => opened.push(place),
			since: 0,
		});
		assert.deepEqual(
			notes.slice(2).map((note) => note.options.tag),
			["ocean-crew-approval-a2", "ocean-crew-approval-a3", "ocean-crew-approval-a4"],
		);
		stopVisible();
		stop();
		assert.equal(listener, undefined);
	} finally {
		globals.Notification = saved.Notification;
		globals.document = saved.document;
		globals.window = saved.window;
	}
});

test("the connector marks keep the catalog's ids and the shared CSS keeps its class names", () => {
	const marks = source("connector-marks.ts");
	for (const id of [
		"github",
		"notion",
		"linear",
		"sentry",
		"stripe",
		"slack",
		"canva",
		"monday",
		"attio",
		"exa",
		"deepwiki",
		"context7",
		"mslearn",
		"amap",
		"mail",
		"mail-163",
		"mail-126",
		"mail-other",
		"mail-gmail",
		"mail-icloud",
		"mail-qq",
	]) {
		assert.match(marks, new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), id);
	}
	assert.match(marks, /export const MARKS = \{/);
	assert.match(marks, /GITHUB_D/);

	const connectors = source("connectors-page.ts");
	assert.match(connectors, /export const CONNECTORS_PAGE_CSS = `/);
	assert.match(connectors, /\.bt-app-grid\{display:grid/);
	assert.match(connectors, /\.bt-app-chips button\[aria-pressed=true\]/);
	assert.match(connectors, /export function ConnectorsPage\(/);
	// Every category and the recommended row are still there, verbatim.
	for (const text of ["Developer", "Docs & files", "Commerce", "Recommended", "Mailbox", "Other MCP server"]) {
		assert.ok(connectors.includes(text), text);
	}

	const avatar = source("avatar-library.ts");
	assert.match(avatar, /export const AVATAR_LIBRARY_CSS = `/);
	assert.match(avatar, /\.bt-lib-pick img\{/);
	assert.match(avatar, /const CHUNK = 20/);
	assert.match(avatar, /const PAGE = 24/);

	const capabilities = source("capability-settings.ts");
	for (const text of [
		"Shared capabilities",
		"Add capability",
		"Local command",
		"HTTP server",
		"Save an MCP server or skill first.",
	]) {
		assert.ok(capabilities.includes(text), text);
	}

	// The dialog and the dock hold keep their class names and timing.
	assert.match(source("exchange.ts"), /bt-exchange/);
	assert.match(source("exchange.ts"), /const SHEET_EXIT_MS = 220/);
	assert.match(source("card-hold.ts"), /noteHeldCard/);
	assert.match(source("browser-overlap.ts"), /export function rectsOverlap/);
});
