// Event-triggered routines: what counts as a match, and what the Bot is asked when one fires. A
// routine reuses the scheduled-task framing, so the same silence and run-record rules apply.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { fireRoutine, ROUTINES, type Routine, routinesOf, routineText } from "../src/host/work/routines.ts";
import { emptyTeam } from "../src/shared/state.ts";

function setup() {
	const saved: number[] = [];
	const rt: any = {
		state: emptyTeam(),
		load: async () => {},
		save: async () => {
			saved.push(Date.now());
		},
		botOf: (id: string) => (id === "dev" ? { id: "dev", name: "Dev" } : undefined),
		chatOf: (id: string) => (id === "dev" ? "s-dev" : undefined),
		agentOf: async () => undefined,
		warn: () => {},
	} as unknown as Runtime;
	return { rt, routines: routinesOf(rt as Runtime), saved };
}

test("an im keyword routine matches on the words it was given", async () => {
	const { routines } = setup();
	await routines.create({
		botId: "dev",
		name: "deploy watch",
		prompt: "check the deploy",
		trigger: { kind: "im_keyword", words: ["deploy", "上线"] },
		windowMinutes: 30,
	});
	assert.equal(routines.matchText("we will deploy tonight", 1).length, 1);
	assert.equal(routines.matchText("上线了", 1).length, 1);
	assert.equal(routines.matchText("nothing here", 1).length, 0);
});

test("a routine can listen in one chat only", async () => {
	const { routines } = setup();
	await routines.create({
		botId: "dev",
		name: "ops only",
		prompt: "look",
		trigger: { kind: "im_keyword", words: ["deploy"], chat: "oc_ops" },
		windowMinutes: 60,
	});
	assert.equal(routines.matchesMessage("deploy now", "oc_ops").length, 1);
	assert.equal(routines.matchesMessage("deploy now", "oc_other").length, 0, "another chat is not this routine");
});

test("a routine with no words never matches anything", async () => {
	const { routines } = setup();
	await routines.create({
		botId: "dev",
		name: "empty",
		prompt: "x",
		trigger: { kind: "im_keyword", words: [] },
		windowMinutes: 5,
	});
	assert.equal(routines.matchesMessage("anything at all", "c1").length, 0);
});

test("a disabled routine never fires, and removing one is permanent", async () => {
	const { routines } = setup();
	const made = await routines.create({
		botId: "dev",
		name: "off",
		prompt: "x",
		trigger: { kind: "im_keyword", words: ["hello"] },
		windowMinutes: 5,
		enabled: false,
	});
	assert.equal(routines.matchText("hello", 1).length, 0);
	await routines.create({
		botId: "dev",
		name: "on",
		prompt: "y",
		trigger: { kind: "im_keyword", words: ["hello"] },
		windowMinutes: 5,
	});
	assert.equal(routines.matchText("hello", 1).length, 1);
	assert.equal(await routines.remove(made.id), true);
	assert.equal(await routines.remove(made.id), false);
	assert.equal(routines.list().length, 1);
});

test("a routine with no Bot or no prompt is refused", async () => {
	const { routines } = setup();
	await assert.rejects(
		() =>
			routines.create({
				botId: "nobody",
				name: "x",
				prompt: "y",
				trigger: { kind: "im_keyword", words: ["a"] },
				windowMinutes: 5,
			}),
		/No such Bot/,
	);
	await assert.rejects(
		() =>
			routines.create({
				botId: "dev",
				name: "x",
				prompt: "  ",
				trigger: { kind: "im_keyword", words: ["a"] },
				windowMinutes: 5,
			}),
		/Say what the Bot should do/,
	);
});

test("the turn a routine opens is framed like a scheduled task and may be silenced", async () => {
	const routine: Routine = {
		id: "r1",
		botId: "dev",
		name: "ana",
		prompt: "read the mail and tell me what matters",
		trigger: { kind: "im_keyword", words: ["ana"] },
		windowMinutes: 60,
		enabled: true,
		createdAt: 1,
	};
	const text = routineText(routine, { summary: "mail from Ana — Q3 numbers", at: 2 });
	assert.match(text, /^\[Scheduled task\] read the mail/);
	assert.match(text, /What triggered it: mail from Ana/);
	assert.match(text, /reply \[PASS\]/, "a routine that finds nothing stays quiet");
});

test("firing without a live Bot answers false instead of throwing", async () => {
	const { rt } = setup();
	const routine = {
		id: "r1",
		botId: "dev",
		name: "x",
		prompt: "y",
		trigger: { kind: "im_keyword" as const, words: ["a"] },
		windowMinutes: 5,
		enabled: true,
		createdAt: 1,
	};
	assert.equal(await fireRoutine(rt as Runtime, routine, { summary: "s", at: 1 }), false);
	assert.ok((rt.state as any)[ROUTINES] === undefined, "nothing was written by a failed fire");
});
