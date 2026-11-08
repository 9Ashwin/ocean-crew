// What a Bot runs on: the "Runs on" card of a Bot's settings. Changing it starts a new
// part of every conversation, so it asks first.
import { createElement as h, useState } from "react";
import { t } from "../core/i18n.ts";
import { startModel } from "./bot-draft.ts";
import { ModelMenu } from "./model-menu.ts";

export function RunModeCard({ bot, roster, actions, run, Card }: any) {
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState("");
	const start = () => {
		setTarget(startModel(roster));
		setOpen(true);
	};
	const changing = target !== "" && target !== bot.model;
	const confirm = () =>
		run(actions.updateBot(bot.id, { model: target })).then((done: any) => {
			if (done !== false) setOpen(false);
		});
	return h(
		Card,
		{ title: t("Runs on") },
		h(
			"div",
			{ className: "bt-set-row bt-bs-row" },
			h(
				"span",
				{ className: "bt-set-copy" },
				h("span", { className: "bt-bs-label" }, t("Ocean Crew model")),
				h(
					"span",
					{ className: "bt-set-hint" },
					t("Answers with a model served by Ocean Crew, with Ocean Crew's tools."),
				),
			),
			h(
				"button",
				{
					type: "button",
					className: "bt-soft bt-soft-sm",
					"aria-expanded": open,
					onClick: () => (open ? setOpen(false) : start()),
				},
				open ? t("Cancel") : t("Change"),
			),
		),
		open
			? h(
					"div",
					{ className: "bt-runmode" },
					h(ModelMenu, {
						bot: { id: bot.id, name: bot.name, model: target || undefined },
						roster,
						actions,
						wide: true,
						withEfforts: false,
						onPick: setTarget,
					}),
					changing
						? h(
								"div",
								{
									className: "bt-runmode-confirm",
									role: "group",
									"aria-label": t("Change what {name} runs on?", { name: bot.name }),
								},
								h(
									"div",
									{ className: "bt-runmode-title" },
									t("Change what {name} runs on?", { name: bot.name }),
								),
								h(
									"ul",
									{ className: "bt-runmode-notes" },
									h(
										"li",
										{ key: "new-part" },
										t("A new part starts in every conversation, so the change applies from now on."),
									),
								),
								h(
									"button",
									{ type: "button", className: "bt-send", onClick: () => void confirm() },
									t("Change and start a new part"),
								),
							)
						: null,
				)
			: null,
	);
}

export const AGENT_CARDS_CSS = `
.bt-runmode{display:flex;flex-direction:column;gap:10px;margin-top:8px}
.bt-runmode-confirm{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-runmode-title{font-size:13px;font-weight:600}
.bt-runmode-notes{margin:0;padding-left:18px;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
`;
