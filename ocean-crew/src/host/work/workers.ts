// Temporary workers. A Bot that needs a side job done — read ten pages, check every file, sweep a
// list — starts a worker instead of doing it in its own conversation: a child Session with its own
// context that never joins the roster, writes no memory and is archived when it finishes. DSH owns
// the child runtime (see the subagent service); this module owns the policy: what a worker may be
// asked, how its result comes back, and how the user sees and stops it.
import type { Runtime } from "../core/runtime.ts";

/** How many workers one Bot may have running at once. */
export const WORKERS_PER_BOT = 3;
/** How long a worker may run before it is stopped and its result reported as unfinished. */
export const WORKER_TIMEOUT_MS = 20 * 60_000;

export interface WorkerRecord {
	childId: string;
	/** The Bot that started it. */
	parent: string;
	/** The Session the work runs in, for the background view. */
	parentSession: string;
	label: string;
	task: string;
	startedAt: number;
	status: "running" | "done" | "failed" | "stopped";
	/** The result, once it settled. */
	output?: string;
	reason?: string;
}

export interface WorkerRun {
	childId: string;
	/** Resolves with the worker's answer text; never rejects. */
	result: Promise<string>;
}

export interface Workers {
	/** Everything known about this team's workers, newest last. */
	view(): WorkerRecord[];
	/** Start one worker for a Bot; the activation is DSH's, not a second runtime. */
	start(input: {
		parentAgent: any;
		parentBotId: string;
		parentSession: string;
		task: string;
		label: string;
	}): Promise<WorkerRun>;
	/** Stop one worker by id. */
	stop(childId: string): Promise<boolean>;
	/** Stop every worker this team started. */
	stopAll(): Promise<number>;
}

const outputOf = (result: any): string => {
	const blocks: any[] = Array.isArray(result?.output) ? result.output : [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
};

export function workersOf(rt: Runtime): Workers {
	const table = new Map<string, WorkerRecord>();
	// The activation handles are process-local: a worker does not survive a restart, and its record
	// then reads as stopped, which is what it is.
	const handles = new Map<string, { dispose: () => Promise<void> }>();

	const settle = (childId: string, status: WorkerRecord["status"], output?: string, reason?: string): void => {
		const held = table.get(childId);
		if (held === undefined || held.status !== "running") return;
		held.status = status;
		if (output !== undefined && output !== "") held.output = output.slice(0, 4000);
		if (reason !== undefined) held.reason = reason.slice(0, 300);
		handles.delete(childId);
	};

	return {
		view() {
			// A worker with no handle left and still marked running did not survive: say so instead
			// of showing work that is not happening.
			for (const [childId, held] of table)
				if (held.status === "running" && !handles.has(childId)) {
					held.status = "stopped";
					held.reason = "the host restarted before it finished";
				}
			return [...table.values()];
		},
		async start({ parentAgent, parentBotId, parentSession, task, label }) {
			const running = [...table.values()].filter((held) => held.parent === parentBotId && held.status === "running");
			if (running.length >= WORKERS_PER_BOT)
				throw Object.assign(
					new Error(
						`This Bot already has ${running.length} workers running. Wait for one to finish, or stop it first.`,
					),
					{ code: "bot/busy" },
				);
			// The service is optional: without it a worker cannot be started, and the caller is told
			// rather than silently running the job in the Bot's own conversation.
			const service: any = (rt.ctx as any).get?.("subagents");
			if (service === undefined || typeof service.startActivation !== "function")
				throw Object.assign(new Error("Delegation is not available in this DSH build."), {
					code: "bot/unavailable",
				});
			const provider = providerOf(service);
			if (provider === undefined)
				throw Object.assign(new Error("No delegation backend is loaded in this DSH build."), {
					code: "bot/unavailable",
				});

			const controller = new AbortController();
			const activation = await service.startActivation({
				provider,
				label: label.slice(0, 80),
				request: { prompt: [{ type: "text", text: task }], parent: parentAgent, signal: controller.signal },
				signal: controller.signal,
				// The Bot decides what to tell the user: the worker's answer is a tool result, not a
				// message of its own in the Bot's chat.
				delivery: "caller",
			});
			const childId = String(activation.childId);
			const record: WorkerRecord = {
				childId,
				parent: parentBotId,
				parentSession,
				label,
				task: task.slice(0, 2000),
				startedAt: Date.now(),
				status: "running",
			};
			table.set(childId, record);
			handles.set(childId, activation);

			// Unreferenced: a waiting worker must not keep the process alive on its own.
			const timer = setTimeout(() => {
				void activation.dispose?.().catch(() => undefined);
				settle(
					childId,
					"stopped",
					undefined,
					`it ran longer than ${Math.round(WORKER_TIMEOUT_MS / 60_000)} minutes`,
				);
			}, WORKER_TIMEOUT_MS);
			(timer as any).unref?.();

			const result = Promise.resolve(activation.result)
				.then((settled: any) => {
					clearTimeout(timer);
					const text = outputOf(settled);
					const failed = settled?.stopReason === "error" || settled?.stopReason === "failed";
					settle(childId, failed ? "failed" : "done", text, failed ? "it ended with an error" : undefined);
					return text;
				})
				.catch((error: any) => {
					clearTimeout(timer);
					const reason = error?.message ?? String(error);
					settle(childId, "failed", undefined, reason);
					return `The worker could not finish: ${reason}`;
				});
			return { childId, result };
		},
		async stop(childId) {
			const held = handles.get(childId);
			if (held === undefined) return false;
			const record = table.get(childId);
			try {
				await held.dispose();
			} catch (error: any) {
				rt.warn("ocean-crew: stopping worker %s failed: %s", childId, error?.message ?? error);
				return false;
			}
			if (record !== undefined) settle(childId, "stopped", record.output, "the user stopped it");
			return true;
		},
		async stopAll() {
			let stopped = 0;
			for (const childId of [...handles.keys()]) if (await this.stop(childId)) stopped += 1;
			return stopped;
		},
	};
}

/** The first registered backend, so the plugin does not have to name one in its configuration. */
function providerOf(service: any): string | undefined {
	if (typeof service.providers === "function") {
		const providers: unknown = service.providers();
		if (Array.isArray(providers) && providers.length > 0) {
			const first = providers[0];
			return typeof first === "string" ? first : (first?.name ?? undefined);
		}
	}
	// The registry is not enumerable: the documented names are the fallback order.
	for (const name of ["spawn", "fork", "acp"]) {
		try {
			if (typeof service.resolve === "function" && service.resolve(name) !== undefined) return name;
		} catch {
			// A name this build does not have.
		}
	}
	return undefined;
}
