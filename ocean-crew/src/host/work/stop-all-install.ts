// Wiring for one stop for the whole team. The window calls the endpoint; IM calls the same
// function through `/stop all`. The report is the answer in both places, because a stop that only
// says "stopped" hides the work that is still running and the calls that already went out.
import type { Runtime } from "../core/runtime.ts";
import { type StopAllReport, stopAllOf } from "./stop-all.ts";

/** One line per thing the user needs to know after a stop. Empty when the stop was clean. */
export function reportLines(report: StopAllReport, text: (key: string, values?: any) => string): string[] {
	const lines: string[] = [];
	const stopped = [...report.stopped, ...report.rooms];
	lines.push(
		stopped.length === 0 ? text("Nothing was running") : text("Stopped: {names}", { names: stopped.join("、") }),
	);
	if (report.abandoned > 0)
		lines.push(text("{count} result(s) were owed and are now closed.", { count: report.abandoned }));
	if (report.sideEffects.length > 0) {
		const shown = report.sideEffects
			.slice(0, 5)
			.map((entry) => `${entry.tool}${entry.target === undefined ? "" : ` → ${entry.target}`} (${entry.answer})`);
		lines.push(text("Already happened, and a stop does not undo it: {list}", { list: shown.join("、") }));
	}
	for (const entry of report.residual.slice(0, 5))
		lines.push(text("Still running: {owner} — {reason}", { owner: entry.owner, reason: entry.reason }));
	return lines;
}

export function install(rt: Runtime): void {
	const stopAll = async (cause: "user" | "all" = "all"): Promise<StopAllReport> => {
		const report = await stopAllOf(rt)(cause);
		rt.warn(
			"ocean-crew: team stop: %d bot(s), %d group(s), %d owed result(s), %d still running",
			report.stopped.length,
			report.rooms.length,
			report.abandoned,
			report.residual.length,
		);
		return report;
	};
	Object.assign(rt, { stopAll });

	rt.stopAllEndpoint = async (endpoint: string, body: any): Promise<any> => {
		if (endpoint !== "stop-all")
			throw Object.assign(new Error(`Unknown endpoint ${endpoint}`), { code: "bot/not-found" });
		return stopAll(body?.cause === "user" ? "user" : "all");
	};
}
