// The nested model of browser_task: it answers with the plugin's own tools, so a whole
// web task can run in one tool call while the outer Bot keeps the steps.

import { Buffer } from "node:buffer";
import {
	BlockAssembler,
	createAssistantMessage,
	createSystemMessage,
	createToolResultMessage,
	createUserMessage,
} from "@deepseek-ai/dsh-llm";

type Any = any;

const NO_SESSION_MODEL = "browser_task needs a Bot session model";
const OMITTED_IMAGE = "[Browser screenshot omitted.]";

/** The execution context of the browser_task tool call. */
export interface SessionModelExec {
	agent?: {
		session?: {
			id?: string;
			requestHeader?(): Any;
		};
	};
	signal?: AbortSignal;
}

/** The host context the nested model reads its LLM and attachments from. */
export interface SessionModelContext {
	get?(name: string): Any;
	attachments?: Any;
	llm: {
		stream(options: Any): AsyncIterable<Any>;
		resolveModelInfo?(provider: string, model: string): Promise<{ inputModalities?: string[] } | undefined>;
	};
}

/** The runtime bits the conversion reads: text-only routes and usage tags. */
export interface SessionModelRuntime {
	config?: { textOnlyModels?: string[] };
	tagUsage?(messages: Any[], options: { sessionId: string; kind: string }): Any[];
}

function routeOf(exec: SessionModelExec): { header: Any; sessionId: string } {
	const session = exec?.agent?.session;
	if (!session || typeof session.requestHeader !== "function" || typeof session.id !== "string") {
		throw new Error(NO_SESSION_MODEL);
	}
	let header: Any;
	try {
		header = session.requestHeader();
	} catch {
		throw new Error(NO_SESSION_MODEL);
	}
	if (!header?.config?.provider || !header.config.model) throw new Error(NO_SESSION_MODEL);
	return { header, sessionId: session.id };
}

function textParts(content: Any): string[] {
	if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text ?? "");
	return [typeof content === "string" ? content : String(content ?? "")];
}

function imageInput(part: Any): { mediaType: string; data: Buffer; name: string } | undefined {
	const url = part?.image_url?.url;
	if (typeof url !== "string") return undefined;
	const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
	if (!match) return undefined;
	return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], "base64"), name: "Browser screenshot" };
}

function attachmentsOf(ctx: SessionModelContext): Any {
	try {
		return ctx.get?.("attachments") ?? ctx.attachments;
	} catch {
		return ctx.attachments;
	}
}

async function userContent(
	content: Any,
	attachments: Any,
	readsImages: boolean,
): Promise<{ blocks: Any[]; sawImage: boolean; rejectedImage: boolean }> {
	const parts = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
	const blocks: Any[] = [];
	const pending: Array<{ index: number; input: Any }> = [];
	let sawImage = false;
	let rejectedImage = false;
	for (const part of parts) {
		if (part?.type === "text") {
			blocks.push({ type: "text", text: String(part.text ?? "") });
			continue;
		}
		if (part?.type === "image_url") {
			sawImage = true;
			if (!readsImages) {
				blocks.push({ type: "text", text: OMITTED_IMAGE });
				rejectedImage = true;
				continue;
			}
			const input = imageInput(part);
			if (!input || typeof attachments?.saveImages !== "function") {
				blocks.push({ type: "text", text: OMITTED_IMAGE });
				rejectedImage = true;
				continue;
			}
			pending.push({ index: blocks.length, input });
			blocks.push(undefined);
			continue;
		}
		if (part?.type) blocks.push({ type: "text", text: String(part.text ?? "") });
	}
	if (pending.length > 0) {
		try {
			const refs = await attachments.saveImages(pending.map((item) => item.input));
			pending.forEach((item, index) => {
				blocks[item.index] = { type: "image", attachment: refs[index] };
			});
		} catch {
			pending.forEach((item) => {
				blocks[item.index] = { type: "text", text: OMITTED_IMAGE };
			});
			rejectedImage = true;
		}
	}
	return { blocks: blocks.filter(Boolean), sawImage, rejectedImage };
}

function assistantContent(message: Any, config: Any): Any {
	const blocks: Any[] = textParts(message.content)
		.filter((text) => text !== "")
		.map((text) => ({ type: "text", text }));
	const reasoning = message.reasoning_content ?? message.reasoning;
	if (typeof reasoning === "string" && reasoning !== "") blocks.push({ type: "reasoning", text: reasoning });
	for (const call of message.tool_calls ?? []) {
		const fn = call.function ?? {};
		const args = fn.arguments;
		blocks.push({
			type: "tool-call",
			id: String(call.id ?? ""),
			name: String(fn.name ?? ""),
			arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
		});
	}
	// DSH's message helpers infer their literal content shapes; this payload is converted
	// from the OpenAI-compatible request the loop builds, so the cast is the invariant.
	return createAssistantMessage({
		content: blocks,
		source: { provider: config.provider, model: config.model },
	} as never);
}

async function dshMessages(
	messages: Any[],
	attachments: Any,
	config: Any,
	readsImages: boolean,
): Promise<{ messages: Any[]; sawImage: boolean; rejectedImage: boolean }> {
	const output: Any[] = [];
	let sawImage = false;
	let rejectedImage = false;
	for (const message of messages ?? []) {
		if (message.role === "system") {
			output.push(createSystemMessage(textParts(message.content).join("\n")));
		} else if (message.role === "user") {
			const content = await userContent(message.content, attachments, readsImages);
			output.push(createUserMessage({ content: content.blocks, source: { kind: "user" } } as never));
			sawImage ||= content.sawImage;
			rejectedImage ||= content.rejectedImage;
		} else if (message.role === "assistant") {
			output.push(assistantContent(message, config));
		} else if (message.role === "tool") {
			output.push(
				createToolResultMessage({
					callId: String(message.tool_call_id ?? ""),
					content: textParts(message.content).map((text) => ({ type: "text", text })),
					isError: false,
				} as never),
			);
		}
	}
	return { messages: output, sawImage, rejectedImage };
}

function driverTools(tools: Any[]): Any[] {
	return (tools ?? []).map((tool) => {
		const fn = tool.function ?? tool;
		return {
			name: String(fn.name ?? ""),
			description: String(fn.description ?? ""),
			parameters: fn.parameters ?? {},
		};
	});
}

async function routeReadsImages(
	ctx: SessionModelContext,
	config: Any,
	rt: SessionModelRuntime | undefined,
): Promise<boolean> {
	if (rt?.config?.textOnlyModels?.includes?.(`${config.provider}/${config.model}`)) return false;
	if (typeof ctx.llm?.resolveModelInfo !== "function") return true;
	try {
		const info = await ctx.llm.resolveModelInfo(config.provider, config.model);
		return info?.inputModalities === undefined || info.inputModalities.includes("image");
	} catch {
		return true;
	}
}

export function sessionComplete(ctx: SessionModelContext, exec: SessionModelExec, rt?: SessionModelRuntime) {
	return async ({ messages, tools }: { messages: Any[]; tools: Any[] }): Promise<Any> => {
		const { header, sessionId } = routeOf(exec);
		const hasImages = (messages ?? []).some(
			(message) => Array.isArray(message.content) && message.content.some((part: Any) => part?.type === "image_url"),
		);
		const readsImages = hasImages ? await routeReadsImages(ctx, header.config, rt) : true;
		const converted = await dshMessages(messages, attachmentsOf(ctx), header.config, readsImages);
		const requestMessages =
			typeof rt?.tagUsage === "function"
				? rt.tagUsage(converted.messages, { sessionId, kind: "browser-task" })
				: converted.messages;
		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream({
			...header.config,
			messages: requestMessages,
			tools: driverTools(tools),
			sessionId,
			signal: exec.signal,
		}))
			assembler.push(chunk);
		const finish: Any = assembler.finish;
		if (finish.kind === "error" || finish.kind === "aborted") {
			throw new Error(finish.failure?.message ?? finish.kind);
		}
		const blocks: Any[] = assembler.blocks();
		const text = blocks
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const reasoning = blocks
			.filter((block) => block.type === "reasoning")
			.map((block) => block.text)
			.join("\n");
		const toolCalls = blocks
			.filter((block) => block.type === "tool-call")
			.map((block) => ({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: block.arguments },
			}));
		const message: Any = { content: text };
		if (reasoning) message.reasoning_content = reasoning;
		if (toolCalls.length > 0) message.tool_calls = toolCalls;
		const vision = converted.sawImage
			? converted.rejectedImage || !readsImages
				? "rejected"
				: "accepted"
			: undefined;
		return {
			choices: [
				{
					message,
					finish_reason: toolCalls.length > 0 ? "tool_calls" : finish.kind === "max-tokens" ? "length" : "stop",
				},
			],
			...(vision ? { vision } : {}),
		};
	};
}
