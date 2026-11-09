// Run records for scheduled tasks: what each firing did, so a task that ran and failed is
// not indistinguishable from one that never fired. The file is one JSON line per run and is
// read back newest first; a line that cannot be parsed is skipped rather than hiding the rest.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ScheduleOutcome = "answered" | "silent" | "failed" | "skipped";

export interface ScheduleRun {
	taskId: string;
	sessionId: string;
	/** Stable Bot or group id the task belongs to, so the page can group without a Session lookup. */
	ownerId?: string;
	startedAt: number;
	finishedAt?: number;
	outcome: ScheduleOutcome;
	/** Why it failed, or why it was skipped. Short and safe to show. */
	reason?: string;
	/** A machine code when the failure came from a turn (the DSH failure code). */
	code?: string;
}

/** How many runs are kept: enough for "the last few" without growing without bound. */
export const RUNS_KEPT = 200;

export interface RunLog {
	/** The newest run of every task, keyed by task id. */
	latest(): Promise<Record<string, ScheduleRun>>;
	/** Every kept run, newest first. */
	all(): Promise<ScheduleRun[]>;
	append(run: ScheduleRun): Promise<void>;
}

const asRun = (value: unknown): ScheduleRun | undefined => {
	if (value === null || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const outcome = raw.outcome;
	if (outcome !== "answered" && outcome !== "silent" && outcome !== "failed" && outcome !== "skipped")
		return undefined;
	if (typeof raw.taskId !== "string" || raw.taskId === "") return undefined;
	if (typeof raw.sessionId !== "string" || raw.sessionId === "") return undefined;
	if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) return undefined;
	return {
		taskId: raw.taskId,
		sessionId: raw.sessionId,
		...(typeof raw.ownerId === "string" && raw.ownerId !== "" ? { ownerId: raw.ownerId } : {}),
		startedAt: raw.startedAt,
		...(typeof raw.finishedAt === "number" && Number.isFinite(raw.finishedAt) ? { finishedAt: raw.finishedAt } : {}),
		outcome,
		...(typeof raw.reason === "string" && raw.reason !== "" ? { reason: raw.reason.slice(0, 200) } : {}),
		...(typeof raw.code === "string" && raw.code !== "" ? { code: raw.code.slice(0, 60) } : {}),
	};
};

export function runLog(home: string): RunLog {
	const path = join(home, "schedule-runs.jsonl");
	// Writes are appended in order: two firings in the same tick must not interleave lines.
	let writing: Promise<void> = Promise.resolve();
	const all = async (): Promise<ScheduleRun[]> => {
		let text = "";
		try {
			text = await readFile(path, "utf8");
		} catch {
			return [];
		}
		const runs: ScheduleRun[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const run = asRun(parsed);
			if (run !== undefined) runs.push(run);
		}
		return runs.reverse();
	};
	const append = async (run: ScheduleRun): Promise<void> => {
		const next = writing.then(async () => {
			const kept = [run, ...(await all())].slice(0, RUNS_KEPT);
			await mkdir(dirname(path), { recursive: true });
			const body = kept
				.slice()
				.reverse()
				.map((entry) => JSON.stringify(entry))
				.join("\n");
			await writeFile(path, `${body}\n`, "utf8");
		});
		// A failed write must not poison every later one: the chain continues on rejection.
		writing = next.catch(() => undefined);
		await next;
	};
	return {
		all,
		async latest() {
			const out: Record<string, ScheduleRun> = {};
			for (const run of await all()) if (out[run.taskId] === undefined) out[run.taskId] = run;
			return out;
		},
		append,
	};
}
