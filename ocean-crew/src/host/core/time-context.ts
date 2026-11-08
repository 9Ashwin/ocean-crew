// The time a Bot's model sees: one dated, zoned snapshot at the head of its first step,
// refreshed when the last reading is older than the configured interval. A loaded DSH
// clock covers every step itself, so no second one is added; a user message is never
// changed, only a snapshot message is appended for the model.
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Runtime } from "./runtime.ts";

const SOURCE = "ocean-crew-time-context";
const isClock = (source: any): boolean => source?.kind === SOURCE || source?.kind === "time-context";

// DSH's message types close the producer-source union, while a plugin adds its own
// snapshot source. The cast is that one declared extension.
const createContextMessage = createUserMessage as unknown as (input: {
	content: unknown[];
	source: Record<string, unknown>;
}) => any;

interface StepDecision {
	kind: string;
	messages: any[];
	[key: string]: unknown;
}

// One event as the history reader yields it.
interface HistoryEvent {
	type?: string;
	time?: number;
	data?: { source?: any; [key: string]: unknown };
}

export function install(rt: Runtime): void {
	const { ctx, config } = rt;
	const interval = config.timeRefreshIntervalMs ?? 600_000;
	if (!Number.isSafeInteger(interval) || interval < 0)
		throw new TypeError("timeRefreshIntervalMs must be a non-negative safe integer");
	const formatter = new Intl.DateTimeFormat("en-CA", {
		...(config.timeZone ? { timeZone: config.timeZone } : {}),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	});
	const zone = formatter.resolvedOptions().timeZone;

	ctx.on(
		"agent/pre-step",
		async ({ agent, signal }: any, next: () => Promise<StepDecision>): Promise<StepDecision> => {
			const decision = await next();
			if (decision.kind === "reject" || signal.aborted) return decision;
			await rt.load();
			if (!rt.isBotSession(agent.id) || signal.aborted) return decision;
			// A loaded DSH clock covers every step itself. Its listener may run before or
			// after this one (a reload reorders them), so its presence is read from its
			// projection, not from the messages added so far.
			const projections = ctx.get?.("sessionProjections") as
				| { stateOf?: (session: unknown, key: string) => unknown }
				| undefined;
			if (projections?.stateOf?.(agent.session, "timeContext") !== undefined) return decision;
			if (decision.messages.some((message: any) => isClock(message.source))) return decision;
			const now = Date.now();
			if (typeof rt.eventsBackwards === "function") {
				for await (const event of rt.eventsBackwards(
					agent.id,
					signal,
					Number.POSITIVE_INFINITY,
				) as AsyncIterable<HistoryEvent>) {
					if (event.type === "user/message" && isClock(event.data?.source)) {
						if (now >= (event.time ?? 0) && now - (event.time ?? 0) < interval) return decision;
						break;
					}
					if ((event.time ?? 0) <= now - interval) break;
				}
			}
			if (signal.aborted) return decision;
			const text = `Current time: ${formatter.format(now)} (${zone}).`;
			return {
				...decision,
				messages: [
					...decision.messages,
					createContextMessage({
						content: [{ type: "text", text }],
						source: { kind: SOURCE, form: "snapshot", sections: [{ name: SOURCE, text }] },
					}),
				],
			};
		},
		{ prepend: true },
	);
}
