// The Bot shell's frame geometry: the left column (open, avatar rail, drawer or hidden),
// the Bot panel and the conversation share the window. The conversation keeps at least
// MIN_CHAT px; the column folds to a rail of avatars before the chat is squeezed, and an
// open panel that no longer fits folds away or covers the chat. These rules are pure so
// tests can drive them; the DOM side lives in frame-watch.ts.
import { STORAGE } from "../core/storage.ts";

export const MIN_CHAT = 420;
export const RAIL_WIDTH = 88;
export const PANEL_MIN: Record<string, number> = { details: 320, browser: 360, side: 320 };
// The shell collapses its own sidebar below this width.
export const DSH_NARROW = 1024;
// The open column's width range; a drag released short of RAIL_SNAP lands on the rail.
export const SIDEBAR_MIN = 264;
export const SIDEBAR_MAX = 420;
export const FALLBACK_SIDEBAR_WIDTH = 280;
export const RAIL_SNAP = (RAIL_WIDTH + SIDEBAR_MIN) / 2;

export type SidebarPref = "open" | "rail" | "hidden";
export type LeftColumn = "open" | "rail" | "drawer" | "hidden";
export type PanelState = "none" | "shown" | "folded" | "overlay";

export interface FrameLayoutInput {
	viewport: number;
	sidebarWidth: number;
	pref: SidebarPref;
	drawer?: boolean;
	panel?: null | { view: string; yielded: boolean };
}

export interface FrameLayout {
	left: LeftColumn;
	panel: PanelState;
	/** The width the panel and the conversation share. */
	room: number;
}

/**
 * `room` is the width the panel and the conversation share: the viewport minus what the
 * left column occupies (its full width when open, nothing when hidden, else the rail's —
 * a drawer floats over the rail's place, so the chat does not move under it).
 */
export function frameLayout({
	viewport,
	sidebarWidth,
	pref,
	drawer = false,
	panel = null,
}: FrameLayoutInput): FrameLayout {
	const fits = pref === "open" && viewport >= sidebarWidth + MIN_CHAT;
	let left: LeftColumn = pref === "hidden" ? "hidden" : fits ? "open" : drawer && pref === "open" ? "drawer" : "rail";
	let occupied = left === "open" ? sidebarWidth : left === "hidden" ? 0 : RAIL_WIDTH;
	let panelState: PanelState = "none";
	if (panel !== null) {
		const need = (PANEL_MIN[panel.view] ?? PANEL_MIN.details) + MIN_CHAT;
		if (occupied + need <= viewport) panelState = "shown";
		else if (panel.yielded === true) {
			// A panel the user asks to see takes the column's room: it falls back to the rail,
			// and covers the conversation only when even that is not enough.
			if (left !== "hidden") {
				left = "rail";
				occupied = RAIL_WIDTH;
			}
			panelState = occupied + need <= viewport ? "shown" : "overlay";
		} else panelState = "folded";
	}
	return { left, panel: panelState, room: Math.max(0, viewport - occupied) };
}

export interface DragResult {
	left: "rail" | "open" | "drawer";
	width: number;
}

/**
 * Where a drag of the column's edge to `x` lands: short of RAIL_SNAP the rail; past it an
 * open column of that width, docked while the chat keeps MIN_CHAT beside it, else floating
 * as a drawer.
 */
export function dragColumn(x: number, viewport: number): DragResult {
	if (x < RAIL_SNAP) return { left: "rail", width: RAIL_WIDTH };
	const docks = viewport >= SIDEBAR_MIN + MIN_CHAT;
	const high = docks ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - MIN_CHAT)) : SIDEBAR_MAX;
	return { left: docks ? "open" : "drawer", width: Math.round(Math.max(SIDEBAR_MIN, Math.min(x, high))) };
}

// The top-left switch hides the whole column and brings back the one it hid.
export const toggledPref = (pref: SidebarPref, shown: SidebarPref): SidebarPref =>
	pref === "hidden" ? shown : "hidden";

// The shell measures the window on its own frame, a beat apart from us, and re-applies its
// own rule when it does: a flip this soon after a width change is the shell settling, not a
// gesture.
export const RESIZE_SETTLE_MS = 500;

export interface SidebarState {
	collapsed: boolean;
	viewport: number;
}

export interface SidebarToggleInput {
	before: SidebarState;
	after: SidebarState;
	requested?: boolean;
	sinceResize?: number;
}

// A flip of the shell's collapsed flag counts as the user's own switch gesture only when we
// did not request it, the width has settled, and it stayed on one side of the auto-collapse
// line (a crossing is the shell's own rule firing).
export const userSidebarToggle = ({
	before,
	after,
	requested = false,
	sinceResize = Infinity,
}: SidebarToggleInput): boolean =>
	before.collapsed !== after.collapsed &&
	!requested &&
	sinceResize >= RESIZE_SETTLE_MS &&
	before.viewport < DSH_NARROW === after.viewport < DSH_NARROW;

// The user's column survives restarts: `pref` is 'open' by default, 'rail' after a drag down
// to it, 'hidden' after the switch; `shown` is what the switch brings back; `width` is the
// open column's.
const PREFS: readonly string[] = ["open", "rail", "hidden"];

export interface SidebarSaved {
	pref: SidebarPref;
	shown: "open" | "rail";
	width: number;
}

/** The slice of `localStorage` this module uses. */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const defaultStorage = (): StorageLike | undefined =>
	(globalThis as unknown as { localStorage?: StorageLike }).localStorage;

export function readSidebar(storage?: StorageLike): SidebarSaved {
	try {
		const store = storage ?? defaultStorage();
		const saved = JSON.parse(store?.getItem(STORAGE.sidebar) ?? "null") as Partial<SidebarSaved> | null;
		const pref = PREFS.includes(String(saved?.pref)) ? (saved?.pref as SidebarPref) : "open";
		const shown = saved?.shown === "rail" ? "rail" : "open";
		const width = Number.isFinite(saved?.width)
			? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved?.width)))
			: FALLBACK_SIDEBAR_WIDTH;
		return { pref, shown, width };
	} catch {
		return { pref: "open", shown: "open", width: FALLBACK_SIDEBAR_WIDTH };
	}
}

export function writeSidebar(value: SidebarSaved, storage?: StorageLike): void {
	try {
		(storage ?? defaultStorage())?.setItem(STORAGE.sidebar, JSON.stringify(value));
	} catch {
		/* storage unavailable */
	}
}
