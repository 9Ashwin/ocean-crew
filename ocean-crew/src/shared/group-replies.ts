// Reading a settled group_relay result back into the group's conversation rows, shared

// result's JSON holds the round's `replies`, in the order the live view draws them.

// A reply as group_relay reports it: a plain message from a Bot (`kind` undefined), a
// working/lifecycle event (`kind` set), or the user's own message (`kind: 'user'`).
export interface RelayReply {
	kind?: string;
	botId?: string;
	name?: string;
	text?: string;
	time?: number;
	duration?: number;
	via?: string;
	[key: string]: unknown;
}

export interface ParsedReplies {
	replies: RelayReply[];
	broken: boolean;
}

// A member's messages in one row: `texts` holds a plain reply's consecutive messages;
// an event reply keeps its own `kind` and no texts.
export interface StackedReply {
	reply: RelayReply;
	index: number;
	texts: string[];
	time?: number;
	duration?: number;
}

// Compaction can prune the middle of a long tool result, which leaves invalid
// JSON: then every complete reply object that survived is recovered so the turn
// still draws what it can.
const RELAY_LIST = /"replies"\s*:\s*\[/;
// Compaction marks a pruned span with a literal bracketed note like
// "[... tool result middle pruned ...]". Its "]" looks like the end of the
// replies array to a naive scan, so the text is split on the marker first.
const PRUNE_MARKER = /\[\.\.\. tool result middle pruned \.\.\.\]/;

export function parseReplies(text: string): ParsedReplies {
	try {
		return { replies: (JSON.parse(text) as { replies?: RelayReply[] }).replies ?? [], broken: false };
	} catch {
		/* fall through */
	}
	const replies: RelayReply[] = [];
	const head = RELAY_LIST.exec(text);
	if (head) {
		for (const piece of text.slice(head.index + head[0].length).split(PRUNE_MARKER)) {
			// The cut can start inside a string, leaving a fragment that keeps the
			// scanner inside quotes: restart at the first complete reply instead.
			const first = piece.indexOf('{"');
			if (first !== -1) scanReplies(piece, first, replies);
		}
	}
	return { replies, broken: true };
}

function scanReplies(text: string, start: number, replies: RelayReply[]): void {
	let depth = 0;
	let from = -1;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) from = i;
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0 && from >= 0) {
				try {
					replies.push(JSON.parse(text.slice(from, i + 1)) as RelayReply);
				} catch {
					/* partial object */
				}
				from = -1;
			}
		} else if (ch === "]" && depth === 0) break;
	}
}

// A member's messages in a row, as one block under its name: what it says while it
// works comes one message at a time. A block carries the last message's time and run.
export function stackReplies(replies: readonly RelayReply[]): StackedReply[] {
	const items: StackedReply[] = [];
	replies.forEach((reply, index) => {
		const last = items.at(-1);
		if (
			last !== undefined &&
			reply.kind === undefined &&
			last.reply.kind === undefined &&
			last.reply.botId === reply.botId
		) {
			last.texts.push(reply.text ?? "");
			last.time = reply.time;
			last.duration = reply.duration;
		} else
			items.push({
				reply,
				index,
				texts: reply.kind === undefined ? [reply.text ?? ""] : [],
				time: reply.time,
				duration: reply.duration,
			});
	});
	return items;
}
