// The exact thinking time of a Turn, read from the timed model stream DSH keeps in each
// assistant/message event: for one step, its last reasoning chunk's time minus its first
// one's, summed over the turn. assistant/attempt events are skipped on purpose — a failed
// or retried attempt's thinking never reached the reply.
import { HISTORY_TIMEOUT_MS } from "./constants.ts";
import type { Runtime } from "./runtime.ts";

// One stream item, as DSH keeps it in an assistant/message event's `stream`.
interface StreamRecord {
	type?: string;
	time0?: number;
	dt?: number[];
	texts?: string[];
}

interface SessionEvent {
	type?: string;
	time?: number;
	data?: {
		turn?: number;
		step?: number;
		stream?: StreamRecord[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** A Turn's thinking time from its events, or undefined when no step timed its reasoning. */
export function thinkingMs(events: SessionEvent[], turn: number): number | undefined {
	let total = 0;
	let timed = false;
	for (const event of events) {
		if (event.type !== "assistant/message" || event.data?.turn !== turn) continue;
		const span = streamReasoningMs(event.data.stream);
		if (span === undefined) continue;
		timed = true;
		total += span;
	}
	return timed ? total : undefined;
}

// One stream's reasoning span. A reasoning-chunks record packs its member times as the
// first time plus the gaps to each next member, so its last member lands at time0 + sum(dt).
const streamReasoningMs = (stream: StreamRecord[] | undefined): number | undefined => {
	let first: number | undefined;
	let last: number | undefined;
	for (const record of stream ?? []) {
		if (record.type !== "reasoning-chunks" || (record.texts ?? []).length === 0) continue;
		const time0 = record.time0 ?? 0;
		const end = (record.dt ?? []).reduce((time, gap) => time + gap, time0);
		if (first === undefined || time0 < first) first = time0;
		if (last === undefined || end > last) last = end;
	}
	return first === undefined ? undefined : (last as number) - first;
};

export function install(rt: Runtime): void {
	// A closed turn's events do not change; cache its answer once turn/end exists.
	const settled = new Map<string, number | undefined>();
	rt.thinkingOf = async (sessionId: string, turn: number): Promise<number | undefined> => {
		const key = `${sessionId}:${turn}`;
		if (settled.has(key)) return settled.get(key);
		const events: SessionEvent[] = [];
		// Newest first; events older than the turn close the read.
		for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
			events.push(event);
			if (typeof event.data?.turn === "number" && event.data.turn < turn) break;
		}
		// The read went through every newer turn whole, so each closed one is answered too.
		for (const event of events) {
			if (event.type === "turn/end" && typeof event.data?.turn === "number" && event.data.turn >= turn) {
				settled.set(`${sessionId}:${event.data.turn}`, thinkingMs(events, event.data.turn));
			}
		}
		return settled.has(key) ? settled.get(key) : thinkingMs(events, turn);
	};
}
