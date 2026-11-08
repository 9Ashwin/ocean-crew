// The Bot-to-Bot exchange dialog: one Bot's messages to another, long ones shown by
// their start and read on request.
import { Fragment, createElement as h, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../core/i18n.ts";
import { dayLabel } from "../core/text.ts";
import { inkText } from "../look/inks.ts";
import { BotMark, colorOf } from "../look/mark.ts";
import { layoutOf } from "../look/themes.ts";
import { useEscape, usePaneLeft } from "../shell/overlay-hooks.ts";
import { Bubbles } from "./cells.ts";
import { stripLongNote } from "./fold.ts";

const SHEET_EXIT_MS = 220;

/** One message in the transcript between two Bots. */
export interface ExchangeEntry {
	id: string;
	from: string;
	time: number;
	text: string;
	/** Set when the host kept only the start of a long message. */
	length?: number;
}

/** A Bot as the roster reports it. */
export interface ExchangeBot {
	id: string;
	name?: string;
	color?: string;
	[key: string]: unknown;
}

export interface ExchangeRoster {
	byId: Record<string, ExchangeBot | undefined>;
	prefs?: { layout?: string };
}

export interface ExchangeActions {
	exchange(from: string, to: string): Promise<ExchangeEntry[] | null | undefined>;
	exchangeText(id: string): Promise<string>;
	closeOverlay(): void;
}

export interface ExchangeDialogProps {
	pair: [string, string];
	roster: ExchangeRoster;
	actions: ExchangeActions;
}

export function ExchangeDialog({ pair, roster, actions }: ExchangeDialogProps): any {
	const [entries, setEntries] = useState<ExchangeEntry[] | null>(null);
	const [leaving, setLeaving] = useState(false);
	const log = useRef<any>(null);
	const atEnd = useRef(true);
	useLayoutEffect(() => {
		if (entries !== null && atEnd.current && log.current) log.current.scrollTop = log.current.scrollHeight;
	}, [entries]);
	// The sheet slides back down before it unmounts.
	const close = (): void => {
		if (leaving) return;
		setLeaving(true);
		setTimeout(() => actions.closeOverlay(), SHEET_EXIT_MS);
	};
	useEscape(close);
	useEffect(() => {
		let stop = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let seen: string | null = null;
		atEnd.current = true;
		setEntries(null);
		const load = async (): Promise<void> => {
			const result = await actions.exchange(pair[0], pair[1]);
			if (stop) return;
			const key = JSON.stringify(result ?? []);
			if (key !== seen) {
				seen = key;
				setEntries(result ?? []);
			}
			timer = setTimeout(load, document.hidden ? 8000 : 2000);
		};
		void load();
		return () => {
			stop = true;
			clearTimeout(timer);
		};
	}, [pair[0], pair[1]]);
	const left = roster.byId[pair[0]];
	const right = roster.byId[pair[1]];
	const flat = layoutOf(roster.prefs) === "flat";
	let lastDay = 0;
	const paneLeft = usePaneLeft();
	return h(
		"div",
		{ className: "bt-pane bt-exchange", style: { left: paneLeft }, "data-leaving": leaving || undefined },
		h(
			"div",
			{ className: "bt-dialog", role: "dialog", "aria-label": t("Bot exchange") },
			h(
				"div",
				{ className: "bt-head" },
				h(
					"span",
					{ className: "bt-pill", style: { cursor: "default" } },
					left ? h(BotMark, { bot: left, size: 22 }) : null,
					left?.name ?? "?",
					h("span", { className: "bt-swap" }, "⇄"),
					right ? h(BotMark, { bot: right, size: 22 }) : null,
					right?.name ?? "?",
				),
			),
			h(
				"div",
				{
					ref: log,
					className: "bt-dialog-log",
					role: "log",
					"aria-label": t("Bot exchange transcript"),
					onScroll: (event: any) => {
						const node = event.currentTarget;
						atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 2;
					},
				},
				entries === null
					? h("div", { className: "bt-hint" }, t("Loading…"))
					: entries.length === 0
						? h("div", { className: "bt-hint" }, t("No messages yet"))
						: entries.map((entry) => {
								const bot = roster.byId[entry.from] ?? { id: entry.from, name: t("You"), color: "gray" };
								const showDay = entry.time - lastDay > 30 * 60 * 1000;
								lastDay = entry.time;
								// A long message comes with its start only; the rest is read on request.
								const whole =
									entry.length === undefined
										? undefined
										: { length: entry.length, load: () => actions.exchangeText(entry.id) };
								const lead = h("span", { className: "bt-lead" }, h(BotMark, { bot: bot, size: 22 }));
								return h(
									Fragment,
									{ key: entry.id },
									showDay ? h("time", { className: "bt-time" }, dayLabel(entry.time)) : null,
									h(
										"div",
										{ className: "bt-group-msg" },
										h(
											"span",
											{
												className: "bt-group-name",
												style: flat ? undefined : { color: inkText(colorOf(bot)) },
											},
											flat ? lead : null,
											bot.name,
										),
										h(Bubbles, {
											texts: [stripLongNote(entry.text)],
											roster,
											selfId: bot.id,
											actions,
											whole,
											lead: flat ? null : lead,
										}),
									),
								);
							}),
			),
			h(
				"div",
				{ className: "bt-dialog-foot" },
				h("button", { type: "button", className: "bt-soft", onClick: close }, t("Close Chat")),
			),
		),
	);
}
