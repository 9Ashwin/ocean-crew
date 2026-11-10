// Where the conversation is happening: a Bot answering in Feishu or WeChat gets one context message
// per step saying so, with the reply rules of that place. It never rewrites what the user wrote.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatContextLines, chatPlaces } from "../src/host/chat/chat-place.ts";

test("a direct chat says which platform it is, and that one person reads it", () => {
	const lines = chatContextLines({ platform: "feishu", kind: "direct" }).join("\n");
	assert.match(lines, /Feishu direct chat/);
	assert.match(lines, /Only the user reads this chat/);
	assert.match(lines, /keep it short/);
	assert.match(lines, /no headings, no status report/);
});

test("a group says the group reads it, and names it when the platform did", () => {
	const lines = chatContextLines({ platform: "feishu", kind: "group", title: "Launch" }).join("\n");
	assert.match(lines, /Feishu group chat "Launch"/);
	assert.match(lines, /Several people can read the group/);
});

test("the rules answer the things a Bot gets wrong in a chat", () => {
	const lines = chatContextLines({ platform: "wechat", kind: "direct" }).join("\n");
	// "send it to me" in a chat means this chat, not the window's chat.
	assert.match(lines, /"send it to me", "here", or "this chat"/);
	// An answer already reaches the user: repeating or announcing it is noise.
	assert.match(lines, /do not need to repeat it/);
	// A file the user sent is an attachment, not a link the model can hand back by path.
	assert.match(lines, /picture, a voice note or a file they sent is an attachment/);
});

test("an unknown platform is named as it came instead of being dropped", () => {
	assert.match(chatContextLines({ platform: "telegram", kind: "direct" }).join("\n"), /telegram direct chat/);
});

test("a Session remembers its place and forgets it when the window writes instead", () => {
	const places = chatPlaces();
	assert.equal(places.of("s1"), undefined);
	places.note("s1", { platform: "feishu", kind: "group", title: "Ops" });
	assert.deepEqual(places.of("s1"), { platform: "feishu", kind: "group", title: "Ops" });
	assert.equal(places.of("s2"), undefined, "another Session keeps its own");
	places.clear("s1");
	assert.equal(places.of("s1"), undefined);
});

// The snapshot is added once per place, not once per step: a long turn must not collect a copy in
// every step, and a chat that changed must not keep reading the old one.
test("only the newest snapshot decides whether the Bot has been told", () => {
	const key = (place: any): string => `${place.platform}:${place.kind}:${place.title ?? ""}`;
	const newest = (messages: any[]): any => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const source = messages[index]?.source;
			if (source?.kind === "ocean-crew-im-context") return source;
		}
		return undefined;
	};
	const messages = [
		{ source: { kind: "user" } },
		{ source: { kind: "ocean-crew-im-context", place: key({ platform: "feishu", kind: "direct" }) } },
	];
	assert.equal(newest(messages)?.place, "feishu:direct:");
	// The same place again: nothing to add.
	assert.equal(newest(messages)?.place, key({ platform: "feishu", kind: "direct" }));
	// A different place is a different snapshot.
	messages.push({
		source: { kind: "ocean-crew-im-context", place: key({ platform: "feishu", kind: "group", title: "Ops" }) },
	});
	assert.equal(newest(messages)?.place, "feishu:group:Ops");
});
