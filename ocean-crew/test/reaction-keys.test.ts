// The companion's mark, as a chat platform needs it: an emoji character is the window's currency,
// and a platform takes its own key. A mark with no key is not sent, because a refused reaction must
// never look like one that worked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FEISHU_REACTIONS, reactionKey } from "../src/host/im/reaction-keys.ts";
import { COMPANION_REACTIONS } from "../src/shared/companion.ts";

test("every mark the companion can choose has a Feishu key", () => {
	// A mark with no key would silently never appear in Feishu, which is the bug this guards.
	for (const entry of COMPANION_REACTIONS) assert.ok(FEISHU_REACTIONS[entry.emoji], `${entry.emoji} has a Feishu key`);
});

test("a key is returned for a known mark and nothing for an unknown one", () => {
	assert.equal(reactionKey("❤️"), "HEART");
	assert.equal(reactionKey("🤔"), "THINKING");
	assert.equal(reactionKey("🦄"), undefined, "no invented key");
	assert.equal(reactionKey(""), undefined);
	assert.equal(reactionKey(" HEART "), undefined, "a key is not an emoji");
});

test("the keys are the service's own spelling: no spaces, no lower case", () => {
	const keys = Object.values(FEISHU_REACTIONS);
	assert.equal(new Set(keys).size, keys.length, "no two marks share a key");
	for (const key of keys) assert.match(key, /^[A-Z]+$/, key);
});
