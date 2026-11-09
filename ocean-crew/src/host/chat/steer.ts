// In a Bot's private chat a user steer must reach the Bot at once, not at the next DSH
// step boundary. Two mechanisms:
//  - a foreground shell call detaches into the jobs registry on a steer and returns
//    DSH's promoted result, so the step ends while the command runs on;
//  - a running model call is cancelled (hook reason) and the steer is moved to the front
//    of next-turn, so a fresh turn claims it at once.
import { isAbsolute, resolve } from "node:path";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { STEER_CUT } from "../core/constants.ts";
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";

const SHELL_TOOLS = ["pwsh", "bash"];
// Long enough for a fast command to finish instead of detaching; a test injects
// `rt.steerGraceMs` to keep the detach path quick.
const STEER_GRACE_MS = 1000;

// DSH's message types close the producer-source union, while a plugin adds its own

// passes through. The cast is that one declared extension.
const createPluginMessage = createUserMessage as unknown as (input: {
	content: unknown[];
	source: Record<string, unknown>;
}) => any;

/** Per-session scratch state of the steer machinery; rebuilt from events, never saved. */
interface SteerTrack {
	phase: "boundary" | "model" | "tools";
	jobsByCall: Map<string, unknown>;
	jobWaiters: Map<string, Set<(jobId: unknown) => void>>;
	steerWaiters: Set<(value?: unknown) => void>;
	killedJobs: Set<unknown>;
	cutting: boolean;
}

export function install(rt: Runtime): void {
	const ctx = rt.ctx as any;
	let jobs: any;
	const attachJobs = (sub: any): void => {
		const own = sub.jobs;
		jobs = own;
		sub.effect(
			() => () => {
				if (jobs === own) jobs = undefined;
			},
			"ocean-crew: jobs service",
		);
	};
	if (typeof ctx.inject === "function") ctx.inject(["jobs"], attachJobs);
	else if (ctx.get?.("jobs") !== undefined)
		attachJobs({ jobs: ctx.get("jobs"), effect: (execute: any, label: any) => ctx.effect(execute, label) });

	const privateOf = (sessionId?: string): boolean =>
		sessionId !== undefined && rt.chatOwners.has(sessionId) && !rt.groupOwners.has(sessionId);
	const liveAgent = (sessionId: string): any => ctx.get?.("agents")?.get?.(sessionId);

	// Per-session state kept by the session/event listener below.
	const state = new Map<string, SteerTrack>();
	const stateOf = (id: string): SteerTrack => {
		let entry = state.get(id);
		if (entry === undefined) {
			entry = {
				phase: "boundary",
				jobsByCall: new Map(),
				jobWaiters: new Map(),
				steerWaiters: new Set(),
				killedJobs: new Set(),
				cutting: false,
			};
			state.set(id, entry);
		}
		return entry;
	};
	const isUserSteer = (event: any): boolean =>
		event?.data?.target === "next-step" &&
		(event.data.inserted ?? []).some((message: any) => message?.source?.kind === "user");
	const wake = (set: Set<any>, value?: unknown): void => {
		const waiters = [...set];
		set.clear();
		for (const fn of waiters) fn(value);
	};

	// A user steer into a private chat must cut a running model call. The check runs off
	// the event that queued it, never inside the append that emitted the event.
	const maybeCut = (id: string): void => {
		const entry = rt.live?.get(id);
		const agent = liveAgent(id);
		if (!privateOf(id) || rt.readOnly?.() !== undefined || entry === undefined || agent === undefined) return;
		if (
			[...(rt.switchJobs?.() ?? [])].some(
				(job: any) => job?.botId === rt.chatOwners.get(id) && job.roomId === undefined,
			)
		)
			return;
		const track = stateOf(id);
		if (track.phase !== "model" || track.cutting) return;
		if (entry.turn === undefined || (entry.calls?.size ?? 0) > 0 || agent.status !== "running") return;
		const nextStep = agent.inbox?.nextStep ?? [];
		const last = [...nextStep].reverse().find((message: any) => message?.source?.kind === "user");
		if (last === undefined) return;
		track.cutting = true;
		rt.markSteerCut?.(id);
		agent.inbox.remove(last.id);
		agent.cancel({ kind: "hook", reason: STEER_CUT }, { keepInbox: true });
		agent.send(last, "next-turn", true);
		if (agent.inbox.nextTurn[0]?.id !== last.id) {
			agent.inbox.remove(last.id);
			agent.inbox.prepend("next-turn", last);
		}
	};
	const scheduleCut = (id: string): void => {
		queueMicrotask(() => maybeCut(id));
	};

	// Renders one jobs.read() result the way tool-jobs' renderModelDelta does: stdout and
	// unlabeled chunks joined, then a [stderr] section, then a dropped-output note when
	// the ring lost bytes.
	const renderJobRead = (read: any): string => {
		const visible = (read.chunks ?? []).filter((chunk: any) => chunk?.channel !== "log");
		const out = visible
			.filter((chunk: any) => chunk.channel !== "stderr")
			.map((chunk: any) => chunk.text ?? "")
			.join("");
		const err = visible
			.filter((chunk: any) => chunk.channel === "stderr")
			.map((chunk: any) => chunk.text ?? "")
			.join("");
		const separator = out.length > 0 && !out.endsWith("\n") ? "\n" : "";
		const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : "");
		const spillPaths = read.job?.output?.spillPaths ?? [];
		if (read.lossy !== true && !visible.some((chunk: any) => chunk.gapBefore === true)) return body;
		const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(", ") : "(unavailable)"}]`;
		return `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}${notice}`;
	};

	const noticeOf = (name: string, command: string, text: string): any =>
		createPluginMessage({
			content: [{ type: "text", text }],
			// Same source as DSH's job-completion notice so every chat renders it the same
			// way, and Ocean Crew's routing ignores it.
			source: { kind: "tool-jobs", form: "notice", summary: boundContextSummary(`${name} ${command} …`) },
		});

	const detachAfter = (jobId: string, args: any, exec: any, def: any, native: Promise<any>, label: string): void => {
		const id = exec.agent.id;
		const command = args?.command ?? "";
		native.then(
			(value: any) => {
				const track = stateOf(id);
				if (track.killedJobs.delete(jobId) || liveAgent(id) !== exec.agent) return;
				const deliver = (text: string): any => {
					const message = noticeOf(label, command, text);
					if (exec.agent.status === "idle") return exec.agent.followup(message);
					return exec.agent.inject(message);
				};
				if (value?.kind === "promoted") {
					// The native timeout passed after the detach; the job stays registered and
					// tool-jobs will notify on settle.
					if (typeof value.output === "string" && value.output !== "")
						return deliver(
							`background job ${jobId} (${label}: ${command}) is still running. Output since your last read:\n${value.output}`,
						);
					return undefined;
				}
				const rendered = (def.output?.render?.(args, value) ?? [])
					.map((block: any) => block?.text ?? "")
					.filter((text: string) => text !== "")
					.join("\n");
				return deliver(`background job ${jobId} (${label}: ${command}) finished:\n${rendered}`);
			},
			(error: any) => {
				const track = stateOf(id);
				if (track.killedJobs.delete(jobId) || liveAgent(id) !== exec.agent) return;
				const message = noticeOf(
					label,
					command,
					`background job ${jobId} (${label}: ${command}) failed: ${error?.message ?? String(error)}`,
				);
				if (exec.agent.status === "idle") return exec.agent.followup(message);
				return exec.agent.inject(message);
			},
		);
	};

	const shadowed = new WeakSet<object>();
	const formatWarned = new Set<string>();
	const shadowShell = (agent: any, name: string): (() => void) | undefined => {
		if (typeof ctx.tools?.get !== "function") return undefined;
		const def = ctx.tools.get(name, agent);
		if (def === undefined) return undefined;
		const promoted = (def.output?.schema?.oneOf ?? []).find(
			(variant: any) => variant?.properties?.kind?.const === "promoted",
		);
		if (
			typeof def.output?.render !== "function" ||
			promoted?.properties?.cwd === undefined ||
			promoted?.properties?.jobId === undefined ||
			promoted?.properties?.timeoutMs === undefined ||
			promoted?.properties?.output === undefined
		) {
			if (!formatWarned.has(name)) {
				formatWarned.add(name);
				rt.warn("ocean-crew: %s has no promoted result format; its calls keep the step boundary", name);
			}
			return undefined;
		}
		shadowed.add(agent);
		const lift = agent.ctx.tools.register({
			...def,
			execute: async (args: any, exec: any) => {
				const native = def.execute(args, exec);
				const sessionId = exec.agent?.id;
				if (
					args?.run_in_background === true ||
					jobs === undefined ||
					sessionId === undefined ||
					!privateOf(sessionId)
				)
					return native;
				const track = stateOf(sessionId);
				const startedAt = Date.now();
				let steerResolve: ((value?: unknown) => void) | undefined;
				let jobResolve: ((jobId: unknown) => void) | undefined;
				let graceTimer: ReturnType<typeof setTimeout> | undefined;
				const graceMs = typeof rt.steerGraceMs === "number" ? rt.steerGraceMs : STEER_GRACE_MS;
				try {
					// A user steer ends the wait: first for the steer event itself, then a short
					// grace for a fast command, then for the job id the native call registers (it
					// may not exist yet while approval is pending).
					const steerSeen = (): Promise<string> => {
						if ((exec.agent.inbox?.nextStep ?? []).some((message: any) => message?.source?.kind === "user"))
							return Promise.resolve("steered");
						return new Promise((resolveSteer) => {
							steerResolve = resolveSteer;
							track.steerWaiters.add(resolveSteer);
						}).then(() => "steered");
					};
					const first = await Promise.race([native, steerSeen()]);
					if (first !== "steered") return await native;
					const graced = await Promise.race([
						native,
						new Promise((resolveGrace) => {
							graceTimer = setTimeout(() => resolveGrace("grace"), graceMs);
						}),
					]);
					if (graced !== "grace") return await native;
					const known = track.jobsByCall.get(exec.callId);
					const jobWait: Promise<unknown> =
						known !== undefined
							? Promise.resolve(known)
							: new Promise((resolveJob) => {
									jobResolve = resolveJob;
									const set = track.jobWaiters.get(exec.callId) ?? new Set<() => void>();
									track.jobWaiters.set(exec.callId, set);
									set.add(resolveJob as unknown as (jobId: unknown) => void);
								});
					const settled = await Promise.race([native.then(() => "native"), jobWait.then(() => "job")]);
					if (settled !== "job") return await native;
				} catch {
					// A native rejection before or after the steer propagates unchanged.
					return await native;
				} finally {
					if (steerResolve !== undefined) track.steerWaiters.delete(steerResolve);
					if (jobResolve !== undefined) {
						const set = track.jobWaiters.get(exec.callId);
						set?.delete(jobResolve);
						if (set?.size === 0) track.jobWaiters.delete(exec.callId);
					}
					clearTimeout(graceTimer);
				}
				const jobId = track.jobsByCall.get(exec.callId) as string;
				let read: any;
				try {
					read = jobs.read(jobId, sessionId);
				} catch {
					return await native;
				}
				const status = read?.job?.status;
				if (status === "completed" || status === "killed" || status === "failed") return await native;
				detachAfter(jobId, args, exec, def, native, name);
				const base = rt.sessionFolder?.(exec.agent.session);
				const cwd =
					args?.workdir === undefined
						? (base ?? "")
						: !isAbsolute(args.workdir) && base !== undefined
							? resolve(base, args.workdir)
							: args.workdir;
				return { kind: "promoted", cwd, jobId, timeoutMs: Date.now() - startedAt, output: renderJobRead(read) };
			},
		});
		// tools.js keeps this with the Session's scope; unmarking lets a later scope
		// register the shadow again.
		return () => {
			shadowed.delete(agent);
			lift?.();
		};
	};
	rt.shadowShells = (agent: any): Array<() => void> | undefined => {
		if (agent === undefined || !rt.isBotSession?.(agent.session?.id)) return undefined;
		if (shadowed.has(agent) || typeof agent.ctx?.tools?.register !== "function") return undefined;
		const disposers: Array<() => void> = [];
		for (const name of SHELL_TOOLS) {
			try {
				const lift = shadowShell(agent, name);
				if (typeof lift === "function") disposers.push(lift);
			} catch (error) {
				rt.warn("ocean-crew: shadowing %s failed: %s", name, error);
			}
		}
		return disposers;
	};

	listenGlobal(ctx, "session/event", (session: any, event: any) => {
		const id = session?.id;
		if (id === undefined || !privateOf(id)) return;
		const track = stateOf(id);
		switch (event.type) {
			case "step/start": {
				track.phase = "model";
				const agent = liveAgent(id);
				if ((agent?.inbox?.nextStep ?? []).some((message: any) => message?.source?.kind === "user"))
					scheduleCut(id);
				break;
			}
			case "assistant/message":
				track.phase = "tools";
				break;
			case "step/end":
			case "turn/start":
			case "turn/end":
				track.phase = "boundary";
				track.cutting = false;
				break;
			case "job/registered": {
				const callId = event.data?.toolCall?.callId;
				if (callId !== undefined) {
					track.jobsByCall.set(callId, event.data.jobId);
					const set = track.jobWaiters.get(callId);
					if (set !== undefined) {
						track.jobWaiters.delete(callId);
						wake(set, event.data.jobId);
					}
				}
				break;
			}
			case "job/settled":
				if (event.data?.toolCall?.callId !== undefined) track.jobsByCall.delete(event.data.toolCall.callId);
				break;
			case "tool/call": {
				if (event.data?.name === "job_kill") {
					try {
						const parsed = JSON.parse(event.data.arguments ?? "{}");
						if (parsed.job_id !== undefined) track.killedJobs.add(parsed.job_id);
					} catch {
						// Unparseable args carry no kill target.
					}
				}
				break;
			}
			case "agent/inbox/spliced":
				if (isUserSteer(event)) {
					wake(track.steerWaiters, true);
					scheduleCut(id);
				}
				break;
		}
	});
}
