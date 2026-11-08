// The goal-grill skill provider: the bundled skill is listed with its frontmatter
// description, and its body is served without the frontmatter.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { goalProvider, install, parseSkill } from "../src/host/work/goal-skills.ts";

interface Provider {
	name: string;
	list(): Promise<Array<Record<string, any>>>;
	get(item: Record<string, any>): Promise<Record<string, any>>;
}

test("the bundled goal-grill skill is listed with its description and served whole", async () => {
	const provider = goalProvider() as unknown as Provider;
	assert.equal(provider.name, "ocean-crew-goal");
	const [candidate] = await provider.list();
	assert.equal(candidate.name, "goal-grill");
	assert.ok(String(candidate.description).startsWith("Align with the user before writing a group goal"));
	assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
	assert.equal(candidate.provider, "ocean-crew-goal");
	assert.equal(candidate.source, "bundled");
	assert.equal(candidate.rank, 550);
	assert.equal(candidate.resourceBase.kind, "directory");

	const full = await provider.get(candidate);
	assert.equal(full.description, candidate.description);
	assert.ok(String(full.content).startsWith("# Align a goal before you write it"));
	assert.ok(String(full.content).includes("## 4. Write the goal"));
	assert.doesNotMatch(String(full.content), /^---/);
});

test("parseSkill requires the frontmatter description", () => {
	assert.throws(() => parseSkill("# no frontmatter", "x"), /has no description/);
	const parsed = parseSkill("---\nname: a\ndescription: d\n---\nbody", "x");
	assert.deepEqual(parsed, { description: "d", content: "body" });
});

test("install registers the provider with the DSH skills service", () => {
	const registered: Array<() => Provider> = [];
	const ctx = {
		inject(deps: Record<string, unknown>, callback: (ctx: unknown) => void) {
			assert.deepEqual(deps, { skills: null });
			callback({ skills: { registerProvider: (provider: () => Provider) => registered.push(provider) } });
		},
	};
	const rt = { ctx } as unknown as Runtime;
	install(rt);
	assert.equal(registered.length, 1);
	assert.equal(registered[0]().name, "ocean-crew-goal");
});

test("install leaves the plugin untouched without a skills service", () => {
	const rt = { ctx: { get: () => undefined } } as unknown as Runtime;
	assert.doesNotThrow(() => install(rt));
});
