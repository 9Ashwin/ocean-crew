// Settings → IM. Laid out like Connectors: requests that wait for the owner on top, the
// IM bots already added, then a grid of platforms. A platform opens its own view with
// setup steps and the form; an added IM bot opens a view with its Bot, accounts and
// chats.
//

// renders, but every action it asks for comes from `actions`, and when a host module is
// absent the request rejects and the page shows that message in its error line. The QR
// QR code of the WeChat sign-in is drawn with qrcode-generator; a caller may inject its
// own encoder through `qrEncoder` (tests do), and the bundled one is the default.
import qrcode from "qrcode-generator";
import { Fragment, createElement as h, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MaskedInput } from "../chat/secret-card.ts";
import { hostText, t } from "../core/i18n.ts";
import { ChatsIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "../look/icons.ts";
import { BotAvatar } from "../look/mark.ts";
import { Segmented } from "../look/motion.ts";
import { Switch } from "./bot-settings.ts";
import { MARKS } from "./connector-marks.ts";
import { Caret, useAnchoredMenu } from "./model-menu.ts";

type Any = any;

// The IM platforms Ocean Crew can connect to: two private-chat connectors only (Feishu
// and WeChat). the page keeps
// the same table until that import is available.
export interface ImField {
	key: string;
	label: string;
	secret?: boolean;
	hint?: string;
	options?: Array<[string, string]>;
}

export interface ImPlatform {
	id: string;
	name: string;
	fields: ImField[];
	buttons?: boolean;
	groups?: boolean;
	login?: "qr";
}

export const IM_PLATFORMS: readonly ImPlatform[] = [
	{ id: "weixin", name: "WeChat", fields: [], buttons: false, groups: false, login: "qr" },
	{
		id: "feishu",
		name: "Feishu / Lark",
		fields: [
			{
				key: "domain",
				label: "Edition",
				options: [
					["feishu", "Feishu"],
					["lark", "Lark"],
				],
			},
			{ key: "appId", label: "App ID" },
			{ key: "appSecret", label: "App Secret", secret: true },
		],
		buttons: true,
		groups: true,
	},
];

/** One QR code's modules, as a QR encoder hands them over. */
export interface QrMatrix {
	count: number;
	isDark(row: number, column: number): boolean;
}
export type QrEncoder = (text: string) => QrMatrix;

// sign-in with. Type 0 picks the smallest version that fits, level M matches the code the
// platform shows.
export const encodeQr: QrEncoder = (text) => {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	return { count: qr.getModuleCount(), isDark: (row, column) => qr.isDark(row, column) };
};

// Two private-chat connectors: WeChat has a brand mark, Feishu a monogram tile.
const BRAND: Record<string, string> = { weixin: "wechat" };
const MONO: Record<string, string> = { feishu: "飞" };

const GUIDES: Record<string, { steps: string[]; link?: [string, string]; lark?: [string, string] }> = {
	weixin: {
		steps: ["Choose the Bot that answers.", "Scan the code with WeChat on your phone and confirm."],
	},
	feishu: {
		link: ["https://open.feishu.cn/app", "open.feishu.cn"],
		lark: ["https://open.larksuite.com/app", "open.larksuite.com"],
		steps: [
			"Create a custom app in the developer console and add the bot capability.",
			"Grant the permissions to read and send messages.",
			"Paste the App ID and App Secret from Credentials, then connect.",
			"Under Events & callbacks, receive events through a long connection, add the receive message event, and publish a version.",
		],
	},
};

const platformOf = (id: string): ImPlatform =>
	IM_PLATFORMS.find((entry) => entry.id === id) ?? { id, name: id, fields: [] };

export function ImMark({ id, size = 36 }: { id: string; size?: number }) {
	const Brand = (MARKS as Record<string, Any>)[BRAND[id] ?? ""];
	return h(
		"span",
		{
			className: "bt-app-icon bt-im-icon",
			style: { width: size, height: size },
			"data-small": size < 30 || undefined,
		},
		Brand
			? h(Brand)
			: h(
					"span",
					{
						className: "bt-im-mono",
						style: { background: `var(--bt-im-${id}, var(--bt-ink-2))` },
						"aria-hidden": true,
					},
					MONO[id] ?? id.slice(0, 1).toUpperCase(),
				),
	);
}

function stateOf(conn: Any, status: Any): string {
	if (!conn.enabled) return "off";
	return status?.state === "ready" || status?.state === "error" || status?.state === "connecting"
		? status.state
		: "connecting";
}

function stateText(conn: Any, status: Any): string {
	const state = stateOf(conn, status);
	if (state === "off") return t("Disabled");
	if (state === "ready") return t("Connected");
	if (state === "error") return t("Could not connect: {error}", { error: hostText(status.error ?? "") });
	return t("Connecting…");
}

const Dot = ({ state }: { state: string }) =>
	h("span", { className: "bt-im-dot", "data-state": state, "aria-hidden": true });

const Tick = ({ on }: { on: boolean }) =>
	h("span", { className: "bt-model-tick", "aria-hidden": true }, on ? h(CheckIcon) : null);

interface TargetValue {
	botId?: string;
	roomId?: string;
}

// Who an IM bot or an IM group talks to: a Bot, or with `rooms` also a group chat.
function TargetMenu({
	value,
	roster,
	rooms = false,
	label,
	onPick,
	disabled = false,
}: {
	value?: TargetValue | null;
	roster: Any;
	rooms?: boolean;
	label?: string;
	onPick: (next: TargetValue | null) => void;
	disabled?: boolean;
}) {
	const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu();
	const bot = value?.botId !== undefined ? roster.bots.find((entry: Any) => entry.id === value.botId) : undefined;
	const room = value?.roomId !== undefined ? roster.rooms.find((entry: Any) => entry.id === value.roomId) : undefined;
	const pick = (next: TargetValue | null): void => {
		close();
		onPick(next);
	};
	const shown = bot
		? h(BotAvatar, { bot, size: 20, badge: false, live: false })
		: room
			? h("span", { className: "bt-im-room" }, h(ChatsIcon))
			: null;
	return h(
		Fragment,
		null,
		h(
			"button",
			{
				ref: button,
				type: "button",
				className: "bt-model-trigger bt-im-target",
				"aria-haspopup": "menu",
				"aria-expanded": isOpen,
				"aria-label": label,
				disabled,
				onClick: () => (isOpen ? close() : open()),
			},
			shown,
			h("span", { className: "bt-model-name" }, bot?.name ?? room?.name ?? t("Not bound")),
			h(Caret),
		),
		shownPlace
			? createPortal(
					h(
						"div",
						{
							ref: menu,
							className: `bt-menu bt-model-menu bt-im-menu${shownPlace.bottom !== undefined ? " bt-menu-up" : ""}`,
							role: "menu",
							"aria-label": label,
							style: shownPlace,
							"data-leaving": leaving || undefined,
						},
						rooms
							? h(
									"button",
									{
										type: "button",
										role: "menuitemradio",
										"aria-checked": !bot && !room,
										onClick: () => pick(null),
									},
									h("span", { className: "bt-menu-label" }, t("Not bound")),
									h(Tick, { on: !bot && !room }),
								)
							: null,
						rooms ? h("div", { className: "bt-model-group", role: "presentation" }, t("Bots")) : null,
						roster.bots.map((entry: Any) =>
							h(
								"button",
								{
									key: entry.id,
									type: "button",
									role: "menuitemradio",
									"aria-checked": entry.id === bot?.id,
									onClick: () => pick({ botId: entry.id }),
								},
								h(BotAvatar, { bot: entry, size: 20, badge: false, live: false }),
								h("span", { className: "bt-menu-label" }, entry.name),
								h(Tick, { on: entry.id === bot?.id }),
							),
						),
						rooms && roster.rooms.length > 0
							? h("div", { className: "bt-model-group", role: "presentation" }, t("Group chats"))
							: null,
						rooms
							? roster.rooms.map((entry: Any) =>
									h(
										"button",
										{
											key: entry.id,
											type: "button",
											role: "menuitemradio",
											"aria-checked": entry.id === room?.id,
											onClick: () => pick({ roomId: entry.id }),
										},
										h("span", { className: "bt-im-room" }, h(ChatsIcon)),
										h("span", { className: "bt-menu-label" }, entry.name),
										h(Tick, { on: entry.id === room?.id }),
									),
								)
							: null,
					),
					document.body,
				)
			: null,
	);
}

function Row({ label, children, className }: { label: string; children?: Any; className?: string }) {
	return h(
		"div",
		{ className: className ? `bt-set-row ${className}` : "bt-set-row" },
		h("span", { className: "bt-set-copy" }, label),
		h("span", { className: "bt-set-control bt-im-control" }, children),
	);
}

function Subview({ title, onBack, children }: { title: string; onBack: () => void; children?: Any }) {
	return h(
		"div",
		{ className: "bt-app-sub bt-im-sub" },
		h(
			"div",
			{ className: "bt-app-sub-head" },
			h(
				"button",
				{ type: "button", className: "bt-icon-btn", "aria-label": t("Back"), onClick: onBack },
				h(ChevronLeftIcon),
			),
			h("h3", null, title),
		),
		children,
	);
}

function Guide({ platform, domain }: { platform: string; domain?: string }) {
	const guide = GUIDES[platform];
	if (!guide) return null;
	const link = platform === "feishu" && domain === "lark" ? guide.lark : guide.link;
	return h(
		"div",
		{ className: "bt-im-guide" },
		h(
			"ol",
			null,
			guide.steps.map((step) => h("li", { key: step }, t(step))),
		),
		link
			? h(
					"a",
					{ className: "bt-connector-link", href: link[0], target: "_blank", rel: "noopener noreferrer" },
					t("Open {site}", { site: link[1] }),
				)
			: null,
	);
}

const QUIET = 4;

function QrCode({ text, encode }: { text: string; encode: QrEncoder }) {
	const qr = encode(text);
	const count = qr.count;
	const size = count + QUIET * 2;
	let path = "";
	for (let y = 0; y < count; y += 1) {
		for (let x = 0; x < count; x += 1) if (qr.isDark(y, x)) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
	}
	return h(
		"svg",
		{
			className: "bt-im-qr",
			viewBox: `0 0 ${size} ${size}`,
			role: "img",
			"aria-label": t("Pairing QR code"),
			shapeRendering: "crispEdges",
		},
		h("rect", { className: "bt-im-qr-paper", width: size, height: size }),
		h("path", { className: "bt-im-qr-ink", d: path }),
	);
}

// QR-login platforms (WeChat iLink): im-login-start returns the code text, then
// im-login-wait long-polls until the owner scans and confirms or the code expires.
function QrLogin({
	actions,
	platform,
	botId,
	onDone,
	qrEncoder = encodeQr,
}: {
	actions: Any;
	platform: string;
	botId: string;
	onDone: () => void;
	qrEncoder?: QrEncoder;
}) {
	const [round, setRound] = useState(0);
	const [login, setLogin] = useState<Any>(null);
	const [status, setStatus] = useState("waiting");
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setLogin(null);
		setStatus("waiting");
		setError(null);
		void (async () => {
			try {
				const started = await actions.imLoginStart({ platform, botId });
				if (!live) return;
				setLogin(started);
				for (;;) {
					const answer = await actions.imLoginWait({ platform, botId, loginId: started.loginId });
					if (!live) return;
					if (answer.status === "done") {
						onDone();
						return;
					}
					setStatus(answer.status);
					if (answer.status === "expired") return;
				}
			} catch (failure) {
				if (live) setError(failure instanceof Error ? failure.message : String(failure));
			}
		})();
		return () => {
			live = false;
		};
	}, [botId, round]);
	const expired = status === "expired" || error !== null;
	const caption = error
		? hostText(error)
		: status === "scanned"
			? t("Scanned — confirm on the phone")
			: status === "expired"
				? t("Code expired")
				: login
					? t("Scan with WeChat")
					: t("Getting a code…");
	return h(
		"div",
		{ className: "bt-im-qr-box", "data-state": error ? "error" : status },
		h(
			"div",
			{ className: "bt-im-qr-frame" },
			login && !expired
				? h(QrCode, { text: login.qr, encode: qrEncoder })
				: h("span", { className: "bt-im-qr-blank", "aria-hidden": true }),
			status === "scanned" ? h("span", { className: "bt-im-qr-done", "aria-hidden": true }, h(CheckIcon)) : null,
		),
		h("p", { className: "bt-im-qr-caption", role: error ? "alert" : "status" }, caption),
		expired
			? h(
					"button",
					{ type: "button", className: "bt-soft bt-soft-sm", onClick: () => setRound((value) => value + 1) },
					t("Get a new code"),
				)
			: null,
	);
}

function AddView({
	platform,
	roster,
	actions,
	onBack,
	qrEncoder = encodeQr,
}: {
	platform: string;
	roster: Any;
	actions: Any;
	onBack: () => void;
	qrEncoder?: QrEncoder;
}) {
	const shown = platformOf(platform);
	const [fields, setFields] = useState<Record<string, string>>({});
	const [botId, setBotId] = useState(roster.bots[0]?.id ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (key: string, value: string): void => setFields((current) => ({ ...current, [key]: value }));
	const missing = shown.fields.some((field) => !field.options && String(fields[field.key] ?? "").trim() === "");
	const add = (): void => {
		if (busy || botId === "" || missing) return;
		setBusy(true);
		setError(null);
		void Promise.resolve(actions.imAdd({ platform, botId, fields }))
			.then(() => onBack())
			.catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
			.finally(() => setBusy(false));
	};
	const fieldRow = (field: ImField) => {
		if (field.options) {
			const value = fields[field.key] ?? field.options[0][0];
			return h(
				Row,
				{ key: field.key, label: t(field.label) },
				h(
					Segmented,
					{ label: t(field.label), value },
					field.options.map(([id, label]) =>
						h(
							"button",
							{
								key: id,
								type: "button",
								"aria-pressed": value === id,
								onClick: () => set(field.key, id),
							},
							t(label),
						),
					),
				),
			);
		}
		const label = t(field.label);
		return h(
			Row,
			{ key: field.key, label, className: "bt-im-field" },
			field.secret
				? h(
						"span",
						{ className: "bt-q-field bt-secret-field bt-im-secret" },
						h(MaskedInput, {
							value: fields[field.key] ?? "",
							onChange: (value: string) => set(field.key, value),
							onEnter: add,
							label: field.hint ? `${field.hint}…` : label,
						}),
					)
				: h("input", {
						className: "bt-input",
						"aria-label": label,
						placeholder: label,
						spellCheck: false,
						autoComplete: "off",
						value: fields[field.key] ?? "",
						onChange: (event: Any) => set(field.key, event.target.value),
						onKeyDown: (event: Any) => {
							if (event.key === "Enter" && !event.nativeEvent.isComposing) add();
						},
					}),
		);
	};
	return h(
		Subview,
		{ title: t(shown.name), onBack },
		h(
			"div",
			{ className: "bt-im-hero" },
			h(ImMark, { id: platform, size: 44 }),
			h(Guide, { platform, domain: fields.domain }),
		),
		h(
			"div",
			{ className: "bt-set-card bt-im-form" },
			h(
				Row,
				{ label: t("Talks to") },
				h(TargetMenu, {
					value: botId ? { botId } : null,
					roster,
					label: t("Talks to"),
					onPick: (next: TargetValue | null) => next?.botId && setBotId(next.botId),
				}),
			),
			shown.login === "qr" ? null : shown.fields.map(fieldRow),
			shown.login === "qr"
				? h(
						"div",
						{ className: "bt-im-qr-row" },
						h(QrLogin, { actions, platform, botId, onDone: onBack, qrEncoder }),
					)
				: null,
			shown.login === "qr"
				? null
				: h(
						"div",
						{ className: "bt-im-foot" },
						error ? h("span", { className: "bt-im-error", role: "alert" }, hostText(error)) : h("span"),
						h(
							"button",
							{
								type: "button",
								className: "bt-send bt-soft-sm",
								disabled: busy || botId === "" || missing,
								onClick: add,
							},
							busy ? t("Connecting…") : t("Connect"),
						),
					),
		),
	);
}

function chatName(conn: Any, key: string, chat: Any): string {
	if (chat.title) return chat.title;
	return conn.paired.find((entry: Any) => entry.id === key)?.name ?? t("Direct message");
}

function Initial({ name }: { name: string }) {
	return h(
		"span",
		{ className: "bt-im-initial", "aria-hidden": true },
		String(name || "?")
			.replace(/^@/, "")
			.slice(0, 1)
			.toUpperCase(),
	);
}

function Requests({
	conn,
	run,
	busy,
	actions,
	withSource = false,
}: {
	conn: Any;
	run: (task: Any) => Promise<unknown>;
	busy: boolean;
	actions: Any;
	withSource?: boolean;
}) {
	return conn.requests.map((request: Any) =>
		h(
			"div",
			{ key: `${conn.id}:${request.id}`, className: "bt-set-row bt-im-request" },
			h(Initial, { name: request.name }),
			h(
				"span",
				{ className: "bt-set-copy" },
				h("span", { className: "bt-im-name" }, request.name),
				withSource
					? h(
							"span",
							{ className: "bt-set-hint" },
							t("Wants to talk through {bot}", {
								bot: t(conn.account?.name ?? platformOf(conn.platform).name),
							}),
						)
					: null,
			),
			h(
				"span",
				{ className: "bt-set-control" },
				h(
					"button",
					{
						type: "button",
						className: "bt-soft bt-soft-sm",
						disabled: busy,
						onClick: () => run(actions.imPair(conn.id, request.id, false)),
					},
					t("Deny"),
				),
				h(
					"button",
					{
						type: "button",
						className: "bt-send bt-soft-sm",
						disabled: busy,
						onClick: () => run(actions.imPair(conn.id, request.id, true)),
					},
					t("Allow"),
				),
			),
		),
	);
}

function useRun(): { busy: boolean; error: string | null; run: (task: Any) => Promise<unknown> } {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = (task: Any): Promise<unknown> => {
		setBusy(true);
		setError(null);
		return Promise.resolve(task)
			.catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
			.finally(() => setBusy(false));
	};
	return { busy, error, run };
}

function DetailView({
	conn,
	status,
	roster,
	actions,
	onBack,
}: {
	conn: Any;
	status: Any;
	roster: Any;
	actions: Any;
	onBack: () => void;
}) {
	const shown = platformOf(conn.platform);
	const { busy, error, run } = useRun();
	const [confirm, setConfirm] = useState<string | null>(null);
	const state = stateOf(conn, status);
	const ask = (key: string, task: () => Any): void => {
		if (confirm !== key) {
			setConfirm(key);
			return;
		}
		setConfirm(null);
		void run(task());
	};
	const chats = Object.entries(conn.chats ?? {});
	return h(
		Subview,
		{ title: t(conn.account?.name ?? shown.name), onBack },
		error ? h("div", { className: "bt-im-banner", role: "alert" }, hostText(error)) : null,
		h(
			"div",
			{ className: "bt-set-card" },
			h(
				"div",
				{ className: "bt-set-row bt-im-head", "data-state": state },
				h(ImMark, { id: conn.platform, size: 40 }),
				h(
					"span",
					{ className: "bt-set-copy" },
					h("span", { className: "bt-im-title" }, t(conn.account?.name ?? shown.name)),
					h(
						"span",
						{ className: "bt-im-status" },
						h(Dot, { state }),
						`${t(shown.name)} · ${stateText(conn, status)}`,
					),
				),
				h(
					"span",
					{ className: "bt-set-control" },
					state === "error"
						? h(
								"button",
								{
									type: "button",
									className: "bt-soft bt-soft-sm",
									disabled: busy,
									onClick: () => run(actions.imRetry(conn.id)),
								},
								t("Try again"),
							)
						: null,
					h(Switch, {
						on: conn.enabled,
						label: t("Enabled"),
						disabled: busy,
						onChange: (on: boolean) => run(actions.imUpdate(conn.id, { enabled: on })),
					}),
				),
			),
			h(
				Row,
				{ label: t("Talks to") },
				h(TargetMenu, {
					value: conn.botId ? { botId: conn.botId } : null,
					roster,
					label: t("Talks to"),
					disabled: busy,
					onPick: (next: TargetValue | null) =>
						next?.botId && run(actions.imUpdate(conn.id, { botId: next.botId })),
				}),
			),
		),
		conn.requests.length > 0
			? h(
					"section",
					{ className: "bt-set-section" },
					h("h3", null, t("Waiting for approval")),
					h("div", { className: "bt-set-card bt-im-attn" }, h(Requests, { conn, run, busy, actions })),
				)
			: null,
		h(
			"section",
			{ className: "bt-set-section" },
			h("h3", null, t("Accounts")),
			h(
				"div",
				{ className: "bt-set-card" },
				conn.paired.length === 0
					? h(
							"div",
							{ className: "bt-set-row" },
							h("span", { className: "bt-set-hint" }, t("Send the IM bot a message to connect your account")),
						)
					: conn.paired.map((entry: Any) =>
							h(
								"div",
								{ key: entry.id, className: "bt-set-row" },
								h(Initial, { name: entry.name }),
								h("span", { className: "bt-set-copy" }, h("span", { className: "bt-im-name" }, entry.name)),
								h(
									"button",
									{
										type: "button",
										className: "bt-mini bt-im-danger",
										"data-confirm": confirm === `p:${entry.id}` || undefined,
										disabled: busy,
										onClick: () => ask(`p:${entry.id}`, () => actions.imUnpair(conn.id, entry.id)),
									},
									confirm === `p:${entry.id}` ? t("Remove?") : t("Remove"),
								),
							),
						),
			),
		),
		chats.length > 0
			? h(
					"section",
					{ className: "bt-set-section" },
					h("h3", null, t("Chats")),
					h(
						"div",
						{ className: "bt-set-card" },
						chats.map(([key, chat]: [string, Any]) =>
							h(
								"div",
								{ key, className: "bt-set-row bt-im-chat" },
								h(
									"span",
									{ className: "bt-set-copy bt-im-chat-name" },
									h("span", { className: "bt-im-name" }, chatName(conn, key, chat)),
									h("span", { className: "bt-tag" }, chat.kind === "group" ? t("Group") : t("Direct")),
								),
								h(
									"span",
									{ className: "bt-set-control" },
									chat.kind === "group"
										? h(TargetMenu, {
												value: chat.target ?? null,
												roster,
												rooms: true,
												label: t("Bound to"),
												disabled: busy,
												onPick: (target: TargetValue | null) =>
													run(actions.imChat(conn.id, { chatKey: key, target })),
											})
										: null,
									h(
										"button",
										{
											type: "button",
											className: "bt-mini bt-im-danger",
											"data-confirm": confirm === `c:${key}` || undefined,
											disabled: busy,
											onClick: () =>
												ask(`c:${key}`, () => actions.imChat(conn.id, { chatKey: key, remove: true })),
										},
										confirm === `c:${key}` ? t("Remove?") : t("Remove"),
									),
								),
							),
						),
					),
				)
			: null,
		h(
			"div",
			{ className: "bt-set-card" },
			h(
				"button",
				{
					type: "button",
					className: "bt-set-row bt-im-remove",
					"data-confirm": confirm === "conn" || undefined,
					disabled: busy,
					onClick: () => ask("conn", () => Promise.resolve(actions.imRemove(conn.id)).then(onBack)),
				},
				confirm === "conn" ? t("Remove this IM bot? Its accounts and chats are removed too.") : t("Remove IM bot"),
			),
		),
	);
}

function BotRow({ conn, status, roster, onOpen }: { conn: Any; status: Any; roster: Any; onOpen: () => void }) {
	const shown = platformOf(conn.platform);
	const state = stateOf(conn, status);
	const bot = roster.bots.find((entry: Any) => entry.id === conn.botId);
	const waiting = conn.requests.length;
	return h(
		"button",
		{ type: "button", className: "bt-set-row bt-im-bot", "data-state": state, onClick: onOpen },
		h(ImMark, { id: conn.platform, size: 36 }),
		h(
			"span",
			{ className: "bt-set-copy" },
			h("span", { className: "bt-im-title" }, t(conn.account?.name ?? shown.name)),
			h(
				"span",
				{ className: "bt-im-status" },
				h(Dot, { state }),
				[t(shown.name), stateText(conn, status), bot ? t("Talks to {bot}", { bot: bot.name }) : null]
					.filter(Boolean)
					.join(" · "),
			),
		),
		waiting > 0
			? h(
					"span",
					{ className: "bt-im-count", "aria-label": t("{count} waiting for approval", { count: waiting }) },
					waiting,
				)
			: null,
		h("span", { className: "bt-chevron" }, h(ChevronRightIcon)),
	);
}

function PlatformTile({ platform, count, onOpen }: { platform: ImPlatform; count: number; onOpen: () => void }) {
	return h(
		"div",
		{ className: "bt-app", "data-state": count > 0 ? "ready" : "off" },
		h(
			"button",
			{ type: "button", className: "bt-app-main", onClick: onOpen },
			h(ImMark, { id: platform.id }),
			h(
				"span",
				{ className: "bt-app-text" },
				h("span", { className: "bt-app-name" }, t(platform.name)),
				count > 0 ? h("span", { className: "bt-app-status" }, t("{count} added", { count })) : null,
			),
		),
		h("button", { type: "button", className: "bt-app-btn", onClick: onOpen }, t("Connect")),
	);
}

export function ImPage({
	roster,
	actions,
	qrEncoder = encodeQr,
}: {
	roster: Any;
	actions: Any;
	qrEncoder?: QrEncoder;
}) {
	const [view, setView] = useState<{ add?: string; conn?: string } | null>(null);
	const { busy, error, run } = useRun();
	const list = roster.im?.connections ?? [];
	const statuses = roster.imStatus ?? {};
	const platforms = (roster.im?.platforms ?? []).map(platformOf);
	const back = (): void => setView(null);

	if (view?.add) return h(AddView, { key: view.add, platform: view.add, roster, actions, onBack: back, qrEncoder });
	const open = view?.conn ? list.find((conn: Any) => conn.id === view.conn) : undefined;
	if (open) return h(DetailView, { conn: open, status: statuses[open.id], roster, actions, onBack: back });

	const waiting = list.filter((conn: Any) => conn.requests.length > 0);
	return h(
		"div",
		{ className: "bt-apps bt-im-page" },
		error ? h("div", { className: "bt-im-banner", role: "alert" }, hostText(error)) : null,
		waiting.length > 0
			? h(
					"section",
					{ className: "bt-set-section" },
					h("h3", null, t("Waiting for approval")),
					h(
						"div",
						{ className: "bt-set-card bt-im-attn" },
						waiting.map((conn: Any) => h(Requests, { key: conn.id, conn, run, busy, actions, withSource: true })),
					),
				)
			: null,
		list.length > 0
			? h(
					"section",
					{ className: "bt-set-section" },
					h("h3", null, t("Your IM bots")),
					h(
						"div",
						{ className: "bt-set-card" },
						list.map((conn: Any) =>
							h(BotRow, {
								key: conn.id,
								conn,
								status: statuses[conn.id],
								roster,
								onOpen: () => setView({ conn: conn.id }),
							}),
						),
					),
				)
			: null,
		h(
			"section",
			{ className: "bt-app-section" },
			h(
				"div",
				{ className: "bt-app-section-head" },
				h("h3", null, list.length > 0 ? t("Add an IM bot") : t("Choose a platform")),
			),
			h(
				"div",
				{ className: "bt-app-grid" },
				platforms.map((platform: ImPlatform) =>
					h(PlatformTile, {
						key: platform.id,
						platform,
						count: list.filter((conn: Any) => conn.platform === platform.id).length,
						onOpen: () => setView({ add: platform.id }),
					}),
				),
			),
		),
	);
}

export const IM_CSS = `
.bt-im-page{gap:20px}
.bt-im-page .bt-app-section{margin-top:0;gap:6px}
.bt-im-page .bt-app-section-head h3{font-size:13px;line-height:18px;padding:0 4px}
.bt-im-icon{overflow:hidden}
.bt-im-icon svg{width:22px;height:22px}
.bt-im-icon[data-small] svg{width:16px;height:16px}
.bt-im-mono{display:inline-flex;align-items:center;justify-content:center;width:62%;height:62%;border-radius:6px;color:var(--bt-im-mark-ink);font-size:13px;line-height:1;font-weight:600}
.bt-im-icon[data-small] .bt-im-mono{font-size:10px;border-radius:4px}
.bt-im-mono{transition:filter .6s ease,opacity .6s ease}
.bt-app:not([data-state=ready]) .bt-im-mono{filter:grayscale(1);opacity:.5}
.bt-im-title{font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-im-name{font-size:13px;line-height:18px;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bt-im-status{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-state=error]>.bt-set-copy>.bt-im-status{color:var(--bt-danger);white-space:normal}
.bt-im-dot{flex:none;width:7px;height:7px;border-radius:50%;corner-shape:round;background:var(--bt-ink-3)}
.bt-im-dot[data-state=ready]{background:var(--bt-green)}
.bt-im-dot[data-state=error]{background:var(--bt-danger)}
.bt-im-dot[data-state=off]{background:none;box-shadow:inset 0 0 0 1.5px var(--bt-ink-3)}
.bt-im-dot[data-state=connecting]{animation:bt-im-breathe 1.4s ease-in-out infinite}
@keyframes bt-im-breathe{50%{opacity:.35}}
.bt-im-bot{gap:12px;padding:12px}
.bt-im-bot .bt-chevron svg{width:14px;height:14px}
.bt-im-count{flex:none;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:11px;line-height:20px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.bt-im-attn{border-color:color-mix(in srgb,var(--bt-accent) 35%,var(--bt-line));background:color-mix(in srgb,var(--bt-accent) 4%,var(--bt-card))}
.bt-im-request{gap:12px}
.bt-im-initial{flex:none;width:28px;height:28px;border-radius:50%;corner-shape:round;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink-2);font-size:12px;font-weight:600}
.bt-im-sub{gap:16px}
.bt-im-hero{display:flex;align-items:flex-start;gap:14px;padding:0 4px}
.bt-im-hero .bt-app-icon{flex:none}
.bt-im-guide{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px;color:var(--bt-ink-2)}
.bt-im-guide ol{margin:0;padding:0;list-style:none;counter-reset:bt-im-step;display:flex;flex-direction:column;gap:6px}
.bt-im-guide li{counter-increment:bt-im-step;display:flex;gap:10px}
.bt-im-guide li::before{content:counter(bt-im-step);flex:none;width:20px;height:20px;margin-top:0;border-radius:50%;corner-shape:round;background:var(--bt-hover);color:var(--bt-ink-2);font-size:11px;line-height:20px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.bt-im-guide .bt-connector-link{align-self:flex-start;margin-left:30px}
.bt-im-form .bt-set-row{min-height:56px}
.bt-im-control{flex:0 1 60%;min-width:0;justify-content:flex-end}
.bt-im-field .bt-im-control>.bt-input,.bt-im-field .bt-im-control>.bt-im-secret{flex:1;min-width:0;max-width:360px}
.bt-im-secret{margin:0}
.bt-im-target{max-width:240px}
.bt-im-target .bt-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-im-room{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;corner-shape:round;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-im-room svg{width:12px;height:12px}
.bt-im-menu button{gap:8px}
.bt-im-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px}
.bt-im-error{flex:1;min-width:0;font-size:12px;line-height:16px;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-im-banner{padding:10px 12px;border-radius:12px;background:var(--bt-danger-soft);color:var(--bt-danger);font-size:12px;line-height:16px}
.bt-im-qr-row{display:flex;justify-content:center;padding:20px 12px 24px}
.bt-im-qr-box{display:flex;flex-direction:column;align-items:center;gap:12px}
.bt-im-qr-frame{position:relative;width:184px;height:184px;padding:8px;box-sizing:border-box;border-radius:12px;background:var(--bt-qr-paper);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-im-qr-paper{fill:var(--bt-qr-paper)}
.bt-im-qr-ink{fill:var(--bt-qr-ink)}
.bt-im-qr{display:block;width:100%;height:100%;animation:bt-veil-in .22s ease-out}
.bt-im-qr-blank{display:block;width:100%;height:100%;border-radius:6px;background:linear-gradient(100deg,var(--bt-hover) 30%,var(--bt-active) 50%,var(--bt-hover) 70%);background-size:300% 100%;animation:bt-im-sheen 1.4s linear infinite}
.bt-im-qr-box[data-state=expired] .bt-im-qr-blank,.bt-im-qr-box[data-state=error] .bt-im-qr-blank{animation:none;background:var(--bt-hover)}
@keyframes bt-im-sheen{0%{background-position:100% 0}100%{background-position:0 0}}
.bt-im-qr-done{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:12px;background:color-mix(in srgb,var(--bt-qr-paper) 82%,transparent);color:var(--bt-green)}
.bt-im-qr-done svg{width:40px;height:40px}
.bt-im-qr-caption{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2);text-align:center}
.bt-im-qr-box[data-state=error] .bt-im-qr-caption{color:var(--bt-danger);max-width:320px}
.bt-im-chat-name{flex-direction:row;align-items:center;gap:8px}
.bt-im-chat .bt-set-control{gap:8px}
.bt-im-danger:hover{color:var(--bt-danger)}
.bt-im-danger[data-confirm]{color:var(--bt-danger);background:var(--bt-danger-soft)}
.bt-im-remove{justify-content:center;color:var(--bt-danger)}
.bt-im-remove[data-confirm]{background:var(--bt-danger-soft)}
@media (prefers-reduced-motion:reduce){.bt-im-dot,.bt-im-qr-blank,.bt-im-qr{animation:none}}
`;
