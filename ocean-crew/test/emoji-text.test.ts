// Emoji that a chat platform sends as words: Feishu's panel puts `[赞]` into the text, so a message
// that looks like an emoji in the chat used to reach the window as brackets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emojiText, onlyEmoji, PLATFORM_EMOJI } from "../src/host/im/emoji-text.ts";

test("a platform code becomes the emoji it means", () => {
	assert.equal(emojiText("[赞]"), "👍");
	assert.equal(emojiText("收到[ok]"), "收到👌");
	assert.equal(emojiText("[爱心][爱心][爱心]"), "❤️❤️❤️");
});

test("an unknown code is left alone: a wrong guess is worse than brackets", () => {
	assert.equal(emojiText("[不存在的表情]"), "[不存在的表情]");
	assert.equal(emojiText("数组[0] 和 [索引]"), "数组[0] 和 [索引]");
});

test("Feishu's own stickers land on the closest character instead of staying brackets", () => {
	// `[了解]` is Feishu's "Get" sticker: it has no character of its own, and four characters of
	// punctuation in a chat is worse than an emoji that reads as agreement.
	assert.equal(emojiText("[了解]"), "👌");
	assert.equal(emojiText("[马上]"), "🔜");
	assert.equal(emojiText("[比心]"), "🫰");
});

test("the English spelling of a code works too, in either case", () => {
	assert.equal(emojiText("[get]"), "👌");
	assert.equal(emojiText("[GET]"), "👌");
	assert.equal(emojiText("[Thinking]"), "🤔");
});

test("text without a code is returned as it came", () => {
	assert.equal(emojiText("就是普通的一句话"), "就是普通的一句话");
	assert.equal(emojiText(""), "");
	assert.equal(emojiText("a [b"), "a [b");
});

test("a code inside a longer word is not half-replaced", () => {
	assert.equal(emojiText("前缀[赞]后缀"), "前缀👍后缀");
	assert.equal(emojiText("[赞][赞]"), "👍👍");
});

test("an emoji-only message is recognised, a message with words is not", () => {
	assert.equal(onlyEmoji("[赞]"), true);
	assert.equal(onlyEmoji("❤️"), true);
	assert.equal(onlyEmoji("好的[赞]"), false);
	assert.equal(onlyEmoji(""), false);
});

test("every mapped code points at a real emoji, not at another code", () => {
	for (const [code, emoji] of Object.entries(PLATFORM_EMOJI)) {
		assert.match(code, /^\[[^[\]]+\]$/, `${code} is a code`);
		assert.ok(emoji !== "" && !emoji.startsWith("["), `${code} maps to a character`);
	}
	assert.ok(Object.keys(PLATFORM_EMOJI).length >= 120, "the table covers what people actually send");
});
