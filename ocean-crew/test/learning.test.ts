// Learning: the review pass' state file, the skill and AGENTS.md proposals, the card
// answer endpoint, and the failure paths the design requires — a failed chat read or
// model call keeps the work queued, a refused approval keeps the card, a saved secret
// never becomes a proposal, and declined ideas are remembered. The review's model call
// (memory.ts's `rt.botShot`) and the conversation record (`rt.partLines`) are stubs, so
// the assertions are about this module's own behaviour.
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { format } from "node:util";
import type { Runtime } from "../src/host/core/runtime.ts";
import {
	agentsAnswer,
	agentsProblem,
	agentsRequest,
	agentsSystem,
	applyEdits,
	hashOf,
	install,
	LEARNING,
	parseJson,
	skillProblem,
	skillRequest,
	skillSystem,
	withoutReviewedAgentsRecords,
} from "../src/host/work/learning.ts";

type R = Runtime & Record<string, any>;

interface Line {
	text: string;
	who: string;
	time?: number;
	seq: number;
}

// A key-shaped value the secret heuristic recognizes, written in parts so the source
// tree itself never holds a token-shaped string.
const A_KEY = ["sk", "live", "abcdefghijklmnopqrstuvwxyz012345"].join("-");

const CREATED = JSON.stringify({
	action: "create",
	name: "release-checks",
	description: "Use when checking a release.",
	content: "Run the release checks.",
	why: "The repeated work showed that the checks need to be kept.",
});
const NONE = JSON.stringify({ action: "none", reason: "This work taught nothing reusable." });
const AGENTS_EDIT = JSON.stringify({
	action: "edit",
	edits: [
		{
			op: "add",
			after: "- Existing rule",
			text: "- Keep the report concise.",
			why: "The user corrected the report format more than once.",
		},
	],
});

interface Options {
	config?: Record<string, unknown>;
	replies?: Array<string | Error>;
	seedCapabilities?: Record<string, any>;
}

interface LearningTest {
	rt: R;
	home: string;
	state: any;
	bots: Record<string, any>;
	replies: Array<string | Error>;
	requests: Array<{ system: string; text: string }>;
	history: Map<string, Line[]>;
	folders: Map<string, string>;
	warnings: string[];
	partLinesFailures: number;
	capabilityFailures: number;
	capabilityEndpointFailures: number;
	learningState: () => any;
	run: () => Promise<number>;
	emit: (name: string, payload: unknown) => void;
	learningView: () => Record<string, any[]>;
}

function runtime(t: { after(fn: () => void | Promise<void>): void }, options: Options = {}): LearningTest {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-learning-"));
	const bots: Record<string, any> = {
		a: {
			id: "a",
			name: "Chief",
			role: "Chief of Staff",
			sessionId: "a",
			instructions: "",
			capabilities: [],
			createdAt: 1,
		},
		b: { id: "b", name: "Writer", role: "Writing", sessionId: "b", instructions: "", capabilities: [], createdAt: 2 },
	};
	const state: any = {
		version: 1,
		mainBotIds: ["a"],
		bots,
		rooms: {},
		agents: {},
		exchanges: [],
		exchangeTurns: {},
		questions: {},
		views: {},
		closedCards: {},
		prefs: {},
		switching: {},
		capabilities: { items: { ...(options.seedCapabilities ?? {}) } },
		revision: 0,
	};
	const replies = [...(options.replies ?? [])];
	const requests: LearningTest["requests"] = [];
	const history = new Map<string, Line[]>();
	const folders = new Map<string, string>();
	const warnings: string[] = [];
	const listeners = new Map<string, Array<(payload: any) => void>>();
	const disposers: Array<() => unknown> = [];
	let saving = Promise.resolve();
	const control = { partLinesFailures: 0, capabilityFailures: 0, capabilityEndpointFailures: 0 };
	const chatOwners = new Map([
		["a", "a"],
		["b", "b"],
	]);
	const rt = {
		home,
		state,
		config: {
			learningTimes: {
				minTurnMs: 0,
				idleMs: 0,
				intervalMs: 0,
				tickMs: 10_000_000,
				...(options.config?.learningTimes as object),
			},
			...(options.config ?? {}),
		},
		ctx: {
			on(name: string, listener: (payload: any) => void) {
				listeners.set(name, [...(listeners.get(name) ?? []), listener]);
				return () => {};
			},
			effect(execute: () => unknown) {
				const dispose = execute();
				if (typeof dispose === "function") disposers.push(dispose as () => unknown);
			},
			sessions: { flush: async () => {} },
			get: () => undefined,
			logger: { warn: () => {} },
		},
		warn: (...args: unknown[]) => warnings.push(format(...args)),
		botOf: (id?: string) => (id === undefined ? undefined : bots[id]),
		chatOf: (id: string) => bots[id]?.sessionId ?? id,
		isBotSession: (id?: string) => id !== undefined && chatOwners.has(id),
		chatOwners,
		readOnly: () => undefined,
		workView: () => ({}),
		uiLanguage: () => undefined,
		resolveAgent: async (sessionId: string) => ({ session: { id: sessionId } }),
		sessionFolder: (session: any) => (session?.id === undefined ? undefined : folders.get(session.id)),
		real: async (path: string) => path,
		workFolder: async () => undefined,
		async *partLines(sessionId: string, _signal: AbortSignal) {
			if (control.partLinesFailures > 0) {
				control.partLinesFailures -= 1;
				throw new Error("chat index unavailable");
			}
			// parts.ts reads the record backwards: newest line first.
			for (const line of [...(history.get(sessionId) ?? [])].sort((one, other) => (other.seq ?? 0) - (one.seq ?? 0)))
				yield line;
		},
		botShot: async (_bot: any, system: string, text: string) => {
			requests.push({ system, text });
			const next = replies.shift();
			if (next instanceof Error) throw next;
			return next ?? NONE;
		},
		redactSecrets: (text: string) => text.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[secret]"),
		capabilitySave: async (body: Record<string, any>) => {
			if (control.capabilityFailures > 0) {
				control.capabilityFailures -= 1;
				throw new Error("the capability list is busy");
			}
			const item = { ...body };
			state.capabilities.items[body.name] = item;
			return item;
		},
		capabilityDelete: async (name: string) => {
			delete state.capabilities.items[name];
			return true;
		},
		capabilityEndpoint: async (endpoint: string, body: Record<string, any>) => {
			if (control.capabilityEndpointFailures > 0) {
				control.capabilityEndpointFailures -= 1;
				throw new Error("the attach was refused");
			}
			if (endpoint === "bot-capability") {
				const bot = bots[body.botId];
				bot.capabilities = [...(bot.capabilities ?? []), body.name];
			}
			return {};
		},
		save: async () => {},
		load: async () => {},
		teamTools: [],
	};
	install(rt as unknown as Runtime);
	t.after(async () => {
		for (const dispose of disposers.splice(0).reverse()) await dispose();
		await saving;
		rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	});
	const learningPath = join(home, "learning", "state.json");
	return {
		rt: rt as unknown as R,
		home,
		state,
		bots,
		replies,
		requests,
		history,
		folders,
		warnings,
		get partLinesFailures() {
			return control.partLinesFailures;
		},
		set partLinesFailures(value: number) {
			control.partLinesFailures = value;
		},
		get capabilityFailures() {
			return control.capabilityFailures;
		},
		set capabilityFailures(value: number) {
			control.capabilityFailures = value;
		},
		get capabilityEndpointFailures() {
			return control.capabilityEndpointFailures;
		},
		set capabilityEndpointFailures(value: number) {
			control.capabilityEndpointFailures = value;
		},
		learningState: () => {
			try {
				return JSON.parse(fs.readFileSync(learningPath, "utf8"));
			} catch {
				return {};
			}
		},
		run: async () => {
			const value = await (rt as unknown as R).learningRun();
			saving = Promise.resolve();
			return value;
		},
		emit: (name, payload) => {
			for (const listener of listeners.get(name) ?? []) listener(payload);
		},
		learningView: () => (rt as unknown as R).learningView() as Record<string, any[]>,
	};
}

const ownChat = (): Line[] => [
	{ who: "user", text: "User: Please review this work", seq: 10 },
	{ who: "bot", text: "Writer: I finished the work.", seq: 11 },
];

const until = async (check: () => boolean): Promise<void> => {
	for (let tries = 0; tries < 200; tries += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("until: the condition did not hold");
};

async function markPending(host: LearningTest, sessionId = "b"): Promise<void> {
	host.emit("agent/status", { agent: { id: sessionId }, status: "running" });
	host.emit("agent/status", { agent: { id: sessionId }, status: "idle" });
	await until(() => (host.learningState().pending?.[sessionId] ?? []).length > 0);
}

const projectFolder = (t: { after(fn: () => void): void }, content: string | null = "# Project\n- Existing rule\n") => {
	const folder = mkdtempSync(join(tmpdir(), "ocean-crew-project-"));
	fs.mkdirSync(join(folder, ".git"));
	if (content !== null) fs.writeFileSync(join(folder, "AGENTS.md"), content);
	t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }));
	return folder;
};

// ---------------------------------------------------------------------------
// The pure helpers.

test("parseJson reads fenced and unfenced objects and ignores garbage", () => {
	assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
	assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
	assert.deepEqual(parseJson('prose {"a":1} after'), { a: 1 });
	assert.equal(parseJson("no object here"), undefined);
	assert.equal(parseJson("[1,2]"), undefined);
	assert.equal(parseJson('{"a":'), undefined);
});

test("agentsProblem validates edit safety and whole-line matches", () => {
	const current = "# Project\n- Existing rule\n";
	assert.equal(agentsProblem({ action: "none" }, current), undefined);
	assert.equal(agentsProblem(undefined, current), "the answer is not a JSON object");
	assert.equal(agentsProblem({ action: "edit", edits: [] }, current), "an edit needs 1 to 3 changes");
	const base = { op: "add" as const, after: "- Existing rule", text: "- New rule", why: "the user said so" };
	assert.equal(agentsProblem({ action: "edit", edits: [base] }, current), undefined);
	assert.match(String(agentsProblem({ action: "edit", edits: [{ ...base, why: "" }] }, current)), /needs a reason/);
	assert.match(
		String(agentsProblem({ action: "edit", edits: [{ ...base, text: `- uses ${A_KEY}` }] }, current)),
		/looks like it holds a secret/,
	);
	assert.match(
		String(agentsProblem({ action: "edit", edits: [{ ...base, after: "- Missing" }] }, current)),
		/anchor must be one exact whole line/,
	);
	assert.match(
		String(
			agentsProblem(
				{ action: "edit", edits: [{ op: "replace", old: "# Project", text: "# Project", why: "w" }] },
				current,
			),
		),
		/change nothing/,
	);
	assert.match(
		String(agentsProblem({ action: "edit", edits: [{ ...base, text: "fix #123" }] }, current)),
		/task number, date, or version/,
	);
});

test("agentsAnswer reads an edit written as the answer and lines apart as edits", () => {
	const current = "one\ntwo\nthree\n";
	const single = agentsAnswer(JSON.stringify({ action: "add", after: "three", text: "four", why: "w" }), current);
	assert.deepEqual(single?.edits?.[0]?.op, "add");
	const replace = agentsAnswer(JSON.stringify({ action: "replace", old: "two", text: "", why: "w" }), current);
	assert.equal(replace?.edits?.[0]?.op, "remove");
	const apart = agentsAnswer(
		JSON.stringify({ action: "edit", edits: [{ op: "remove", old: "one\ntwo", why: "w" }] }),
		"one\nx\ntwo\n",
	);
	assert.equal(apart?.edits?.length, 2);
});

test("applyEdits supports end and anchored add, replace, remove and a new file", () => {
	assert.equal(applyEdits(undefined, [{ op: "add", text: "a\nb" }]), "a\nb\n");
	assert.equal(applyEdits("a\nb\n", [{ op: "add", text: "c" }]), "a\nb\nc\n");
	assert.equal(applyEdits("a\nb\n", [{ op: "add", after: "a", text: "x" }]), "a\nx\nb\n");
	assert.equal(applyEdits("a\nb\n", [{ op: "replace", old: "b", text: "c" }]), "a\nc\n");
	assert.equal(applyEdits("a\nb\n", [{ op: "remove", old: "a" }]), "b\n");
	assert.equal(applyEdits("a\r\nb\r\n", [{ op: "add", after: "a", text: "c" }]), "a\r\nc\r\nb\r\n");
	assert.throws(() => applyEdits(undefined, [{ op: "add", after: "a", text: "b" }]), /only add at the end/);
	assert.throws(() => applyEdits("a\na\n", [{ op: "replace", old: "a", text: "b" }]), /must occur once/);
});

test("skillProblem validates actions, learned-skill limits and secret-looking content", () => {
	const skills: Record<string, any> = {
		"release-checks": { name: "release-checks", kind: "skill", description: "d", content: "c" },
	};
	const learned = ["release-checks"];
	const good = { action: "create", name: "weekly-report", description: "d", content: "c", why: "w" };
	assert.equal(skillProblem(good, { skills, learned: [] }), undefined);
	assert.equal(
		skillProblem({ ...good, name: "release-checks" }, { skills, learned }),
		"release-checks already exists",
	);
	assert.equal(skillProblem({ ...good, action: "keep" } as any, { skills, learned }), "unknown action keep");
	assert.equal(skillProblem({ action: "none" }, { skills, learned }), undefined);
	assert.match(String(skillProblem({ ...good, content: A_KEY }, { skills, learned: [] })), /secret/);
	assert.match(
		String(skillProblem({ ...good, action: "update", name: "other" }, { skills, learned })),
		/is not a learned skill of this Bot/,
	);
});

test("withoutReviewedAgentsRecords drops the records a review has read", () => {
	const records = [
		{ botId: "b", text: "one", order: 1 },
		{ botId: "b", text: "two", order: 2 },
		{ botId: "b", text: "three", order: 3 },
	];
	assert.deepEqual(
		withoutReviewedAgentsRecords(records, [1, 2]).map((record) => record.text),
		["three"],
	);
});

test("the review systems describe the skill and AGENTS.md rules", () => {
	assert.match(skillSystem(), /You review a stretch of finished work/);
	assert.match(skillSystem(), /\{"action":"none"/);
	assert.match(agentsSystem(), /AGENTS\.md/);
	assert.match(agentsSystem(), /\{"action":"edit"/);
	const request = skillRequest({ bot: { name: "Writer", role: "Writing" }, lines: ["User: hi"], language: "English" });
	assert.match(request, /The Bot: Writer, Writing\./);
	assert.match(request, /This Bot has no learned skills yet/);
	assert.match(request, /Write the description and the content in English/);
	const agents = agentsRequest({ folder: "/p", current: "# P", lines: ["one"], declined: [], language: "English" });
	assert.match(agents, /Project folder: \/p/);
	assert.match(agents, /Current AGENTS.md:/);
	assert.match(agents, /The user writes in English/);
});

// ---------------------------------------------------------------------------
// The pass.

test("a long turn marks the chat; the pass makes a skill proposal from the answer", async (t) => {
	const host = runtime(t, { replies: [CREATED] });
	host.history.set("b", ownChat());
	await markPending(host);
	// The turn marker is written to the learning state under home.
	const pending = host.learningState().pending;
	assert.deepEqual(pending, { b: ["b"] });

	assert.equal(await host.run(), 1);
	const proposals = host.learningView().b;
	assert.equal(proposals.length, 1);
	assert.deepEqual(
		[proposals[0].kind, proposals[0].action, proposals[0].name, proposals[0].botId],
		["skill", "create", "release-checks", "b"],
	);
	assert.match(host.requests[0].system, /You review a stretch of finished work/);
	assert.match(host.requests[0].text, /User: Please review this work/);
	assert.match(host.requests[0].text, /Writer: I finished the work\./);

	// Approving stores the skill in the capability library and attaches it to the Bot.
	assert.deepEqual(await host.rt.learningEndpoint("learning-answer", { id: proposals[0].id, approve: true }), {
		applied: true,
	});
	assert.equal(host.state.capabilities.items["release-checks"].kind, "skill");
	assert.ok(host.bots.b.capabilities.includes("release-checks"));
	assert.equal(host.learningView().b, undefined);
	const settled = host.rt.learningSettledView().b;
	assert.deepEqual([settled[0].outcome, settled[0].sessionId], ["approved", "b"]);
});

test("a none answer makes no proposal and advances the read cursor", async (t) => {
	const host = runtime(t, { replies: [NONE] });
	host.history.set("b", ownChat());
	await markPending(host);
	assert.equal(await host.run(), 0);
	assert.equal(host.learningView().b, undefined);
	assert.equal(host.learningState().cursors.b, 11);
	// The same lines are not read again.
	await host.run();
	assert.equal(host.requests.length, 1);
});

test("a declined proposal is remembered and never proposed again silently", async (t) => {
	const host = runtime(t, { replies: [CREATED, NONE] });
	host.history.set("b", ownChat());
	await markPending(host);
	await host.run();
	const [proposal] = host.learningView().b;
	assert.deepEqual(await host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: false }), {
		applied: false,
	});
	assert.deepEqual(
		host.learningState().declined.map((entry: any) => entry.name),
		["release-checks"],
	);
	// New work comes in: the next review says what was declined.
	host.history.set("b", [
		...ownChat(),
		{ who: "user", text: "User: Please review the release", seq: 12 },
		{ who: "bot", text: "Writer: Done.", seq: 13 },
	]);
	await markPending(host);
	await host.run();
	assert.match(host.requests.at(-1)?.text ?? "", /Proposals the user declined/);
	assert.match(host.requests.at(-1)?.text ?? "", /release-checks/);
});

test("a failed chat read keeps the Bot pending for the next pass", async (t) => {
	const host = runtime(t, { replies: [CREATED] });
	host.history.set("b", ownChat());
	host.partLinesFailures = 1;
	await markPending(host);
	assert.equal(await host.run(), 0);
	assert.ok(host.warnings.some((line) => line.includes("learning review of Writer failed")));
	assert.deepEqual(host.learningState().pending, { b: ["b"] });
	// The next pass reads the chat and makes the proposal.
	await host.run();
	assert.equal(host.learningView().b.length, 1);
	assert.deepEqual(host.learningState().pending, {});
});

test("a saved secret never becomes a proposal", async (t) => {
	const host = runtime(t, {
		replies: [JSON.stringify({ ...JSON.parse(CREATED), content: `The key is ${A_KEY}.` })],
	});
	host.history.set("b", ownChat());
	await markPending(host);
	assert.equal(await host.run(), 0);
	assert.equal(host.learningView().b, undefined);
	assert.ok(host.warnings.some((line) => line.includes("proposed content containing a saved secret")));
});

test("a refused approval keeps the card, so the user can still decline it", async (t) => {
	const host = runtime(t, { replies: [CREATED] });
	host.history.set("b", ownChat());
	await markPending(host);
	await host.run();
	const [proposal] = host.learningView().b;
	host.capabilityFailures = 1;
	await assert.rejects(
		host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: true }),
		/capability list is busy/,
	);
	assert.equal(host.learningView().b.length, 1);
	// The retry succeeds: the proposal was saved once and is not saved again.
	assert.deepEqual(await host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: true }), {
		applied: true,
	});
	assert.ok(host.bots.b.capabilities.includes("release-checks"));
});

test("an answered card from an earlier chat part is not shown in the current one", async (t) => {
	const host = runtime(t, { replies: [CREATED] });
	host.history.set("b", ownChat());
	await markPending(host);
	await host.run();
	const [proposal] = host.learningView().b;
	await host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: true });
	// The Bot's chat moves on to a fresh part.
	host.bots.b.sessionId = "b2";
	assert.equal(host.rt.learningSettledView().b, undefined);
	assert.equal(host.rt.learningView().b, undefined);
});

test("an unknown answer endpoint is refused, and learning can be turned off", async (t) => {
	const host = runtime(t);
	await assert.rejects(host.rt.learningEndpoint("learning-nothing", {}), /Unknown endpoint learning-nothing/);
	const off = runtime(t, { config: { learning: false } });
	assert.deepEqual(off.learningView(), {});
	assert.deepEqual(off.rt.learningSettledView(), {});
	await assert.rejects(off.rt.learningEndpoint("learning-answer", {}), /Learning is turned off on this host/);
	assert.equal(await off.rt.learningRun(), 0);
});

test("approving a created skill is idempotent when the attach failed after the save", async (t) => {
	const host = runtime(t, { replies: [CREATED] });
	host.history.set("b", ownChat());
	await markPending(host);
	await host.run();
	const [proposal] = host.learningView().b;
	host.capabilityEndpointFailures = 1;
	await assert.rejects(
		host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: true }),
		/the attach was refused/,
	);
	// The skill was saved and is already learned; the retry only attaches it.
	assert.equal(host.state.capabilities.items["release-checks"].kind, "skill");
	assert.deepEqual(host.learningState().learned.b, ["release-checks"]);
	assert.deepEqual(await host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: true }), {
		applied: true,
	});
	assert.ok(host.bots.b.capabilities.includes("release-checks"));
});

test("a learned skill removed from the library is no longer learned", async (t) => {
	const host = runtime(t, { replies: [CREATED] });
	host.history.set("b", ownChat());
	await markPending(host);
	await host.run();
	const [proposal] = host.learningView().b;
	await host.rt.learningEndpoint("learning-answer", { id: proposal.id, approve: true });
	assert.deepEqual(host.learningState().learned.b, ["release-checks"]);
	await host.rt.capabilityDelete("release-checks", { botId: "b", ui: false });
	assert.deepEqual(host.learningState().learned.b, []);
});

// ---------------------------------------------------------------------------
// AGENTS.md reviews.

test("a Git folder with pending work gets one AGENTS proposal and approval writes it", async (t) => {
	const folder = projectFolder(t);
	const host = runtime(t, { replies: [NONE, AGENTS_EDIT] });
	host.history.set("b", ownChat());
	host.folders.set("b", folder);
	await markPending(host);
	assert.equal(await host.run(), 1);
	const proposals = host.learningView().b;
	const agents = proposals.find((proposal) => proposal.kind === "agents");
	assert.notEqual(agents, undefined);
	assert.equal(agents?.folder, folder);
	assert.equal(agents?.path, join(folder, "AGENTS.md"));
	assert.equal(agents?.base, hashOf("# Project\n- Existing rule\n"));
	assert.match(
		host.requests[1].system,
		/You review a stretch of finished work that AI Bots did in one project folder/,
	);
	assert.match(host.requests[1].text, /# Project/);

	assert.deepEqual(await host.rt.learningEndpoint("learning-answer", { id: agents?.id, approve: true }), {
		applied: true,
	});
	assert.equal(
		fs.readFileSync(join(folder, "AGENTS.md"), "utf8"),
		"# Project\n- Existing rule\n- Keep the report concise.\n",
	);
	assert.equal(host.learningView().b, undefined);
});

test("a failed AGENTS model call keeps its folder work for the next pass", async (t) => {
	const folder = projectFolder(t);
	const host = runtime(t, { replies: [NONE, new Error("model refused")] });
	host.history.set("b", ownChat());
	host.folders.set("b", folder);
	await markPending(host);
	assert.equal(await host.run(), 0);
	assert.ok(host.warnings.some((line) => line.includes("AGENTS.md review")));
	assert.notEqual(host.learningState().agentsPending[folder], undefined);
	// The next pass reviews the queued work and proposes the edit.
	host.replies.push(AGENTS_EDIT);
	assert.equal(await host.run(), 1);
	assert.equal(host.learningView().b.filter((proposal) => proposal.kind === "agents").length, 1);
});

test("agentsMd false keeps folder queues and does not review folders", async (t) => {
	const folder = projectFolder(t);
	const host = runtime(t, { replies: [NONE], config: { agentsMd: false } });
	host.history.set("b", ownChat());
	host.folders.set("b", folder);
	await markPending(host);
	assert.equal(await host.run(), 0);
	assert.deepEqual(host.learningState().agentsPending, {});
	assert.equal(host.requests.length, 1);
});

test("a declined AGENTS edit is included in the next folder request", async (t) => {
	const folder = projectFolder(t);
	const host = runtime(t, { replies: [NONE, AGENTS_EDIT] });
	host.history.set("b", ownChat());
	host.folders.set("b", folder);
	await markPending(host);
	await host.run();
	const agents = host.learningView().b.find((proposal) => proposal.kind === "agents");
	await host.rt.learningEndpoint("learning-answer", { id: agents?.id, approve: false });
	assert.equal(host.learningState().declined[0].kind, "agents");
	// New work in the same folder: the request names the turned-down change.
	host.history.set("b", [
		...ownChat(),
		{ who: "user", text: "User: More work", seq: 12 },
		{ who: "bot", text: "Writer: done", seq: 13 },
	]);
	host.replies.push(AGENTS_EDIT);
	await markPending(host);
	await host.run();
	assert.match(host.requests.at(-1)?.text ?? "", /Changes the user turned down before/);
});

test("user corrections stay in long chat reviews after the text budget", async (t) => {
	const host = runtime(t, { replies: [NONE] });
	const lines: Line[] = [];
	for (let index = 0; index < 30; index += 1) {
		lines.push({ who: "bot", text: `Bot ${index}: ${"x".repeat(LEARNING.botLineMax)}`, seq: index + 1 });
	}
	lines.push({ who: "user", text: "User: this is the correction that matters", seq: 40 });
	host.history.set("b", lines);
	await markPending(host);
	await host.run();
	const request = host.requests.at(-1)?.text ?? "";
	assert.match(request, /this is the correction that matters/);
	assert.ok(request.length <= LEARNING.textMax + LEARNING.userTextMax + 2_000);
});
