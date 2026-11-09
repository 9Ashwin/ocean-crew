// The live feed: a Server-Sent Events stream of what changes, for a window that draws
// the team itself (the desktop app) instead of polling.
//   hello     the stream opened: the current revision
//   revision  the team was saved: ask for `state` again
//   live      work changed without a new revision: ask for `state` again
//   message   a new entry of a Bot's own chat, as the `chat` endpoint returns it
//   stream    the reply a Bot is writing: a start, its text as it comes, an end
//

// owns. Until that module is installed the feed carries hello/revision/live/stream, which
// is what a window needs when nothing but the route is wired yet.
import { ROUTE } from "../core/constants.ts";
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";

export const FEED_ROUTE = `${ROUTE}/feed`;
// A comment line now and then keeps an idle connection open.
const KEEPALIVE_MS = 20_000;
// Status changes come in bursts (a turn starts several Sessions); one notice covers them.
const LIVE_DELAY_MS = 150;
// A window that stops reading is dropped once this many events wait for it; it reconnects
// and catches up from `hello`.
const MAX_QUEUED = 512;

// endpoint returns. The feed looks it up per event, so it may be installed after this
// module.
type DisplayItems = (sessionId: string, events: unknown[]) => unknown[];

// One frame of the assistant stream DSH reports while a Bot writes its reply.
interface AssistantFrame {
	type: string;
	attemptId: string;
	turn?: number;
	chunk?: { type?: string; text?: string };
}

interface AgentRef {
	id: string;
}

export function install(rt: Runtime): void {
	const { ctx, state } = rt;
	const encoder = new TextEncoder();
	const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	// A Request built on a caller's signal only follows it while the Request is reachable;
	// once collected, its abort never fires and the feed stays open. Each open feed keeps
	// its Request until it leaves.
	const requests = new Map<ReadableStreamDefaultController<Uint8Array>, Request>();
	// Attempts being streamed, by id. A turn that answers another Bot is hidden from the
	// chat (turns.ts marks it before the model is called), so its text is not streamed.
	const writing = new Map<string, { botId: string; sessionId: string }>();

	const leave = (controller: ReadableStreamDefaultController<Uint8Array> | undefined): void => {
		if (controller === undefined) return;
		clients.delete(controller);
		requests.delete(controller);
		if (clients.size === 0) writing.clear();
		try {
			controller.close();
		} catch {
			// Already closed or errored.
		}
	};

	const send = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void => {
		if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
			leave(controller);
			return;
		}
		try {
			controller.enqueue(chunk);
		} catch {
			// The stream was closed under us; drop the client so the next notice skips it.
			clients.delete(controller);
			requests.delete(controller);
		}
	};

	const publish = (event: string, data: unknown): void => {
		const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		for (const controller of clients) send(controller, chunk);
	};

	const offSaved = rt.onSaved(() => {
		if (clients.size > 0) publish("revision", { revision: state.revision });
	});

	let liveTimer: ReturnType<typeof setTimeout> | undefined;
	const live = (): void => {
		if (clients.size === 0 || liveTimer !== undefined) return;
		liveTimer = setTimeout(() => {
			liveTimer = undefined;
			publish("live", {});
		}, LIVE_DELAY_MS);
	};
	listenGlobal(ctx, "agent/status", ({ agent }: { agent: AgentRef }) => {
		if (rt.selfOf(agent.id) !== undefined) live();
	});

	listenGlobal(ctx, "session/event", (session: { id: string }, event: { type?: string }) => {
		if (clients.size === 0) return;
		const botId = rt.chatOwners.get(session.id);
		if (botId === undefined) return;
		const displayItems = rt.displayItems as DisplayItems | undefined;
		if (typeof displayItems === "function") {
			for (const item of displayItems(session.id, [event]))
				publish("message", { botId, sessionId: session.id, item });
		}
		if (event.type === "tool/call") live();
	});

	// A turn that answers another Bot is hidden; its frames never start a stream.
	const hiddenTurn = (sessionId: string, turn: number | undefined): boolean =>
		turn !== undefined && (state.exchangeTurns[sessionId] ?? []).includes(turn);
	listenGlobal(ctx, "agent/assistant-stream", ({ agent, frame }: { agent: AgentRef; frame: AssistantFrame }) => {
		if (frame.type === "start") {
			const botId = rt.chatOwners.get(agent.id);
			if (clients.size === 0 || botId === undefined || hiddenTurn(agent.id, frame.turn)) return;
			writing.set(frame.attemptId, { botId, sessionId: agent.id });
			publish("stream", { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: "start" });
			return;
		}
		const target = writing.get(frame.attemptId);
		if (target === undefined) return;
		if (frame.type === "chunk" && frame.chunk?.type === "text-delta")
			publish("stream", { ...target, attemptId: frame.attemptId, text: frame.chunk.text });
		else if (frame.type === "end") {
			writing.delete(frame.attemptId);
			publish("stream", { ...target, attemptId: frame.attemptId, phase: "end" });
		}
	});

	ctx.effect(() => {
		const connection = ctx.connection;
		if (connection === undefined) {
			rt.warn("ocean-crew: no connection service, so the live feed has no route");
			return undefined;
		}
		return connection.fetch.register({
			path: FEED_ROUTE,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: async (request: Request): Promise<Response> => {
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
				const body = new ReadableStream<Uint8Array>({
					start(own) {
						controller = own;
						clients.add(own);
						send(own, encoder.encode(`event: hello\ndata: ${JSON.stringify({ revision: state.revision })}\n\n`));
					},
					cancel() {
						leave(controller);
					},
				});
				// `start` runs synchronously in the constructor above, so it has run here.
				const open = controller!;
				requests.set(open, request);
				request.signal.addEventListener("abort", () => leave(open), { once: true });
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
				});
			},
		});
	}, "ocean-crew: live feed route");

	ctx.effect(() => {
		const keepalive = setInterval(() => {
			if (clients.size > 0) for (const controller of clients) send(controller, encoder.encode(": keepalive\n\n"));
		}, KEEPALIVE_MS);
		keepalive.unref?.();
		return () => {
			clearInterval(keepalive);
			clearTimeout(liveTimer);
			offSaved();
			for (const controller of clients) leave(controller);
		};
	}, "ocean-crew: live feed");
}
