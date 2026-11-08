// Usage: what the team's Sessions spent, read from DSH's own token-meter session
// projections (`dsh-token-meter`) instead of keeping a second ledger. A Session's
// projection carries the provider-reported input, output and cache buckets of its
// complete durable log; the host only groups them by Bot and by group chat.
import type { Bot, Room } from "../../shared/state.ts";
import type { Runtime } from "../core/runtime.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface UsageRow {
	kind: "bot" | "room";
	id: string;
	name: string;
	color?: string;
	sessions: number;
	totals: UsageTotals;
}

/** The team's usage: one row per Bot and per group chat, plus the total. */
export interface UsageView {
	available: boolean;
	rows: UsageRow[];
	total: UsageTotals;
}

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const add = (into: UsageTotals, from: UsageTotals): void => {
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
};

const sessionsOfBot = (bot: Bot): string[] =>
	[
		...new Set(
			[bot.sessionId ?? bot.id, ...(bot.segments ?? []).map((segment) => segment.sessionId)].filter(Boolean),
		),
	] as string[];

const sessionsOfRoom = (room: Room): string[] =>
	[
		...new Set(
			[
				room.sessionId ?? room.id,
				...Object.values(room.sessions ?? {}),
				...(room.parts ?? []).map((segment) => segment.sessionId),
			].filter(Boolean),
		),
	] as string[];

export function install(rt: Runtime): void {
	const { ctx } = rt;

	// The registry is an optional DSH service: without it the page says usage is not
	// available rather than reporting zeros as if nothing had been spent.
	const projections = (): any => {
		try {
			return (ctx as any).get?.("sessionProjections");
		} catch {
			return undefined;
		}
	};

	const totalsOf = async (sessionId: string): Promise<UsageTotals | undefined> => {
		const registry = projections();
		if (registry?.snapshot === undefined) return undefined;
		try {
			const agent = (await rt.resolveAgent?.(sessionId)) as { session?: unknown } | undefined;
			if (agent?.session === undefined) return undefined;
			const snapshot = registry.snapshot(agent.session);
			const usage = snapshot?.values?.tokenUsage;
			if (usage === undefined) return undefined;
			return {
				input: Number(usage.uncachedInputTokens) || 0,
				output: Number(usage.outputTokens) || 0,
				cacheRead: Number(usage.cacheReadTokens) || 0,
				cacheWrite: Number(usage.cacheWriteTokens) || 0,
			};
		} catch {
			return undefined;
		}
	};

	const rowOf = async (
		kind: UsageRow["kind"],
		id: string,
		name: string,
		color: string | undefined,
		sessions: string[],
	): Promise<UsageRow> => {
		const totals = zero();
		let counted = 0;
		for (const sessionId of sessions) {
			const part = await totalsOf(sessionId);
			if (part === undefined) continue;
			add(totals, part);
			counted += 1;
		}
		return { kind, id, name, ...(color === undefined ? {} : { color }), sessions: counted, totals };
	};

	const sumOf = (row: UsageRow): number =>
		row.totals.input + row.totals.output + row.totals.cacheRead + row.totals.cacheWrite;

	async function usageView(): Promise<UsageView> {
		await rt.load?.();
		const state = rt.state;
		const available = projections()?.snapshot !== undefined;
		const rows: UsageRow[] = [];
		for (const bot of Object.values(state.bots) as Bot[]) {
			rows.push(await rowOf("bot", bot.id, bot.name, bot.color, sessionsOfBot(bot)));
		}
		for (const room of Object.values(state.rooms) as Room[]) {
			rows.push(await rowOf("room", room.id, room.name, undefined, sessionsOfRoom(room)));
		}
		const total = zero();
		for (const row of rows) add(total, row.totals);
		rows.sort((left, right) => sumOf(right) - sumOf(left) || left.name.localeCompare(right.name));
		return { available, rows, total };
	}

	Object.assign(rt, { usageView });
}
