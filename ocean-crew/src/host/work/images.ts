// Images for text-only models. Every model may take images; before a Session request
// reaches a model that cannot read them, each image becomes text from a vision model.
// Texts are kept per attachment, so later requests repeat the same words and the
// prompt cache still hits.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { OCR_CACHE_MAX, OCR_PROMPT, OCR_RETRY_MS, OCR_TIMEOUT_MS } from "../core/constants.ts";
import { listenGlobal } from "../core/events.ts";
import { replaceFile } from "../core/files.ts";
import type { Runtime } from "../core/runtime.ts";
import { splitRef } from "../core/text.ts";
import type { ModelEntry } from "../team/models.ts";

/** Attached bytes one content block points at. */
export interface ImageAttachment {
	attachmentId: string;
	name?: string;
	[key: string]: unknown;
}

/** One content block of a message, as much of it as this module reads. */
interface ContentBlock {
	type?: string;
	offloaded?: boolean;
	attachment?: ImageAttachment;
	[key: string]: unknown;
}

/** One message as the llm request carries it. */
interface MessageLike {
	role?: string;
	content?: ContentBlock[];
	[key: string]: unknown;
}

/** The part of a Session `offloadTargets` reads. */
interface OffloadSession {
	surface: { nodes: readonly number[] };
	eventAt(seq: number): { type?: string; [key: string]: unknown } | undefined;
	deriveEventMessage(event: unknown): { content?: ContentBlock[] } | undefined;
}

/** Where one old message's live images are: its seq and the image block positions. */
export interface OffloadTarget {
	seq: number;
	imageIndexes: number[];
}

interface LlmService {
	stream(options: Record<string, unknown>): AsyncIterable<unknown>;
	resolveModelInfo?(provider: string, model: string): Promise<{ inputModalities?: readonly string[] } | undefined>;
}

interface AttachmentsService {
	imageHostPath?(attachment: ImageAttachment): string | undefined;
}

interface FsService {
	processPathFromHostPath?(path: string): string | undefined;
}

interface SessionsService {
	messageProjections?: readonly { type?: string }[];
	flush(session: unknown): Promise<unknown>;
}

interface AgentSessionLike {
	seq?: number;
	append(type: string, data: unknown): void;
}

/** What a vision model read out of one attachment. */
export interface ImageReading {
	text: string;
	model: string;
}

interface OcrRoute {
	ref: string;
	provider: string;
	model: string;
}

const errorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
};

// messages' images, and only those not already offloaded.
export function offloadTargets(session: OffloadSession, beforeSeq: number): OffloadTarget[] {
	const targets: OffloadTarget[] = [];
	for (const seq of session.surface.nodes) {
		if (seq >= beforeSeq) continue;
		const event = session.eventAt(seq);
		if (event?.type !== "user/message" && event?.type !== "tool/result") continue;
		const message = session.deriveEventMessage(event);
		const imageIndexes: number[] = [];
		let imageIndex = 0;
		for (const block of message?.content ?? []) {
			if (block?.type !== "image") continue;
			if (block.offloaded !== true) imageIndexes.push(imageIndex);
			imageIndex += 1;
		}
		if (imageIndexes.length > 0) targets.push({ seq, imageIndexes });
	}
	return targets;
}

export function install(rt: Runtime): void {
	const { ctx, config, home } = rt;
	const llm = (): LlmService => ctx.llm as unknown as LlmService;
	const sessions = (): SessionsService | undefined => ctx.sessions as unknown as SessionsService | undefined;
	const attachments = (): AttachmentsService | undefined => ctx.get?.("attachments") as AttachmentsService | undefined;
	const fsService = (): FsService | undefined => ctx.get?.("fs") as FsService | undefined;

	// `textOnlyModels` names models whose provider claims image input but rejects it.
	const textOnlyModels = new Set(config.textOnlyModels ?? []);
	const ocrPath = join(home, "ocr.json");
	let ocrCache: Map<string, ImageReading> | null = null;
	let ocrWriting: Promise<void> = Promise.resolve();
	const ocrPending = new Map<string, Promise<ImageReading | null>>();
	const ocrFailed = new Map<string, { at: number }>();

	const liveImages = (message: MessageLike | undefined): boolean =>
		Array.isArray(message?.content) && message.content.some((block) => block?.type === "image" && !block.offloaded);

	async function readsImages(provider: string, model: string): Promise<boolean> {
		if (textOnlyModels.has(`${provider}/${model}`)) return false;
		try {
			const info = await llm().resolveModelInfo?.(provider, model);
			return info?.inputModalities === undefined || info.inputModalities.includes("image");
		} catch {
			return true;
		}
	}

	// The configured `ocrModel` first, then served models that declare image input, the
	// DSH default among them first. A provider with no key set is skipped.
	async function ocrRoute(): Promise<OcrRoute | undefined> {
		const models = ((await rt.catalog()) as ModelEntry[]).filter(
			(entry) => entry.needsKey !== true && rt.isLocalAgentRef?.(entry.ref) !== true,
		);
		const served = new Set(models.map((entry) => entry.ref));
		const declared = models.filter((entry) => entry.input?.includes("image")).map((entry) => entry.ref);
		const fallback = rt.defaultRef();
		for (const ref of new Set([config.ocrModel, ...declared.filter((item) => item === fallback), ...declared])) {
			const route = splitRef(ref);
			if (route && served.has(ref as string) && (await readsImages(route.provider, route.model)))
				return { ref: ref as string, ...route };
		}
		return undefined;
	}

	async function loadOcr(): Promise<void> {
		if (ocrCache !== null) return;
		try {
			ocrCache = new Map(
				Object.entries(JSON.parse(await readFile(ocrPath, "utf8")) as Record<string, ImageReading>),
			);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") rt.warn("ocean-crew: unreadable OCR cache %s: %s", ocrPath, error);
			ocrCache = new Map();
		}
	}

	function saveOcr(): void {
		const cache = ocrCache as Map<string, ImageReading>;
		while (cache.size > OCR_CACHE_MAX) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		const snapshot = JSON.stringify(Object.fromEntries(cache));
		ocrWriting = ocrWriting
			.then(async () => {
				await mkdir(home, { recursive: true });
				const temp = `${ocrPath}.${process.pid}.tmp`;
				await writeFile(temp, snapshot, "utf8");
				await replaceFile(temp, ocrPath);
			})
			.catch((error) => rt.warn("ocean-crew: OCR cache write failed: %s", error));
	}

	// `sessionId` is the Session the reading is for; its usage counts there.
	async function readImage(attachment: ImageAttachment, sessionId: string): Promise<ImageReading> {
		const route = await ocrRoute();
		if (route === undefined) throw new Error("no vision model is available");
		const assembler = new BlockAssembler();
		const messages = [
			{
				role: "user",
				content: [
					{ type: "image", attachment },
					{ type: "text", text: OCR_PROMPT },
				],
			},
		];
		const tagged = typeof rt.tagUsage === "function" ? rt.tagUsage(messages, { sessionId, kind: "image" }) : messages;
		for await (const chunk of llm().stream({
			provider: route.provider,
			model: route.model,
			sessionId,
			messages: tagged,
			maxTokens: 8192,
			signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
		}))
			assembler.push(chunk as never);
		const finish = assembler.finish;
		if (finish.kind === "error" || finish.kind === "aborted")
			throw new Error((finish as { failure?: { message?: string } }).failure?.message ?? finish.kind);
		const text = assembler
			.blocks()
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("\n")
			.trim();
		if (text === "") throw new Error("the vision model returned no text");
		const model =
			((await rt.catalog()) as ModelEntry[]).find((entry) => entry.ref === route.ref)?.name ?? route.model;
		return { text, model };
	}

	// Resolves to the cached reading, or to null when the image cannot be read now.
	async function imageReading(attachment: ImageAttachment, sessionId: string): Promise<ImageReading | null> {
		const cache = ocrCache as Map<string, ImageReading>;
		const id = String(attachment.attachmentId);
		if (cache.has(id)) return cache.get(id) as ImageReading;
		const failed = ocrFailed.get(id);
		if (failed && Date.now() - failed.at < OCR_RETRY_MS) return null;
		if (!ocrPending.has(id)) {
			ocrPending.set(
				id,
				readImage(attachment, sessionId)
					.then(
						(reading) => {
							cache.set(id, reading);
							ocrFailed.delete(id);
							saveOcr();
							return reading;
						},
						(error) => {
							rt.warn("ocean-crew: could not read image %s: %s", id, error);
							ocrFailed.set(id, { at: Date.now() });
							return null;
						},
					)
					.finally(() => ocrPending.delete(id)),
			);
		}
		return ocrPending.get(id) as Promise<ImageReading | null>;
	}

	const imageLabel = (attachment: ImageAttachment): string =>
		attachment.name
			? `"${attachment.name}"`
			: `sha256:${String(attachment.attachmentId).slice("sha256:".length, "sha256:".length + 8)}`;

	function imagePath(attachment: ImageAttachment): string | undefined {
		try {
			const hostPath = attachments()?.imageHostPath?.(attachment);
			if (hostPath === undefined) return undefined;
			return fsService()?.processPathFromHostPath?.(hostPath) ?? hostPath;
		} catch {
			return undefined;
		}
	}

	function imageAsText(attachment: ImageAttachment, reading: ImageReading | null): ContentBlock {
		const label = imageLabel(attachment);
		const path = imagePath(attachment);
		const saved = path === undefined ? "" : ` Read-only copy saved at ${JSON.stringify(path)}.`;
		return {
			type: "text",
			text:
				reading === null
					? `[Image ${label}: you cannot see images and it could not be read right now.${saved} Ask the user what it shows if it matters.]`
					: `[Image ${label}.${saved} You cannot see images, so ${reading.model} read it for you:]\n${reading.text}\n[End of image ${label}]`,
		};
	}

	// Members read the group as text, so a picture posted there reaches every member,
	// vision model or not, as its reading; the image block itself also rides with the
	// prompt for members whose model or tools can inspect it directly.
	async function imagesForGroup(attachments: readonly ImageAttachment[], sessionId: string): Promise<string[]> {
		await loadOcr();
		return Promise.all(
			attachments.map(async (attachment) => {
				const reading = await imageReading(attachment, sessionId);
				const label = imageLabel(attachment);
				const path = imagePath(attachment);
				const saved = path === undefined ? "" : ` (read-only copy saved at ${JSON.stringify(path)})`;
				return reading === null
					? `[Image ${label}${saved}: it could not be read right now. Ask the user what it shows if it matters.]`
					: `[Image ${label}${saved}, read by ${reading.model}:]\n${reading.text}\n[End of image ${label}]`;
			}),
		);
	}

	async function withImagesAsText(messages: MessageLike[], sessionId: string): Promise<MessageLike[]> {
		await loadOcr();
		const images = new Map<string, ImageAttachment>();
		for (const message of messages) {
			if (!liveImages(message)) continue;
			for (const block of message.content ?? []) {
				if (block?.type === "image" && !block.offloaded && block.attachment !== undefined)
					images.set(String(block.attachment.attachmentId), block.attachment);
			}
		}
		const readings = new Map(
			await Promise.all(
				[...images].map(
					async ([id, attachment]): Promise<[string, ImageReading | null]> => [
						id,
						await imageReading(attachment, sessionId),
					],
				),
			),
		);
		return messages.map((message) =>
			liveImages(message)
				? {
						...message,
						content: (message.content ?? []).map((block) =>
							block?.type === "image" && !block.offloaded && block.attachment !== undefined
								? imageAsText(block.attachment, readings.get(String(block.attachment.attachmentId)) ?? null)
								: block,
						),
					}
				: message,
		);
	}

	listenGlobal(ctx, "llm/stream", (options: Record<string, any>, next: () => AsyncIterable<unknown>) => {
		if (
			options.sessionId === undefined ||
			rt.ownRequest?.(options) === true ||
			!(options.messages ?? []).some(liveImages)
		)
			return next();
		return (async function* imagesAsTextOrPass(): AsyncGenerator<unknown> {
			await rt.load();
			if (rt.roomOf(options.sessionId) !== undefined || (await readsImages(options.provider, options.model))) {
				yield* next();
				return;
			}
			// `next` cannot take new messages, so the rewritten request starts over; it
			// carries no image, so this listener lets it through.
			yield* llm().stream({
				...options,
				messages: await withImagesAsText(options.messages as MessageLike[], options.sessionId),
			});
		})();
	});

	ctx.on(
		"agent/status",
		({ agent, status }: { agent?: { id?: string; session?: AgentSessionLike }; status?: string }) => {
			if (status !== "idle" || !agent?.session || agent.id === undefined || !rt.isBotSession(agent.id)) return;
			if (rt.readOnly() !== undefined) return;
			const beforeSeq = Number(agent.session.seq);
			setImmediate(() => {
				void (async () => {
					try {
						const projections = sessions()?.messageProjections;
						if (!projections?.some((projection) => projection.type === "image/offload")) return;
						const targets = offloadTargets(agent.session as OffloadSession & AgentSessionLike, beforeSeq);
						if (targets.length === 0) return;
						agent.session?.append("image/offload", { targets });
						await sessions()?.flush(agent.session);
					} catch (error) {
						rt.warn("ocean-crew: old images for %s not offloaded: %s", agent.id, error);
					}
				})();
			});
		},
	);

	Object.assign(rt, { imagesForGroup, withImagesAsText });
}
