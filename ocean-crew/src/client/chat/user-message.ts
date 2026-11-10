import { Fragment, createElement as h, useEffect, useRef, useState } from "react";
import { imPlatform } from "../../shared/im-platforms.ts";
import { type MentionableBot, mentionSpans } from "../../shared/mentions.ts";
import { dateLocale, t } from "../core/i18n.ts";
import { clockLabel, messageClock } from "../core/text.ts";
import { CheckIcon, CopyIcon } from "../look/icons.ts";
import { BotMark } from "../look/mark.ts";
import { noHover } from "../look/motion.ts";
import { useFold } from "./fold.ts";

// -------------------------------------------------------------------------
// The user's own messages. DSH draws every "@word" in them as a file reference, and
// cuts it at the first space, so "@新 Bot" showed as a file "新". Here the Bot mentions
// are cut out first, by the rule the group host calls them with; DSH's own drawing
// keeps everything else (files, conversation references, skills).

// The row is drawn by this file. The shipped desktop runtime has no primitives module, so a gate on
// one of its helpers read false everywhere and this cell never rendered at all — which is why a mark
// stored on the message was never seen. What is needed instead is the shell's text factory slot,
// which Ocean Crew already uses for its queue preview and which exists in every build.
export const canDrawUserMessages = (): boolean => true;

/** One content block of a user message. */
export interface UserContentBlock {
	type?: string;
	text?: string;
	attachment?: any;
	[key: string]: unknown;
}

/** The text, attachments and unknown blocks of a user message, split like the group host. */
export interface UserContentParts {
	text: string;
	attachments: UserContentBlock[];
	rest: UserContentBlock[];
}

export function contentParts(content: unknown): UserContentParts {
	const texts: string[] = [];
	const attachments: UserContentBlock[] = [];
	const rest: UserContentBlock[] = [];
	for (const block of (Array.isArray(content) ? content : []) as UserContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if ((block?.type === "image" || block?.type === "file") && block.attachment !== undefined)
			attachments.push(block);
		else rest.push(block);
	}
	// Joined as the group host joins them, so a mention never spans two blocks here only.
	return { text: texts.join("\n"), attachments, rest };
}

/** A Bot as the roster holds it. */
export interface RosterBot extends MentionableBot {
	[key: string]: any;
}

/** The roster the cells read; shaped like `sources` publishes it. */
export interface UserRoster {
	byId: Record<string, RosterBot>;
	bots: RosterBot[];
	roomsById: Record<string, { members: string[]; [key: string]: any }>;
	imVia?: Record<string, Record<string | number, string>>;
}

// In a group only its members are called; elsewhere a mention opens that Bot's chat.
export function mentionableBots(roster: UserRoster, sessionId: string): RosterBot[] {
	const room = roster.roomsById[sessionId];
	if (room) return room.members.map((id) => roster.byId[id]).filter(Boolean);
	return roster.byId[sessionId] ? roster.bots : [];
}

/** One run of a user message: plain text, or a Bot mention with its label. */
export type UserTextPart = { text: string; bot?: undefined } | { bot: RosterBot; label: string; text?: undefined };

// Runs of plain text and Bot mentions, in order.
export function userTextParts(
	text: string,
	bots: RosterBot[],
	referenceLabels: readonly string[] = [],
): UserTextPart[] {
	const parts: UserTextPart[] = [];
	let cursor = 0;
	for (const span of mentionSpans(text, bots, { references: referenceLabels })) {
		if (!span.bot) continue;
		if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start) });
		parts.push({ bot: span.bot, label: text.slice(span.start + 1, span.end) });
		cursor = span.end;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor) });
	return parts;
}

function UserText({ text, bots, referenceLabels, skillNames, references, actions, renderFactorySlot }: any) {
	return userTextParts(text, bots, referenceLabels).map((part, index) => {
		if (part.bot)
			return h(
				"button",
				{
					key: index,
					type: "button",
					className: "bt-umention",
					title: `@${part.bot.name}`,
					onClick: () => actions.openSession(part.bot.id),
				},
				h(BotMark, { bot: part.bot, size: 16 }),
				part.label,
			);
		// The shell's own renderer draws links, code and reference chips as the rest of the app does;
		// the plain branch keeps a message readable in a shell that provides no factory.
		const rendered = renderFactorySlot?.("conversation.user.text", {
			text: part.text,
			facts: {
				references: references ?? [],
				referenceLabels,
				skills: skillNames ?? [],
			},
			interactive: true,
		});
		return h(Fragment, { key: index }, rendered ?? part.text);
	});
}

/** A file's size in one short label, the way the rest of the app writes it. */
function fileSizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Attachments({ attachments, renderMessageImages }: any) {
	const compact = attachments.length > 1;
	return h(
		"div",
		{ className: "bt-uattach" },
		attachments.map((block: any, index: number) => {
			if (block.type === "image") {
				return renderMessageImages
					? h(
							Fragment,
							{ key: index },
							renderMessageImages({ images: [{ attachment: block.attachment }], align: "end", compact }),
						)
					: null;
			}
			const file = block.attachment;
			// The extension and size come from the name and the byte count, so this row needs no
			// helper from a package the shipped runtime may not have.
			const extension = String(file.name ?? "")
				.split(".")
				.pop()
				?.toUpperCase()
				.slice(0, 8);
			const size = typeof file.bytes === "number" ? fileSizeText(file.bytes) : "";
			const meta = [extension, size].filter(Boolean).join(" · ");
			return h(
				"span",
				{ key: index, className: "bt-ufile", title: file.name },
				h("span", { className: "bt-ufile-icon", "aria-hidden": true }, extension ?? ""),
				h(
					"span",
					{ className: "bt-ufile-text" },
					h("span", { className: "bt-ufile-name" }, file.name),
					meta ? h("span", { className: "bt-ufile-meta" }, meta) : null,
				),
			);
		}),
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = (): void => {
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1000);
		});
	};
	return h(
		"button",
		{
			type: "button",
			className: "bt-tool",
			"aria-label": copied ? t("Copied") : t("Copy"),
			title: copied ? t("Copied") : t("Copy"),
			onClick: copy,
		},
		copied ? h(CheckIcon) : h(CopyIcon),
	);
}

const clock = (time?: number): string | undefined =>
	typeof time === "number"
		? new Date(time).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" })
		: undefined;

// A message that came in over IM names its platform: "via Telegram" by the time.
export const viaOf = (source: any): string | undefined =>
	typeof source?.rpcId === "string" && source.rpcId.startsWith("im:") ? source.rpcId.split(":")[1] : undefined;
export const ViaTag = ({ via }: { via: string }) =>
	h("span", { className: "bt-uvia" }, t("via {platform}", { platform: t(imPlatform(via)?.name ?? via) }));

/** The message node the chat cell receives; only the fields this cell reads. */
export interface UserMessageNode {
	kind?: string;
	data?: any;
	[key: string]: unknown;
}

/** A sent message, or one that joined a running turn ("steering"). */
export function UserMessageCell({
	node,
	sessionId,
	useRoster,
	actions,
	renderMessageImages,
	renderFactorySlot,
	openFile,
	openSkill,
}: any) {
	const roster: UserRoster = useRoster((value: UserRoster) => value);
	const data = node.data ?? {};
	const { text, attachments, rest } = contentParts(data.content);
	const referenceLabels = data.referenceLabels ?? [];
	const references = openFile && openSkill ? { openFile, openSkill } : undefined;
	const steering = node.kind === "steering";
	const sentAt = Number.isFinite(data.time) ? messageClock(data.time) : undefined;
	const via = viaOf(data.source) ?? roster.imVia?.[sessionId]?.[data.seq];
	// A companion may put one emoji on what the user said; it rides under that bubble. The
	// slot's own props do not promise a session, so the lookup asks this chat first and then
	// every chat: a message id is unique, and a mark that was drawn is found either way.
	const reaction =
		useRoster((value: any) => {
			const marks: Record<string, Record<string, string>> = value.companionReactions ?? {};
			const keys = [String(data.seq ?? ""), String(data.messageId ?? ""), String(data.id ?? "")].filter(
				(key: string) => key !== "" && key !== "undefined",
			);
			for (const key of keys) {
				const here = sessionId === undefined ? undefined : marks[sessionId]?.[key];
				if (here !== undefined) return here;
			}
			for (const chat of Object.values(marks)) for (const key of keys) if (chat[key] !== undefined) return chat[key];
			return null;
		}) ?? null;
	const { shown, folded, control } = useFold(text, { markdown: false });
	const body = h(UserText, {
		text: shown,
		bots: mentionableBots(roster, sessionId),
		referenceLabels,
		skillNames: data.skillNames ?? [],
		references,
		actions,
		renderFactorySlot,
	});
	const row = useRef<any>(null);
	// Touch has no hover: a tap on the bubble opens its copy tool, a tap elsewhere closes it.
	const [toolsOpen, setToolsOpen] = useState(false);
	useEffect(() => {
		if (!toolsOpen) return undefined;
		const onDown = (event: any): void => {
			if (!row.current?.contains(event.target)) setToolsOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("touchstart", onDown);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("touchstart", onDown);
		};
	}, [toolsOpen]);
	const tapTools = (event: any): void => {
		if (
			!noHover() ||
			(event.target instanceof Element &&
				event.target.closest("a,button,input,textarea,select,pre,code,[role=button],[role=link]"))
		)
			return;
		setToolsOpen((value) => !value);
	};
	return h(
		"div",
		{ ref: row, className: "bt-umsg", "data-steering": steering || undefined },
		h(
			"div",
			{ className: "bt-ustack" },
			attachments.length > 0 ? h(Attachments, { attachments, renderMessageImages }) : null,
			text !== "" || rest.length > 0
				? h(
						"div",
						{
							className: "bt-ubody",
							title: clock(data.time),
							"data-folded": folded || undefined,
							onClick: tapTools,
						},
						control ? h("div", { className: "bt-fold-body" }, body) : body,
						control,
						// An unknown block is shown as its own text when it carries any: no primitives
						// module is required to keep the content visible.
						rest.map((block, index) =>
							typeof (block as any)?.text === "string" && (block as any).text !== ""
								? h("div", { key: index, className: "bt-ublock" }, String((block as any).text))
								: null,
						),
					)
				: null,
			referenceLabels.length > 0
				? h("div", { className: "bt-urefs" }, t("Referenced {labels}", { labels: referenceLabels.join(t(", ")) }))
				: null,
			sentAt || via
				? h(
						"div",
						{ className: "bt-utime", title: clockLabel(data.time) },
						...(via ? [h(ViaTag, { key: "via", via })] : []),
						sentAt,
					)
				: null,
			reaction === null ? null : h("div", { className: "bt-ureact", title: t("Reaction") }, reaction),
		),
		text === ""
			? null
			: h("div", { className: "bt-utools", "data-open": toolsOpen || undefined }, h(CopyButton, { text })),
	);
}

export const USER_MESSAGE_CSS = `
.bt-umsg{display:flex;flex-direction:row-reverse;align-items:center;justify-content:flex-start;gap:4px}
.bt-ustack{min-width:0;max-width:calc(var(--bt-msg-w) * 100%);display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.bt-ubody{max-width:100%;box-sizing:border-box;background:var(--bt-user);color:var(--bt-user-ink);border-radius:18px;padding:7px 12px;font-size:var(--dsh-content-font-size,14px);line-height:calc(var(--dsh-content-font-size,14px) + 10px);white-space:pre-wrap;word-break:break-word;text-wrap:pretty;text-autospace:normal}
.bt-ubody a{color:inherit}
.bt-umention{display:inline-flex;align-items:center;gap:3px;vertical-align:-3px;max-width:100%;padding:0 1px;border:0;background:none;color:inherit;font:inherit;font-weight:600;line-height:inherit;cursor:pointer;border-radius:6px;white-space:nowrap}
.bt-umention:hover{text-decoration:underline;text-underline-offset:2px}
.bt-umention>:first-child{flex:none}
.bt-uattach{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}
.bt-ufile{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;width:240px;min-height:64px;padding:8px 12px;border-radius:18px;border:.5px solid var(--bt-line-2);background:var(--bt-card)}
.bt-ufile-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:9px;font-weight:600;line-height:1}
.bt-ufile-text{display:flex;flex-direction:column;min-width:0}
.bt-ufile-name{font-size:14px;line-height:22px;font-weight:500;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-ufile-meta{font-size:12px;line-height:15px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-urefs{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
/* A companion's emoji on the user's message: a small chip on the bubble's tail. */
.bt-ureact{margin-top:-4px;margin-right:10px;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 5px;border-radius:11px;background:var(--bt-card);border:.5px solid var(--bt-line-2);box-shadow:0 1px 3px rgb(0 0 0 / .08);font-size:13px;line-height:1;animation:bt-reaction-in .22s ease-out}
@keyframes bt-reaction-in{from{opacity:0;transform:translateY(-3px) scale(.8)}}
.bt-uvia{display:inline-block;margin-right:6px;padding:0 6px;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:11px;line-height:16px;vertical-align:1px}
.bt-utools{display:flex;flex:none;gap:2px;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s}
.bt-umsg:hover .bt-utools,.bt-umsg:focus-within .bt-utools{opacity:1;visibility:visible}
`;
