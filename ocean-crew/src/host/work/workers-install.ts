// Wiring for temporary workers: the tool list already carries `spawn_worker` and `stop_worker`, so
// this module only has to own the policy object and make the workers visible to the two places that
// show them — the background view and the team stop.
import type { Runtime } from "../core/runtime.ts";
import { workersOf } from "./workers.ts";

export function install(rt: Runtime): void {
	const workers = workersOf(rt);
	Object.assign(rt, { workers, workersView: () => workers.view() });

	// The background view lists workers beside running turns, so the user sees side jobs too.
	for (const name of ["backgroundView", "stopAll"] as const) {
		const previous = (rt as any)[name];
		if (name === "backgroundView" && typeof previous === "function") {
			(rt as any).backgroundView = () => {
				const view: any = previous();
				const held = workers.view().filter((worker) => worker.status === "running");
				return { entries: [...(view?.entries ?? []), ...held.map((worker) => workerEntry(worker))] };
			};
		}
	}
}

function workerEntry(worker: any): any {
	return {
		sessionId: worker.childId,
		owner: worker.parent,
		doing: "worker",
		since: worker.startedAt,
		held: worker.label,
		worker: true,
	};
}
