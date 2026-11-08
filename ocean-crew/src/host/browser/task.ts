// One goal in, one answer out. The plugin runs the ref tools itself and returns
// the step list, so a Bot can hand off a whole web task and still check what happened.
import { type BrowserToolSpec, type LoopTraceStep, runToolLoop, type ToolLoopResult } from "./loop.ts";
import {
	type BrowserPluginTool,
	type RefToolContext,
	systemPrompt as refsPrompt,
	toolDefs as refTools,
} from "./refs.ts";

type Any = any;

const driverTools = (session: Any, origin: Any, handoffs: string[]): BrowserToolSpec[] =>
	refTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (args: Record<string, Any>) => {
			const value = await tool.execute(args, {
				session,
				botId: session.botId,
				profileDir: session.userDataDir,
				origin,
			});
			if (tool.name === "browser_handoff")
				handoffs.push(typeof value === "string" ? value : String(value?.text ?? ""));
			return value;
		},
	}));

export interface RunTaskResult extends ToolLoopResult {
	text: string;
}

export async function runTask({
	session,
	goal,
	complete,
	origin,
	maxSteps = 8,
}: {
	session: Any;
	goal: string;
	complete: (request: Any) => Promise<Any>;
	origin?: Any;
	maxSteps?: number;
}): Promise<RunTaskResult> {
	if (typeof complete !== "function") throw new Error("browser_task needs a Bot session model");
	const handoffs: string[] = [];
	const result = await runToolLoop({
		tools: driverTools(session, origin, handoffs),
		complete,
		goal,
		system: refsPrompt,
		maxSteps,
	});
	const steps = result.trace.map((step: LoopTraceStep) => `${step.name} ${JSON.stringify(step.args)}`).join("\n");
	const text = [
		result.answer || "(no answer)",
		"",
		// The outer Bot needs the handoff instructions even if the nested model omits them.
		...(handoffs.length > 0 ? ["Handoffs:", handoffs.join("\n"), ""] : []),
		result.stopped === "max-steps" ? `Stopped after ${result.steps} steps.` : `Finished in ${result.steps} steps.`,
		"Steps:",
		steps || "(none)",
	].join("\n");
	return { ...result, text };
}

export const id = "task";
export const label = "Whole task";
export const systemPrompt =
	"Call browser_task once with the user's web goal. The tool runs the browser and returns the answer plus the steps it took. Posting, uploading, downloading, and deleting may need approval; deletes require a second confirmed click after checking the snapshot. Payments, logins, and captchas go to the user via browser_handoff. If an action result is unknown, check with browser_snapshot and never repeat it blindly. Do not browse with any other tool.";

export const toolDefs: BrowserPluginTool[] = [
	{
		name: "browser_task",
		needsBrowser: true,
		description:
			"Run a whole web task in this Bot's browser: open pages, read them, click, and type. Returns the answer and the steps. Login, payment, and captcha are handed to the user.",
		parameters: {
			goal: {
				type: "string",
				required: true,
				description: "What to do on the web, including the address when you know it",
			},
		},
		async execute(args, ctx: RefToolContext & { complete?: (request: Any) => Promise<Any>; origin?: Any }) {
			const result = await runTask({
				session: ctx.session,
				goal: String(args.goal ?? ""),
				complete: ctx.complete as (request: Any) => Promise<Any>,
				origin: ctx.origin,
			});
			return { text: result.text };
		},
	},
];

export const tools = toolDefs;
