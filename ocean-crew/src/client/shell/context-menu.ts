// The Bot and group context menu: opening from a sidebar row, Escape and focus handling,
// and the viewport clamp that keeps it on screen. The DSH Agent row and its Sessions get
// menus with the same frame and their own entries.

import { Fragment, createElement as h, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../core/i18n.ts";
import { currentPart } from "../core/text.ts";
import {
	CopyIcon,
	DuplicateIcon,
	GearIcon,
	HideIcon,
	PencilIcon,
	PinIcon,
	StarLineIcon,
	TrashIcon,
	UnreadIcon,
} from "../look/icons.ts";
import { stepMenuFocus, useViewport, viewBottom } from "../look/motion.ts";
import { useEscape } from "./overlay-hooks.ts";
import { isMainOf } from "./sources.ts";

// hands them in, and every field read here is one the page owns.
type Any = any;
// The action of one menu row: its label, its icon, what it runs, and whether it removes.
type MenuAction = [label: string, icon: Any, run: () => unknown, danger?: boolean];

const menuGroups = (raw: Array<Array<MenuAction | null>>): MessageActionGroups =>
	raw.map((group) => group.filter((item): item is MenuAction => item !== null)).filter((group) => group.length > 0);
type MessageActionGroups = MenuAction[][];

export function ContextMenu({
	menu,
	roster,
	actions,
	leaving = false,
}: {
	menu: Any;
	roster: Any;
	actions: Any;
	leaving?: boolean;
}) {
	useEscape(() => actions.closeMenu());
	const ref = useRef<any>(null);
	const trigger = useRef<any>(typeof document === "undefined" ? null : document.activeElement);
	useEffect(() => {
		const onDown = (event: any): void => {
			if (!(event.target instanceof Element) || !event.target.closest(".bt-menu")) actions.closeMenu();
		};
		const onKey = (event: any): void => {
			stepMenuFocus(ref.current, event, trigger.current);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey, true);
		};
	}, []);
	const [place, setPlace] = useState<any>({ left: menu.x, top: menu.y });
	const tick = useViewport();
	useLayoutEffect(() => {
		const box = ref.current?.getBoundingClientRect();
		if (!box) return;
		setPlace({
			left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
			top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)),
		});
	}, [menu.x, menu.y, tick]);
	if (menu.kind === "agent" || menu.kind === "agent-session") return h(AgentMenu, { menu, roster, actions, leaving });
	const bot = roster.byId[menu.id];
	const room = roster.roomsById[menu.id];
	const entry = bot ?? room;
	if (entry === undefined) return null;
	const isMainBot = isMainOf(roster, menu.id);
	const isTile = roster.mainBotId === menu.id;
	const mainCount = (roster.mainBotIds ?? []).length;
	const groups = menuGroups([
		[
			isTile
				? null
				: [
						entry.pinned ? t("Unpin") : t("Pin"),
						PinIcon,
						() => actions.setFlags(menu.id, { pinned: !entry.pinned }),
					],
			[t("Mark as Unread"), UnreadIcon, () => actions.markUnread(menu.id)],
		],
		[
			bot ? [t("Rename Bot"), PencilIcon, () => actions.renameBot(bot.id)] : null,
			bot ? [t("Edit Bot"), GearIcon, () => actions.openSettings("bots", bot.id)] : null,
			room ? [t("Group settings"), GearIcon, () => actions.openSettings("groups", room.id)] : null,
			room ? [t("Rename group"), PencilIcon, () => actions.renameBot(room.id)] : null,
			bot
				? [
						t("Duplicate"),
						DuplicateIcon,
						async () => {
							const copy = await actions.duplicateBot(bot.id);
							actions.openSession(copy.id);
						},
					]
				: null,
			bot && !isMainBot ? [t("Make Main Bot"), StarLineIcon, () => actions.setMain(bot.id, true)] : null,
			bot && isMainBot && mainCount > 1
				? [t("Remove Main Bot role"), StarLineIcon, () => actions.setMain(bot.id, false)]
				: null,
		],
		[[t("Copy conversation ID"), CopyIcon, () => navigator.clipboard?.writeText(bot ? currentPart(bot) : menu.id)]],
		[
			isMainBot ? null : [t("Hide from sidebar"), HideIcon, () => actions.setFlags(menu.id, { hidden: true })],
			isMainBot
				? null
				: [
						room ? t("Delete group") : t("Delete"),
						TrashIcon,
						() => (bot ? actions.deleteBot(bot.id) : actions.deleteRoom(menu.id)),
						true,
					],
		],
	]);
	return h(
		"div",
		{
			ref,
			className: "bt-menu",
			role: "menu",
			"aria-label": t("{name} actions", { name: bot?.name ?? room.name }),
			style: place,
			"data-leaving": leaving || undefined,
		},
		groups.map((group, index) =>
			h(
				Fragment,
				{ key: index },
				index > 0 ? h("div", { className: "bt-menu-sep", role: "separator" }) : null,
				group.map(([label, Icon, run, danger]) =>
					h(
						"button",
						{
							key: label,
							type: "button",
							role: "menuitem",
							className: danger ? "bt-danger" : undefined,
							onClick: () => {
								actions.closeMenu();
								void Promise.resolve(run()).catch((error: unknown) => actions.reportError(error, "menu"));
							},
						},
						h(Icon),
						label,
					),
				),
			),
		),
	);
}

// Menus for the DSH Agent row and its Sessions; none of the Bot entries apply.
function AgentMenu({ menu, roster, actions, leaving }: { menu: Any; roster: Any; actions: Any; leaving?: boolean }) {
	const ref = useRef<any>(null);
	const trigger = useRef<any>(typeof document === "undefined" ? null : document.activeElement);
	useEffect(() => {
		const onKey = (event: any): void => {
			stepMenuFocus(ref.current, event, trigger.current);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
	const [place, setPlace] = useState<any>({ left: menu.x, top: menu.y });
	const tick = useViewport();
	useLayoutEffect(() => {
		const box = ref.current?.getBoundingClientRect();
		if (!box) return;
		setPlace({
			left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
			top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)),
		});
	}, [menu.x, menu.y, tick]);
	const agent = roster.agentsById[menu.kind === "agent" ? menu.id : menu.agentId];
	if (agent === undefined) return null;
	const groups = menuGroups(
		menu.kind === "agent"
			? [
					[
						[
							agent.pinned ? t("Unpin") : t("Pin"),
							PinIcon,
							() => actions.setFlags(agent.id, { pinned: !agent.pinned }),
						],
					],
					[[t("Remove DSH Agent"), TrashIcon, () => actions.removeAgent(agent.id), true]],
				]
			: [
					[[t("Rename"), PencilIcon, () => actions.beginAgentRename(menu.id)]],
					[[t("Archive"), TrashIcon, () => actions.archiveAgentSession(agent.id, menu.id), true]],
				],
	);
	return h(
		"div",
		{
			ref,
			className: "bt-menu",
			role: "menu",
			"aria-label": menu.kind === "agent" ? "DSH Agent" : t("Session actions"),
			style: place,
			"data-leaving": leaving || undefined,
		},
		groups.map((group, index) =>
			h(
				Fragment,
				{ key: index },
				index > 0 ? h("div", { className: "bt-menu-sep", role: "separator" }) : null,
				group.map(([label, Icon, run, danger]) =>
					h(
						"button",
						{
							key: label,
							type: "button",
							role: "menuitem",
							className: danger ? "bt-danger" : undefined,
							onClick: () => {
								actions.closeMenu();
								void Promise.resolve(run()).catch((error: unknown) => console.warn("[ocean-crew]", error));
							},
						},
						h(Icon),
						label,
					),
				),
			),
		),
	);
}
