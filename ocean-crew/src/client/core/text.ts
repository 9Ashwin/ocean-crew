// Text helpers for the browser half: line and header text, message and separator clocks,
// mention links, relay placement, and the compact figures of a Session's status bar.
import { type MentionableBot, mentionSpans } from "../../shared/mentions.ts";
import { dateLocale, t } from "./i18n.ts";

export const MENTION_ORIGIN = "https://bots.local/";

// The Bots a text calls, by the rule the group host reads (shared/mentions.ts). The
// speaker's own name takes part so that it is never read as a shorter name inside it
// ("@新 Bot" in "@新 Bot 2"); it then stays plain text.
export function linkMentions(text: string, bots: readonly MentionableBot[], selfId: string | undefined): string {
	if (!text || !text.includes("@")) return text;
	let out = "";
	let cursor = 0;
	for (const span of mentionSpans(text, bots)) {
		if (!span.bot || span.bot.id === selfId) continue;
		out += `${text.slice(cursor, span.start)}[${text.slice(span.start + 1, span.end).replace(/[[\]\\]/g, "\\$&")}](${MENTION_ORIGIN}${span.bot.id})`;
		cursor = span.end;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

export function mentionTarget(event: Event): string | null {
	const anchor = event.target instanceof Element ? event.target.closest(`a[href^="${MENTION_ORIGIN}"]`) : null;
	return anchor ? (anchor.getAttribute("href") as string).slice(MENTION_ORIGIN.length) : null;
}

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" });
}
const midnight = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
const daysBefore = (date: Date, now: number): number =>
	Math.round((midnight(new Date(now)) - midnight(date)) / 86400000);

export function dayLabel(ms: number): string {
	const date = new Date(ms);
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();
	return sameDay
		? t("Today {time}", { time: clock(ms) })
		: `${date.toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric" })} ${clock(ms)}`;
}

// The time separator's stamp: "Today 1:12 AM", "Yesterday 9:03 PM", "Thu, Sep 3 4:20 PM".
export function clockLabel(time: number, now = Date.now()): string {
	const date = new Date(time);
	const days = daysBefore(date, now);
	const stamp = clock(time);
	if (days === 0) return t("Today {time}", { time: stamp });
	if (days === 1) return t("Yesterday {time}", { time: stamp });
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return `${date.toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} ${stamp}`;
}

export function messageClock(time: number, now = Date.now()): string {
	return daysBefore(new Date(time), now) === 0 ? clock(time) : clockLabel(time, now);
}

// A short relative stamp for list rows: "just now", "5 min", "3 h", "2 d", then a date.
export function relativeShort(ms: number): string {
	const diff = Math.max(0, Date.now() - ms);
	if (diff < 60_000) return t("just now");
	if (diff < 3_600_000) return t("{n} min", { n: Math.floor(diff / 60_000) });
	if (diff < 86_400_000) return t("{n} h", { n: Math.floor(diff / 3_600_000) });
	if (diff < 30 * 86_400_000) return t("{n} d", { n: Math.floor(diff / 86_400_000) });
	return new Date(ms).toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
}

// A running clock: "8s", "1m 8s", "1h 2m 8s", in every language.
export function elapsedLabel(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	return `${hours > 0 ? `${hours}h ` : ""}${total >= 60 ? `${Math.floor(total / 60) % 60}m ` : ""}${total % 60}s`;
}

/** One content block as DSH keeps it; only text blocks carry copy. */
interface ContentBlock {
	type?: unknown;
	text?: unknown;
}

export const contentText = (content: readonly ContentBlock[] | null | undefined): string =>
	(content ?? [])
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");

// A name can contain brackets. Generated headers end at the newline; without a newline,

export const HEADER =
	/^\[(Message from|Reply from|Group chat|Group post from|Bot team setup|Handoff · part|Secret card)(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/;

export const currentPart = (bot: { sessionId?: string; id: string }): string => bot.sessionId ?? bot.id;

// The prompts in a due scheduled task's message. DSH frames it for the model: one task
// as `reminder_prompt_json: "…"`, several as `reminders_json: [{reminder_prompt}]`.
export function reminderPrompts(text: string): string[] {
	const one = /^reminder_prompt_json: (.*)$/m.exec(text);
	const batch = /^reminders_json: (.*)$/m.exec(text);
	try {
		const prompts: unknown[] = [
			...(one ? [JSON.parse(one[1])] : []),
			...(batch
				? (JSON.parse(batch[1]) as Array<{ reminder_prompt?: unknown }>).map((entry) => entry.reminder_prompt)
				: []),
		];
		return prompts.filter((prompt): prompt is string => typeof prompt === "string" && prompt.trim() !== "");
	} catch {
		// An unreadable framing shows as the plain "Routine started" line.
		return [];
	}
}

export const stripHeader = (text: string): string => text.replace(HEADER, "");

/** The host's per-Bot memory news: when each change landed, and when a window saw it. */
export interface MemoryNews {
	[botId: string]: { seen?: unknown; at?: number } | undefined;
}

// Of the Bots in a conversation, the one whose memory changed last, by the host's clock:
// changes reaching one window in the same poll share a `seen` time.
export function latestMemoryChange(news: MemoryNews | undefined, ids: readonly string[]): string | null {
	const at = (id: string | undefined): number => (id !== undefined && news?.[id]?.seen ? (news[id]?.at ?? 0) : 0);
	return ids.reduce<string | null>((best, id) => (at(id) > at(best ?? undefined) ? id : best), ids[0] ?? null);
}

/** A memory summary as the panel shows it: headings over paragraphs. */
export type SummaryBlock = { kind: "p" | "h"; text: string };

// A memory summary is "## Heading" lines, each over one paragraph; stray Markdown marks
// and list bullets are dropped.
export function summaryBlocks(text: unknown): SummaryBlock[] {
	const blocks: SummaryBlock[] = [];
	let paragraph: string[] = [];
	const flush = (): void => {
		if (paragraph.length > 0) blocks.push({ kind: "p", text: paragraph.join(" ") });
		paragraph = [];
	};
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.trim().replace(/\*\*|__/g, "");
		const heading = /^#{1,6}\s+(.+)$/.exec(line);
		if (heading) {
			flush();
			blocks.push({ kind: "h", text: heading[1].trim() });
		} else if (line === "") {
			flush();
		} else {
			paragraph.push(line.replace(/^[-*•]\s+/, ""));
		}
	}
	flush();
	return blocks;
}

export function isHiddenTurn(
	roster: { exchangeTurns: Record<string, number[]> },
	sessionId: string | undefined,
	turn: number | undefined,
): boolean {
	if (sessionId === undefined || turn === undefined) return false;
	return (roster.exchangeTurns[sessionId] ?? []).includes(turn);
}

export const toolName = (root: any): string | undefined => root?.name || root?.call?.name;

/** Reads one tool call's arguments, from a live reader or from the raw JSON. */
export interface ToolArgs {
	text(key: string): string | undefined;
	value(key: string): any;
}

export function toolArgs(root: any): ToolArgs {
	if (typeof root?.args?.text === "function") {
		return {
			text: (key: string) => root.args.text(key) ?? undefined,
			value: (key: string) => (typeof root.args.value === "function" ? root.args.value(key) : undefined),
		};
	}
	let parsed: any;
	const object = (): Record<string, any> | null => {
		if (parsed === undefined) {
			try {
				parsed = JSON.parse(root?.argsRaw ?? root?.call?.argsRaw ?? "");
			} catch {
				parsed = null;
			}
			if (typeof parsed !== "object" || Array.isArray(parsed)) parsed = null;
		}
		return parsed;
	};
	return {
		text: (key: string) => {
			const value = object()?.[key];
			return typeof value === "string" ? value : undefined;
		},
		value: (key: string) => object()?.[key],
	};
}

// A relay context is a Bot-to-Bot request, reply or stop notice injected into the model's
// history. ocean-crew's own package sources (kickoff, room, secret, handoff parts) are not
// events in the chat, nor is a request handed back after its line was already shown:
// deferred, resumed after a restart, or retried after a tool call written as text.
const RELAY_ROLES = new Set(["request", "reply", "stopped"]);
export const isRelayContext = (data: any): boolean => {
	const source = data?.source;
	if (source === null || typeof source !== "object" || source.kind !== "bot" || source.handoff === true) return false;
	if (source.deferred === true || source.resumed === true || source.retried === true) return false;
	return RELAY_ROLES.has(source.role) && typeof source.senderSessionId === "string";
};

// 'context' chat nodes never reach the flow on DSH 0.2, so a relay spliced into a running
// turn would be invisible; the step that answers it renders the line. A relay attaches to
// the next step that renders a cell: tool-only steps mount nothing (ui-chat gives them no
// visible node), so `prev` is the previous step with visible content, not the previous
// step in the list. `contexts` and `steps` are the turn's turnDataSource lists (anchor
// order) and `step` is the rendering step's own data. A step is found by its number: the
// cell's node data and the source's entries can be different snapshot objects.
const stepShows = (step: any): boolean =>
	(step?.blocks ?? []).some((block: any) => {
		// ui-chat's mount rule for a step node: non-empty reasoning, or reply content
		// (`hasAssistantReplyContent`); a tool call alone keeps the node hidden.
		if (block === undefined || block.kind === "tool-call") return false;
		return block.kind === "text" || block.kind === "reasoning" ? String(block.text ?? "").trim() !== "" : true;
	});
const stepHasReasoning = (step: any): boolean =>
	(step?.blocks ?? []).some((block: any) => block?.kind === "reasoning" && String(block.text ?? "").trim() !== "");
// The step's own cells: a reasoning step emits a 'reasoning' part and a step with reply
// content a 'response' part, or both. The line belongs in the first of them — before the
// thinking row, else before the reply.
export const relayPart = (data: any, groupPart: string | undefined): boolean =>
	groupPart === undefined || (stepHasReasoning(data) ? groupPart === "reasoning" : groupPart === "response");

export function relaysBefore(contexts: readonly any[] | null | undefined, steps: readonly any[], step: any): any[] {
	const index = steps.findIndex((entry) => entry?.step === step?.step);
	if (index === -1) return [];
	let prev = Number.NEGATIVE_INFINITY;
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		if (stepShows(steps[cursor])) {
			prev = steps[cursor].time;
			break;
		}
	}
	// The lower bound is inclusive: a relay steered right after the previous step's
	// assistant/message can share its millisecond, and it still belongs to this step — its
	// own model call follows the previous one. The upper bound stays strict: a step's time
	// is its settled message or first visible token.
	return (contexts ?? []).filter(
		(data) => isRelayContext(data) && typeof data.time === "number" && data.time >= prev && data.time < step.time,
	);
}

// Back-to-back Bot-to-Bot messages fold into one "N messages with" line. A hidden exchange
// turn holds a request and its reply; a visible one (a reply, or a request answered to the
// user) adds only its trigger and ends the run. Group turns never show in a one-to-one
// chat, so they do not break a run. `order` lists the Session's turns; `peers` maps each
// relayed turn to its sender's id. Returns null (unknown), 'folded', or { count, peerIds }
// for the run's first line.
export function commRunOf(
	order: readonly (string | number)[],
	peers: Record<string, string | undefined>,
	turn: string | number,
	hiddenTurns: readonly (string | number)[] = [],
): null | "folded" | { count: number; peerIds: string[] } {
	const turns: Array<{ turn: string | number; peer: string | undefined; hidden: boolean }> = [];
	for (const entry of order) {
		const peer = peers[String(entry)];
		const hidden = hiddenTurns.includes(entry);
		if (hidden && peer === undefined) continue;
		turns.push({ turn: entry, peer, hidden });
	}
	const at = turns.findIndex((entry) => entry.turn === turn);
	if (at === -1 || turns[at].peer === undefined) return null;
	const previous = turns[at - 1];
	if (previous?.peer !== undefined && previous.hidden) return "folded";
	let count = 0;
	const peerIds: string[] = [];
	for (let index = at; index < turns.length; index += 1) {
		const entry = turns[index];
		if (entry.peer === undefined || (index > at && !turns[index - 1].hidden)) break;
		count += entry.hidden ? 2 : 1;
		if (!peerIds.includes(entry.peer)) peerIds.push(entry.peer);
	}
	return { count, peerIds };
}

/** The session-list shape the sidebar reads. */
export interface SessionList {
	projectionsBySession?: Record<string, { values?: Record<string, any> } | undefined>;
	byId?: Record<string, { projectionValues?: Record<string, any> } | undefined>;
}

// Latest visible line for a sidebar row; Bot-to-Bot exchange turns stay out of it.
export function previewOf(list: SessionList, id: string, hiddenTurns: readonly number[] = []): string {
	const outline =
		list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId?.[id]?.projectionValues?.turnOutline;
	if (!Array.isArray(outline)) return "";
	for (let index = outline.length - 1; index >= 0; index -= 1) {
		const entry = outline[index];
		if (hiddenTurns.includes(entry.turn)) continue;
		const text = entry.response || entry.prompt || "";
		if (text !== "") return stripHeader(text).replace(/\s+/g, " ").trim();
	}
	return "";
}

const formatTokens = (count: number): string =>
	count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count);

// Same buckets as the shell's usage pill: every prompt-side billing bucket plus output.
export function usageOf(list: SessionList, ids: readonly string[]): string {
	let input = 0;
	let cacheRead = 0;
	let output = 0;
	for (const id of ids) {
		const usage = list.projectionsBySession?.[id]?.values?.tokenUsage;
		if (!usage) continue;
		input += (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		cacheRead += usage.cacheReadTokens ?? 0;
		output += usage.outputTokens ?? 0;
	}
	if (input + output === 0) return "";
	const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
	return t("{tokens} tok · Cache hit {hit}%", { tokens: formatTokens(input + output), hit });
}

// A share that is not whole never reads as 100%: it gets decimals until it does not.
function percentText(part: number, whole: number): string {
	if (part >= whole) return "100";
	for (let places = 0; places < 3; places += 1) {
		const text = ((part / whole) * 100).toFixed(places);
		if (Number(text) < 100) return text;
	}
	return "99.99";
}

/** One figure of the Session status bar. */
export interface RunStat {
	key: string;
	text: string;
	title?: string;
}

// One Session's figures from DSH's sessionStats, tokenUsage and contextPressure views, as
// its status bar counts them: turns, output tokens over decode time, cache reads over every
// prompt-side token, and the context in use. Figures with nothing to count yet are left out.
export function runStatsOf(values: any): RunStat[] {
	const stats = values?.sessionStats;
	const usage = values?.tokenUsage;
	const pressure = values?.contextPressure;
	const shown: RunStat[] = [];
	if (stats?.turns > 0)
		shown.push({ key: "turns", text: stats.turns === 1 ? t("1 turn") : t("{count} turns", { count: stats.turns }) });
	if (stats?.decodeMs > 0 && stats.decodeTokens > 0) {
		const speed = stats.decodeTokens / (stats.decodeMs / 1000);
		shown.push({
			key: "speed",
			text: t("{speed} tok/s", { speed: speed >= 10 ? Math.round(speed) : Math.round(speed * 10) / 10 }),
		});
	}
	const prompt = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
	if (prompt > 0)
		shown.push({
			key: "cache",
			text: t("Cache hit {hit}%", { hit: percentText(usage.cacheReadTokens ?? 0, prompt) }),
		});
	const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
	if (Number.isFinite(used) && pressure.contextWindow > 0) {
		shown.push({
			key: "context",
			text: t("Context {percent}%", { percent: Math.min(100, Math.round((used / pressure.contextWindow) * 100)) }),
			title: t("{used} of {total} tokens of context in use", {
				used: formatTokens(used),
				total: formatTokens(pressure.contextWindow),
			}),
		});
	}
	return shown;
}
