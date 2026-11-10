// Emoji that arrive from a chat platform as words rather than characters. Feishu's emoji panel puts
// a code like `[赞]` into the text, so a message that looks like an emoji in the chat reaches the
// model — and the window — as literal brackets. This maps the codes people actually use back to the
// character; a code it does not know is left alone, because a wrong guess is worse than a literal.
//
// A code is only listed when its meaning is unambiguous. Anything else stays as it came.

export const PLATFORM_EMOJI: Record<string, string> = {
	// Faces
	"[微笑]": "😊",
	"[大笑]": "😄",
	"[笑哭]": "😂",
	"[偷笑]": "🤭",
	"[呲牙]": "😁",
	"[调皮]": "😜",
	"[酷]": "😎",
	"[害羞]": "😊",
	"[害羞了]": "☺️",
	"[汗]": "😅",
	"[尴尬]": "😅",
	"[惊讶]": "😮",
	"[疑问]": "❓",
	"[晕]": "😵",
	"[睡]": "😴",
	"[嘘]": "🤫",
	"[生病]": "🤒",
	"[哭]": "😢",
	"[泪]": "😭",
	"[怒]": "😠",
	"[发怒]": "😡",
	"[得意]": "😏",
	"[坏笑]": "😏",
	"[嘿哈]": "😆",
	"[加油]": "💪",
	"[思考]": "🤔",
	"[what]": "😮",
	// Hands and gestures
	"[赞]": "👍",
	"[强]": "👍",
	"[good]": "👍",
	"[ok]": "👌",
	"[鼓掌]": "👏",
	"[握手]": "🤝",
	"[抱拳]": "🙏",
	"[拥抱]": "🤗",
	"[合十]": "🙏",
	"[弱]": "👎",
	"[胜利]": "✌️",
	// Hearts and symbols
	"[爱心]": "❤️",
	"[心碎]": "💔",
	"[玫瑰]": "🌹",
	"[蜡烛]": "🕯️",
	"[蛋糕]": "🎂",
	"[咖啡]": "☕",
	"[啤酒]": "🍺",
	"[太阳]": "☀️",
	"[月亮]": "🌙",
	"[庆祝]": "🎉",
	"[礼物]": "🎁",
	"[红包]": "🧧",
	"[炸弹]": "💣",
	"[刀]": "🔪",
	"[发]": "📤",
	"[机智]": "🤓",
	"[吃瓜]": "🍉",
	"[看]": "👀",
};

// The longest code is a handful of characters; a text with no bracket at all needs no work.
const CODE = /\[[^[\]\n]{1,12}\]/g;

/** The text with platform emoji codes replaced by the emoji they mean. */
export function emojiText(text: string): string {
	const source = String(text ?? "");
	if (!source.includes("[")) return source;
	return source.replace(CODE, (code) => PLATFORM_EMOJI[code] ?? code);
}

/** True when this text is nothing but emoji and whitespace, which is a sticker said in words. */
export function onlyEmoji(text: string): boolean {
	const stripped = emojiText(text).replace(/\s+/g, "");
	if (stripped === "") return false;
	// Ranges cover the pictographs, symbols and joiners people actually send; anything else means
	// this message carries words too.
	return !/[0-9A-Za-z\u4e00-\u9fff]/.test(stripped);
}
