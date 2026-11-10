// The user message row: it draws itself, and it shows the companion's mark. What this guards is the
// reason the mark went unseen for a while — a row that needed a module the shipped runtime does not
// have was never drawn at all, so nothing inside it could appear.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/client/chat/user-message.ts", import.meta.url), "utf8");

test("the user row does not depend on a module the runtime may not ship", () => {
	// The desktop runtime has no primitives package; a gate on one of its helpers read false there.
	assert.match(source, /canDrawUserMessages = \(\): boolean => true/);
	assert.doesNotMatch(source, /dsh-client-ui-primitives/);
	// The text is rendered through the shell's factory slot, which every build provides.
	assert.match(source, /renderFactorySlot\?\.\("conversation\.user\.text"/);
});

test("the mark is looked up without the slot's session, and drawn under the bubble", () => {
	// The chat.node contract carries no session, so a lookup that needed one would never find a mark.
	assert.match(source, /for \(const chat of Object\.values\(marks\)\)/);
	assert.match(source, /data\.messageId/);
	assert.match(source, /className: "bt-ureact"/);
	assert.match(source, /\.bt-ureact\{/);
});

test("the row keeps the things a user message carries", () => {
	// Attachments, the via tag, the clock and the quote/copy tools are part of the message the user
	// actually sent; replacing the shipped row must not quietly drop them.
	assert.match(source, /bt-uattach/);
	assert.match(source, /bt-uvia/);
	assert.match(source, /bt-utime/);
	assert.match(source, /bt-utools/);
	assert.match(source, /bt-umention/);
});
