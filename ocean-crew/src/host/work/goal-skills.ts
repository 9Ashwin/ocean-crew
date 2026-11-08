// The ocean-crew goal skill `goal-grill`: how the admin aligns a group goal with the
// user before writing it. Registered when a DSH `skills` service exists, like the Office
// skills, so the plugin runs the same everywhere.
//

// `skills/goal-grill/SKILL.md` from disk;

// provider shape. At integration, replace SKILL_MARKDOWN with a read of the asset file
// and keep LOCATOR pointing at it.

import type { Runtime } from "../core/runtime.ts";

const PROVIDER = "ocean-crew-goal";
const SKILL = "goal-grill";
const LOCATOR = `skills/${SKILL}/SKILL.md`;
const DIRECTORY = `skills/${SKILL}`;

// frontmatter is parsed below exactly as the file's is).
const SKILL_MARKDOWN = `---
name: goal-grill
description: Align with the user before writing a group goal — find the facts yourself, ask only the open decisions in one numbered round with a recommended answer each, then write the goal with checks and stages.
---

# Align a goal before you write it

A goal runs for a long time. A wrong guess at the start costs every stage after it. Settle what the user wants first, and spend as little of their time as you can.

## 1. Find the facts yourself

Facts are your job; decisions are the user's. Before you ask anything, look it up: read the files, the code, the earlier chat and the records you can reach, or ask a member of the group with @Name to check. Never ask the user something you could look up.

## 2. Map what is still open

Write down the choices the goal depends on: scope, what "done" means, how to check it, limits on time, cost, tools or folders, and who does what. Some choices only make sense once others are made; ask only the ones whose earlier choices are settled. Leave out what does not change the plan.

## 3. Ask one round

Ask the open choices in one message. Number them. For each, say what you recommend and why in one line, and the other options in a few words, so the user can answer "all as recommended" or "2: B". Do not ask more than you need. When nothing is open, skip this step.

If the answers open new choices, ask one more short round. Stop asking once the plan is clear.

## 4. Write the goal

Call group_goal start with:

- objective: the one outcome, in the user's terms;
- acceptance: how anyone can check it is done — commands or tests to run, files or results to look at, what evidence to show;
- constraints: the rules every member keeps, including what the user ruled out;
- stages in order: each small enough to check on its own, with its own acceptance and its tasks, each task for one member by name. Give review work to a member who did not do the work.

Then hand out the tasks of stage 1 with @Name in the same reply.

## While the goal runs

When the user corrects the direction, write it into the goal with group_goal revise before you go on, and tell the group what changed.
`;

interface SkillMetadata {
	description: string;
	content: string;
}

export interface SkillCandidate {
	name: string;
	description: string;
	invocation: { modelInvocable: boolean; userInvocable: boolean };
	provider: string;
	source: "bundled";
	rank: number;
	resourceBase: { kind: "directory"; path: string };
	locator: string;
}

export interface SkillProvider {
	name: string;
	list(): Promise<SkillCandidate[]>;
	get(item: SkillCandidate): Promise<SkillCandidate & SkillMetadata>;
}

// The frontmatter is a small block of `key: value` lines between `---` fences; only

export function parseSkill(raw: string, path: string): SkillMetadata {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	const metadata: Record<string, string> = frontmatter?.[1]
		? Object.fromEntries(
				frontmatter[1]
					.split("\n")
					.map((line) => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? [])
					.filter((parts): parts is [string, string] => parts.length === 2),
			)
		: {};
	if (typeof metadata.description !== "string" || metadata.description.length === 0)
		throw new Error(`${PROVIDER}: ${path} has no description`);
	return { description: metadata.description, content: raw.slice(frontmatter?.[0].length ?? 0).trim() };
}

function candidate(): SkillCandidate {
	const { description } = parseSkill(SKILL_MARKDOWN, LOCATOR);
	return {
		name: SKILL,
		description,
		invocation: { modelInvocable: true, userInvocable: true },
		provider: PROVIDER,
		source: "bundled",
		rank: 550,
		resourceBase: { kind: "directory", path: DIRECTORY },
		locator: LOCATOR,
	};
}

export function goalProvider(): SkillProvider {
	const all = [candidate()];
	return {
		name: PROVIDER,
		list: () => Promise.resolve(all),
		async get(item: SkillCandidate) {
			const { description, content } = parseSkill(SKILL_MARKDOWN, item.locator);
			return { ...item, description, content };
		},
	};
}

export function install(rt: Runtime): void {
	// The DSH plugin context exposes `inject` for optional services; without a skills
	// service there is nothing to register, and the plugin still runs the same.
	rt.ctx.inject?.(
		{ skills: null },
		(ctx: { skills?: { registerProvider(provider: () => SkillProvider): unknown } }) => {
			ctx.skills?.registerProvider(() => goalProvider());
		},
	);
}
