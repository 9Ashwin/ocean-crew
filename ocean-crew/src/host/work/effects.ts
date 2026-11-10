// Which tools touch the world outside the team, and how hard. A tool's effect decides whether
// it runs as called or becomes a card the user has to approve: reading is free, a draft stays
// inside the team, and anything that sends, destroys or pays is shown first.
//
// The classifier is deliberately blunt for tools it does not know: a name that reads like
// "send", "delete" or "charge" is treated as the strictest kind. A wrong guess that asks the
// user once is better than a wrong guess that posts publicly or spends money.

export type ToolEffect = "read" | "draft" | "external_send" | "destructive" | "payment";

/** The effects a card is shown for, in order of how much they need one. */
export const APPROVAL_EFFECTS: readonly ToolEffect[] = ["payment", "destructive", "external_send"];

/** The verbs that make an unknown tool strict. Order matters: the worst match wins. */
const PAYMENT_WORDS = /\b(pay|payment|charge|checkout|purchase|buy|subscribe|invoice|transfer|withdraw)\b/i;
const DESTRUCTIVE_WORDS = /\b(delete|remove|destroy|drop|purge|revoke|archive|overwrite|truncate|reset|kill)\b/i;
const SEND_WORDS =
	/\b(send|post|publish|share|reply|comment|create|update|edit|write|upload|invite|message|notify|submit|transfer)\b/i;
const DRAFT_WORDS = /\b(draft|preview|propose|schedule|plan)\b/i;
const READ_WORDS =
	/^(get|list|read|search|find|fetch|query|lookup|describe|show|inspect|view|count|check|status|download|export)\b/i;

/**
 * The effect of one tool name. A known read verb stays a read even when the rest of the name
 * has a strict word, because `get_message` reads while `send_message` sends.
 */
export function effectOfTool(name: string): ToolEffect {
	const plain = String(name ?? "")
		.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "")
		.replace(/[_:]/g, " ")
		.trim();
	if (plain === "") return "external_send";
	const first = plain.split(/\s+/)[0] ?? "";
	if (READ_WORDS.test(first) && !PAYMENT_WORDS.test(plain)) return "read";
	if (PAYMENT_WORDS.test(plain)) return "payment";
	if (DESTRUCTIVE_WORDS.test(plain)) return "destructive";
	if (DRAFT_WORDS.test(first)) return "draft";
	if (SEND_WORDS.test(plain)) return "external_send";
	// An unknown verb is treated as strict: the user sees the card and can allow it.
	return "external_send";
}

/** True when this effect needs the user's approval before the call runs. */
export const needsApproval = (effect: ToolEffect): boolean => APPROVAL_EFFECTS.includes(effect);

/**
 * What a card shows about the call: the target the tool names, and enough of the arguments to
 * recognise it. Never a secret value: the caller passes only what is already safe to show.
 */
export interface CallSummary {
	tool: string;
	effect: ToolEffect;
	/** The tool's own word for what it acts on, when the arguments carry one. */
	target?: string;
	/** The arguments, shortened for display. */
	detail: string;
}

const TARGET_KEYS = [
	"to",
	"recipient",
	"recipients",
	"channel",
	"channel_id",
	"chat_id",
	"email",
	"address",
	"url",
	"path",
	"id",
	"query",
];

/** One call, as the card presents it. Long values are cut, not summarised away. */
export function summariseCall(tool: string, effect: ToolEffect, args: unknown): CallSummary {
	const raw =
		args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	let target: string | undefined;
	for (const key of TARGET_KEYS) {
		const value = raw[key];
		if (typeof value === "string" && value.trim() !== "") {
			target = value.trim().slice(0, 120);
			break;
		}
		if (Array.isArray(value) && value.length > 0) {
			target = value
				.filter((item) => typeof item === "string")
				.slice(0, 3)
				.join(", ")
				.slice(0, 120);
			break;
		}
	}
	let detail = "";
	try {
		detail = JSON.stringify(raw);
	} catch {
		detail = String(raw);
	}
	return {
		tool,
		effect,
		...(target === undefined ? {} : { target }),
		detail: detail.length > 600 ? `${detail.slice(0, 600)}…` : detail,
	};
}

/** A user-facing sentence for an effect, used as the card's reason line. */
export const effectReason = (effect: ToolEffect): string => {
	if (effect === "payment") return "This call spends money. Nothing runs until you allow it.";
	if (effect === "destructive") return "This call deletes or overwrites something. Nothing runs until you allow it.";
	return "This call sends something outside the team. Nothing runs until you allow it.";
};
