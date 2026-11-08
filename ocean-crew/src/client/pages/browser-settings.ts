// The Browser access settings: what each Bot may post, upload, download or delete on its
// own, per site, until a time. Everything else it does on a page is free; these grants
// only lift the confirmation the Bot asks for.
import { createElement as h, useEffect, useState } from "react";
import { dateLocale, t } from "../core/i18n.ts";
import { BotAvatar } from "../look/mark.ts";

const ACTIONS: ReadonlyArray<readonly [string, string]> = [
	["post", "Post"],
	["upload", "Upload"],
	["download", "Download"],
	["delete", "Delete"],
];
const DURATIONS: ReadonlyArray<readonly [string, string]> = [
	["hour", "1 hour"],
	["today", "Today"],
	["week", "7 days"],
	["permanent", "Permanent"],
];

/** A site grant as the team file keeps it: kinds of action, and when it stops. */
export interface BrowserGrant {
	site: string;
	kinds: string[];
	until?: number;
}

const expired = (grant: BrowserGrant): boolean => Number.isFinite(grant.until) && (grant.until as number) <= Date.now();

function siteValue(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/^[a-z][a-z\d+.-]*:\/\//, "")
			.split(/[/?#]/, 1)[0]
			.replace(/:\d+$/, "") || "*"
	);
}

function grantTime(grant: BrowserGrant): string {
	if (!Number.isFinite(grant.until)) return t("Permanent");
	if ((grant.until as number) <= Date.now()) return t("Expired");
	const time = new Date(grant.until as number).toLocaleString(dateLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	});
	return t("Until {time}", { time });
}

function grantKinds(grant: BrowserGrant): string[] {
	if (grant.kinds.includes("*")) return [t("All four")];
	return ACTIONS.filter(([kind]) => grant.kinds.includes(kind)).map(([, label]) => t(label));
}

/**
 * The settings row page: a Bot's grants, and the form that adds one. `Section` and `Row`
 * are the settings shell's own components; `run` starts a host action.
 */
export function BrowserPage({ roster, actions, run, Section, Row }: any) {
	const bots: any[] = roster.bots ?? [];
	const [botId, setBotId] = useState(bots[0]?.id ?? "");
	const [site, setSite] = useState("");
	const [kinds, setKinds] = useState<string[]>(["post"]);
	const [duration, setDuration] = useState("hour");
	const [busy, setBusy] = useState(false);
	const selectedBot = bots.find((bot) => bot.id === botId);

	useEffect(() => {
		if (!bots.some((bot) => bot.id === botId)) setBotId(bots[0]?.id ?? "");
	}, [bots, botId]);

	const grants = bots.flatMap((bot) =>
		(bot.browserGrants ?? []).map((grant: BrowserGrant, index: number) => ({
			bot,
			grant,
			index,
			expired: expired(grant),
		})),
	);
	const remove = (bot: any, index: number): void => {
		const next = (bot.browserGrants ?? []).filter(
			(grant: BrowserGrant, position: number) => position !== index && !expired(grant),
		);
		void run(actions.updateBot(bot.id, { browserGrants: next.length ? next : null }));
	};
	const add = (event: any): void => {
		event.preventDefault();
		if (!selectedBot || kinds.length === 0 || busy) return;
		const now = Date.now();
		let until: number | undefined;
		if (duration === "hour") until = now + 60 * 60 * 1000;
		else if (duration === "today") {
			const end = new Date(now);
			end.setHours(23, 59, 59, 999);
			until = end.getTime();
		} else if (duration === "week") until = now + 7 * 24 * 60 * 60 * 1000;
		const grant: BrowserGrant = {
			site: siteValue(site),
			kinds: [...kinds],
			...(until !== undefined ? { until } : {}),
		};
		setBusy(true);
		void run(
			actions.updateBot(selectedBot.id, {
				browserGrants: [
					...(selectedBot.browserGrants ?? []).filter((existing: BrowserGrant) => !expired(existing)),
					grant,
				],
			}),
		).finally(() => setBusy(false));
	};
	const toggleKind = (kind: string, checked: boolean): void => {
		setKinds((current) =>
			checked ? (current.includes(kind) ? current : [...current, kind]) : current.filter((value) => value !== kind),
		);
	};

	return h(
		"div",
		{ className: "bt-browser-settings" },
		h(
			Section,
			{ title: t("Browser access") },
			h(
				"p",
				{ className: "bt-browser-note" },
				t(
					"Bots browse, click and fill in forms freely. Posting, uploading, downloading and deleting ask you first unless you allow them here. Payments are always yours: the Bot hands the page to you.",
				),
			),
		),
		h(
			Section,
			{ title: t("Allowed actions") },
			grants.length === 0
				? h(Row, { label: t("Nothing allowed yet.") })
				: grants.map(({ bot, grant, index, expired: wasExpired }: any) =>
						h(
							"div",
							{
								key: `${bot.id}:${index}`,
								className: `bt-browser-grant${wasExpired ? " bt-browser-grant-expired" : ""}`,
							},
							h(
								"div",
								{ className: "bt-browser-grant-who" },
								h(BotAvatar, { bot, size: 28 }),
								h("span", null, bot.name),
							),
							h(
								"div",
								{ className: "bt-browser-grant-meta" },
								h(
									"span",
									{ className: "bt-browser-grant-site" },
									grant.site === "*" ? t("All sites") : grant.site,
								),
								h(
									"div",
									{ className: "bt-browser-grant-kinds" },
									grantKinds(grant).map((label) => h("span", { key: label, className: "bt-chip" }, label)),
								),
								h("span", { className: "bt-set-hint" }, grantTime(grant)),
							),
							h(
								"button",
								{
									type: "button",
									className: "bt-soft bt-soft-sm",
									onClick: () => remove(bot, index),
									"aria-label": t("Remove grant"),
								},
								t("Remove grant"),
							),
						),
					),
		),
		h(
			Section,
			{ title: t("Allow an action") },
			h(
				"form",
				{ className: "bt-browser-form", onSubmit: add },
				h(
					Row,
					{ label: t("Bot") },
					h(
						"select",
						{
							className: "bt-select",
							value: botId,
							onChange: (event: any) => setBotId(event.target.value),
							disabled: bots.length === 0,
						},
						bots.map((bot) => h("option", { key: bot.id, value: bot.id }, bot.name)),
					),
				),
				h(
					Row,
					{ label: t("Site") },
					h("input", {
						className: "bt-input bt-browser-site",
						type: "text",
						value: site,
						placeholder: t("example.com — leave empty for all sites"),
						onChange: (event: any) => setSite(event.target.value),
					}),
				),
				h(
					Row,
					{ label: t("Actions") },
					h(
						"div",
						{ className: "bt-browser-action-list" },
						ACTIONS.map(([kind, label]) =>
							h(
								"label",
								{ key: kind, className: "bt-browser-action-choice" },
								h("input", {
									type: "checkbox",
									checked: kinds.includes(kind),
									onChange: (event: any) => toggleKind(kind, event.target.checked),
								}),
								t(label),
							),
						),
					),
				),
				h(
					Row,
					{ label: t("Duration") },
					h(
						"div",
						{ className: "bt-browser-duration", role: "group", "aria-label": t("Duration") },
						DURATIONS.map(([key, label]) =>
							h(
								"button",
								{
									key,
									type: "button",
									className: "bt-browser-duration-choice",
									"aria-pressed": duration === key,
									onClick: () => setDuration(key),
								},
								t(label),
							),
						),
					),
				),
				h(
					"div",
					{ className: "bt-browser-form-foot" },
					h(
						"button",
						{
							type: "submit",
							className: "bt-soft bt-soft-sm",
							disabled: busy || !selectedBot || kinds.length === 0,
						},
						busy ? t("Saving…") : t("Add"),
					),
				),
			),
		),
	);
}
