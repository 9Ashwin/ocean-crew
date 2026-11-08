// The right-hand Bot panel: a Bot's details or one of its side chats. Browser pages are
// gone; a Bot that needs a page uses the local Playwright CLI through its shell tools.
import { createElement as h, useEffect, useRef, useState } from "react";
import { SideChatView } from "../chat/side-chat.ts";
import { sideChatsOf } from "../chat/side-model.ts";
import { t } from "../core/i18n.ts";
import { DotsIcon, FolderIcon, SideIcon, TerminalIcon } from "../look/icons.ts";
import { SPRING_SHAPE, stepMenuFocus, useLinger } from "../look/motion.ts";
import { DetailsDrawer } from "./details-drawer.ts";

export const PANEL_LINGER_MS = 300;

export interface PanelMenuItem {
	key?: string;
	icon?: unknown;
	label?: string;
	onPick?: () => void;
	sep?: boolean;
}

// The `···` popover anchored to its button. `items` holds {key, icon, label,
// onPick} and {sep:true} entries; Escape or a click outside closes it. The
// callers hide the button when the list is empty.
export function PanelMenu({
	items,
	className,
	"aria-label": label,
}: {
	items: PanelMenuItem[];
	className: string;
	"aria-label": string;
}) {
	const [open, setOpen] = useState(false);
	const [shown, leaving] = useLinger(open, 120);
	const wrap = useRef<any>(null);
	const button = useRef<any>(null);
	useEffect(() => {
		if (!open) return undefined;
		const onDown = (event: any): void => {
			if (wrap.current && !wrap.current.contains(event.target)) setOpen(false);
		};
		const onKey = (event: any): void => {
			if (stepMenuFocus(wrap.current, event, button.current)) return;
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setOpen(false);
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);
	if (items.length === 0) return null;
	return h(
		"span",
		{ className: "bt-pmenu", ref: wrap },
		h(
			"button",
			{
				ref: button,
				type: "button",
				className,
				"aria-label": label,
				title: label,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				onClick: () => setOpen((value) => !value),
			},
			h(DotsIcon),
		),
		shown
			? h(
					"div",
					{ className: "bt-pmenu-pop", role: "menu", "data-leaving": leaving || undefined },
					items.map((item, index) =>
						item.sep
							? h("span", { key: `sep-${index}`, className: "bt-pmenu-sep", role: "separator" })
							: h(
									"button",
									{
										key: item.key,
										type: "button",
										role: "menuitem",
										className: "bt-pmenu-item",
										onClick: () => {
											setOpen(false);
											item.onPick?.();
										},
									},
									h(item.icon as any),
									h("span", null, item.label),
								),
					),
				)
			: null,
	);
}

// The menu builders in side-model.js give keys; each maps to an icon, a label
// and the action it runs. A rejected action surfaces through reportError.
export function menuItemFor(key: string, actions: any, subject: string): PanelMenuItem {
	const report = (run: () => unknown) => () => {
		void Promise.resolve(run()).catch((error) => actions.reportError(error, "panel-menu"));
	};
	switch (key) {
		case "side":
			return { key, icon: SideIcon, label: t("Side chat"), onPick: report(() => actions.newSideChat(subject)) };
		case "terminal":
			return { key, icon: TerminalIcon, label: t("Terminal"), onPick: report(() => actions.newTerminal()) };
		case "files":
			return { key, icon: FolderIcon, label: t("Files"), onPick: report(() => actions.openFiles()) };
		default:
			return { sep: true };
	}
}

// The panel column: details for the subject Bot or group, or one of its side chats.
export function BotPanel({
	pane,
	leaving,
	overlay,
	roster,
	actions,
	useSessions,
	useSessionStatus,
	useActivity,
	useWork,
}: any) {
	const bot = roster.byId[pane.id];
	const sideChats = bot ? sideChatsOf(roster, bot.id) : [];
	const sideChat = sideChats.find((chat: any) => chat?.id === pane.side);
	const view = pane.view === "side" && sideChat !== undefined ? "side" : "details";
	return h(
		"aside",
		{
			className: "bt-panel",
			"data-leaving": leaving || undefined,
			"data-overlay": overlay || undefined,
			style: { "--bt-panel-w": "520px" },
		},
		view === "side" && sideChat
			? h(
					"div",
					{ key: `side:${sideChat.id}`, className: "bt-panel-view" },
					h(SideChatView, { subject: pane.id, chat: sideChat, roster, actions }),
				)
			: h(
					"div",
					{ key: `details:${pane.id}`, className: "bt-panel-view" },
					h(DetailsDrawer, {
						sessionId: pane.id,
						startRenaming: pane.renaming,
						startTab: pane.tab,
						hasStrip: false,
						roster,
						actions,
						useSessions,
						useSessionStatus,
						useActivity,
						useWork,
					}),
				),
	);
}

export const PANEL_CSS = `
.bt-panel{position:fixed;inset-block:0;inset-inline-end:0;z-index:40;display:flex;flex-direction:column;width:var(--bt-panel-w,520px);max-width:calc(100vw - 320px);background:var(--bt-bg);border-inline-start:1px solid var(--bt-line);box-shadow:var(--bt-shadow-panel,0 0 32px rgba(0,0,0,.12));overflow:hidden}
.bt-panel[data-leaving]{pointer-events:none}
.bt-panel-view{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto}
`;
