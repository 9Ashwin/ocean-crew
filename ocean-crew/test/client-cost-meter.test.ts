// The third-party dsh-cost-meter plugin draws a per-turn "本轮费用" line into the
// conversation turn tail. A Bot chat keeps usage on its usage page instead, so the Bot
// surface shadows that slot entry with a component that renders nothing. The plugin stays
// installed and Agent mode keeps its own line, since the replacement lives in the Bot-only
// conversation group.
//
// The registration is asserted from the source rather than rendered: the Bot surface goes
// through DSH's slots API inside apply(), and this process has no DOM, shell or
// dsh-cost-meter. The priority that decides the winner is pure and tested directly.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freePriority, groupsFor } from "../src/client/shell/surface.ts";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(PLUGIN, "src/client/index.ts"), "utf8");

// The source slice of one install group: from its declaration to the closing `];`.
function groupOf(declaration: string): string {
	const start = source.indexOf(declaration);
	assert.ok(start >= 0, `${declaration} is declared`);
	const end = source.indexOf("\n\t];", start);
	assert.ok(end > start, `${declaration} closes`);
	return source.slice(start, end);
}

test("the Bot chat replaces dsh-cost-meter's turn-tail entry with nothing", () => {
	const conversation = groupOf("const installConversation = () => [");
	const registration = conversation.match(
		/shadow\(\s*"conversation\.chat\.turnTail",\s*\{\s*id: "cost-meter-turn",[^}]*\},\s*Nothing,?\s*\)/,
	);
	assert.ok(registration, "the cost-meter entry is shadowed with Nothing");
	// Same id as the third-party registration: the entry is replaced, not added beside it.
	assert.match(registration[0], /id: "cost-meter-turn"/);
	// A priority below the plugin's entry makes this one the one that renders.
	assert.match(registration[0], /priority: BOT_PRIORITY/);
	// The line keeps the plugin's list position, so nothing around it moves.
	assert.match(registration[0], /order: 10/);
});

test("the replacement is part of the Bot-only conversation group, not the shell or Agent mode", () => {
	const conversation = groupOf("const installConversation = () => [");
	assert.match(conversation, /cost-meter-turn/);
	// The shell group is shared with plain Bot views and has its own steps.
	const shell = groupOf("const installShell = () => [");
	assert.doesNotMatch(shell, /cost-meter-turn/);
	// groupsFor mounts the conversation replacements only over a Bot conversation: Agent
	// mode gets the shell's own interface back, and a plain view keeps the shell without
	// the chat replacement, so dsh-cost-meter keeps its line wherever Ocean Crew's chat
	// does not draw the turn.
	assert.deepEqual(groupsFor({ mode: "bot" }), { shell: true, conversation: true });
	assert.deepEqual(groupsFor({ mode: "agent" }), { shell: false, conversation: false });
	assert.deepEqual(groupsFor({ mode: "bot", plain: true }), { shell: true, conversation: false });
});

test("the chosen priority lands strictly below the cost meter's entry", () => {
	// A plugin entry without an explicit priority sits at 0; a lower number renders first,
	// so Ocean Crew's -100 wins the cell.
	assert.equal(
		freePriority([{ options: { id: "cost-meter-turn", priority: 0 } }], {
			id: "cost-meter-turn",
			priority: -100,
		}),
		-100,
	);
	// A plugin that already shadows with a negative priority still loses: the step goes
	// below whatever holds the cell.
	assert.equal(
		freePriority([{ options: { id: "cost-meter-turn", priority: -100 } }], { id: "cost-meter-turn", priority: -100 }),
		-101,
	);
	// Entries in other cells do not drag this one down.
	assert.equal(
		freePriority(
			[{ options: { id: "bot-btw", priority: -1000 } }, { options: { key: "assistant-step", priority: -2000 } }],
			{ id: "cost-meter-turn", priority: -100 },
		),
		-100,
	);
});
