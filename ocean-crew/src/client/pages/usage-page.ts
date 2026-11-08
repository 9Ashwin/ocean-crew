// Usage: what the team spent, grouped by Bot and by group chat. The numbers come from
// DSH's own token-meter session projections; the page only displays them.
import { createElement as h, useEffect, useState } from "react";
import { dateLocale, t } from "../core/i18n.ts";
import { BotAvatar, RoomAvatar } from "../look/mark.ts";

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface Row {
	kind: "bot" | "room";
	id: string;
	name: string;
	color?: string;
	sessions: number;
	totals: Totals;
}

interface View {
	available: boolean;
	rows: Row[];
	total: Totals;
}

const tokens = (n: number): string => n.toLocaleString(dateLocale());
const sum = (totals: Totals): number => totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
const cell = (label: string, value: number): any =>
	h(
		"span",
		{ className: "bt-set-hint", style: { display: "flex", justifyContent: "space-between", gap: "18px" } },
		h("span", null, label),
		h("span", { style: { fontVariantNumeric: "tabular-nums", color: "var(--bt-ink)" } }, tokens(value)),
	);

// The settings route keeps `focusId` for a Bot or group; the row it names is marked.
export function UsagePage({ roster, actions, focusId }: any) {
	const [view, setView] = useState<View | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void Promise.resolve(actions.usage())
			.then((answer: any) => {
				if (live) setView(answer as View);
			})
			.catch((error: any) => {
				if (live) setFailed(error?.message ?? String(error));
			});
		return () => {
			live = false;
		};
	}, [actions]);

	const total = view?.total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return h(
		"div",
		{ className: "bt-set-page" },
		h(
			"section",
			{ className: "bt-set-section" },
			h("h3", null, t("Usage")),
			h(
				"div",
				{ className: "bt-set-card" },
				h(
					"div",
					{ className: "bt-set-row" },
					h(
						"div",
						{ className: "bt-set-copy" },
						h("span", null, t("Team total")),
						cell(t("Input"), total.input),
						cell(t("Output"), total.output),
						cell(t("Cache read"), total.cacheRead),
						cell(t("Cache write"), total.cacheWrite),
					),
					h(
						"div",
						{ className: "bt-set-control" },
						h(
							"strong",
							{ style: { fontVariantNumeric: "tabular-nums" } },
							`${tokens(sum(total))} ${t("Tokens")}`,
						),
					),
				),
			),
		),
		failed !== null ? h("p", { className: "bt-error" }, failed) : null,
		view === null
			? null
			: view.available === false
				? h("p", { className: "bt-set-hint" }, t("This DSH does not provide token usage."))
				: view.rows.length === 0
					? h("p", { className: "bt-set-hint" }, t("No tokens have been spent yet."))
					: h(
							"section",
							{ className: "bt-set-section" },
							h("h3", null, t("By Bot and group")),
							h(
								"div",
								{ className: "bt-set-card" },
								view.rows.map((row) => {
									const bot = row.kind === "bot" ? roster?.byId?.[row.id] : undefined;
									const room = row.kind === "room" ? { members: [] } : undefined;
									return h(
										"div",
										{
											key: `${row.kind}:${row.id}`,
											className: "bt-set-row",
											style: focusId === row.id ? { background: "var(--bt-hover)" } : undefined,
										},
										h(
											"div",
											{ className: "bt-set-copy" },
											h(
												"span",
												{ style: { display: "flex", alignItems: "center", gap: "8px" } },
												row.kind === "bot"
													? h(BotAvatar, {
															bot: bot ?? { id: row.id, name: row.name, color: row.color },
															size: 22,
															badge: false,
														})
													: h(RoomAvatar, { room: room as any, roster: roster ?? { byId: {} }, size: 22 }),
												row.name,
											),
											h(
												"span",
												{ className: "bt-set-hint" },
												`${row.sessions} ${t("Sessions")} · ${t("Input")} ${tokens(row.totals.input)} · ${t("Output")} ${tokens(row.totals.output)} · ${t("Cache read")} ${tokens(row.totals.cacheRead)} · ${t("Cache write")} ${tokens(row.totals.cacheWrite)}`,
											),
										),
										h(
											"div",
											{ className: "bt-set-control" },
											h(
												"strong",
												{ style: { fontVariantNumeric: "tabular-nums" } },
												tokens(sum(row.totals)),
											),
										),
									);
								}),
							),
						),
	);
}
