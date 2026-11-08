// The DOM side of the frame layout in frame-layout.ts: measuring the shell's sidebar track,
// and the one CSS rule that writes the conversation column's margins (our own column on the
// left, the Bot panel on the right).
import { installStyles } from "../look/styles.ts";

export const sidebarTrackWidth = (): number | null =>
	typeof document === "undefined"
		? null
		: (document.querySelector('[class*="_sidebarCol"]')?.getBoundingClientRect().width ?? null);

// The shell frame marks itself [data-sidebar-collapsed]; null when no frame is found.
export const dshCollapsed = (): boolean | null => {
	if (typeof document === "undefined") return null;
	const column = document.querySelector('[class*="_sidebarCol"]');
	return column ? (column.parentElement?.hasAttribute("data-sidebar-collapsed") ?? false) : null;
};

// The track the collapsed shell sidebar keeps: nothing under a frameless window (Windows
// title bar, macOS desktop), its icon rail elsewhere.
export const collapsedTrackWidth = (): number =>
	document.documentElement.hasAttribute("data-windows-titlebar") ||
	document.documentElement.dataset.platform === "darwin"
		? 0
		: 56;

// The conversation column's margins live in one rule of our own, matched on the column's
// exact class. A custom property on <body> would restyle the whole page, tens of
// milliseconds a write. A changed rule still restyles the column's subtree, so a drag
// writes the column's own inline style each frame and the rule once, on release.
const room: { rule: any; selector: string } = { rule: null, selector: "" };
const roomRule = (): any => {
	const live = room.rule?.parentStyleSheet?.ownerNode?.isConnected;
	if (live && room.selector) return room.rule;
	const column = document.querySelector('[class*="_centerCol"]');
	const selector = column
		? [...column.classList]
				.filter((name: string) => name.includes("_centerCol"))
				.map((name: string) => `.${CSS.escape(name)}`)
				.join(",")
		: "";
	if (live && !selector) return room.rule;
	const declarations = room.rule?.style.cssText ?? "";
	room.rule?.parentStyleSheet?.ownerNode?.remove();
	const style = installStyles(`${selector || '[class*="_centerCol"]'}{${declarations}}`, "chat-room");
	// A style element appended to the document always has a sheet.
	room.rule = style.sheet!.cssRules[0];
	room.selector = selector;
	return room.rule;
};
const margin = (side: "left" | "right", width: number | null, style: any): void => {
	if (width === null) style.removeProperty(`margin-${side}`);
	else style.setProperty(`margin-${side}`, `${width}px`, "important");
};
let roomHold = 0;

export const chatRoom = {
	/** The margin the Bot panel takes on the right, in px, or null for the shell's own. */
	setRight(width: number | null): void {
		margin("right", width, roomRule().style);
	},
	/** The margin our own left column takes while the shell sidebar is collapsed. */
	setLeft(width: number | null): void {
		margin("left", width, roomRule().style);
	},
	/** While on, a margin change lands at once instead of gliding. */
	hold(on: boolean): void {
		cancelAnimationFrame(roomHold);
		if (on) {
			roomRule().style.setProperty("transition", "none", "important");
			return;
		}
		// Two frames, so the last held write is on screen before the glide comes back.
		roomHold = requestAnimationFrame(() => {
			roomHold = requestAnimationFrame(() => roomRule().style.removeProperty("transition"));
		});
	},
	/** The columns themselves, for a drag's per-frame writes. */
	columns(): unknown[] {
		roomRule();
		return room.selector ? [...document.querySelectorAll(room.selector)] : [];
	},
};

/** The frame source the watcher writes the geometry into. */
export interface FrameSource {
	set(next: (state: any) => any): void;
}

// Feeds the frame source the geometry the layout rules read: viewport, the shell sidebar's
// collapsed track width, and its collapsed flag. A resize or a sidebar slide does not always
// come with a window event, so the track width comes off a ResizeObserver and the flag off a
// MutationObserver.
export function installFrameWatch(frame: FrameSource): () => void {
	let collapsedWidth = collapsedTrackWidth();
	let raf = 0;
	const watched = new Set<unknown>();
	const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
	const read = (): void => {
		// While the shell slides its sidebar (data-animating on the frame) the track reports
		// in-between widths: keep the last settled ones. The viewport and the collapsed flag
		// still update; the observer refires when the flag clears, so the settled width lands then.
		const column = document.querySelector('[class*="_sidebarCol"]');
		const animating = column?.closest("[data-animating]") != null;
		const width = animating ? null : sidebarTrackWidth();
		const collapsed = dshCollapsed();
		if (width !== null && collapsed === true) collapsedWidth = width;
		frame.set((state: any) => {
			const next = { ...state, viewport: window.innerWidth, collapsedWidth, collapsed: collapsed === true };
			return state.viewport === next.viewport &&
				state.collapsedWidth === next.collapsedWidth &&
				state.collapsed === next.collapsed
				? state
				: next;
		});
	};
	const measure = (): void => {
		for (const selector of ['[class*="_sidebarCol"]', '[class*="_centerCol"]']) {
			for (const element of document.querySelectorAll(selector)) {
				if (!watched.has(element)) {
					watched.add(element);
					observer?.observe(element);
				}
			}
		}
		read();
	};
	const schedule = (): void => {
		if (raf === 0)
			raf = requestAnimationFrame(() => {
				raf = 0;
				measure();
			});
	};
	measure();
	const mutations = new MutationObserver(schedule);
	mutations.observe(document.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["data-sidebar-collapsed", "data-animating"],
	});
	window.addEventListener("resize", schedule);
	return () => {
		cancelAnimationFrame(raf);
		mutations.disconnect();
		observer?.disconnect();
		window.removeEventListener("resize", schedule);
	};
}
