// The pure group helpers: the "@" rule, [PASS], the echoed-name strip, references and
// the idle guard.
// it is covered with the turns tests there).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isIdleRelayText, isPass, mentionsIn, referenceNote, stripOwnName } from "../src/host/groups/index.ts";

const members = ["M", "Mx", "K", "Writer"].map((name) => ({ id: name.toLowerCase(), name }));
const names = ({ all, found }: { all: boolean; found: { name: string }[] }) => ({
	all,
	found: found.map((member) => member.name),
});

test("mentionsIn finds members in order, longest name first", () => {
	assert.deepEqual(names(mentionsIn("@Mx and @M, then @writer", members)), {
		all: false,
		found: ["Mx", "M", "Writer"],
	});
	assert.deepEqual(names(mentionsIn("@K你好 @K again", members)), { all: false, found: ["K"] });
	assert.deepEqual(names(mentionsIn("@Kate is not K", members)), { all: false, found: [] });
	assert.deepEqual(names(mentionsIn("mail a@K.com", members)), { all: false, found: [] });
	assert.deepEqual(names(mentionsIn("@all please, @所有人", members)), { all: true, found: [] });
	assert.deepEqual(names(mentionsIn("@everyone and @M", members)), { all: true, found: ["M"] });
	assert.deepEqual(names(mentionsIn("no mentions", members)), { all: false, found: [] });
});

test("isPass takes empty replies and [PASS] forms", () => {
	for (const text of ["", "[PASS]", " 【pass】 then more", "(pass)", "pass.", "Pass！", "  PASS  "])
		assert.equal(isPass(text), true, text);
	for (const text of ["passing the ball", "I pass on this one", "ok"]) assert.equal(isPass(text), false, text);
});

test('stripOwnName drops an echoed "Name:" prefix', () => {
	assert.equal(stripOwnName("Writer", "Writer: hello"), "hello");
	assert.equal(stripOwnName("Writer", "**Writer**：你好"), "你好");
	assert.equal(stripOwnName("A.b", "A.b: x"), "x");
	assert.equal(stripOwnName("A.b", "Axb: x"), "Axb: x");
	assert.equal(stripOwnName("Writer", "Coder: hi"), "Coder: hi");
});

test("a reference label is not a call, even when it starts with a member's name", () => {
	const references = [{ labels: ["K notes", "K"], text: "" }];
	assert.deepEqual(names(mentionsIn("see @K notes, then @Writer", members, references)), {
		all: false,
		found: ["Writer"],
	});
	assert.deepEqual(names(mentionsIn("@K notes", members)), { all: false, found: ["K"] });
	assert.equal(referenceNote([]), "");
	assert.equal(
		referenceNote([{ text: "A" }, { text: "B" }]),
		"Conversations the user referenced in this round:\n\nA\n\nB",
	);
});

test('a reference takes out only its own "@label", so a typed call with the same text stays', () => {
	const writer = [{ labels: ["Writer"], text: "" }];
	assert.deepEqual(names(mentionsIn("Read @Writer, then @Writer please answer.", members, writer)), {
		all: false,
		found: ["Writer"],
	});
	assert.deepEqual(names(mentionsIn("see @Writer", members, writer)), { all: false, found: [] });
	assert.deepEqual(names(mentionsIn("see @Writer and @Writer", members, [...writer, ...writer])), {
		all: false,
		found: [],
	});
	// "@Kate" is not the reference "K", so the "@K" after it is the one taken out.
	assert.deepEqual(
		names(mentionsIn("@Kate, @K", [...members, { id: "kate", name: "Kate" }], [{ labels: ["K"], text: "" }])),
		{
			all: false,
			found: ["Kate"],
		},
	);
	assert.deepEqual(names(mentionsIn("@K notes and @K", members, [{ labels: ["K notes"], text: "" }])), {
		all: false,
		found: ["K"],
	});
});

test("mentionsIn keeps code and links literal", () => {
	assert.deepEqual(names(mentionsIn("`@M` and [@K](https://example.com) then @Writer", members)), {
		all: false,
		found: ["Writer"],
	});
	assert.deepEqual(names(mentionsIn("```\n@M\n```\n@K", members)), { all: false, found: ["K"] });
});

test("the idle guard reads ack and status posts, but not work talk", () => {
	const everyone = [
		{ id: "chief", name: "Chief" },
		{ id: "writer", name: "Writer" },
	];
	for (const text of [
		"收到",
		"收到，待命",
		"好的，谢谢！",
		"当前暂无待办",
		"Standing by",
		"no new work",
		"waiting for instructions",
	])
		assert.equal(isIdleRelayText(text, everyone, []), true, text);
	for (const text of ["任务", "变化", "文档改好了，在 docs/ 下。", "我检查一下测试。"])
		assert.equal(isIdleRelayText(text, everyone, []), false, text);
	// A repeated body and a body the prior one contains are the ping-pong the guard stops.
	assert.equal(isIdleRelayText("收到，谢谢", everyone, ["收到，谢谢"]), true);
	assert.equal(isIdleRelayText("好的", everyone, ["那就这样，好的"]), true);
	assert.equal(isIdleRelayText("文档", everyone, ["收到"]), false);
});
