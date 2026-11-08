// Outbound text for IM platforms. Bots write Markdown; each platform adapter turns it
// into what the platform renders (Telegram HTML) or plain text, and cuts it at the
// platform's per-message limit without breaking inside a code fence when it can help it.

const escapeHtml = (text: unknown): string =>
	String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// One Markdown document as blocks: fenced code stays a block of its own so chunking
// can keep it whole; the rest splits on blank lines.
type Block = { kind: "text"; lines: string[] } | { kind: "code"; lang: string; lines: string[]; open: boolean };

/** One message as a platform sends it: the rendered form and the plain-text fallback. */
export interface TelegramChunk {
	html: string;
	text: string;
}

// Inline Markdown inside one line or block: `code`, **bold**, _italic_, ~~strike~~,
// [label](url). Code spans are pulled out first so markers inside them stay literal.
function inlineHtml(line: string): string {
	const spans: string[] = [];
	const kept = line.replace(/`([^`]+)`/g, (_all, code: string) => {
		spans.push(`<code>${escapeHtml(code)}</code>`);
		return `\x00${spans.length - 1}\x00`;
	});
	const html = escapeHtml(kept)
		.replace(
			/\[([^\]]*)\]\(([^)\s]+)\)/g,
			(_all, label: string, url: string) => `<a href="${escapeHtml(url)}">${label}</a>`,
		)
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/__([^_]+)__/g, "<b>$1</b>")
		.replace(/\*([^*]+)\*/g, "<i>$1</i>")
		.replace(/\b_([^_]+)_\b/g, "<i>$1</i>")
		.replace(/~~([^~]+)~~/g, "<s>$1</s>");
	return html.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => spans[Number(index)]);
}

function inlinePlain(line: string): string {
	return line
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) =>
			label === url ? label : `${label} (${url})`,
		)
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/\b_([^_]+)_\b/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1");
}

function blocks(markdown: string): Block[] {
	const out: Block[] = [];
	const lines = String(markdown).split("\n");
	let at = 0;
	let buffer: string[] = [];
	const flush = (): void => {
		if (buffer.length > 0) out.push({ kind: "text", lines: buffer });
		buffer = [];
	};
	while (at < lines.length) {
		const line = lines[at];
		const fence = /^```(\S*)\s*$/.exec(line);
		if (fence !== null) {
			flush();
			const close = lines.slice(at + 1).findIndex((item) => /^```\s*$/.test(item));
			const body = close === -1 ? lines.slice(at + 1) : lines.slice(at + 1, at + 1 + close);
			out.push({ kind: "code", lang: fence[1] ?? "", lines: body, open: true });
			at += 1 + (close === -1 ? body.length : close + 1);
			continue;
		}
		if (line.trim() === "") flush();
		else buffer.push(line);
		at += 1;
	}
	flush();
	return out;
}

const renderHtml = (block: Block): string =>
	block.kind === "code"
		? `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ""}>${escapeHtml(block.lines.join("\n"))}</code></pre>`
		: block.lines.map(inlineHtml).join("\n");

const renderPlain = (block: Block): string =>
	block.kind === "code" ? block.lines.join("\n") : block.lines.map(inlinePlain).join("\n");

export function toTelegramHtml(markdown: string): string {
	return blocks(markdown).map(renderHtml).join("\n");
}

export function toPlain(markdown: string): string {
	return blocks(markdown).map(renderPlain).join("\n");
}

const points = (text: string): number => Array.from(text).length;

// Split a block that alone exceeds the limit: text at line boundaries (a line that
// is still too long is cut where it lands — Telegram answers it as plain text), a
// code fence into several fenced blocks.
function forceCut(block: Block, limit: number): TelegramChunk[] {
	if (block.kind !== "code") {
		const chunks: TelegramChunk[] = [];
		let html = "";
		let text = "";
		const flush = (): void => {
			if (html === "") return;
			chunks.push({ html, text });
			html = "";
			text = "";
		};
		for (const line of block.lines) {
			const lineHtml = inlineHtml(line);
			const candidate = html === "" ? lineHtml : `${html}\n${lineHtml}`;
			if (points(candidate) <= limit) {
				html = candidate;
				text = text === "" ? inlinePlain(line) : `${text}\n${inlinePlain(line)}`;
				continue;
			}
			flush();
			// A single line over the limit is cut on its rendered text.
			let rest = lineHtml;
			let restPlain = inlinePlain(line);
			while (points(rest) > limit) {
				const part = Array.from(rest).slice(0, limit).join("");
				const plainPart = Array.from(restPlain).slice(0, limit).join("");
				chunks.push({ html: part, text: plainPart });
				rest = Array.from(rest).slice(limit).join("");
				restPlain = Array.from(restPlain).slice(limit).join("");
			}
			html = rest;
			text = restPlain;
		}
		flush();
		return chunks;
	}
	const chunks: TelegramChunk[] = [];
	const open = `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ""}>`;
	const close = "</code></pre>";
	let body = block.lines.join("\n");
	const room = limit - points(open) - points(close);
	while (body !== "") {
		let at = Math.min(points(body), Math.max(1, room));
		const chars = Array.from(body);
		const newline = body.lastIndexOf("\n", at);
		if (newline > room / 2) at = newline;
		const part = chars.slice(0, at).join("");
		chunks.push({ html: `${open}${escapeHtml(part)}${close}`, text: part });
		body = chars.slice(at).join("").replace(/^\n/, "");
	}
	return chunks;
}

// Chunks of one Markdown message, each under `limit` rendered characters. Block
// A fence left open at a cut would render the next chunk as a bare body, so the cut closes
// it and the next chunk reopens it with the same language. When the reply is split into
// more than one part, each part says which one it is, so the reader knows more is coming.
const FENCE_LINE = /^\s*(?:```|~~~)(.*)$/;
const fenceOpen = (text: string): { open: boolean; lang: string } => {
	let open = false;
	let lang = "";
	for (const line of text.split("\n")) {
		const found = FENCE_LINE.exec(line);
		if (found === null) continue;
		if (!open) lang = found[1].trim();
		open = !open;
	}
	return { open, lang };
};

export function chunkMarkdown(markdown: string | null | undefined, limit: number): string[] {
	const whole = String(markdown ?? "").trimEnd();
	if (whole === "") return [];
	if (points(whole) <= limit) return [whole];
	// A part marker is only useful when the budget is much larger than the marker itself;
	// on a tiny limit it would eat the text and say nothing.
	const marked = limit >= 128;
	// Room for "(i/n)" comes out of the limit, so every part stays within it.
	const budgetTotal = Math.max(1, limit - (marked ? 8 : 0));
	const raw: string[] = [];
	let rest = whole;
	let inside = false;
	let lang = "";
	while (points(rest) > budgetTotal) {
		const opening = inside ? `\`\`\`${lang}\n` : "";
		const closing = inside || FENCE_LINE.test(rest) ? 4 : 0;
		const budget = Math.max(1, budgetTotal - points(opening) - closing);
		const chars = [...rest];
		let at = budget;
		const slice = chars.slice(0, budget).join("");
		const newline = slice.lastIndexOf("\n");
		if (newline > budget / 2) at = newline;
		else {
			const space = slice.lastIndexOf(" ");
			if (space > budget / 2) at = space;
		}
		const body = chars.slice(0, at).join("");
		rest = chars.slice(at).join("").replace(/^\s+/, "");
		let state: boolean = inside;
		for (const line of body.split("\n")) {
			const found = FENCE_LINE.exec(line);
			if (found === null) continue;
			if (!state) lang = found[1].trim();
			state = !state;
		}
		raw.push(`${opening}${body}${state ? "\n```" : ""}`);
		inside = state;
	}
	if (rest !== "") raw.push(`${inside ? `\`\`\`${lang}\n` : ""}${rest}`);
	if (!marked || raw.length <= 1) return raw;
	return raw.map((piece, index) => `${piece} (${index + 1}/${raw.length})`);
}

export function chunkTelegram(markdown: string, limit = 4096): TelegramChunk[] {
	const chunks: TelegramChunk[] = [];
	let html = "";
	let text = "";
	const flush = (): void => {
		if (html === "" && text === "") return;
		chunks.push({ html, text });
		html = "";
		text = "";
	};
	for (const block of blocks(markdown)) {
		const blockHtml = renderHtml(block);
		const blockText = renderPlain(block);
		const candidate = html === "" ? blockHtml : `${html}\n${blockHtml}`;
		if (points(candidate) <= limit) {
			html = candidate;
			text = text === "" ? blockText : `${text}\n${blockText}`;
			continue;
		}
		flush();
		if (points(blockHtml) <= limit) {
			html = blockHtml;
			text = blockText;
			continue;
		}
		chunks.push(...forceCut(block, limit));
	}
	flush();
	return chunks;
}
