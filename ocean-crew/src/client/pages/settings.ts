import { Component, createElement as h, useCallback, useEffect, useRef, useState } from "react";
import { ComputerPage } from "../chat/computer.ts";
import { KeyIcon, SecretsPage } from "../chat/secret-card.ts";
import { t } from "../core/i18n.ts";
import {
	ChatsIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ClockIcon,
	CloseIcon,
	ConnectorIcon,
	GlobeIcon,
	InfoIcon,
	MonitorIcon,
	PlugIcon,
	PlusIcon,
	SETTINGS_ICONS,
	SlidersIcon,
} from "../look/icons.ts";
import { ACCENT_INKS, INKS } from "../look/inks.ts";
import { AdminStar, BotAvatar, RoomAvatar } from "../look/mark.ts";
import { Segmented, useGlide } from "../look/motion.ts";
import { allThemes, flatWidthOf, layoutOf, MESSAGE_WIDTH, thinkingShown, widthOf } from "../look/themes.ts";
import { useEscape } from "../shell/overlay-hooks.ts";
import { isMainOf } from "../shell/sources.ts";
import { AboutPage } from "./about.ts";
import { BotSettingsForm, Switch } from "./bot-settings.ts";
import { BrowserPage } from "./browser-settings.ts";
import { CapabilitiesPage } from "./capability-settings.ts";
import { ConnectorsPage } from "./connectors-page.ts";
import { CreateBot } from "./create-bot.ts";
import { FeedbackIcon, FeedbackPage } from "./feedback.ts";
import { FolderMenu } from "./folder-menu.ts";
import { GroupSettingsForm, NewGroupForm } from "./group-settings.ts";
import { ImPage } from "./im-page.ts";
import { KeptPrivateSection } from "./kept-private.ts";
import { ModelMenu } from "./model-menu.ts";
import { ProvidersPage } from "./providers-page.ts";
import { SchedulesPage } from "./schedules.ts";
import { UsagePage } from "./usage-page.ts";

// The bundle runs in the DSH window; the host type check has no DOM lib.
declare const document: any;

const capitalize = (word: string): string => word[0].toUpperCase() + word.slice(1);

// Settings dialog: a 198px page list beside the page. Bots and group chats each list
// their members, and one opens on its own settings form. Usage widens the dialog.
// Models is there wherever the host serves the model providers, beside DSH's own settings.
const SETTINGS_PAGES: ReadonlyArray<readonly [string, string]> = [
	["general", "General"],
	["models", "Models"],
	["bots", "Bots"],
	["groups", "Group chats"],
	["connectors", "Connectors"],
	["im", "IM"],
	["capabilities", "Capabilities"],
	["browser", "Browser"],
	["computer", "Computer use"],
	["schedules", "Scheduled tasks"],
	["usage", "Usage"],
	["secrets", "Secrets"],
	["feedback", "Feedback"],
	["about", "About Ocean Crew"],
];
const PAGE_ICONS: Record<string, any> = {
	...SETTINGS_ICONS,
	models: SlidersIcon,
	connectors: ConnectorIcon,
	im: ChatsIcon,
	capabilities: PlugIcon,
	browser: GlobeIcon,
	computer: MonitorIcon,
	schedules: ClockIcon,
	secrets: KeyIcon,
	feedback: FeedbackIcon,
	about: InfoIcon,
};

function SetSection({ title, className = "", children }: any) {
	return h(
		"section",
		{ className: `bt-set-section ${className}`.trim() },
		h("h3", null, title),
		h("div", { className: "bt-set-card" }, children),
	);
}
function SetRow({ label, hint, children, className = "" }: any) {
	return h(
		"div",
		{ className: `bt-set-row ${className}`.trim() },
		h(
			"div",
			{ className: "bt-set-copy" },
			h("span", null, label),
			hint ? h("span", { className: "bt-set-hint" }, hint) : null,
		),
		children ? h("div", { className: "bt-set-control" }, children) : null,
	);
}

const LAYOUTS: ReadonlyArray<readonly [string, string]> = [
	["bubble", "Bubble"],
	["flat", "Flat"],
];

function Choice({ label, value, options, pick }: any) {
	return h(
		Segmented,
		{ label, value, className: "bt-look-seg" },
		options.map(([id, text]: readonly [string, string]) =>
			h(
				"button",
				{
					key: id,
					type: "button",
					"aria-pressed": value === id,
					onClick: () => {
						if (value !== id) pick(id);
					},
				},
				t(text),
			),
		),
	);
}

// A width in percent of the column. A drag saves once it rests, as the custom accent
// does; a change still waiting when the dialog closes is saved, not dropped.
function WidthSlider({ label, value, save }: any) {
	const [width, setWidth] = useState(value);
	const pending = useRef<number | null>(null);
	const timer = useRef<any>(0);
	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => {
		if (pending.current === null) setWidth(value);
	}, [value]);
	const flush = (): void => {
		const next = pending.current;
		pending.current = null;
		if (next !== null) saveRef.current(next);
	};
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			flush();
		},
		[],
	);
	const pick = (next: number): void => {
		setWidth(next);
		pending.current = next;
		clearTimeout(timer.current);
		timer.current = setTimeout(flush, 350);
	};
	const { min, max, step } = MESSAGE_WIDTH;
	return h(
		"div",
		{ className: "bt-range", style: { "--bt-fill": `${((width - min) / (max - min)) * 100}%` } },
		h("input", {
			type: "range",
			min,
			max,
			step,
			value: width,
			"aria-label": label,
			"aria-valuetext": `${width}%`,
			onChange: (event: any) => pick(Number(event.target.value)),
		}),
		h("output", null, `${width}%`),
	);
}

function GeneralPage({ roster, actions, run }: any) {
	const prefs = roster.prefs ?? {};
	const themes = allThemes();
	const current = themes[prefs.theme] ? prefs.theme : "deepseek";
	const [custom, setCustom] = useState(prefs.accent ?? "#4d6bfe");
	const timer = useRef<any>(0);
	useEffect(() => () => clearTimeout(timer.current), []);
	const pickCustom = (value: string): void => {
		setCustom(value);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => run(actions.setPrefs({ accent: value })), 350);
	};
	return [
		h(
			SetSection,
			{ key: "look", title: t("Appearance") },
			h(
				SetRow,
				{ label: t("Theme"), hint: t("Colors for the whole team, on every device.") },
				h(
					"select",
					{
						className: "bt-select",
						"aria-label": t("Theme"),
						value: current,
						onChange: (event: any) => run(actions.setPrefs({ theme: event.target.value })),
					},
					Object.entries(themes).map(([id, theme]: [string, any]) =>
						h("option", { key: id, value: id }, t(theme.label)),
					),
				),
			),
			h(
				SetRow,
				{ label: t("Accent"), hint: t("Unread marks, badges, and the brand mark.") },
				h(
					"div",
					{ className: "bt-swatches" },
					h("button", {
						type: "button",
						className: "bt-swatch bt-swatch-default",
						title: t("Theme accent"),
						"aria-label": t("Theme accent"),
						"aria-pressed": !prefs.accent,
						onClick: () => run(actions.setPrefs({ accent: null })),
					}),
					ACCENT_INKS.map((ink: string) =>
						h("button", {
							key: ink,
							type: "button",
							className: "bt-swatch",
							title: t(capitalize(ink)),
							"aria-label": t(capitalize(ink)),
							"aria-pressed": prefs.accent === INKS[ink][0],
							style: { background: INKS[ink][0] },
							onClick: () => run(actions.setPrefs({ accent: INKS[ink][0] })),
						}),
					),
					h(
						"label",
						{
							className: "bt-swatch bt-swatch-custom",
							title: t("Custom accent"),
							"data-on":
								Boolean(prefs.accent) && !ACCENT_INKS.some((ink: string) => INKS[ink][0] === prefs.accent),
						},
						h("input", {
							type: "color",
							value: custom,
							"aria-label": t("Custom accent"),
							onChange: (event: any) => pickCustom(event.target.value),
						}),
					),
				),
			),
			h(
				SetRow,
				{ label: t("Message layout") },
				h(Choice, {
					label: t("Message layout"),
					value: layoutOf(prefs),
					options: LAYOUTS,
					pick: (id: string) => run(actions.setPrefs({ layout: id })),
				}),
			),
			// The flat layout's text has a width of its own; the bubble width stays for the user's messages.
			layoutOf(prefs) === "flat"
				? h(
						SetRow,
						{ label: t("Text width") },
						h(WidthSlider, {
							label: t("Text width"),
							value: flatWidthOf(prefs),
							save: (flatWidth: number) => run(actions.setPrefs({ flatWidth })),
						}),
					)
				: null,
			h(
				SetRow,
				{ label: t("Bubble width") },
				h(WidthSlider, {
					label: t("Bubble width"),
					value: widthOf(prefs),
					save: (width: number) => run(actions.setPrefs({ width })),
				}),
			),
			h(
				SetRow,
				{ label: t("Show thinking") },
				h(Switch, {
					label: t("Show thinking"),
					on: thinkingShown(prefs),
					onChange: (thinking: boolean) => run(actions.setPrefs({ thinking })),
				}),
			),
		),
		h(
			SetSection,
			{ key: "new", title: t("New Bots") },
			h(
				SetRow,
				{ label: t("Default model"), className: "bt-set-model" },
				h(ModelMenu, {
					bot: { id: "new-bots", name: t("New Bots"), model: prefs.defaultBotModel },
					roster,
					actions,
					run,
					wide: true,
					withEfforts: false,
					onPick: (ref: string) => run(actions.setPrefs({ defaultBotModel: ref })),
				}),
				prefs.defaultBotModel
					? h(
							"button",
							{
								type: "button",
								className: "bt-soft bt-soft-sm",
								onClick: () => run(actions.setPrefs({ defaultBotModel: null })),
							},
							t("Reset"),
						)
					: null,
			),
		),
		h(
			SetSection,
			{ key: "input", title: t("Input") },
			h(
				SetRow,
				{ label: t("Enter sends message") },
				h(Switch, {
					label: t("Enter sends message"),
					on: prefs.enterToSend !== false,
					onChange: (enterToSend: boolean) => run(actions.setPrefs({ enterToSend })),
				}),
			),
		),
		// The footer entry above the settings button is the primary switch; this row
		// stays as the settings-side fallback for surfaces that do not draw it.
		actions.setSurface
			? h(
					SetSection,
					{ key: "mode", title: t("Mode") },
					h(
						SetRow,
						{ label: t("Classic Agent mode") },
						h(
							"button",
							{ type: "button", className: "bt-soft bt-soft-sm", onClick: () => actions.setSurface("agent") },
							t("Switch"),
						),
					),
				)
			: null,
		h(LocationsSection, { key: "places", actions, run }),
		h(ResetSection, { key: "reset", actions, run }),
	];
}

// The desktop app's preload hands its window `dsBotApp`; only there does the data location
// show, since DSH keeps the plugin's data where it runs.
function LocationsSection({ actions, run }: any) {
	const app = (globalThis as any).dsBotApp;
	const [team, setTeam] = useState<any>(null);
	const [data, setData] = useState<any>(null);
	// One change at a time: the data move checks the new folder against the team workspace, and

	const [moving, setMoving] = useState(false);
	const busy = useRef(false);
	useEffect(() => {
		void Promise.resolve(actions.folders())
			.then((info: any) => setTeam(info?.team ?? null))
			.catch(() => {});
		if (app !== undefined)
			void Promise.resolve(app.dataLocation())
				.then(setData)
				.catch(() => {});
	}, []);
	const pickTeam = (path: string): any => {
		if (busy.current) return undefined;
		busy.current = true;
		setMoving(true);
		return run(
			Promise.resolve(actions.setTeamWorkspace(path))
				.then((answer: any) => {
					setTeam(answer.team);
					app?.teamWorkspaceChanged(answer.team);
				})
				.finally(() => {
					busy.current = false;
					setMoving(false);
				}),
		);
	};
	return h(
		SetSection,
		{ title: t("Locations"), className: "bt-set-places" },
		h(
			SetRow,
			{ label: t("Team workspace"), hint: t("Where Bots without a folder of their own work.") },
			team === null
				? null
				: h(FolderMenu, { value: team, team: true, actions, run, onPick: pickTeam, disabled: moving }),
		),
		data === null
			? null
			: h(
					SetRow,
					{ label: t("Data location"), hint: data.path },
					data.fixed
						? null
						: h(
								"button",
								{
									type: "button",
									className: "bt-soft bt-soft-sm",
									disabled: moving,
									onClick: () => {
										if (!busy.current) void run(app.moveData(team ?? undefined));
									},
								},
								t("Change…"),
							),
				),
	);
}

// Starting over: the team is replaced by a fresh one, first Main Bot included. The
// confirmation is in place because there is no undo from the UI; a backup stays on disk.
function ResetSection({ actions, run }: any) {
	const [confirming, setConfirming] = useState(false);
	const [confirmAgain, setConfirmAgain] = useState(false);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reset = (): void => {
		if (!confirmAgain) {
			setConfirmAgain(true);
			return;
		}
		setBusy(true);
		setError(null);
		void Promise.resolve(run(actions.resetTeam()))
			.then((answer: any) => {
				setDone(answer?.backup ?? "");
				setConfirming(false);
				setConfirmAgain(false);
			})
			.catch((failure: any) => setError(failure?.message ?? String(failure)))
			.finally(() => setBusy(false));
	};
	return h(
		SetSection,
		{ title: t("Start over") },
		h(
			SetRow,
			{
				label: t("Reinitialize the team"),
				hint: t(
					"Deletes every Bot, group chat, memory, schedule, IM pairing and index, then creates a new Chief Main Bot. API keys, the team workspace and DSH Sessions stay; a backup is kept on disk.",
				),
			},
			confirming
				? h(
						"div",
						{ className: "bt-set-actions" },
						h(
							"button",
							{ type: "button", className: "bt-soft bt-soft-sm", onClick: reset, disabled: busy },
							confirmAgain ? t("Reset now") : t("Reset…"),
						),
						h(
							"button",
							{
								type: "button",
								className: "bt-soft bt-soft-sm",
								onClick: () => setConfirming(false),
								disabled: busy,
							},
							t("Cancel"),
						),
					)
				: h(
						"button",
						{ type: "button", className: "bt-danger bt-soft-sm", onClick: () => setConfirming(true) },
						t("Reinitialize…"),
					),
		),
		done === null
			? null
			: h("p", { className: "bt-set-hint" }, t("The team was reinitialized. Backup: {path}", { path: done })),
		error === null ? null : h("p", { className: "bt-error" }, error),
	);
}

// The first Main Bot is the sidebar tile. Picking another Bot there hands it the role
// in one step; more Main Bots can sit beside it.
function MainBotsSection({ roster, actions, run }: any) {
	const mains = (roster.mainBotIds ?? []).map((id: string) => roster.byId[id]).filter(Boolean);
	const [first, ...others] = mains;
	const candidates = roster.bots.filter((bot: any) => !isMainOf(roster, bot.id));
	return h(
		SetSection,
		{ title: t("Main Bot") },
		h(
			SetRow,
			{
				label: t("Main Bot"),
				hint: first
					? t("First in the sidebar. Pick another Bot to hand it the role; {name} then stops being a Main Bot.", {
							name: first.name,
						})
					: undefined,
			},
			h(
				"select",
				{
					className: "bt-select",
					"aria-label": t("Main Bot"),
					value: first?.id ?? "",
					onChange: (event: any) =>
						run(actions.setMain(event.target.value, true, first ? { replace: first.id } : {})),
				},
				first ? null : h("option", { value: "" }, t("Choose a Bot…")),
				roster.bots.map((bot: any) => h("option", { key: bot.id, value: bot.id }, bot.name)),
			),
		),
		others.map((bot: any) =>
			h(
				SetRow,
				{ key: bot.id, label: bot.name, hint: t("Also a Main Bot.") },
				h(
					"button",
					{
						type: "button",
						className: "bt-soft bt-soft-sm",
						onClick: () => run(actions.setMain(bot.id, true, { primary: true })),
					},
					t("Move to first"),
				),
				h(
					"button",
					{ type: "button", className: "bt-soft bt-soft-sm", onClick: () => run(actions.setMain(bot.id, false)) },
					t("Remove Main Bot role"),
				),
			),
		),
		candidates.length > 0
			? h(
					SetRow,
					{
						label: t("Add a Main Bot"),
						hint: t("Main Bots can create and change Bots, and run every group chat."),
					},
					h(
						"select",
						{
							className: "bt-select",
							"aria-label": t("Add a Main Bot"),
							value: "",
							onChange: (event: any) => {
								if (event.target.value) void run(actions.setMain(event.target.value, true));
							},
						},
						h("option", { value: "" }, t("Choose a Bot…")),
						candidates.map((bot: any) => h("option", { key: bot.id, value: bot.id }, bot.name)),
					),
				)
			: null,
	);
}

const MOTIONS: ReadonlyArray<readonly [string, string]> = [
	["quiet", "Quiet"],
	["normal", "Normal"],
	["lively", "Lively"],
];
function MotionSection({ roster, actions, run }: any) {
	const motion =
		roster.prefs?.motion === "quiet" || roster.prefs?.motion === "lively" ? roster.prefs.motion : "normal";
	return h(
		SetSection,
		{ title: t("Animation") },
		h(
			SetRow,
			{ label: t("Bot animation") },
			h(
				Segmented,
				{ label: t("Bot animation"), value: motion, className: "bt-motion-seg" },
				MOTIONS.map(([id, label]) =>
					h(
						"button",
						{
							key: id,
							type: "button",
							"aria-pressed": motion === id,
							onClick: () => {
								if (motion !== id) run(actions.setPrefs({ motion: id }));
							},
						},
						t(label),
					),
				),
			),
		),
	);
}

function BotsPage({ roster, actions, run }: any) {
	const [creating, setCreating] = useState(false);
	return [
		h(MainBotsSection, { key: "main", roster, actions, run }),
		h(MotionSection, { key: "motion", roster, actions, run }),
		creating
			? h(CreateBot, {
					key: "create",
					roster,
					actions,
					inline: true,
					onBack: () => setCreating(false),
					onCreated: (bot: any) => actions.openSettings("bots", bot.id),
				})
			: h(
					"div",
					{ key: "new", className: "bt-actions" },
					h(
						"button",
						{ type: "button", className: "bt-soft bt-soft-sm bt-with-icon", onClick: () => setCreating(true) },
						h(PlusIcon),
						t("New Bot"),
					),
				),
		h(
			SetSection,
			{ key: "bots", title: t("Bots · {count}", { count: roster.bots.length }) },
			roster.bots.map((bot: any) =>
				h(
					"button",
					{
						key: bot.id,
						type: "button",
						className: "bt-set-row",
						onClick: () => actions.openSettings("bots", bot.id),
					},
					h(
						"span",
						{ className: "bt-set-bot" },
						h(BotAvatar, { bot, size: 28, badge: false, live: false }),
						h("span", { className: "bt-row-title" }, bot.name),
						bot.role ? h("span", { className: "bt-tag" }, bot.role) : null,
						isMainOf(roster, bot.id) ? h("span", { className: "bt-tag" }, t("Main Bot")) : null,
						bot.hidden && !isMainOf(roster, bot.id) ? h("span", { className: "bt-tag" }, t("Hidden")) : null,
					),
					h("span", { className: "bt-chevron" }, h(ChevronRightIcon)),
				),
			),
		),
		h(KeptPrivateSection, { key: "kept", roster, actions, run, Section: SetSection, Row: SetRow }),
	];
}

function GroupsPage({ roster, actions, run }: any) {
	const [creating, setCreating] = useState(false);
	return [
		creating
			? h(NewGroupForm, {
					key: "create",
					roster,
					actions,
					run,
					onCancel: () => setCreating(false),
					onCreated: (room: any) => actions.openSettings("groups", room.id),
				})
			: h(
					"div",
					{ key: "new", className: "bt-actions" },
					h(
						"button",
						{
							type: "button",
							className: "bt-soft bt-soft-sm bt-with-icon",
							disabled: roster.bots.length < 2,
							title: roster.bots.length < 2 ? t("A group chat needs at least two Bots") : undefined,
							onClick: () => setCreating(true),
						},
						h(PlusIcon),
						t("Create group chat"),
					),
				),
		h(
			SetSection,
			{ key: "groups", title: t("Group chats · {count}", { count: roster.rooms.length }) },
			roster.rooms.length === 0
				? h(SetRow, {
						label: t("No group chats yet."),
						hint: t("A group chat lets several Bots work on one thing with you."),
					})
				: roster.rooms.map((room: any) => {
						const admin = roster.byId[room.admin];
						return h(
							"button",
							{
								key: room.id,
								type: "button",
								className: "bt-set-row",
								onClick: () => actions.openSettings("groups", room.id),
							},
							h(
								"span",
								{ className: "bt-set-bot" },
								h(RoomAvatar, { room, roster, size: 28 }),
								h("span", { className: "bt-row-title" }, room.name),
								h("span", { className: "bt-tag" }, t("{count} members", { count: room.members.length })),
								admin ? h("span", { className: "bt-tag bt-tag-admin" }, h(AdminStar), admin.name) : null,
								room.hidden ? h("span", { className: "bt-tag" }, t("Hidden")) : null,
							),
							h("span", { className: "bt-chevron" }, h(ChevronRightIcon)),
						);
					}),
		),
	];
}

// A page that throws while it renders shows a line in its place. Uncaught, the
// error takes down the plugin's whole overlay, and no dialog opens again until
// the window reloads. The page's key resets it; Usage stays mounted, so its
// boundary resets when the shown page changes.
class PageBoundary extends Component<{ children?: any; reset?: any }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}
	componentDidUpdate(previous: any): void {
		if (this.state.failed && previous.reset !== this.props.reset) this.setState({ failed: false });
	}
	componentDidCatch(error: unknown): void {
		console.error("ocean-crew: a settings page failed", error);
	}
	render(): any {
		return this.state.failed
			? h("div", { className: "bt-error", role: "alert" }, t("This page could not be shown."))
			: this.props.children;
	}
}

// While `leaving`, the dialog plays its exit and takes no input.
export function SettingsDialog({ page, id, roster, actions, useUpdate, leaving = false }: any) {
	const [error, setError] = useState("");
	const close = useCallback(() => actions.closeSettings(), []);
	useEscape(close);
	const run = (promise: any): Promise<boolean> =>
		Promise.resolve(promise)
			.then(() => {
				setError("");
				return true;
			})
			.catch((failure: any) => {
				setError(failure?.message ?? String(failure));
				return false;
			});
	// A Bot or group deleted while its form is open leaves its page on the list.
	const bot = page === "bots" && id ? roster.byId[id] : undefined;
	const room = page === "groups" && id ? roster.roomsById[id] : undefined;
	const pages = SETTINGS_PAGES.filter(([key]) => key !== "models" || actions.providers !== undefined);
	const shown = pages.some(([key]) => key === page) ? page : "general";
	const usageFocus = shown === "usage" && id ? id : null;
	const label = t(pages.find(([key]) => key === shown)![1]);
	const back = bot ? t("Back to Bots") : room ? t("Back to group chats") : usageFocus ? t("All usage") : null;
	const nav = useGlide(shown, { axis: "y" });
	// A page enters from the right when it is one level in, from the left when it comes
	// back out, and from below beside it. Usage keeps its own entrance and its data
	// across its own levels, so they share one page.
	const pageKey = `${shown}:${bot?.id ?? room?.id ?? ""}`;
	const depth = bot || room ? 1 : 0;
	const last = useRef<{ key: string; depth: string | number; move: string }>({ key: pageKey, depth, move: "up" });
	if (last.current.key !== pageKey) {
		last.current = {
			key: pageKey,
			depth,
			move:
				typeof depth === "number" && typeof last.current.depth === "number" && depth > last.current.depth
					? "in"
					: typeof depth === "number" && typeof last.current.depth === "number" && depth < last.current.depth
						? "out"
						: "up",
		};
	}
	// Usage stays mounted from its first visit until Settings closes: coming back to it
	// shows the same page at once instead of loading it again. Meanwhile it keeps its
	// rendered state off screen (content-visibility).
	const [usageOpened, setUsageOpened] = useState(shown === "usage");
	if (shown === "usage" && !usageOpened) setUsageOpened(true);
	const errorLine = error ? h("div", { className: "bt-error", role: "alert", style: { padding: 0 } }, error) : null;
	return h(
		"div",
		{ className: "bt-settings-layer", "data-leaving": leaving || undefined },
		h("div", { className: "bt-scrim", onMouseDown: close }),
		h(
			"div",
			{ className: "bt-settings", role: "dialog", "aria-modal": true, "aria-label": t("Ocean Crew settings") },
			h(
				"nav",
				{ ref: nav.box, className: "bt-settings-nav", "aria-label": t("Settings pages") },
				h("span", { ref: nav.thumb, className: "bt-thumb", "aria-hidden": true }),
				pages.map(([key, text]) =>
					h(
						"button",
						{
							key,
							type: "button",
							className: "bt-settings-item",
							"aria-current": shown === key ? "page" : undefined,
							onClick: () => actions.openSettings(key),
						},
						h(PAGE_ICONS[key]),
						t(text),
					),
				),
				actions.openHarnessSettings
					? h(
							"button",
							{
								type: "button",
								className: "bt-settings-item bt-settings-shell",
								title: t("Models, providers, and the rest of DeepSeek Harness"),
								onClick: () => {
									close();
									actions.openHarnessSettings();
								},
							},
							h(SlidersIcon),
							t("Harness settings"),
						)
					: null,
			),
			h(
				"div",
				{ className: "bt-settings-main" },
				h(
					"div",
					{ className: "bt-settings-head" },
					back
						? h(
								"button",
								{
									type: "button",
									className: "bt-icon-btn",
									"aria-label": back,
									title: back,
									onClick: () => actions.openSettings(shown),
								},
								h(ChevronLeftIcon),
							)
						: null,
					h("h2", { key: bot?.id ?? room?.id ?? shown }, bot?.name ?? room?.name ?? label),
				),
				shown === "usage"
					? null
					: h(
							"div",
							{
								key: pageKey,
								className: "bt-settings-scroll bt-settings-page",
								"data-move": last.current.move,
							},
							errorLine,
							h(
								PageBoundary,
								null,
								shown === "computer"
									? h(ComputerPage, { roster, actions, run, Section: SetSection, Row: SetRow, Switch })
									: null,
								shown === "general" ? h(GeneralPage, { roster, actions, run }) : null,
								shown === "models" ? h(ProvidersPage, { actions, run, Section: SetSection }) : null,
								bot
									? h(
											"div",
											{ className: "bt-settings-form" },
											h(BotSettingsForm, { key: bot.id, bot, roster, actions, run }),
										)
									: null,
								shown === "bots" && !bot ? h(BotsPage, { roster, actions, run }) : null,
								room
									? h(
											"div",
											{ className: "bt-settings-form" },
											h(GroupSettingsForm, { key: room.id, room, roster, actions, run }),
										)
									: null,
								shown === "groups" && !room ? h(GroupsPage, { roster, actions, run }) : null,
								shown === "connectors" ? h(ConnectorsPage, { roster, actions }) : null,
								shown === "im" ? h(ImPage, { roster, actions }) : null,
								shown === "capabilities" ? h(CapabilitiesPage, { roster, actions, run }) : null,
								shown === "browser"
									? h(BrowserPage, { roster, actions, run, Section: SetSection, Row: SetRow })
									: null,
								shown === "schedules" ? h(SchedulesPage, { roster, actions, start: id ?? undefined }) : null,
								shown === "secrets" ? h(SecretsPage, { roster, actions, run, Section: SetSection }) : null,
								shown === "feedback"
									? h(FeedbackPage, { actions, run, Section: SetSection, Row: SetRow })
									: null,
								shown === "about"
									? h(AboutPage, { useUpdate, actions, run, Section: SetSection, Row: SetRow })
									: null,
							),
						),
				usageOpened
					? h(
							"div",
							{
								key: "usage",
								className: "bt-settings-scroll bt-settings-usage",
								"data-off": shown === "usage" ? undefined : "",
								"aria-hidden": shown === "usage" ? undefined : true,
							},
							shown === "usage" ? errorLine : null,
							h(PageBoundary, { reset: shown }, h(UsagePage, { roster, actions, focusId: usageFocus })),
						)
					: null,
			),
			h(
				"button",
				{ type: "button", className: "bt-settings-close", "aria-label": t("Close settings"), onClick: close },
				h(CloseIcon),
			),
		),
	);
}
