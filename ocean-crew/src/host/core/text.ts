// Pure text helpers shared by the host modules: message text, names, model refs,
// cutting and estimating text, and the clock format of chat anchors.

import { COLORS, EXTRA_COLORS, OWN_CHAT_LINE_MAX } from "./constants.ts";

export const isColor = (color: unknown): color is string =>
	typeof color === "string" &&
	(COLORS.includes(color) || EXTRA_COLORS.includes(color) || /^#[0-9a-f]{6}$/i.test(color));
export const currentColor = (color: string | undefined): string | undefined => (isColor(color) ? color : undefined);

// A model reference as DSH names a model: `provider/model`, split at the first slash.
export interface ModelRef {
	provider: string;
	model: string;
}

export const splitRef = (ref: unknown): ModelRef | undefined => {
	if (typeof ref !== "string") return undefined;
	const index = ref.indexOf("/");
	return index > 0 ? { provider: ref.slice(0, index), model: ref.slice(index + 1) } : undefined;
};

// One content block of a Session message; only text blocks carry words.
interface ContentBlock {
	type?: unknown;
	text?: unknown;
}

const isTextBlock = (block: unknown): block is { type: "text"; text: string } => {
	if (typeof block !== "object" || block === null) return false;
	const candidate = block as ContentBlock;
	return candidate.type === "text" && typeof candidate.text === "string";
};

export const textOf = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n")
		.trim();

export const normalize = (value: unknown): string =>
	String(value ?? "")
		.trim()
		.toLowerCase();

export const unquote = (text: unknown): string =>
	String(text ?? "")
		.trim()
		.replace(/^["'“”「『《]+|["'“”」』》]+$/g, "")
		.trim();

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The part of a long message around the first match, so a search hit stays visible.
export const excerpt = (text: string, wanted: string, max = OWN_CHAT_LINE_MAX): string => {
	if (text.length <= max) return text;
	const at = wanted === "" ? 0 : Math.max(0, text.toLowerCase().indexOf(wanted) - 120);
	return `${at > 0 ? "…" : ""}${text.slice(at, at + max)}…`;
};

// An upper bound: a CJK character is about one token, other text about a third.
export const estimateTokens = (text: string): number => {
	let tokens = 0;
	for (const char of text) tokens += (char.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.34;
	return Math.ceil(tokens);
};
export const clip = (text: string, max: number, rest: string): string =>
	text.length > max ? `${text.slice(0, max)}… (cut; ${rest})` : text;
// The first `max` UTF-16 units of a text, never half of a character.
export const headOf = (text: string, max: number): string =>
	text.length <= max ? text : text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max);

export const createClock = (timeZone?: string): ((time?: number) => string) => {
	const clockFormat = new Intl.DateTimeFormat("en-CA", {
		...(timeZone ? { timeZone } : {}),
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return (time?: number) =>
		typeof time === "number" && Number.isFinite(time) ? clockFormat.format(time).replace(",", "") : "?";
};
