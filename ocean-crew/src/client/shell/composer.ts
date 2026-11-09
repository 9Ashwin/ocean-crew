// Composer: typing, mentions and the add menu; the shell's send button submits.
import { Fragment, createElement as h, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../core/i18n.ts";
import { ChatsIcon, ClockIcon, GoalIcon, PaperclipIcon, PeopleIcon, PlusIcon } from "../look/icons.ts";
import { BotMark } from "../look/mark.ts";
import { stepMenuFocus, useLinger, useViewport, viewBottom } from "../look/motion.ts";
import { canSetGoal } from "../pages/goal.ts";
import { enterSteers, steerable } from "./enter-steer.ts";

const keepComposerFocus = (event: any) => event.preventDefault();

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu does not
// remount its mark on every keystroke.
export function menuIcons(roster: any) {
	const marks = new Map<string, any>();
	return (row: any) => {
		if (!row.bot) return PeopleIcon;
		const id = row.bot.id;
		if (!marks.has(id)) {
			marks.set(id, ({ size = 14 }: any) => h(BotMark, { bot: roster.getSnapshot().byId[id] ?? row.bot, size }));
		}
		return marks.get(id);
	};
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another chat, or
// set a scheduled task for this chat. It stands in for the shell's command menu, whose plan,
// permission, model and compact rows reach past what Ocean Crew keeps for its Bots; "/"
// still opens that menu. Files go through the shell's own file input beside it.
export function ComposerPlus({ sessionId, inputActions, useInput, useRoster, actions }: any) {
	const roster = useRoster((value: any) => value);
	const [open, setOpen] = useState<any>(null);
	const [shown, leaving] = useLinger(open, 120);
	const button = useRef<any>(null);
	const menu = useRef<any>(null);
	const tick = useViewport();
	// The reply arrow reaches the caret through these while this composer is mounted.
	useEffect(() => {
		actions.registerComposer?.(sessionId, inputActions);
		return () => actions.registerComposer?.(sessionId, undefined);
	}, [sessionId, inputActions]);
	// The selector runs on every input change, so inputNow stays live for the key handler
	// while `ready` re-renders only when steerability flips.
	const inputNow = useRef<any>(undefined);
	const ready =
		useInput?.((state: any) => {
			inputNow.current = state;
			return steerable(state);
		}) === true;
	useEffect(() => {
		if (!open) return undefined;
		const onDown = (event: any) => {
			if (![button.current, menu.current].some((node) => node?.contains(event.target))) setOpen(null);
		};
		const onKey = (event: any) => {
			if (stepMenuFocus(menu.current, event, button.current)) return;
			if (event.key === "Escape") {
				event.stopPropagation();
				setOpen(null);
			}
		};
		window.addEventListener("mousedown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open]);
	// No deps: the "+" can mount after this effect first ran, and the card swap on a session
	// switch must pick the placeholder up again.
	useEffect(() => {
		const card = button.current?.closest("[data-composer-card]");
		if (!ready || card === null || card === undefined) return undefined;
		card.style.setProperty("--bt-placeholder", JSON.stringify(t("Press Enter to steer queued messages")));
		return () => card.style.removeProperty("--bt-placeholder");
	});
	useEffect(() => {
		let steering = false;
		const onKey = (event: any) => {
			if (steering || event.defaultPrevented || open) return;
			const target = event.target;
			if (typeof target?.closest !== "function") return;
			const card = button.current?.closest("[data-composer-card]");
			if (card === null || card === undefined || target.closest("[data-composer-card]") !== card) return;
			if (target.closest("[contenteditable=true]") === null) return;
			if (target.closest("[data-composer-composing]")) return;
			if (target.ownerDocument?.querySelector('[role="listbox"]')) return;
			if (!enterSteers(event, inputNow.current)) return;
			event.preventDefault();
			event.stopPropagation();
			steering = true;
			void Promise.resolve(actions.steerQueued(sessionId)).finally(() => {
				steering = false;
			});
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, sessionId]);
	// Hooks stay above the early return below: the roster may not know the Bot yet, and a
	// render that skips a hook breaks the composer's slot when the roster arrives.
	// Anchored to the "+" each render: the visible viewport can move (on-screen keyboard)
	// while the menu is open.
	const place = useMemo(() => {
		if (!shown || !button.current) return null;
		const rect = button.current.getBoundingClientRect();
		return { left: rect.left, bottom: viewBottom() - rect.top + 8 };
	}, [shown, open, tick]);
	const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id;
	if (sessionId === undefined || target === undefined) return null;
	const fileInput = () => button.current?.closest("[data-composer-card]")?.querySelector("input[type=file]");
	const toggle = () => {
		if (open) {
			setOpen(null);
			return;
		}
		// Files go through the composer's own file input; a composer without one takes none.
		setOpen({ files: Boolean(fileInput()) });
	};
	const attach = () => {
		setOpen(null);
		fileInput()?.click();
	};
	const schedule = () => {
		setOpen(null);
		actions.openSettings("schedules", target);
	};
	// The chats open in the shell's "@" menu at the caret, so the pick lands where the user was
	// typing.
	const reference = () => {
		setOpen(null);
		actions.referenceChat(sessionId, inputActions?.captureInsertion?.());
	};
	const canReference = typeof inputActions?.captureInsertion === "function" && actions.canReferenceChat();
	const room = roster.roomsById?.[sessionId];
	const goal = () => {
		setOpen(null);
		actions.composeGoal(room.id);
	};
	return h(
		Fragment,
		null,
		h(
			"button",
			{
				ref: button,
				type: "button",
				className: "bt-plus",
				"aria-label": t("Add"),
				title: t("Add"),
				"aria-haspopup": "menu",
				"aria-expanded": Boolean(open),
				onMouseDown: keepComposerFocus,
				onClick: toggle,
			},
			h(PlusIcon),
		),
		shown
			? createPortal(
					h(
						"div",
						{
							ref: menu,
							className: "bt-menu bt-menu-up bt-plus-menu",
							role: "menu",
							"aria-label": t("Add"),
							style: place ?? {},
							"data-leaving": leaving || undefined,
						},
						shown.files
							? h(
									"button",
									{ type: "button", role: "menuitem", onClick: attach },
									h(PaperclipIcon),
									h("span", { className: "bt-menu-label" }, t("Add files")),
								)
							: null,
						canReference
							? h(
									"button",
									{ type: "button", role: "menuitem", onMouseDown: keepComposerFocus, onClick: reference },
									h(ChatsIcon),
									h("span", { className: "bt-menu-label" }, t("Reference a chat")),
								)
							: null,
						canSetGoal(room, roster)
							? h(
									"button",
									{ type: "button", role: "menuitem", onClick: goal },
									h(GoalIcon),
									h("span", { className: "bt-menu-label" }, t("Set a goal")),
								)
							: null,
						h(
							"button",
							{ type: "button", role: "menuitem", onClick: schedule },
							h(ClockIcon),
							h("span", { className: "bt-menu-label" }, t("Scheduled task")),
						),
					),
					document.body,
				)
			: null,
	);
}
