// Group relay result rendering: reading a settled group_relay result back into the
// group's conversation rows, including what survives a compaction-pruned tool result.

// cases for parseReplies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReplies, type RelayReply, stackReplies } from "../src/shared/group-replies.ts";

test("a member's messages in a row stack under its name, and an event line starts a new block", () => {
	const replies: RelayReply[] = [
		{ botId: "writer", text: "a", time: 10, duration: 1000 },
		{ botId: "writer", text: "b", time: 20, duration: 2000 },
		{ kind: "working", botId: "writer", time: 30 },
		{ botId: "writer", text: "c", time: 40, duration: 4000 },
		{ botId: "chief", text: "d", time: 50, duration: 5000 },
		{ botId: "writer", text: "e", time: 60, duration: 6000 },
	];
	assert.deepEqual(JSON.parse(JSON.stringify(stackReplies(replies).map((item) => [item.index, item.texts]))), [
		[0, ["a", "b"]],
		[2, []],
		[3, ["c"]],
		[4, ["d"]],
		[5, ["e"]],
	]);
	// A stacked block carries its last message's time and how long that turn ran.
	const [stacked, event, single] = stackReplies(replies);
	assert.deepEqual([stacked.time, stacked.duration], [20, 2000]);
	assert.deepEqual([event.time, event.duration], [30, undefined]);
	assert.deepEqual([single.time, single.duration], [40, 4000]);
});

test("a settled result's replies parse whole, with no repair", () => {
	const text = JSON.stringify({
		replies: [
			{ botId: "writer", name: "Writer", text: "Draft is up.", time: 10 },
			{ kind: "working", botId: "writer", name: "Writer", time: 11 },
			{ kind: "user", text: "Thanks", time: 12 },
		],
	});
	const parsed = parseReplies(text);
	assert.equal(parsed.broken, false);
	assert.deepEqual(
		parsed.replies.map((reply) => [reply.kind ?? "post", reply.text]),
		[
			["post", "Draft is up."],
			["working", undefined],
			["user", "Thanks"],
		],
	);
	// No replies key still parses as an empty round.
	assert.deepEqual(parseReplies("{}"), { replies: [], broken: false });
});

test("a pruned result recovers every complete reply object around the gap", () => {
	const pruned =
		'{"replies":[{"botId":"writer","name":"Writer","text":"one","time":1},[... tool result middle pruned ...]{"botId":"writer","name":"Writer","text":"three","time":3},{"botId":"chief","name":"Chief","text":"four","time":4}]}';
	const parsed = parseReplies(pruned);
	assert.equal(parsed.broken, true);
	assert.deepEqual(
		parsed.replies.map((reply) => reply.text),
		["one", "three", "four"],
	);
});

test("a cut that starts inside a string still recovers replies after it", () => {
	// The pruned marker can fall inside a string value; the fragment before the first
	// complete object keeps the scanner inside quotes, so scanning restarts at '{"'.
	const pruned =
		'{"replies":[{"botId":"writer","text":"kept","time":1},[... tool result middle pruned ...]and a broken string "tail {"botId":"chief","text":"recovered","time":2}]}';
	const parsed = parseReplies(pruned);
	assert.equal(parsed.broken, true);
	assert.deepEqual(
		parsed.replies.map((reply) => reply.text),
		["kept", "recovered"],
	);
});

test("invalid text without a replies head recovers nothing and says it is broken", () => {
	assert.deepEqual(parseReplies("not json at all"), { replies: [], broken: true });
	// A partial object never counts as a reply.
	assert.deepEqual(parseReplies('{"replies":[{"botId":"writer","text":"half'), { replies: [], broken: true });
});
