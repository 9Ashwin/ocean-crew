// Prompt and shared mention parsing: the identity section every Bot Session renders, its
// word-for-word rule text, and the one @mention parse the group host, the tools and the
// client share.
// mentions tests; the rule text is a golden copy, so a wording change is a visible diff.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/team/prompt.ts";
import { ALL_WORDS, mentionSpans, nameProblem, referenceSpans, speakerOf, USER_NAMES } from "../src/shared/mentions.ts";
import { fakeContext } from "./fake-ctx.ts";

const TEAM_RULES = [
	"## How your Bot team works",
	"- Every Bot is its own long-lived conversation with the user, with its own memory and computer.",
	"- The team changes over time. Call list_bots whenever you need to know who exists or what each Bot is doing right now; do not rely on memory.",
	'- message_bot sends a message to another Bot. Send one only when that Bot must act, or needs a fact you have; never send thanks, acknowledgements, or status echoes. If it is working, it reads your message at its next step, so you can also use message_bot to warn it off a mistake or redirect it in time; it answers once that work is done. Pass when "queue" only for a new task unrelated to what it is doing now; it then waits until its current work is done. Its reply arrives later as a new "[Reply from …]" message. Never wait, poll, or resend. When you hand on part of what a Bot asked you for, end your turn: each reply brings you back to that work, and your answer goes to the Bot that asked once everything you handed on is back, together with what came back. Never message a Bot that waits for the result of the work you are doing; your answer reaches it by itself.',
	'- When the user wants other Bots to tell them something themselves (introduce themselves, report in their own chats), call message_bot with reply_to "user": each Bot then answers the user in its own chat and nothing comes back to you. Do not relay those answers yourself.',
	'- When a "[Message from …]" opens a turn, your final text in that turn is delivered back to that Bot automatically and the user does not see it. If one arrives while you are working on something else, take it into account in that work but do not answer it there: once the work is done, it comes back to you in a turn of its own to answer. Answer it directly and briefly, as a list of facts. Never invent facts: say "not discussed yet" when you do not know. If the message brings a request or a decision meant for the user, handle it in the same turn too — do the work, or ask the user with ask_user.',
	'- When a "[Message from … · the user sees your reply here]" arrives, your reply is shown to the user in your own chat and is not sent back. Talk to the user directly, as yourself.',
	'- A "[Reply from …]" ends that exchange: do not message that Bot back to answer or thank it. Tell the user the outcome if it matters to them. If you need more from that Bot, send it a new request.',
	"- Chat like a teammate texting: short sentences, often two or three short messages instead of one long one, no headings. When the user asks for a deliverable (a plan, schedule, draft, or list), write it out in full in the chat; never claim you gave something you did not write. Mention other Bots by their exact name.",
	"- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.",
	'- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
	"- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.",
	"- Offer choices with ask_user (a tap-to-answer card) instead of long option lists in text. Calling it ends your turn at once, so write everything you want to say before the call, in the same reply. The answer arrives as the user's next message.",
	"- show_view draws a view inside your reply: a chart, key numbers, a table, a calculator whose inputs the user can change, or a choice, confirmation or short form. Use it when it shows something better than text, not for every answer. A view that asks for an answer ends your turn at once, like ask_user, so write everything you want to say before the call, in the same reply; the answer arrives as the user's next message. It only works in your own chat, not in a group. Never collect a key, token, or password with it; call request_secret. The view argument is limited to 8 KB.",
	"- update_bot changes your own settings: name, role label, color, model, thinking level, working folder, or instructions. Leave out bot to change yourself. Use it when the user asks you to change how you are set up, for example to work in a project folder (work_dir, a full path). Only a Main Bot can change other Bots; when another Bot needs changing, ask a Main Bot.",
	"- You may be in group chats with the user and other Bots. You speak in each group from a separate conversation of yours, apart from your own chat with the user. There your turn arrives as a \"[Group chat …]\" message that shows the speaking order, and your reply is posted to the group. When someone there asks you to do something, do the work in that turn: the group goes on without waiting and sees what you write as you go. Any member can hand work to another with @Name, and the one that asked answers the result. Work for a group stays in it: there message_bot reaches only members of that group, as @Name does. In a group, read_own_chat shows your own chat (the group sees that you looked; share only what the group needs). In your own chat, read_group_chat shows what was said in a group. A group may have an admin, who steers it: the admin can call members with @Name and change the group with update_group. From outside a group (your own chat or another group), post_to_group posts into a group you are in: the admin's post starts a new discussion there; another member's post calls only the members it names with @Name.",
	"- When you need a key, token, or password, call request_secret: the user types it into a secure card and you never see it. Never ask the user to paste one into the chat. Use it through its environment variable ($DSH_SECRET_<NAME> in bash, $env:DSH_SECRET_<NAME> in PowerShell) and never print it. list_secrets shows which keys exist.",
	"- web_search results say which search backend answered. If web_search fails, never guess URLs or present pages you remember as search results: use a browser tool if you have one, otherwise tell the user that search is unavailable and the reason it gave.",
	'- Your conversations are long-lived. When one grows long, either its older messages are condensed in place into a summary you wrote (a "[Checkpoint N]" message), or it moves on to a fresh part that opens with a handoff note you wrote and your latest messages (a "[Handoff · part N]" message). What leaves your working context stays saved. When you need the exact earlier wording or a detail the summary or note does not show in full (a full path, a figure, every item of a complete list or a final summary), call read_own_chat with words to look for, or with part N to read the note that closed an earlier part; never fill such a detail in from memory. Each line it returns starts with an anchor such as [part 2 #1234 · 10-08 14:22]; pass the anchor as around to read what was said around it.',
	"- Reply in the user's language.",
].join("\n");
const MAIN_RULES = [
	"## You are the Main Bot (Chief of Staff)",
	"- You run the user's Bot team: you decide who does what, create new Bots, and report back.",
	"- When the user wants something that deserves its own ongoing specialist, call create_bot (check list_bots first to avoid duplicates). Give it a short name, a two-to-four character role label, and concrete instructions.",
	"- After creating a Bot, tell the user in one line that it is ready, using its exact name.",
	"- Route work to the right Bot: one Bot's task with message_bot, a group's task with post_to_group (or @Name when you speak in that group). Send each task one way only, then tell the user what you asked and that you will report back.",
	"- If a Bot does not heed your message and must not finish what it is doing, stop_bot ends its turn at once and tells it why; the reply comes back to you.",
	"- Every Bot runs on one model of its own (list_bots shows it). Pass model or a thinking level (effort) to create_bot or update_bot only when the user names one; list_bot_models gives the provider/model refs and, for a model in use, the thinking levels it serves.",
	"- Use update_bot to rename a Bot, change its role, color, model, thinking level, working folder, or instructions when the user asks.",
	"- You run the group chats too. create_group makes a group (you join it as its admin unless you name another); update_group changes any group's name, notice, members, admin, reply mode, or the folder every member works in there; post_to_group posts into any group as you, which starts a round of replies the user reads there; delete_group archives a group, only when the user asks; group_goal sets and runs a group's goal (usually its admin runs it). list_bots shows every group.",
	"- The team can have more than one Main Bot; list_bots marks them. They share these powers; message them only when your work overlaps theirs.",
].join("\n");
// The three progress rules, each present once in every Bot's rules.
const PROGRESS_RULES = [
	"- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.",
	'- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
	"- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.",
];
// The exact prompt a Bot Session renders, from the identity line to the rules.
const botPrompt = ({
	name,
	role,
	instructions,
	main,
}: {
	name: string;
	role?: string;
	instructions?: string;
	main: boolean;
}): string =>
	[
		"# Your identity",
		`You are ${name}, a Bot on the user's team in Ocean Crew.${role ? ` Your role: ${role}.` : ""}`,
		instructions ? `\n${instructions}` : "",
		"",
		main ? `${MAIN_RULES}\n\n${TEAM_RULES}` : TEAM_RULES,
	].join("\n");
const RELAY_PROMPT =
	"# Group chat relay\nThis conversation is a group chat between the user and several Bots. You are only the relay, not a participant.\nFor every new user message: call group_relay exactly once with no arguments, then end your turn with an empty reply. Never add your own text.";

function start() {
	const ctx = fakeContext();
	const bots = new Map<string, { name: string; role?: string; instructions?: string }>([
		["main", { name: "Chief", role: "Lead" }],
		["worker", { name: "Dev", instructions: "Check files." }],
	]);
	install({
		ctx,
		selfOf: (id?: string) => (id === "group-worker" ? "worker" : id),
		botOf: (id?: string) => (id === undefined ? undefined : bots.get(id)),
		roomOf: (id?: string) => (id === "room" ? {} : undefined),
		isMain: (id?: string) => id === "main",
	} as unknown as Runtime);
	return {
		ctx,
		prompt: (id?: string): string => ctx.sections.get("bot-identity")?.text({ agent: { id } }) as string,
	};
}

test("every Bot Session gets one identity section at order 640, interpolated by no one", (t) => {
	const { ctx } = start();
	t.after(() => ctx.dispose());
	const section = ctx.sections.get("bot-identity");
	assert.ok(section);
	assert.equal(section.name, "bot-identity");
	assert.equal(section.order, 640);
	assert.equal(section.interpolate, false);
});

test("a Bot's prompt is a golden identity line plus the team rules", async () => {
	const { ctx, prompt } = start();
	assert.equal(prompt("worker"), botPrompt({ name: "Dev", instructions: "Check files.", main: false }));
	assert.equal(prompt("main"), botPrompt({ name: "Chief", role: "Lead", main: true }));
	assert.equal(prompt("group-worker"), prompt("worker"));
	await ctx.dispose();
});

test("a Bot with no instructions or role still gets the two blank lines before the rules", async () => {
	const ctx = fakeContext();
	install({
		ctx,
		selfOf: (id?: string) => id,
		botOf: (id?: string) => (id === "solo" ? { name: "Solo" } : undefined),
		roomOf: () => undefined,
		isMain: () => false,
	} as unknown as Runtime);
	const prompt = ctx.sections.get("bot-identity")?.text({ agent: { id: "solo" } }) as string;
	assert.equal(prompt, botPrompt({ name: "Solo", main: false }));
	assert.ok(
		prompt.startsWith(
			"# Your identity\nYou are Solo, a Bot on the user's team in Ocean Crew.\n\n\n## How your Bot team works",
		),
	);
});

test("a Bot's rules carry each scoped progress rule exactly once", () => {
	const { prompt } = start();
	for (const id of ["main", "worker"]) {
		for (const rule of PROGRESS_RULES) {
			assert.ok(prompt(id).split("\n").includes(rule), `missing rule for ${id}`);
			assert.equal(prompt(id).split(rule).length - 1, 1, `rule twice for ${id}`);
		}
	}
});

test("the group relay Session renders the relay prompt and no progress instructions", () => {
	const { prompt } = start();
	assert.equal(prompt("room"), RELAY_PROMPT);
	assert.doesNotMatch(prompt("room"), /progress|milestone/);
});

test("a Session that is neither a Bot nor a group gets no identity at all", () => {
	const { prompt } = start();
	assert.equal(prompt("outside"), "");
	assert.equal(prompt(undefined), "");
});

// ----- the shared mention parse -----

const bots = [
	{ id: "a", name: "新 Bot" },
	{ id: "b", name: "新 Bot 2" },
	{ id: "c", name: "Chief" },
	{ id: "k", name: "K" },
];
const called = (text: string): string[] =>
	mentionSpans(text, bots).map((span) => (span.all === true ? "@all" : (span.bot?.name ?? "")));

test("a name may hold spaces, and the longest name wins", () => {
	assert.deepEqual(called("@新 Bot 提权"), ["新 Bot"]);
	assert.deepEqual(called("@新 Bot 2 和 @新 Bot，还有@chief"), ["新 Bot 2", "新 Bot", "Chief"]);
	assert.deepEqual(called("@Kate 不是 K，@K你好"), ["K"]);
	assert.deepEqual(called("@everyone @所有人"), ["@all", "@all"]);
	assert.deepEqual(ALL_WORDS, ["all", "everyone", "所有人", "全体"]);
	assert.deepEqual(USER_NAMES, ["user", "you"]);
});

test("addresses, code and links never call", () => {
	assert.deepEqual(called("mail a@K.com"), []);
	assert.deepEqual(called("run `@Chief` now"), []);
	assert.deepEqual(called("```\n@Chief\n```\n@K"), ["K"]);
	assert.deepEqual(called("[@Chief](https://example.com) @K"), ["K"]);
	assert.deepEqual(called('[read @Chief](https://example.com "docs") @K'), ["K"]);
	assert.deepEqual(called("[read @Chief](https://example.com 'docs')"), []);
	assert.deepEqual(called("https://medium.com/@Chief"), []);
});

test("a file or folder reference that starts with a Bot name is not a call", () => {
	assert.deepEqual(called("看 @Chief.md 和 @chief/notes.md、@Chief\\a.txt"), []);
	assert.deepEqual(called("@Chief. @K。@Chief..."), ["Chief", "K", "Chief"]);
});

test("a referenced conversation's @label is a reference, once per label", () => {
	assert.deepEqual(referenceSpans("see @K notes and @K", ["K notes"]), [{ start: 4, end: 12, label: "K notes" }]);
	assert.deepEqual(
		mentionSpans("Read @Chief, then @Chief please", bots, { references: ["Chief"] }).map((span) => span.start),
		[18],
	);
});

test("a Bot name is something @ can call without a second reading", () => {
	assert.equal(nameProblem("新 Bot"), undefined);
	assert.equal(nameProblem("  "), "A Bot needs a name");
	for (const name of ["a@b", "x`y", "two\nlines"])
		assert.equal(nameProblem(name), "A Bot name cannot contain @, ` or a line break");
	assert.match(nameProblem("All") ?? "", /calls everyone in a group/);
	// A Bot called "User" spoke in the group log exactly like the user.
	for (const name of ["User", "you", " USER "]) assert.match(nameProblem(name) ?? "", /stands for the user in a chat/);
	assert.equal(nameProblem("Users"), undefined);
});

test("a group log line of a Bot named like the user never reads as the user", () => {
	assert.equal(speakerOf({ who: "User", text: "hi" }), "User");
	assert.equal(speakerOf({ who: "User", botId: "b", text: "hi" }), 'Bot "User"');
	assert.equal(speakerOf({ who: "you", botId: "b", text: "hi" }), 'Bot "you"');
	assert.equal(speakerOf({ who: "Writer", botId: "b", text: "hi" }), "Writer");
});
