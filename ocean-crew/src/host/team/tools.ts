// Team tools: the roster, bot-to-bot messages, group chat settings and posts, and the
// question and view cards. Group rounds and chat reading are in the groups module; this
// module owns what every Bot Session may do on the user's team, and its scope.
//
// Two parts of it come from packages or

// - deep-view's `show_view` wording and parameter schema are inlined, as the JavaScript
//   build takes them from that dependency, so the model-visible contract stays word for
//   word; the blueprint validation itself is the minimal local shape check until the

// - avatar.js `readAvatar` and links.js `absoluteLinks`: avatar reading asks `rt` for
//   the module and refuses clearly when it is absent; `absoluteLinks` prefers a module
//   that published it on `rt`, else uses the same pure implementation.
// One intentional internal fix: a tool added by addTeamTool after the first scoping now

// registered until the whole scope lifted; no caller depended on that).

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool as defineDshTool } from "@deepseek-ai/dsh-tools";
import { mentionSpans } from "../../shared/mentions.ts";
import type { Bot, Room } from "../../shared/state.ts";
import { COLORS, EXTRA_COLORS, MESSAGE_INLINE_MAX, ROOM_MODES, SOURCE_KIND } from "../core/constants.ts";
import { listenGlobal } from "../core/events.ts";
import { within } from "../core/folders.ts";
import { absoluteLinks } from "../core/links.ts";
import type { Runtime, TeamTool } from "../core/runtime.ts";
import { unquote } from "../core/text.ts";

// The same bound requests.ts publishes (`NAME_MAX`); a request name beyond it is a
// mistake, not an identity.
const NAME_MAX = 200;

const output = {
	schema: { type: "string" },
	render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
		{ type: "text", text: String(value) },
	],
};
const GROUP_REF = { type: "string", required: true, description: "Exact group chat name from list_bots" };
const BLOCKING_QUESTION_TOOL = "ask_user_question";
// Ocean Crew has its own group goals; DSH's session goal still does not survive
// conversation parts.
const GOAL_TOOLS = ["create_goal", "update_goal", "get_goal"];
// DSH's delegation tools start child agents the user cannot watch or stop, and they end
// with the conversation part that started them; Bots hand work to other Bots. Agent
// Teams' teammates are such children too.
const DELEGATION_TOOLS = [
	"subagent",
	"subagent_fork",
	"subagent_codex",
	"subagent_claude_code",
	"list_subagent_models",
	"send_message",
	"interrupt_agent",
	"list_agents",
	"workflow",
	"ralph",
	"spawn_teammate",
	"wait_agent",
	"team_task_create",
	"team_task_get",
	"team_task_list",
	"team_task_update",
];
// restrict() refuses a whole list when one name is registered in the Agent's own scope,
// so each group is masked on its own.
const HIDDEN_TOOL_GROUPS: ReadonlyArray<readonly string[]> = [
	[BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS],
	DELEGATION_TOOLS,
];
const HIDDEN_TOOLS: readonly string[] = HIDDEN_TOOL_GROUPS.flat();
// The guidance DSH writes into the prompt for the hidden tools. Agent Teams makes every
// root Session a Team Lead and tells it to spawn teammates in `team:policy`; its
// `team:identity` context is required, so DSH puts it back after any filter.
const HIDDEN_SECTIONS = new Set([...HIDDEN_TOOLS.map((name) => `tool:${name}`), "tool:goal", "team:policy"]);
const GOAL_REFUSAL = "Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu.";
// DSH 0.2.2's schedule tools can deliver to a new Session, which is outside the team and
// has no Bot; a Bot's tasks deliver to its own chat, which Ocean Crew moves on with each
// part.
const SCHEDULE_TARGET_TOOLS = ["schedule_create", "schedule_edit"];
const SCHEDULE_TARGET_REFUSAL = 'A Bot’s scheduled tasks run in its own chat. Use target "this_session".';
const DELEGATION_REFUSAL =
	"Bots do not start subagents, teammates or workflows. Do the work yourself, or hand it to another Bot with message_bot.";
const MODE_PARAM = {
	type: "string",
	enum: ROOM_MODES,
	description:
		'"everyone": every member answers a plain message in turn, admin first. "admin" (the default): a plain message goes to the admin, who calls others with @Name. @mentions always choose who answers.',
};
const WORK_DIR_PARAM = {
	type: "string",
	description:
		"Full path of the folder to work in, where commands and file tools start. Only when the user asks for it",
};
const AVATAR_PARAM = {
	type: "string",
	description:
		"Profile picture: a local image path (a relative path starts in your working folder) or a data URL. PNG, JPEG, WebP, or GIF; square, 256x256 recommended, up to 120 KB. Images are not resized.",
};
const WORKING_DIRECTORY_TOOL = "working_directory";

// The author-facing parameter spec DSH's defineTool takes: per-property definitions
// with `required` marks. The compiler itself is the DSH package's, so tool argument

interface ParamSpec {
	type?: string;
	description?: string;
	required?: boolean;
	enum?: readonly unknown[];
	items?: ParamSpec;
	properties?: Record<string, ParamSpec>;
	additionalProperties?: boolean;
	[key: string]: unknown;
}

// The registry-ready definition: the same fields @deepseek-ai/dsh-tools defineTool
// produces for these tools (an object-rooted parameter schema and a text output).
interface ToolExecution {
	agent?: AgentLike;
	callId?: string;
	name?: string;
	arguments?: Record<string, any>;
	concludeTurn?: () => void;
	[key: string]: unknown;
}

type ToolHandler = (args: Record<string, any>, exec: ToolExecution) => unknown | Promise<unknown>;

interface ToolOptions {
	name: string;
	description: string;
	parameters: Record<string, ParamSpec>;
	execute: ToolHandler;
}

// defineTool infers argument types from the author spec; this host hands the tool back
// through runtime.ts's loose TeamTool bridge, so the wrapper keeps that one cast in a
// single place.
const defineTool = (options: ToolOptions): TeamTool =>
	defineDshTool({ ...options, output } as never) as unknown as TeamTool;

// deep-view dependency declares it. The wording, parameter names, types and the 8 KB
// limit are the model-visible wire contract and stay word for word; the braces around
// them are compiled locally by the stand-in defineTool.
const showViewParameters: Record<string, ParamSpec> = {
	title: { type: "string", description: "Optional short heading shown above the view" },
	view: {
		type: "object",
		required: true,
		additionalProperties: true,
		description:
			'One component { type, ...props }. Layout: stack (children, top to bottom) and row (children, side by side, wraps when narrow), 1 to 16 children; the outermost may define let: { name: "formula" }. Display: text ({ text: Markdown, tone?: "muted" }), metric ({ label, value, tone?: good|warn|bad, caption? }), table ({ columns: [{ key, label }], rows: [[cells]] }), chart ({ kind?: bar|hbar|line|area|donut, categories: [labels], series: [{ name?, values: [numbers] }], unit?, caption? }; donut takes one series), progress ({ label?, percent 0-100, or value with max, valueLabel?, tone? }), callout ({ text, tone?: info|good|warn|bad }), sources ({ items: [{ label, url }] }), html ({ html, summary, height? }: only for what nothing else can draw; it runs sandboxed with no network, cannot submit, and should use the CSS variables --view-ink, --view-ink-2, --view-line, --view-card, --view-accent, --view-green, --view-star, --view-danger). Inputs, which keep their value in the page: slider ({ id, label, min, max, step?, value, unit? }), number ({ id, label, value, min?, max?, step?, unit? }), choice ({ id, label, options: [{ label, value }], value? }), toggle ({ id, label, value? }); an input id is a plain name such as price. A metric value, caption or tone, a text, a progress field, a callout, a table cell or a chart value may be a formula { "=": "expression" } over input ids and let names: numbers, \'text\', + - * / %, < <= > >= == !=, && || !, a ? b : c, and min max abs floor ceil sqrt pow round clamp fixed(x, digits) format(x, digits) percent(x, digits). Answers, which end your turn: options ({ id, options: [{ label, description? }], multi? }), confirm ({ id, confirmLabel?, cancelLabel? }), form ({ id, fields: [{ id, label, placeholder?, value?, multiline?, readOnly? }], submitLabel?, cancelLabel? }), submit ({ id, label }: sends the inputs\' values to you).',
	},
	await_reply: {
		type: "boolean",
		description:
			"Wait for the user to submit the view. A view with options, confirm, form or submit always waits; a view without them cannot.",
	},
};
// The one sentence deep-view wraps around the blueprint text, with this host's surface.
const SHOW_VIEW_DESCRIPTION =
	"Draw a view in your own chat as part of your reply: a chart, key numbers, a table, a small calculator the user can try values in, or a choice, confirmation or short form. Text you write before and after the call shows around it. Use a view when it answers better than text: a chart to compare values or show a trend, inputs with formulas to let the user try numbers (worked out in the page, no new turn), options to let the user pick. Plain rows and columns read fine as a Markdown table, and one number needs no view. Give the answer first, then the view. Never invent data; mark sample numbers and assumptions as such. Do not repeat the same data as text, chart and table. Add only the controls the user needs. A view with options, confirm, form or submit ends your turn, and the answer arrives as the user's next message. Never collect a key, token or password. Keep the view under 8 KB.";
// UTF-8 bytes of the blueprint JSON plus the title, measured as sent.
const VIEW_BYTE_LIMIT = 8192;
const ANSWERS = new Set(["options", "confirm", "form", "submit"]);

const isRecord = (value: unknown): value is Record<string, any> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const viewBytes = (title: unknown, view: unknown): number =>
	new TextEncoder().encode(`${JSON.stringify(view) ?? ""}${String(title ?? "")}`).length;
// A view that asks for an answer ends the turn; any answer component anywhere does.
const interactiveOf = (node: unknown): boolean => {
	if (Array.isArray(node)) return node.some((item) => interactiveOf(item));
	if (!isRecord(node)) return false;
	if (typeof node.type === "string" && ANSWERS.has(node.type)) return true;
	return Object.values(node).some((value) => interactiveOf(value));
};

// What show_view checks before it shows a view: JSON data under the byte limit with a
// string title, and whether the view can be answered.
const checkShownView = (
	title: unknown,
	sent: unknown,
): { title?: string; view?: Record<string, unknown>; interactive?: boolean; error?: string } => {
	let bytes: number;
	try {
		bytes = viewBytes(title, sent);
	} catch {
		return { error: "The view is not JSON data." };
	}
	if (bytes > VIEW_BYTE_LIMIT) return { error: `The view is ${bytes} bytes; the limit is ${VIEW_BYTE_LIMIT}.` };
	if (title !== undefined && title !== null && typeof title !== "string") return { error: "title: expected a string" };
	if (!isRecord(sent)) return { error: "view: expected a component object" };
	return { title: String(title ?? "").trim(), view: sent, interactive: interactiveOf(sent) };
};

// A file link in another Session's text is read from that Session's folder, so relative
// links are made absolute first. the turns module may
// publish the full helper on `rt`, which wins when present.
const LINK_CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
const MARKDOWN_LINK = /(!?\[[^\]\n]*\]\()(<[^<>\n]*>|[^\s()<>]+)((?:\s+"[^"\n]*")?\))/g;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
const PATH_SCHEME = /^[a-z][a-z\d+.-]*:/i;

const relativeFile = (destination: string): { path: string; fragment: string } | undefined => {
	const hash = destination.indexOf("#");
	const target = hash < 0 ? destination : destination.slice(0, hash);
	const fragment = hash < 0 ? "" : destination.slice(hash);
	if (target === "" || target.includes("?") || (fragment !== "" && !/^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(fragment)))
		return undefined;
	let path: string;
	try {
		path = decodeURIComponent(target);
	} catch {
		return undefined;
	}
	const control = [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
	if (control || /^[\\/]{2}/.test(path) || ABSOLUTE_PATH.test(path) || PATH_SCHEME.test(path) || path.startsWith("~"))
		return undefined;
	return { path, fragment };
};

interface MessageLike {
	id?: string;
	content?: unknown[];
	source?: Record<string, any>;
	[key: string]: unknown;
}

interface AgentLike {
	id?: string;
	session?: { id?: string; [key: string]: unknown };
	inbox?: {
		nextStep?: MessageLike[];
		nextTurn?: MessageLike[];
		remove?(id: unknown): boolean;
		[key: string]: unknown;
	};
	status?: string;
	cancel?(cause: unknown): void;
	ctx?: Record<string, any>;
	[key: string]: unknown;
}

interface LiveTurn {
	turn?: number;
	info?: Record<string, any>;
	joined?: Array<{ info?: Record<string, any> }>;
}

// What one Session's own tool scope holds: its registered tools, the masks applied to
// its Agent, and what lifts them with the scope.
interface Held {
	agent?: AgentLike;
	relay: boolean;
	tools: boolean;
	restricted: boolean;
	filtered: boolean;
	disposers: Array<() => void>;
	unlisted: Set<string>;
	toolLifts?: Map<string, () => void>;
	connectorDenied?: Set<string>;
	connectorLifts?: Array<() => void>;
}

interface ToolsService {
	register(definition: TeamTool): unknown;
	guard?(guard: (exec: ToolExecution) => string | undefined): unknown;
	schemas?(agent?: AgentLike): Array<{ name: string }>;
	restrict?(filter: { allow?: string[]; deny?: string[] }): unknown;
}

interface GoalsService {
	get(agent: unknown): { id: string; revision: number; phase?: string } | undefined;
	block(agent: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }): void;
}

const holdOf = (relay: boolean): Held => ({
	relay,
	tools: false,
	restricted: false,
	filtered: false,
	disposers: [],
	unlisted: new Set(),
});

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state = rt.state;
	const tools = ctx.tools as unknown as ToolsService;

	const callerBot = (exec: ToolExecution): Bot | undefined => rt.botOf(rt.selfOf(exec.agent?.id));
	const callerRoom = (exec: ToolExecution): { fromRoomId?: string } => {
		const roomId = rt.groupOwners.get(exec.agent?.id ?? "")?.roomId;
		return roomId ? { fromRoomId: roomId } : {};
	};
	const liveOf = (sessionId?: string): LiveTurn | undefined =>
		(rt.live as Map<string, LiveTurn> | undefined)?.get(sessionId ?? "");
	const agentOf = async (sessionId: string): Promise<AgentLike> => (await rt.resolveAgent(sessionId)) as AgentLike;

	const roomLine = (room: Room, self?: string): string => {
		const members = room.members
			.map((id) => rt.botOf(id))
			.filter((bot): bot is Bot => bot !== undefined)
			.map((bot) => `${bot.name}${bot.id === room.admin ? " (admin)" : ""}${bot.id === self ? " (you)" : ""}`);
		const goal = room.goal as { title?: string; status?: string; current?: number; stages?: unknown[] } | undefined;
		const parts = [
			`members: ${members.join(", ")}`,
			room.mode === "admin" && room.admin ? "plain messages go to the admin first" : "every member replies in turn",
			room.notice ? `notice: ${room.notice.split("\n")[0].slice(0, 100)}` : "",
			room.workDir ? `members work in ${room.workDir} here` : "",
			room.permission ? `members work with the ${room.permission} permissions here` : "",
			goal !== undefined
				? `goal: "${goal.title}" (${goal.status}${goal.status === "active" || goal.status === "paused" ? `, stage ${Math.min((goal.current ?? 0) + 1, goal.stages?.length ?? 0)}/${goal.stages?.length ?? 0}` : ""})`
				: "",
		].filter(Boolean);
		return `- "${room.name}" — ${parts.join("; ")}`;
	};
	// Main Bots see every group; other Bots see the groups they are in.
	const visibleRooms = (self?: string): Room[] =>
		Object.values(state.rooms).filter((room) => rt.isMain(self) || room.members.includes(self ?? ""));

	rt.teamTools.push(
		defineTool({
			name: "list_bots",
			description:
				"List every Bot on the user's team with its role, what it does and what it is doing right now, and the group chats you can see.",
			parameters: {},
			execute: async (_args, exec) => {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				const lines = Object.values(state.bots).map((bot) => {
					// A private Bot is only named to the others: not what it does, where, or what now.
					if (bot.private === true && bot.id !== self)
						return `- ${bot.name} (${[bot.role, "private Bot, closed to other Bots"].filter(Boolean).join(", ")})`;
					const model = bot.appliedModel ?? bot.model;
					const tags = [
						bot.role,
						model ? `model ${model}` : "",
						bot.workDir ? `works in ${bot.workDir}` : "",
						rt.isMain(bot.id) ? "Main Bot" : "",
						bot.private === true ? "private" : "",
						bot.id === self ? "you" : "",
					]
						.filter(Boolean)
						.join(", ");
					const job = bot.instructions ? ` — ${bot.instructions.split("\n")[0].slice(0, 120)}` : "";
					const now = bot.id === self ? "" : `\n  now: ${rt.statusOf(bot.id)}`;
					return `- ${bot.name}${tags ? ` (${tags})` : ""}${job}${now}`;
				});
				if (lines.length === 0) return "No Bots yet.";
				const rooms = visibleRooms(self);
				return [
					"Bots:",
					...lines,
					"",
					rooms.length === 0 ? "Group chats: none you can see." : "Group chats:",
					...rooms.map((room) => roomLine(room, self)),
				].join("\n");
			},
		}),
	);

	// Sessions a Bot is running in right now: its own chat plus each group Session with a
	// live turn. An idle Bot reports just its own chat.
	const activeSessions = (botId: string): { running: string[]; idle: boolean } => {
		const running = [...new Set([rt.chatOf(botId), ...rt.groupSessionsOf(botId)])].filter(
			(sessionId) => liveOf(sessionId)?.turn !== undefined,
		);
		return { running, idle: running.length === 0 };
	};
	const whereOf = (sessionId: string): string => {
		const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId);
		return room ? `group "${room.name}"` : "its own chat";
	};
	// A Bot request still in the inbox: no step or turn has taken it out yet.
	const unreadRequest = (
		agent: AgentLike,
		senderId: string,
		toUser: boolean,
	): { message: MessageLike; steered: boolean } | undefined => {
		const entries: Array<[MessageLike, boolean]> = [
			...(agent.inbox?.nextStep ?? []).map((message): [MessageLike, boolean] => [message, true]),
			...(agent.inbox?.nextTurn ?? []).map((message): [MessageLike, boolean] => [message, false]),
		];
		for (const [message, steered] of entries) {
			const source = message.source;
			if (
				source?.kind === SOURCE_KIND &&
				source.role === "request" &&
				source.senderSessionId === senderId &&
				(source.audience === "user") === toUser &&
				!source.deferred &&
				!source.resumed
			)
				return { message, steered };
		}
		return undefined;
	};
	// A message's own words and files, without its header line.
	const bodyOf = (message: MessageLike): { text: string; files: unknown[] } => {
		const content = Array.isArray(message.content) ? message.content : [];
		const first = content.find((block) => (block as { type?: string })?.type === "text") as
			| { text?: string }
			| undefined;
		const text = first?.text ?? "";
		return {
			text: text.slice(text.indexOf("\n") + 1),
			files: content
				.filter(
					(block) =>
						(block as { type?: string })?.type === "file" &&
						(block as { attachment?: unknown }).attachment !== undefined,
				)
				.map((block) => (block as { attachment: unknown }).attachment),
		};
	};

	// A tool that throws shows as failed in the chat, instead of as sent or stopped.
	const refuse = (message: string): never => {
		throw new Error(message);
	};
	const worksOf = (exec: ToolExecution): string[] => {
		const turn = liveOf(exec.agent?.id);
		return [rt.workOf(turn?.info), ...(turn?.joined ?? []).map((joined) => rt.workOf(joined.info))].filter(
			(id): id is string => id !== undefined,
		);
	};
	const tooLong = (text: string): string =>
		`Not sent: the message has ${text.length} characters, more than ${MESSAGE_INLINE_MAX}, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.`;
	// Work for a group stays in it: from a group Session, message_bot calls a member
	// there exactly as an "@Name" line would, and never reaches a Bot outside the group.
	const groupRefusal = (room: Room, sender: Bot, target: Bot): string | undefined => {
		if (room.members.includes(target.id)) return undefined;
		const add =
			rt.isMain(sender.id) || rt.isAdminOf(room, sender.id) ? ", or add it yourself with update_group first" : "";
		return `Not sent: ${target.name} is not in "${room.name}", and work for this group stays in it. Ask the user to add ${target.name} to the group${add}.`;
	};
	const callInGroup = async (exec: ToolExecution, room: Room, target: Bot, message: string): Promise<string> => {
		const call = `@${target.name}`;
		await rt.roomStepText(
			exec.agent?.id,
			liveOf(exec.agent?.id)?.info,
			message.startsWith(call) ? message : `${call} ${message}`,
			false,
		);
		return `Called ${target.name} in "${room.name}" with your message, as writing "${call}" there does: it works on it in the group, and you answer its result there. Nothing went to its own chat.`;
	};

	// The Bots each Session's post_to_group called by name in its current turn, so that
	// turn does not also send them the same work in their own chats.
	const calledInPosts = new Map<string, { turn?: number; calls: Map<string, string> }>();
	const turnOf = (exec: ToolExecution): number | undefined => liveOf(exec.agent?.id)?.turn;

	rt.teamTools.push(
		defineTool({
			name: "message_bot",
			description:
				'Send a message to another Bot on the team. If that Bot is working, it reads your message at its next step and can change course, then answers once that work is done; if it is idle, it starts on it right away. Its reply arrives later as a new message to you; with reply_to "user" it answers the user in its own chat instead. In a group chat it reaches only members of that group, as writing "@Name" there does. With request_id you name the request yourself: a repeat of that name with the same message is not sent again, but gives the receipt of the first call back.',
			parameters: {
				to: { type: "string", required: true, description: "Exact Bot name from list_bots" },
				message: {
					type: "string",
					required: true,
					description: "Self-contained message; the other Bot cannot see this conversation",
				},
				reply_to: {
					type: "string",
					enum: ["me", "user"],
					description:
						'"me" (default): the reply comes back to you and the user does not see it. "user": the Bot answers the user in its own chat, where the user reads it, and nothing comes back to you. Use "user" whenever the user wants to hear from that Bot directly or asks Bots to say something in their own chats.',
				},
				when: {
					type: "string",
					enum: ["now", "queue"],
					description:
						'"now" (default): a working Bot reads your message at its next step, between its current actions, and answers once its current work is done; use it for questions, information it needs, corrections and warnings. "queue": it reads your message only after its current work is done, as a separate task; use it only for a new task unrelated to what it is doing now. With reply_to "user" the message always queues.',
				},
				request_id: {
					type: "string",
					description: `Your own name for this request, up to ${NAME_MAX} characters, so that a repeat of it is not sent twice. Send the same request_id with the same message when you repeat a call: the receipt of the first call comes back and nothing is sent again. A request_id names one request: with other content it is refused.`,
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				const sender = callerBot(exec);
				if (sender === undefined) return "Only Bots on the team can use message_bot.";
				const target = rt.findBot(args.to);
				if (target === undefined)
					return `No Bot named ${args.to}. Team: ${Object.values(state.bots)
						.map((bot) => bot.name)
						.join(", ")}`;
				if (target.id === sender.id) return "You cannot message yourself.";
				if (String(args.message ?? "").trim() === "") return "Write a message to send.";
				const name = typeof args.request_id === "string" ? args.request_id.trim() : "";
				if (name.length > NAME_MAX)
					return `The request_id is ${name.length} characters long; a request name is at most ${NAME_MAX}.`;
				const linkFolder = rt.sessionFolder?.(exec.agent?.session ?? exec.agent);
				const text = absoluteLinks(String(args.message), linkFolder);
				const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id ?? "")?.roomId);
				// The request the caller named: it is admitted once, and a repeat of it is not sent again.
				const request =
					name === ""
						? undefined
						: rt.requestIdentity({
								caller: sender.id,
								context: room === undefined ? "chat" : `room:${room.id}`,
								name,
								payload: {
									to: target.id,
									message: String(args.message ?? "")
										.replace(/\r\n?/g, "\n")
										.trim(),
									reply_to: args.reply_to === "user" ? "user" : "me",
									when: args.when === "queue" ? "queue" : "now",
								},
							});
				// What the caller gets for a request that was admitted before.
				const answer = (outcome: { status?: string; receipt?: unknown }): unknown => {
					if (outcome.status === "replay") return outcome.receipt;
					if (outcome.status === "conflict")
						refuse(
							`Not sent: request_id "${name}" was already used for a different request. A request_id names one request; send this one under a new name.`,
						);
					if (outcome.status === "uncertain")
						refuse(
							`Not sent again: the outcome of request_id "${name}" is not known (the delivery failed, or Ocean Crew restarted while it was in flight), so it was not sent again. Check whether ${target.name} got it before sending it under a new name.`,
						);
					if (outcome.status === "expired")
						return `Nothing was sent again: request_id "${name}" was admitted before, but its receipt is no longer kept, so only the fact that it was sent is left. Send the work under a new request_id if it must be done again.`;
					if (outcome.status === "readonly")
						refuse(
							`Not sent: this window cannot save the Bot team, so it cannot record the request_id "${name}". Send it from the window that owns the team, or leave the request_id out.`,
						);
					return outcome.receipt;
				};
				if (request !== undefined) {
					const seen = await rt.knownRequest(request);
					if (seen !== undefined) return answer(seen);
				}
				if (room !== undefined) {
					const refusal = groupRefusal(room, sender, target);
					if (refusal !== undefined) refuse(refusal);
					const send = (): Promise<string> => callInGroup(exec, room, target, text.trim());
					return request === undefined ? await send() : answer(await rt.admitRequest(request, send));
				}
				const posted = calledInPosts.get(exec.agent?.id ?? "");
				const postedIn =
					posted !== undefined && posted.turn === turnOf(exec) ? posted.calls.get(target.id) : undefined;
				if (postedIn !== undefined)
					refuse(
						`Not sent: you called ${target.name} in "${postedIn}" in this turn, and it works on that there. Send each task one way only; to add to it, post in that group.`,
					);
				// Whoever waits for this work gets the answer by itself; a message there only
				// sends the work round in a circle. Not a failed call: the turn goes on with the
				// work, and the result says where its answer goes instead of showing a bare error
				// the Bot cannot act on.
				const works = worksOf(exec);
				if (rt.upstreamOf(works).has(target.id))
					return `Not sent: ${target.name} is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Finish the work and end your turn; to ask ${target.name} something, end your turn with the question.`;
				const send = async (): Promise<string> => {
					const toUser = args.reply_to === "user";
					const work = toUser ? undefined : works[0];
					const chat = rt.chatOf(target.id);
					const agent = await agentOf(chat);
					const status = rt.statusOf(target.id);
					// A request it has not read yet, sent for the same work, takes this one in, so
					// messages to a Bot that cannot read them do not pile up.
					const earlier = unreadRequest(agent, sender.id, toUser);
					const joinable =
						earlier !== undefined && (toUser || rt.sameWork(earlier.message.source?.exchangeId, work));
					const before = joinable ? bodyOf(earlier.message) : undefined;
					let long = await rt.attachLong(
						before ? `${before.text}\n\n${text}` : text,
						`Message from ${sender.name}.txt`,
					);
					// Nothing went out, so a named request must not take this as a delivered
					// receipt: admitRequest drops the pending record instead, and a retry can send.
					if (long === undefined) {
						if (request !== undefined) request.unsent = true;
						return tooLong(text);
					}
					const joins = before !== undefined && agent.inbox?.remove?.(earlier?.message.id) === true;
					if (before !== undefined && !joins)
						long = (await rt.attachLong(text, `Message from ${sender.name}.txt`)) ?? long;
					const working = liveOf(chat)?.turn !== undefined;
					const steer = (args.when !== "queue" && !toUser) || (joins && earlier?.steered === true);
					const exchangeId = joins ? earlier?.message.source?.exchangeId : randomUUID();
					if (joins) rt.forgetDelivery?.(exchangeId);
					else if (!toUser) rt.openWork(exchangeId, { from: sender.id, to: target.id, parent: work });
					try {
						await rt.deliver({
							fromId: sender.id,
							toId: target.id,
							text: long.text,
							files: [...long.files, ...(joins ? (before?.files ?? []) : [])],
							length: long.length,
							role: "request",
							steer,
							exchangeId,
							...(joins ? { merged: true } : {}),
							...(toUser ? { audience: "user" } : {}),
						});
					} catch (error) {
						// The delivery stays noted for the next start while its Bot exists, and the
						// resent request still answers up the tree, so the work it opened stays too.
						// Only a target that is gone drops the work.
						if (!joins && rt.botOf(target.id) === undefined) rt.dropWork(exchangeId);
						throw error;
					}
					const sent = toUser
						? `Delivered to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
						: working && steer
							? `Delivered to ${target.name} while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.`
							: working
								? `Queued for ${target.name}: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.`
								: `Delivered to ${target.name}. Its reply will arrive later as a new message; do not wait for it.`;
					const asker =
						work !== undefined && rt.ownsWork(sender.id, work)
							? rt.botOf(state.works[work]?.from)?.name
							: undefined;
					const notes = [
						joins
							? `${target.name} had not read your earlier message yet, so this one was added to it, and it answers both at once.`
							: "",
						status === "idle" ? "" : `${target.name} now: ${status}.`,
						asker
							? `When you have handed on everything, end your turn: each reply brings you back to this work, and your answer goes to ${asker} once all of it is back.`
							: "",
					].filter(Boolean);
					const out = [sent, ...notes].join(" ");
					// Messages reach a Bot's own chat only; work in a group goes on without them.
					const groups = activeSessions(target.id).running.filter((sessionId) => sessionId !== chat);
					if (groups.length === 0) return out;
					const stop = rt.isMain(sender.id) ? " If it must not go on there, use stop_bot." : "";
					return `${out} Your message does not reach its work in ${groups.map(whereOf).join(" and ")}.${stop}`;
				};
				return request === undefined ? await send() : answer(await rt.admitRequest(request, send));
			},
		}),
	);

	rt.teamTools.push(
		defineTool({
			name: "stop_bot",
			description:
				"Main Bot only. Stop another Bot's running turn immediately — when it must not finish a dangerous action and a message_bot warning is not enough. Its queued messages are dropped with the turn. It is then told why in a new turn, whose reply comes back to you.",
			parameters: {
				bot: { type: "string", required: true, description: "Exact Bot name from list_bots" },
				reason: { type: "string", description: "Why it was stopped; it reads this afterwards" },
			},
			execute: async (args, exec) => {
				await rt.load();
				const sender = callerBot(exec);
				if (sender === undefined || !rt.isMain(sender.id)) return refuse("Only a Main Bot can stop other Bots.");
				const target = rt.findBot(args.bot);
				if (target === undefined)
					return refuse(
						`No Bot named ${args.bot}. Team: ${Object.values(state.bots)
							.map((bot) => bot.name)
							.join(", ")}`,
					);
				if (target.id === sender.id) return refuse("You cannot stop yourself.");
				const { running } = activeSessions(target.id);
				if (running.length === 0)
					return refuse(
						`${target.name} is not running right now, so there is nothing to stop. Use message_bot to reach it.`,
					);
				for (const sessionId of running) {
					const agent = await agentOf(sessionId);
					agent.cancel?.({ kind: "hook", reason: "ocean-crew/stopped" });
				}
				const why =
					String(args.reason ?? "").trim() ||
					"Stop what you are doing; the previous turn was ended on purpose. Acknowledge briefly.";
				await rt.deliver({ fromId: sender.id, toId: target.id, text: why, role: "stopped", ...callerRoom(exec) });
				return `Stopped ${target.name} in ${running.map(whereOf).join(" and ")}. It is told why in a new turn, whose reply comes back to you.`;
			},
		}),
	);

	// it through the runtime and refuse clearly while that module is absent.
	const readAvatar = async (input: unknown, exec: ToolExecution): Promise<string> => {
		if (typeof rt.readAvatar !== "function") throw new Error("Profile pictures are not available in this build yet.");
		return (await rt.readAvatar(input, {
			baseDir: rt.sessionFolder?.(exec.agent?.session ?? exec.agent),
			isData: rt.inData,
		})) as string;
	};

	rt.teamTools.push(
		defineTool({
			name: "create_bot",
			description:
				"Main Bot only. Create a new Bot on the user's team. It appears in the sidebar and greets the user.",
			parameters: {
				name: { type: "string", required: true, description: 'Short display name, e.g. "Researcher" or "Editor"' },
				role: {
					type: "string",
					required: true,
					description: "Two-to-four character role label shown under the name",
				},
				instructions: {
					type: "string",
					required: true,
					description: "What this Bot is responsible for and how it should work",
				},
				brief: { type: "string", description: "Why the user wants it, passed to the new Bot as its first context" },
				model: {
					type: "string",
					description:
						"Model the Bot runs on, as provider/model or a model id. Only when the user names one; otherwise the team default model from Ocean Crew settings, or the model you run on.",
				},
				effort: {
					type: "string",
					description: "Thinking level for the model, as list_bot_models shows it. Only when the user names one.",
				},
				work_dir: WORK_DIR_PARAM,
				avatar: AVATAR_PARAM,
			},
			execute: async (args, exec) => {
				await rt.load();
				if (!rt.isMain(rt.selfOf(exec.agent?.id)))
					return "Only the Main Bot can create Bots. Ask the Main Bot instead.";
				try {
					const avatar = args.avatar ? await readAvatar(String(args.avatar), exec) : undefined;
					const workDir = args.work_dir ? await rt.cleanWorkDir(args.work_dir) : undefined;
					const name = String(args.name ?? "").trim();
					await rt.approveFolder(exec as unknown, {
						path: workDir,
						who: { en: `the new Bot ${name}`, zh: `新 Bot ${name} ` },
					});
					// Without a named model the team's default applies; without one the new Bot
					// takes its creator's: the DSH default may be a provider that has no key, and
					// then the new Bot fails on its first reply.
					const creator = callerBot(exec);
					const served = new Set(
						(await rt.catalog())
							.filter(
								(entry: { needsKey?: boolean; ref: string }) =>
									entry.needsKey !== true && rt.isLocalAgentRef?.(entry.ref) !== true,
							)
							.map((entry: { ref: string }) => entry.ref),
					);
					const fallback = [state.prefs.defaultBotModel, creator?.model].find((ref) => ref && served.has(ref));
					const model = args.model || fallback;
					const bot = await rt.createBot({
						...args,
						avatar: avatar === undefined ? undefined : { image: avatar },
						model,
						workDir,
						effort: args.effort,
						createdBy: creator?.id,
					});
					return `Created ${bot.name}${workDir ? `, working in ${workDir}` : ""}. It is greeting the user now.`;
				} catch (error) {
					return `Could not create the Bot: ${(error as Error).message}`;
				}
			},
		}),
	);

	rt.teamTools.push(
		defineTool({
			name: "update_bot",
			description:
				"Change a Bot's name, role, color, profile picture, model, thinking level, working folder, or instructions. Every Bot may change itself; only a Main Bot may change another Bot.",
			parameters: {
				bot: { type: "string", description: "Current name of the Bot to change; leave out to change yourself" },
				name: { type: "string", description: "New name" },
				role: { type: "string", description: "New role label" },
				instructions: { type: "string", description: "Replacement instructions" },
				color: { type: "string", description: `One of ${[...COLORS, ...EXTRA_COLORS].join(", ")}` },
				avatar: {
					...AVATAR_PARAM,
					description: `${AVATAR_PARAM.description} An empty string removes the photo and shows the Bot's character again.`,
				},
				model: {
					type: "string",
					description:
						"Move the Bot to another model, as provider/model or a model id. It can be changed later in the Bot settings.",
				},
				effort: {
					type: "string",
					description:
						"Thinking level for the Bot's model, as list_bot_models shows; an empty string returns to the model's default",
				},
				work_dir: {
					...WORK_DIR_PARAM,
					description: `${WORK_DIR_PARAM.description}; an empty string returns it to the team workspace`,
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				const caller = rt.botOf(self);
				if (caller === undefined) return "Only Bots on the team can use update_bot.";
				const bot = args.bot ? rt.findBot(args.bot) : caller;
				if (bot === undefined) return `No Bot named ${args.bot}.`;
				if (bot.id !== caller.id && !rt.isMain(self))
					return "Only a Main Bot can change another Bot. Leave out bot to change yourself, or ask a Main Bot with message_bot.";
				try {
					const { name: newName, role, instructions, color, model, effort } = args;
					let image: string | null | undefined;
					if (args.avatar !== undefined) {
						const input = typeof args.avatar === "string" ? args.avatar.trim() : args.avatar;
						image = input === null || input === "" ? null : await readAvatar(String(input), exec);
					}
					const moving = typeof args.work_dir === "string";
					const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined;
					if (moving && workDir !== bot.workDir)
						await rt.approveFolder(exec as unknown, {
							path: workDir,
							sessions: rt.sessionsOfBot(bot.id),
							who: { en: bot.name, zh: ` ${bot.name} ` },
						});
					// The photo rides on the Bot's other avatar fields, as the settings page's
					// upload does: setting one keeps a custom character, and clearing removes only
					// the image. They are read here, after the waits above, so a change made
					// meanwhile stays.
					const avatar = image === undefined ? undefined : { ...rt.botOf(bot.id)?.avatar, image };
					const next = await rt.updateBot(
						bot.id,
						{
							name: newName,
							role,
							instructions,
							color,
							...(avatar !== undefined ? { avatar } : {}),
							...(model ? { model } : {}),
							...(effort === undefined ? {} : { effort }),
							...(moving ? { workDir: workDir ?? "" } : {}),
						},
						self,
						exec.agent?.id,
					);
					if (!moving) return `Updated ${next.name}.`;
					const folder = workDir ?? "the team workspace";
					return bot.id === caller.id
						? `Updated ${next.name}. From your next step on, you work in ${folder}.`
						: `Updated ${next.name}. It now works in ${folder}.`;
				} catch (error) {
					return `Could not update the Bot: ${(error as Error).message}`;
				}
			},
		}),
	);

	// DSH's working_directory changes a Session's folder in place, and the next part starts
	// in the Bot's working folder again. A Bot that changes to a folder outside its working
	// folder sets its working folder instead, with update_bot's checks, and goes on in a
	// fresh part there; a folder inside it only moves this Session there. The folder rules
	// belong to folders.ts; until the runtime publishes them this hook hands calls through.
	ctx.on("tools/execute", async (exec: Record<string, any>, next: () => Promise<unknown>) => {
		// Resolved as DSH gets it, untrimmed, so that both mean the same folder.
		const cd =
			exec.name === WORKING_DIRECTORY_TOOL && typeof exec.arguments?.cd === "string" ? exec.arguments.cd : "";
		const session = exec.agent?.session;
		if (cd === "" || session === undefined) return next();
		if (
			typeof rt.workDirOf !== "function" ||
			typeof rt.teamFolder !== "function" ||
			typeof rt.folderAt !== "function" ||
			typeof rt.isFolder !== "function" ||
			typeof rt.real !== "function" ||
			typeof rt.workFolder !== "function"
		)
			return next();
		await rt.load();
		const bot = callerBot(exec as ToolExecution);
		if (bot === undefined) return next();
		const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id ?? "")?.roomId);
		const home = rt.workDirOf({ botId: bot.id, roomId: room?.id }) ?? rt.teamFolder();
		const base = rt.sessionFolder?.(session);
		if (base === undefined) return next();
		const target = await rt.folderAt(base, cd);
		if (
			target === undefined ||
			!(await rt.isFolder(target)) ||
			home === undefined ||
			within(target, await rt.real(home))
		)
			return next();
		if (room?.workDir)
			throw new Error(
				`Every member of "${room.name}" works in ${room.workDir} here, so you stay inside it. The user or a Main Bot can change the group's folder.`,
			);
		const readOnly = rt.readOnly();
		if (readOnly !== undefined) throw new Error(`Your working folder cannot change now: ${readOnly}`);
		// Saved folders are trimmed like typed ones, so such a name would save another folder.
		if (unquote(target) !== target)
			throw new Error(
				`${JSON.stringify(target)} cannot be a working folder: its name starts or ends with a space or a quote mark.`,
			);
		const workDir = await rt.workFolder(target);
		if (room !== undefined) {
			// The folder holds only for this group conversation, so only this Session's writes
			// widen; the private-Bot check is the one updateBot would run.
			await rt.checkPrivacyChange(bot, { moving: true, workDir });
			await rt.approveFolder(exec, {
				path: workDir,
				sessions: [exec.agent?.id],
				who: { en: bot.name, zh: ` ${bot.name} ` },
			});
			const result = await next();
			if ((result as { isError?: boolean } | undefined)?.isError !== true) {
				if (room.memberDirs === undefined) room.memberDirs = {};
				room.memberDirs[bot.id] = workDir ?? null;
				await rt.save();
			}
			return result;
		}
		await rt.approveFolder(exec, {
			path: workDir,
			sessions: rt.sessionsOfBot(bot.id),
			who: { en: bot.name, zh: ` ${bot.name} ` },
		});
		const result = await next();
		if ((result as { isError?: boolean } | undefined)?.isError !== true)
			await rt.updateBot(bot.id, { workDir: workDir ?? "" }, rt.selfOf(exec.agent?.id));
		return result;
	});

	rt.teamTools.push(
		defineTool({
			name: "list_bot_models",
			description:
				"List the models a Bot can run on, as provider/model refs for create_bot and update_bot. A model in use also lists the thinking levels it serves.",
			parameters: {},
			execute: async () => {
				const models = (await rt.catalog({ fresh: true })) as Array<Record<string, any>>;
				if (models.length === 0) return "No models are configured. Ask the user to add one in Settings → Models.";
				const fallback = rt.defaultRef();
				// Only catalog entries that already carry `reasoning` (models a Bot runs on)
				// show levels; asking every model for its levels would take a call each.
				return models
					.map((entry) => {
						const effortIds: string[] =
							entry.reasoning?.efforts?.map((effort: { id: string }) => effort.id) ?? [];
						const thinking =
							effortIds.length > 0
								? `, thinking: ${effortIds.join(", ")}${entry.reasoning.defaultEffort === undefined ? "" : ` (default: ${entry.reasoning.defaultEffort})`}`
								: "";
						return `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ""}${entry.input?.includes("image") ? ", reads images" : ""}${entry.ref === fallback ? ", default" : ""}${thinking}`;
					})
					.join("\n");
			},
		}),
	);

	// Group tools take Bot names as an array, or as one comma-separated string from models
	// that flatten it.
	const nameList = (value: unknown): string[] =>
		(Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、]/) : [])
			.map((item) => String(item ?? "").trim())
			.filter(Boolean);
	const resolveBots = (refs: unknown): { bots: Bot[]; unknown: string[] } => {
		const bots: Bot[] = [];
		const unknown: string[] = [];
		for (const ref of nameList(refs)) {
			const bot = rt.findBot(ref);
			if (bot === undefined) unknown.push(ref);
			else if (!bots.includes(bot)) bots.push(bot);
		}
		return { bots, unknown };
	};
	const teamNames = (): string =>
		Object.values(state.bots)
			.map((bot) => bot.name)
			.join(", ");
	const groupNames = (self?: string): string =>
		visibleRooms(self)
			.map((room) => `"${room.name}"`)
			.join(", ") || "none";
	const pickRoom = (ref: unknown, self?: string): { room?: Room; error?: string } => {
		const matches = rt.findRooms(ref).filter((room) => visibleRooms(self).includes(room));
		if (matches.length === 1) return { room: matches[0] };
		if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` };
		return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` };
	};

	rt.teamTools.push(
		defineTool({
			name: "create_group",
			description:
				"Main Bot only. Create a group chat with the user and some Bots. You join it as its admin unless you name another member.",
			parameters: {
				members: {
					type: "array",
					required: true,
					items: { type: "string" },
					description: "Exact names of the other Bots to add; you are added automatically",
				},
				name: { type: "string", description: "Group name; defaults to the member names" },
				notice: {
					type: "string",
					description:
						"Shared instructions every member reads before speaking in this group; at most 2000 characters",
				},
				admin: { type: "string", description: "Member who leads the group; defaults to you" },
				mode: MODE_PARAM,
			},
			execute: async (args, exec) => {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				if (!rt.isMain(self)) return "Only a Main Bot can create group chats. Ask a Main Bot instead.";
				const { bots, unknown } = resolveBots(args.members);
				if (unknown.length > 0) return `No Bot named ${unknown.join(", ")}. Team: ${teamNames()}`;
				const admin = args.admin ? rt.findBot(args.admin) : rt.botOf(self);
				if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`;
				const members = [...new Set([self, ...bots.map((bot) => bot.id), admin.id])].filter(
					(id): id is string => id !== undefined,
				);
				try {
					const room = await rt.createRoom({
						members,
						name: args.name,
						notice: args.notice,
						mode: args.mode,
						admin: admin.id,
						createdBy: self,
					});
					return `Created group "${room.name}" with ${room.members.map((id: string) => rt.botOf(id)?.name).join(", ")}. ${admin.id === self ? "You are" : `${admin.name} is`} its admin. It is in the user's sidebar; use post_to_group to start a discussion there.`;
				} catch (error) {
					return `Could not create the group: ${(error as Error).message}`;
				}
			},
		}),
	);

	rt.teamTools.push(
		defineTool({
			name: "update_group",
			description:
				"Change a group chat: rename it, set its notice, add or remove members, change its admin or reply mode. Main Bots may change any group; a group's admin may change its own group.",
			parameters: {
				group: GROUP_REF,
				name: { type: "string", description: "New group name; an empty string names it after its members again" },
				notice: {
					type: "string",
					description:
						"Replacement notice, the shared instructions every member reads; an empty string clears it; at most 2000 characters",
				},
				add_members: { type: "array", items: { type: "string" }, description: "Exact names of Bots to add" },
				remove_members: { type: "array", items: { type: "string" }, description: "Exact names of Bots to remove" },
				admin: {
					type: "string",
					description: 'Member to make the admin; "none" leaves the group without one (Main Bots only)',
				},
				mode: MODE_PARAM,
				work_dir: {
					...WORK_DIR_PARAM,
					description: `${WORK_DIR_PARAM.description}. Every member works there in this group; an empty string lets each member work in its own folder again (Main Bots only)`,
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				if (rt.botOf(self) === undefined) return "Only Bots on the team can use update_group.";
				const picked = pickRoom(args.group, self);
				if (picked.error !== undefined) return picked.error;
				const room = picked.room as Room;
				const moving = typeof args.work_dir === "string";
				if (moving && !rt.isMain(self)) return `Only a Main Bot can set the folder of "${room.name}".`;
				const add = resolveBots(args.add_members);
				const remove = resolveBots(args.remove_members);
				const unknown = [...add.unknown, ...remove.unknown];
				if (unknown.length > 0) return `No Bot named ${unknown.join(", ")}. Team: ${teamNames()}`;
				let admin: string | null | undefined;
				if (args.admin !== undefined && args.admin !== "") {
					if (/^(none|nobody|null|无|没有)$/i.test(String(args.admin).trim())) admin = null;
					else {
						admin = rt.findBot(args.admin)?.id;
						if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`;
					}
				}
				try {
					const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined;
					// A Bot that joins a group with a folder works there from its first turn.
					const joining = add.bots.filter((bot) => !room.members.includes(bot.id));
					if (moving && workDir !== room.workDir) {
						const members = [...room.members, ...joining.map((bot) => bot.id)];
						await rt.approveFolder(exec as unknown, {
							path: workDir,
							sessions: members.map((id) => room.sessions?.[id]).filter(Boolean),
							who: { en: `every member of "${room.name}"`, zh: `群聊「${room.name}」的成员` },
						});
					} else if (joining.length > 0) {
						const names = joining.map((bot) => bot.name);
						await rt.approveFolder(exec as unknown, {
							path: room.workDir,
							sessions: joining.map((bot) => room.sessions?.[bot.id]).filter(Boolean),
							who: { en: names.join(", "), zh: ` ${names.join("、")} ` },
						});
					}
					const { room: next, changes } = await rt.updateRoom(
						room.id,
						{
							name: args.name,
							notice: args.notice,
							mode: args.mode,
							admin,
							add: add.bots.map((bot) => bot.id),
							remove: remove.bots.map((bot) => bot.id),
							...(moving ? { workDir: workDir ?? "" } : {}),
						},
						self,
					);
					return changes.length === 0
						? `Nothing changed in "${next.name}".`
						: `Updated "${next.name}": ${changes.join("; ")}.`;
				} catch (failure) {
					return `Could not update "${room.name}": ${(failure as Error).message}`;
				}
			},
		}),
	);

	rt.teamTools.push(
		defineTool({
			name: "delete_group",
			description: "Main Bot only. Delete a group chat; its history is archived. Only when the user asks.",
			parameters: { group: GROUP_REF },
			execute: async (args, exec) => {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				if (!rt.isMain(self)) return "Only a Main Bot can delete group chats.";
				const picked = pickRoom(args.group, self);
				if (picked.error !== undefined) return picked.error;
				const room = picked.room as Room;
				if (rt.roomBusy(room.id))
					return `"${room.name}" is in the middle of a round. Delete it after the round ends.`;
				await rt.deleteRoom(room.id);
				return `Deleted "${room.name}". Its history is archived.`;
			},
		}),
	);

	rt.teamTools.push(
		defineTool({
			name: "post_to_group",
			description:
				"Post a message into a group chat as yourself. A Main Bot may post into any group, any other Bot into a group it is in. A Main Bot's or the group admin's post starts a round: members reply in the group, where the user reads them. Another member's post calls only the members it names with \"@Name\"; without one it is only written into the group.",
			parameters: {
				group: GROUP_REF,
				message: {
					type: "string",
					required: true,
					description:
						'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member',
				},
				report_back: {
					type: "boolean",
					description: "Also send the members' replies back to you as a new message when the round ends",
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				const sender = rt.botOf(self);
				if (sender === undefined) return "Only Bots on the team can use post_to_group.";
				const picked = pickRoom(args.group, self);
				if (picked.error !== undefined) return picked.error;
				const room = picked.room as Room;
				// An ordinary member's post calls only the members it names (openingSpeakers).
				const member = !rt.isMain(self) && !rt.isAdminOf(room, self);
				const info = liveOf(exec.agent?.id)?.info;
				if (info?.role === "room" && info.roomId === room.id)
					return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`;
				const linkFolder = rt.sessionFolder?.(exec.agent?.session ?? exec.agent);
				const text = absoluteLinks(String(args.message ?? "").trim(), linkFolder);
				if (text === "") return "Write a message to post.";
				// Counted on the whole message. A post past MESSAGE_INLINE_MAX keeps only its
				// first LONG_HEAD characters, and the round reads this list instead of that text.
				const spans = mentionSpans(
					text,
					room.members.map((id) => rt.botOf(id)).filter((bot): bot is Bot => bot !== undefined),
				);
				const named: string[] = [];
				for (const span of spans) {
					if (span.bot && span.bot.id !== self && !named.includes(span.bot.id)) named.push(span.bot.id);
				}
				const mentions = { ids: named, all: spans.some((span) => span.all === true) };
				const reportBack = args.report_back === true;
				if (member && reportBack && named.length === 0) {
					return 'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post without report_back.';
				}
				const long = await rt.attachLong(text, `Post from ${sender.name}.txt`);
				if (long === undefined) return tooLong(text);
				// Replies the poster waits for, while it works on what a Bot asked it for, are
				// work handed on for that request (handoffs.js).
				const work = reportBack ? worksOf(exec).find((id) => rt.ownsWork(self ?? "", id)) : undefined;
				const sub = work === undefined ? undefined : randomUUID();
				if (sub !== undefined) rt.openWork(sub, { from: self, room: room.id, parent: work });
				try {
					// A post that wants the replies names the conversation it was written from,
					// so the report comes back there instead of the own chat.
					await rt.postToRoom(
						room,
						sender,
						long.text,
						{
							mentions,
							...(reportBack ? { reportBack: true, ...callerRoom(exec) } : {}),
							...(member ? { member: true } : {}),
							...(sub ? { sub } : {}),
							...(long.length ? { length: long.length } : {}),
						},
						long.files,
					);
				} catch (failure) {
					if (sub !== undefined) rt.dropWork(sub);
					return `Could not post in "${room.name}": ${(failure as Error).message}`;
				}
				if (member && named.length === 0)
					return `Posted in "${room.name}", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.`;
				if (named.length > 0) {
					const turn = turnOf(exec);
					const earlier = calledInPosts.get(exec.agent?.id ?? "");
					const calls = new Map<string, string>(
						earlier !== undefined && earlier.turn === turn ? earlier.calls : [],
					);
					for (const id of named) calls.set(id, room.name);
					calledInPosts.set(exec.agent?.id ?? "", { turn, calls });
				}
				const asker = sub === undefined ? undefined : rt.botOf(state.works[work ?? ""]?.from)?.name;
				const waits = asker
					? ` End your turn when you have handed on everything: the replies bring you back to this work, and your answer goes to ${asker} once all of it is back.`
					: "";
				return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? "; their replies also come back to you as a new message when the round ends" : ", and nothing comes back to you"}.${waits}`;
			},
		}),
	);

	rt.teamTools.push(
		defineTool({
			name: "ask_user",
			description:
				"Show the user a short multiple-choice question card in the chat (the user can also type their own answer). Calling it ends your turn; the chosen answer arrives later as the user's next message.",
			parameters: {
				question: { type: "string", required: true, description: "One short question" },
				options: {
					type: "array",
					required: true,
					description: "Two to four answers",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							label: { type: "string", required: true, description: "Short answer shown on the option" },
							description: { type: "string", description: "Optional one-line explanation under the label" },
						},
					},
				},
				detail: { type: "string", description: "Optional one-line context shown under the question" },
				multiSelect: { type: "boolean", description: "Allow choosing several options" },
				allowCustom: { type: "boolean", description: "Also offer a field for an answer in the user's own words" },
			},
			execute: async (args, exec) => {
				await rt.load();
				const id = exec.agent?.id ?? "";
				if (rt.groupOwners.has(id))
					return "Question cards only work in your own chat. In a group, ask in your message instead.";
				if (!rt.chatOwners.has(id))
					return `Only Bots on the team can use ask_user. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`;
				const options = (Array.isArray(args.options) ? args.options : [])
					.map((option: unknown) =>
						typeof option === "string" ? { label: option } : ((option as Record<string, unknown>) ?? {}),
					)
					.map((option: Record<string, unknown>) => ({
						label: String(option.label ?? "").trim(),
						...(option.description ? { description: String(option.description).trim() } : {}),
					}))
					.filter((option: { label: string }) => option.label !== "")
					.slice(0, 6);
				if (options.length === 0) return "Give at least one option.";
				// A hidden Bot-to-Bot turn shows none of its calls, so its card goes to the
				// composer dock, which takes questions without a call.
				const turn = liveOf(id)?.turn;
				const hidden = turn !== undefined && (state.exchangeTurns[id] ?? []).includes(turn);

				// keyed by Session (channel.ts reads it that way); shared/state.ts types the
				// draft M1 shape, so this write is typed through the public shape.
				const questions = state.questions as unknown as Record<string, Record<string, unknown>>;
				questions[id] = {
					id: randomUUID(),
					...(exec.callId && !hidden ? { callId: exec.callId } : {}),
					question: String(args.question ?? "").trim(),
					...(args.detail ? { detail: String(args.detail).trim() } : {}),
					options,
					multiSelect: args.multiSelect === true,
					...(args.allowCustom === true ? { allowCustom: true } : {}),
					askedAt: Date.now(),
				};
				await rt.save();
				exec.concludeTurn?.();
				return "The card is on screen; the user's answer arrives as their next message.";
			},
		}),
	);

	// Scoped per Bot session, not global: another plugin's global show_view serves the
	// sessions ocean-crew does not own, while this one shadows it inside them.
	rt.teamTools.push(
		defineTool({
			name: "show_view",
			description: SHOW_VIEW_DESCRIPTION,
			parameters: showViewParameters,
			execute: async (args, exec) => {
				await rt.load();
				const id = exec.agent?.id ?? "";
				if (rt.groupOwners.has(id))
					return "View cards only work in your own chat. In a group, ask in your message instead.";
				if (!rt.chatOwners.has(id))
					return `Only Bots on the team can use show_view. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`;
				const checked = checkShownView(args.title, args.view);
				if (checked.error !== undefined) return checked.error;
				const title = checked.title ?? "";
				const view = checked.view ?? {};
				if (!checked.interactive && args.await_reply === true)
					return "This view has nothing to submit; call show_view with await_reply: false.";
				if (checked.interactive && args.await_reply === false)
					return "This view has controls to submit, so it waits for the user's answer; call show_view without await_reply: false.";
				const awaitReply = args.await_reply ?? checked.interactive;
				if (!awaitReply) return "The view is on screen.";
				// A hidden Bot-to-Bot turn shows none of its calls, so its card goes to the
				// composer dock, which takes a card without a call.
				const turn = liveOf(id)?.turn;
				const hidden = turn !== undefined && (state.exchangeTurns[id] ?? []).includes(turn);
				const views = state.views as unknown as Record<string, Record<string, unknown>>;
				views[id] = {
					id: randomUUID(),
					...(exec.callId && !hidden ? { callId: exec.callId } : {}),
					title,
					view,
					askedAt: Date.now(),
				};
				await rt.save();
				exec.concludeTurn?.();
				return "The view is on screen; the user's answer arrives as their next message.";
			},
		}),
	);

	// A file the user should get where they are talking: an IM chat the current request
	// came from. The host keeps the bytes and the origin routing; this tool is the way a
	// Bot hands a result over without waiting for the user to come back to the desktop.
	rt.teamTools.push(
		defineTool({
			name: "speak",
			description:
				"Speak a short line in the IM chat this request came from, as a voice message (text to speech). Use it when the user asks to hear something, or when a short spoken answer is friendlier than text. It needs the speech model configured on this computer; a conversation that is not linked to IM gets a note instead of a message. Keep it to one or two sentences.",
			parameters: {
				text: {
					type: "string",
					description: "What to say, in plain text without markdown, up to about 1000 characters",
				},
			},
			execute: async (args, exec) => {
				await rt.load();
				const words = String(args.text ?? "").trim();
				if (words === "") return "Give the words to speak.";
				if (typeof (rt as Record<string, any>).speak !== "function")
					return "Text to speech is not configured; answer in text instead.";
				const id = exec.agent?.id ?? "";
				// The chat's platform decides the container: Feishu draws a voice bubble only
				// from opus, while a plain audio file plays anywhere.
				const plan: any = (rt as Record<string, any>).imVoicePlan?.(id);
				let audio: { bytes: Buffer; name: string };
				try {
					audio = await (rt as Record<string, any>).speak(words, plan?.format);
				} catch (error: any) {
					return `Nothing was spoken: ${error?.message ?? error}`;
				}
				// The queue carries a queue-safe copy, so the spoken file lives in the plugin
				// home until the send settles and then goes away.
				const dir = join(rt.home, "voice");
				await mkdir(dir, { recursive: true });
				const path = join(dir, `${randomUUID()}-${audio.name}`);
				await writeFile(path, audio.bytes, { mode: 0o600 });
				try {
					const voiceItem = (rt.config as Record<string, any>)?.tts?.voiceItem === true;
					const result = await rt.imSendFile(id, { path, name: audio.name, voice: voiceItem });
					// The audio arrives on its own: the reply says nothing about the tool, the
					// fact that it was a voice, or what it contained. Announcing it is what made
					// a spoken line read like a system notice instead of someone talking.
					return result.sent > 0
						? "Delivered. Say nothing about the voice message, the tool, or its delivery: it already arrived, and the reply should read as if you simply spoke."
						: `Nothing was sent: ${result.reason ?? "this conversation is not linked to an IM chat"}.`;
				} catch (error: any) {
					return `The voice message was not sent: ${error?.message ?? error}`;
				} finally {
					await rm(path, { force: true }).catch(() => undefined);
				}
			},
		}),
		defineTool({
			name: "send_file",
			description:
				"Send a file from your computer to the chat this request came from, after a report, a chart or an archive. It goes to the IM chat the user is writing from, or to the group chat that asked, and only to them; in a conversation that is not linked to IM it returns a note saying so instead of sending anything. Give the path the way your shell sees it (absolute, or relative to the current folder). Optionally add one line of text to send with it. The chat receives the file itself, so never paste the local path into your reply — the user cannot open a path on this computer from their phone.",
			parameters: {
				path: {
					type: "string",
					description: "The file to send: an absolute path, or one relative to your current folder",
				},
				note: { type: "string", description: "Optional one-line message to send with the file" },
			},
			execute: async (args, exec) => {
				await rt.load();
				const id = exec.agent?.id ?? "";
				const path = String(args.path ?? "").trim();
				if (path === "") return "Give the path of the file to send.";
				const send = (rt as Record<string, any>).imSendFile;
				if (typeof send !== "function") return "This host cannot send files; attach it in your reply instead.";
				try {
					const result = await send(id, { path, note: String(args.note ?? "").trim() });
					return result.sent > 0
						? "The file is on its way to the chat that asked. Do not print its local path in your reply: the file arrives as an attachment."
						: `Nothing was sent: ${result.reason ?? "this conversation is not linked to an IM chat"}. Attach it in your reply instead.`;
				} catch (error: any) {
					return `The file was not sent: ${error?.message ?? error}`;
				}
			},
		}),
	);

	// The team tools live in each Session's own scope, never in the global layer: a Bot's
	// chat and a member's group Session get all of them, a group's own Session gets only
	// its relay, and a Session ocean-crew does not own gets none — so they never appear in
	// a plain dsh conversation, and another plugin's same-named global tool can neither
	// collide with them at boot nor shadow them inside these Sessions. What is scoped onto
	// a Session is kept by its disposers and goes with the ownership: the save hook runs
	// syncScopedTools on every save and adopt, so a deleted Bot's adopted Session, a
	// member who left, or a deleted group shows the plain dsh surface again — and the
	// unload effect lifts whatever is left. The same sync scopes the live Agents back: a
	// reload lifts their scope while they are still live, and agent/created does not fire
	// for them again, so without the walk their next request would come without the team
	// tools.
	const scoped = new Map<string, Held>();
	const unscope = (id: string): void => {
		const held = scoped.get(id);
		if (held === undefined) return;
		scoped.delete(id);
		for (const dispose of held.disposers) {
			try {
				dispose();
			} catch (error) {
				rt.warn("ocean-crew: a scoped tool of %s was not removed: %s", id, error);
			}
		}
	};
	const syncScopedTools = (): void => {
		for (const id of [...scoped.keys()]) {
			if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) unscope(id);
		}
		// A reload lifts the scope of Agents that are still live, and an adopted file can
		// newly own one that already runs: scope each live Agent the team owns before its
		// next request. hideBotUnusedTools does nothing for a Session that stays unowned,
		// and nothing twice for one already scoped.
		const agents = ctx.get("agents") as { list?: () => AgentLike[] } | undefined;
		for (const agent of agents?.list?.() ?? []) hideBotUnusedTools(agent);
	};
	ctx.effect(
		() => () => {
			for (const id of [...scoped.keys()]) unscope(id);
		},
		"ocean-crew: scoped team tools",
	);

	// A wanted Session whose Agent cannot take scoped tools yet is warned about once;
	// held.tools stays unset, so the next step's check tries again.
	const registerless = new WeakSet<object>();
	const shareBotTools = (agent: AgentLike | undefined): void => {
		if (agent === undefined) return;
		const id = agent.session?.id ?? "";
		const owns = rt.isBotSession(id);
		const relayOnly = !owns && rt.roomOf(id) !== undefined;
		const wanted = owns || relayOnly;
		let held = scoped.get(id);
		// A Session that left the team, a scope of the wrong kind, or a fresh Agent for one
		// Session starts over; a wanted scope is registered again below.
		if (held !== undefined && (!wanted || held.agent !== agent || held.relay !== relayOnly)) {
			unscope(id);
			held = undefined;
		}
		if (!wanted || held?.tools === true) return;
		const surface = agent.ctx?.tools;
		if (typeof surface?.register !== "function") {
			if (!registerless.has(agent)) {
				registerless.add(agent);
				rt.warn("ocean-crew: %s needs the team tools but its Agent cannot register them yet", id);
			}
			return;
		}
		const disposers: Array<() => void> = [];
		const failed: string[] = [];
		const registered: string[] = [];
		for (const def of rt.teamTools) {
			if (relayOnly && def.name !== "group_relay") continue;
			try {
				const dispose = surface.register(def);
				if (typeof dispose === "function") {
					disposers.push(dispose);
					held ??= holdOf(relayOnly);
					held.toolLifts ??= new Map();
					held.toolLifts.set(def.name, dispose);
				}
				registered.push(def.name);
			} catch (error) {
				// A tool another plugin already scoped onto this agent stays missing rather
				// than stopping the team; the rest still land.
				failed.push(`${def.name}: ${(error as Error).message ?? error}`);
			}
		}
		held ??= holdOf(relayOnly);
		held.agent = agent;
		held.relay = relayOnly;
		held.tools = true;
		held.disposers.push(...disposers);
		scoped.set(id, held);
		// A scope made outside creation never reached a collected tool list; the assemble
		// adds the pending names to the step's list once, then clears them.
		for (const name of registered) held.unlisted.add(name);
		if (failed.length > 0) rt.warn("ocean-crew: team tools not served to %s: %s", id, failed.join("; "));
	};

	// The standard preset registers `subagent` (model selection) in each Agent's own scope,
	// where restrict() and a same-name section cannot reach it, so the Bot's assembly drops
	// the hidden tools and their guidance instead. restrict still masks what it can, so
	// lookup and execution stay aligned, and the guard refuses calls. The assembly filter
	// goes on every Bot Session whether or not the tools are served yet: subagent's own
	// agent/created listener can run after this one.
	const filterBotAssembly = (agent: AgentLike, held: Held): void => {
		if (held.filtered === true || typeof agent.ctx?.on !== "function") return;
		const dispose = agent.ctx.on(
			"system-prompt/assemble",
			async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
				const assembled = await next();
				// DSH 0.2.2 adds the tool list after this waterfall, so only an older assembly
				// still carries tools to drop here.
				return {
					...assembled,
					...(Array.isArray(assembled.tools)
						? { tools: assembled.tools.filter((tool: { name: string }) => !HIDDEN_TOOLS.includes(tool.name)) }
						: {}),
					sections: assembled.sections.filter((section: { name: string }) => !HIDDEN_SECTIONS.has(section.name)),
				};
			},
		);
		held.filtered = true;
		if (typeof dispose === "function") held.disposers.push(dispose);
	};

	// Tools joined after the first scoping (mail tools appear when the first account is
	// added) register into every held Agent and are offered once.
	const addTeamTool = (def: TeamTool): void => {
		if (rt.teamTools.some((tool) => tool.name === def.name)) return;
		rt.teamTools.push(def);
		for (const held of scoped.values()) {
			const surface = held.agent?.ctx?.tools;
			if (held.relay || typeof surface?.register !== "function") continue;
			try {
				const dispose = surface.register(def);
				if (typeof dispose === "function") {
					held.disposers.push(dispose);
					held.toolLifts ??= new Map();
					held.toolLifts.set(def.name, dispose);
				}
				held.unlisted.add(def.name);
			} catch {
				// an agent that refuses it simply lacks the tool
			}
		}
	};
	const removeTeamTool = (name: string): void => {
		const at = rt.teamTools.findIndex((tool) => tool.name === name);
		if (at !== -1) rt.teamTools.splice(at, 1);
		// Scoped registrations already handed out are disposed by name.
		for (const held of scoped.values()) {
			held.toolLifts?.get(name)?.();
			held.toolLifts?.delete(name);
			held.unlisted.delete(name);
		}
	};

	// Per-Bot connector switches (state.connectors[id].offFor): deny the served tools
	// matching each off connector's prefix. Re-applied on tools/change.
	const maskConnectorTools = (agent: AgentLike, held: Held): void => {
		const surface = agent.ctx?.tools;
		if (typeof surface?.restrict !== "function" || typeof tools.schemas !== "function") return;
		const botId = rt.selfOf(agent.session?.id);
		const prefixes: string[] = rt.connectorOffFor?.(botId) ?? [];
		const served = new Set(tools.schemas(agent).map((schema) => schema.name));
		const deny = [...served].filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
		const before = held.connectorDenied ?? new Set<string>();
		if (deny.length === before.size && deny.every((name) => before.has(name))) return;
		for (const lift of held.connectorLifts ?? []) {
			try {
				lift();
			} catch {
				// already lifted
			}
		}
		held.connectorLifts = [];
		held.connectorDenied = new Set(deny);
		for (const name of deny) {
			try {
				const lift = surface.restrict({ deny: [name] });
				if (typeof lift === "function") held.connectorLifts.push(lift as () => void);
			} catch {
				// a scoped name cannot be restricted; connectors are global
			}
		}
	};
	const reapplyToolMasks = (): void => {
		for (const held of scoped.values()) {
			if (held.agent === undefined) continue;
			try {
				maskConnectorTools(held.agent, held);
			} catch (error) {
				rt.warn("ocean-crew: connector mask failed: %s", error);
			}
		}
	};

	// restrict() throws on a name this profile does not serve.
	const maskHiddenTools = (agent: AgentLike, held: Held, served: Set<string>): void => {
		const surface = agent.ctx?.tools;
		if (typeof surface?.restrict !== "function") return;
		const groups = HIDDEN_TOOL_GROUPS.map((group) => group.filter((name) => served.has(name))).filter(
			(group) => group.length > 0,
		);
		if (groups.length === 0) return;
		// Marked after one attempt even when a group fails, so a profile that can never
		// mask it is not re-masked on every resolve.
		held.restricted = true;
		for (const deny of groups) {
			try {
				const lift = surface.restrict({ deny: [...deny] });
				if (typeof lift === "function") held.disposers.push(lift as () => void);
			} catch {
				// A name in the Agent's own scope fails the whole list (restrict() masks
				// inherited tools only), so mask the rest one at a time; what stays is covered
				// by the assembly filter and the guard.
				for (const name of deny) {
					try {
						const lift = surface.restrict({ deny: [name] });
						if (typeof lift === "function") held.disposers.push(lift as () => void);
					} catch {
						// Expected for names in the Agent's own scope.
					}
				}
			}
		}
	};

	// dsh's own question tool holds the turn open until the user answers, and every message
	// from another Bot or a group round queues behind it. Bot Sessions ask through ask_user
	// instead, so it is taken out of their tool list, as are the goal and delegation tools.
	// The restricts are kept with the Session's scope, so they lift with it.
	const hideBotUnusedTools = (agent: AgentLike | undefined): void => {
		shareBotTools(agent);
		const id = agent?.session?.id;
		// The shell shadows go with the scope, so a reload or a Session that leaves the team
		// lifts them like the rest, and the Agent can be scoped again.
		const shadows: Array<() => void> = rt.shadowShells?.(agent) ?? [];
		if (shadows.length > 0 && id !== undefined) {
			const held = scoped.get(id) ?? holdOf(false);
			held.agent = agent;
			held.disposers.push(...shadows);
			scoped.set(id, held);
		}
		if (agent === undefined || !rt.isBotSession(id)) return;
		const held = scoped.get(id ?? "") ?? holdOf(false);
		held.agent = agent;
		scoped.set(id ?? "", held);
		filterBotAssembly(agent, held);
		if (
			held.restricted !== true &&
			typeof agent.ctx?.tools?.restrict === "function" &&
			typeof tools.schemas === "function"
		)
			maskHiddenTools(agent, held, new Set(tools.schemas(agent).map((schema) => schema.name)));
		maskConnectorTools(agent, held);
	};
	ctx.on("tools/change", () => reapplyToolMasks());
	// A new Bot, part, or group Session gets its Agent before ocean-crew records it, so the
	// recording path resolves it again once the session is known as a Bot's; meanwhile the
	// guard refuses the question and delegation tools in any Bot Session, and a goal made
	// there is blocked.
	tools.guard?.((exec) => {
		if (!rt.isBotSession(exec.agent?.id)) return undefined;
		if (exec.name === BLOCKING_QUESTION_TOOL)
			return `Bots cannot use ${BLOCKING_QUESTION_TOOL}. Ask with ask_user in your own chat, or ask in your reply.`;
		const target = exec.arguments?.target;
		if (SCHEDULE_TARGET_TOOLS.includes(exec.name ?? "") && target !== undefined && target !== "this_session")
			return SCHEDULE_TARGET_REFUSAL;
		return DELEGATION_TOOLS.includes(exec.name ?? "") ? DELEGATION_REFUSAL : undefined;
	});
	// Creation waits for this listener, so the Agent's first step already lacks the tool.
	listenGlobal(ctx, "agent/created", async ({ agent }: { agent?: AgentLike }) => {
		try {
			await rt.load();
			hideBotUnusedTools(agent);
			// Creation runs before the first step collects the tool list, so the names just
			// registered will already be in it; nothing stays pending.
			scoped.get(agent?.session?.id ?? "")?.unlisted.clear();
		} catch (error) {
			rt.warn("ocean-crew: hiding %s on agent/created failed: %s", HIDDEN_TOOLS.join(", "), error);
		}
	});

	// A live Agent the creation path missed — after a restart, agent/created may run before
	// this plugin's listeners are back — is scoped by the load or here, before the step's
	// request. The request's tool list was collected before this waterfall, so names scoped
	// since are added now: a same-named global entry is replaced by the scoped schema, and a
	// PTC list that reaches team tools through run_code is left alone.
	ctx.on(
		"system-prompt/assemble",
		async function scopeTeamTools(_assembly: unknown, context: { agent?: AgentLike }, next: () => Promise<any>) {
			const agent = context.agent;
			if (agent === undefined) return next();
			try {
				await rt.load();
				hideBotUnusedTools(agent);
			} catch (error) {
				rt.warn("ocean-crew: scoping the tools of %s failed: %s", agent.session?.id ?? agent.id, error);
			}
			const assembled = await next();
			const held = scoped.get(agent.session?.id ?? "");
			if (held?.unlisted === undefined || held.unlisted.size === 0) return assembled;
			// DSH 0.2.2 collects the scoped tools itself after this waterfall.
			if (!Array.isArray(assembled.tools)) {
				held.unlisted.clear();
				return assembled;
			}
			const pending = [...held.unlisted];
			// Cleared whatever happens below: the names are offered once, not on every step.
			held.unlisted.clear();
			if ((assembled.tools ?? []).some((tool: { name: string }) => tool.name === "run_code")) return assembled;
			if (typeof tools.schemas !== "function") return assembled;
			try {
				const wanted = new Set(pending);
				const current = new Map(
					tools
						.schemas(agent)
						.filter((schema) => wanted.has(schema.name))
						.map((schema) => [schema.name, schema]),
				);
				let changed = false;
				const list = (assembled.tools ?? []).map((tool: { name: string }) => {
					const schema = current.get(tool.name);
					if (schema === undefined) return tool;
					changed = true;
					return schema;
				});
				const present = new Set((assembled.tools ?? []).map((tool: { name: string }) => tool.name));
				for (const name of pending) {
					if (present.has(name) || !current.has(name)) continue;
					changed = true;
					list.push(current.get(name));
				}
				return changed ? { ...assembled, tools: list } : assembled;
			} catch (error) {
				rt.warn("ocean-crew: listing the scoped tools of %s failed: %s", agent.session?.id ?? agent.id, error);
				return assembled;
			}
		},
	);

	// The /goal command stays open in every Session, so a goal started in a Bot chat or a
	// group is blocked at once; DSH's round driver then starts no round for it.
	let goals: GoalsService | null = null;
	const attachGoals = (sub: {
		goals?: GoalsService;
		effect?: (execute: () => unknown, label?: string) => void;
	}): void => {
		const own = sub.goals;
		goals = own ?? null;
		sub.effect?.(
			() => () => {
				if (goals === own) goals = null;
			},
			"ocean-crew: goal service",
		);
	};
	if (typeof ctx.inject === "function") ctx.inject(["goals"], attachGoals);
	else if (ctx.get("goals") !== undefined)
		attachGoals({ goals: ctx.get("goals") as GoalsService, effect: (execute, label) => ctx.effect(execute, label) });
	const blockGoal = async (sessionId: string): Promise<void> => {
		const service = goals;
		if (service === null) return;
		try {
			const agent = await agentOf(sessionId);
			const goal = service.get(agent);
			if (goal?.phase !== "active") return;
			service.block(
				agent,
				{ id: goal.id, revision: goal.revision },
				{ code: "not-supported", message: GOAL_REFUSAL },
			);
		} catch (error) {
			rt.warn("ocean-crew: blocking the goal in %s failed: %s", sessionId, error);
		}
	};
	ctx.on(
		"session/event",
		(session: { id?: string }, event: { type?: string; data?: { goal?: { phase?: string } } }) => {
			if (event.type !== "goal/change" || event.data?.goal?.phase !== "active") return;
			const id = session?.id;
			if (id === undefined || (!rt.isBotSession(id) && rt.roomOf(id) === undefined)) return;
			// block() appends to the same log, so it waits until every listener has seen this
			// change.
			setTimeout(() => void blockGoal(id), 0);
		},
	);

	Object.assign(rt, {
		pickRoom,
		hideBotUnusedTools,
		syncScopedTools,
		addTeamTool,
		removeTeamTool,
		reapplyToolMasks,
		// File links are absolute before they leave this Session; `links.ts` owns that
		// helper and publishes it for the turns module too.
	});
}
