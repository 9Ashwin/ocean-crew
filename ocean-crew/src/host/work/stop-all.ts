// One stop for everything the team is doing. A separate Stop per Bot leaves the work that Bot
// handed on running, and a result still owed to the user would be delivered later by a turn the
// user believes they cancelled. This walks the whole team: every running chat turn, every group
// round, every subagent under them (recursively), and every result still owed. What it cannot
// finish is reported, never dropped silently.
import type { Runtime } from "../core/runtime.ts";

export interface ResidualWork {
	/** The Bot or group whose work survived the stop. */
	owner: string;
	label: string;
	/** Why it is still there. */
	reason: string;
}

export interface SideEffectReport {
	tool: string;
	target?: string;
	effect: string;
	answer: string;
}

export interface StopAllReport {
	/** Bot chats whose turn or subagents were stopped. */
	stopped: string[];
	/** Group rounds that were stopped. */
	rooms: string[];
	/** Results that were owed to the user and are now closed as abandoned. */
	abandoned: number;
	/** Strict tool calls the user answered while this work ran, so they know what already went out. */
	sideEffects: SideEffectReport[];
	/** Anything still running, with the reason it could not be stopped. */
	residual: ResidualWork[];
}

/** How a stop was asked for; the reason is shown in the report and in the abandoned duties. */
export type StopCause = "user" | "all";

/** Stop the whole team; the report says what stopped and what is still true. */
export type StopAll = (cause?: StopCause) => Promise<StopAllReport>;

export function stopAllOf(rt: Runtime): StopAll {
	return async (cause: StopCause = "all"): Promise<StopAllReport> => {
		await rt.load();
		const report: StopAllReport = { stopped: [], rooms: [], abandoned: 0, sideEffects: [], residual: [] };
		const reason =
			cause === "all" ? "the user stopped all the team's work" : "the user stopped this conversation's work";

		// Every Bot chat and every group round, each stop contained so one failure does not
		// leave the rest running.
		const bots = [...rt.chatOwners.values()];
		for (const botId of new Set(bots)) {
			const bot = rt.botOf(botId);
			const sessionId = rt.chatOf(botId);
			const label = bot?.name ?? botId;
			try {
				const stopped = await rt.stopChat?.(botId);
				if (stopped === true) report.stopped.push(label);
				// A second look: a session that still reports work could not be cancelled.
				if (stopped !== true && sessionId !== undefined && rt.runningOf?.(sessionId) === true)
					report.residual.push({ owner: label, label, reason: "its turn could not be cancelled" });
			} catch (error: any) {
				report.residual.push({ owner: label, label, reason: `stopping it failed: ${error?.message ?? error}` });
			}
		}
		for (const roomId of Object.keys((rt.state as any)?.rooms ?? {})) {
			const room = rt.roomOf(roomId);
			const label = room?.name ?? roomId;
			try {
				const stopped = await rt.stopRoomWork?.(roomId);
				if (stopped === true) report.rooms.push(label);
			} catch (error: any) {
				report.residual.push({ owner: label, label, reason: `stopping it failed: ${error?.message ?? error}` });
			}
		}

		// Temporary workers are the team's side jobs: a stop that leaves them running is not a stop.
		const workers = (rt as any).workers;
		if (workers !== undefined && typeof workers.stopAll === "function") {
			try {
				const stopped = Number(await workers.stopAll());
				if (stopped > 0) report.stopped.push(`${stopped} worker(s)`);
			} catch (error: any) {
				report.residual.push({
					owner: "workers",
					label: "workers",
					reason: `stopping them failed: ${error?.message ?? error}`,
				});
			}
		}

		// A result owed to the user cannot be delivered by a turn that will never finish: close
		// it as abandoned with the reason, so it is visible rather than silently pending.
		const owed = (rt.publishDuties?.() ?? []).filter(
			(duty: any) => duty.state === "pending" || duty.state === "taken",
		);
		if (owed.length > 0) {
			try {
				report.abandoned = rt.abandonDuties?.(reason) ?? 0;
			} catch (error: any) {
				for (const duty of owed)
					report.residual.push({
						owner: duty.name ?? duty.id,
						label: duty.name ?? duty.id,
						reason: `its result stayed owed: ${error?.message ?? error}`,
					});
			}
		}

		// What already reached the outside world stays true after a stop; the report says so.
		const gate = (rt as any).sideEffectGate;
		if (gate !== undefined && typeof gate.decisionsOf === "function")
			for (const [sessionId, botId] of rt.chatOwners) {
				const label = rt.botOf(botId)?.name ?? botId;
				for (const decision of gate.decisionsOf(sessionId))
					report.sideEffects.push({ ...decision, owner: label } as SideEffectReport);
			}
		return report;
	};
}
