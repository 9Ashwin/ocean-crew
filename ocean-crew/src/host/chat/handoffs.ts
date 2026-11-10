// Hand-offs: the work Bots give each other, and what each Bot is doing right now.
//
// A Bot's request to another Bot is a piece of work. What the recipient hands on while
// it works on it hangs below it, and the recipient's answer goes up only once all of
// that came back, together with what came back. Results find their way up by
// themselves, so no Bot needs to message one that waits for it, and that is the one
// hand-off refused. The open works are kept in state.json so a restart waits on.
//

// The goal cards that read this tree (`goalTaskReported`/`goalTaskReset`, goals.ts) and
// mounting a subagent

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEXT_KEPT } from "../core/constants.ts";
import type { Runtime } from "../core/runtime.ts";
import { headOf } from "../core/text.ts";

const minutes = (since: number): string => {
	const count = Math.floor((Date.now() - since) / 60_000);
	return count < 1 ? "for less than a minute" : `for ${count} min`;
};

/** What a turn or a delivery was for, as a delivery source carries it. */
export interface WorkInfo {
	role?: string;
	audience?: string;
	exchangeId?: string;
	work?: string;
	askedBy?: string;
	senderSessionId?: string;
}

/** Whether a result that a Bot took up has reached the user it was for. */
export type PublishState = "pending" | "taken" | "delivered" | "abandoned";

/**
 * A result's publish duty: what still has to happen before the user has seen it.
 * Taking a result only moves it to `taken`; shipping the answer that carries it is a
 * separate step, so a dropped or rewritten answer cannot pass for delivery.
 */
export interface PublishDuty {
	state: PublishState;
	at: number;
	/** The Bot whose answer is to carry the result to the user. */
	by?: string;
	/** The group whose log delivers the result, when it was handed on in one. */
	room?: string;
	/** The start of the result, as state.json keeps it. */
	text?: string;
	/** Why a duty was abandoned instead of delivered. */
	reason?: string;
}

/** One result in the publish ledger; it outlives the works it came from. */
export interface PublishDutyRecord extends PublishDuty {
	id: string;
	/** The work the result was handed up into, when there is one. */
	parent?: string;
	/** The name the result is shown under. */
	name?: string;
}

/** One result a work handed back. */
export interface WorkResult {
	id: string;
	name: string;
	/** The start of the result, as state.json keeps it. */
	text?: string;
	/** The original length when the saved text was cut to `TEXT_KEPT`. */
	length?: number;
	/** The file under `handoff-results/` that keeps the result whole. */
	file?: string;
	/** The subagent child whose run handed this result up. */
	child?: string;
	/** The reply carrying the result never reached the Bot that asked for it. */
	failed?: boolean;
	at?: number;
}

/** One piece of work handed to a Bot, and what it waits for. */
export interface Work {
	from?: string;
	to?: string;
	/** The work the sender was doing when it sent this one. */
	parent?: string;
	/** The group the work was handed on in. */
	room?: string;
	/** The group the request was made from. */
	fromRoom?: string;
	/** A Bot or group name, for a result that reports one; a subagent work's name. */
	name?: string;
	/** The subagent child whose run is this work. */
	child?: string;
	/** The works this one waits for. */
	open: string[];
	/** What the works above handed back. */
	results: WorkResult[];
	at: number;
	/** The request reached its recipient only after a restart. */
	late?: boolean;
	/** What the Bot said last for this work. */
	held?: string;
}

/** The Bot that asked for a work, as the turn that answers it sees its trigger. */
export interface WorkAsker {
	kind: "bot";
	role: "request";
	exchangeId: string;
	senderSessionId?: string;
	senderRoomId?: string;
}

/** The Bots and groups one Bot waits on, per the work that keeps it waiting. */
export interface WaitingViewEntry {
	bots: string[];
	rooms: string[];
	for: string[];
}

export type WaitingView = Record<string, WaitingViewEntry>;

/** The options that open a work; each field is kept only when it says something. */
export interface OpenWorkOptions {
	from?: string;
	to?: string;
	parent?: string;
	fromRoom?: string;
	room?: string;
	name?: string;
	child?: string;
}

/** What a turn's live entry carries, as `turns` publishes it. */
interface LiveEntry {
	turn?: unknown;
	info?: WorkInfo;
	since?: number;
}

/** The live turn table `turns` publishes, keyed by Session. */
interface LiveApi {
	get(sessionId: string): LiveEntry | undefined;
	keys(): IterableIterator<string>;
}

// the saved
// The
// single cast states that gap; no shared file changes.
interface StateWithWorks {
	works?: Record<string, Work>;
	publishDuties?: Record<string, PublishDutyRecord>;
}

export function install(rt: Runtime): void {
	const state = rt.state;
	const table = state as unknown as StateWithWorks;
	const works = (): Record<string, Work> => {
		table.works ??= {};
		return table.works;
	};
	// Results that still owe the user a delivery, kept after their works are gone.
	const duties = (): Record<string, PublishDutyRecord> => {
		table.publishDuties ??= {};
		return table.publishDuties;
	};
	const DUTIES_KEPT = 100;
	const DUTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
	// What came back, whole; state.json keeps the start of each.
	const whole = new Map<string, string>();
	const save = (): void => {
		void rt.save().catch(() => {});
	};
	const nameOf = (id?: string): string | undefined => rt.botOf(id)?.name;
	// `turns` publishes the live turns on the runtime; read as the shape this module uses.
	// Read at call time: this module installs before `turns` fills the map in.
	const live = (): LiveApi => rt.live;

	// The whole result of a work, in a file of its own: state.json is written whole on
	// every save, so it keeps only the start of a long result, and a restart would cut
	// that result short before it reached the Bot that asked for it.
	const resultsDir = join(rt.home, "handoff-results");
	const resultPath = (name: string): string => join(resultsDir, name);
	// A work id is a UUID, but a saved team could carry any name: it stays inside the
	// folder, and one that is not plain falls back to a hash of the id.
	const resultName = (id: string): string => {
		const text = String(id);
		return `${/^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : createHash("sha256").update(text).digest("hex")}.txt`;
	};
	const keptName = (file: unknown): string | undefined =>
		typeof file === "string" && /^[A-Za-z0-9_-]+\.txt$/.test(file) ? file : undefined;
	const writes = (): boolean => rt.readOnly() === undefined;

	// The result of a work, whole, in a file of its own. The file is written before the
	// team file names it, so a result that is claimed to exist is there.
	function keepResult(id: string, text: string): string | undefined {
		if (text.length <= TEXT_KEPT || !writes()) return undefined;
		const name = resultName(id);
		const path = resultPath(name);
		const temp = `${path}.${process.pid}.tmp`;
		try {
			mkdirSync(resultsDir, { recursive: true });
			writeFileSync(temp, text, "utf8");
			renameSync(temp, path);
			return name;
		} catch (error) {
			rt.warn("ocean-crew: result of work %s not kept whole: %s", id, error);
			try {
				rmSync(temp, { force: true });
			} catch {
				// The temp file is not there or cannot be removed; the result stays in state.json.
			}
			return undefined;
		}
	}

	// The copy of a result that is not needed any more: the answer it went into has it.
	const dropResult = (file: unknown): void => {
		const name = keptName(file);
		if (name === undefined || !writes()) return;
		try {
			// save() can resolve without writing during shutdown. Check the durable
			// references too, so an old state can still recover its result after restart.
			const saved = JSON.parse(readFileSync(join(rt.home, "state.json"), "utf8")) as StateWithWorks;
			if (
				Object.values(saved.works ?? {}).some((work) => (work.results ?? []).some((result) => result.file === name))
			)
				return;
			rmSync(resultPath(name), { force: true });
		} catch {
			// A missing or unreadable team file keeps the copy; the next host drops it.
		}
	};

	// What came back for a work: the whole result if it is still to be found, else the
	// start of it. A result that a restart cut, or whose file is gone, is reported as
	// such and not passed on as if it were whole.
	function resultText(result: WorkResult): { text: string; whole: boolean } {
		const kept = whole.get(result.id);
		if (kept !== undefined) return { text: kept, whole: true };
		if (result.length === undefined) return { text: result.text ?? "", whole: true };
		const name = keptName(result.file);
		if (name !== undefined) {
			try {
				const text = readFileSync(resultPath(name), "utf8");
				if (text.length === result.length) return { text, whole: true };
			} catch {
				// The file is gone or unreadable: the start of the result is all there is.
			}
		}
		return { text: result.text ?? "", whole: false };
	}

	// The work a turn does: the request it answers, or the work a result that came back
	// (or a turn picked up again) goes on with.
	const workOf = (info?: WorkInfo): string | undefined =>
		info === undefined
			? undefined
			: info.role === "request" && info.audience !== "user"
				? info.exchangeId
				: info.work;

	// `parent`: the work the sender was doing when it sent this one. `child`: the
	// session id of the subagent a run of this work belongs to — the run, not the
	// child, is the sub-work, so a child that is continued hands up a result per run.
	function openWork(id: string, { from, to, parent, fromRoom, room, name, child }: OpenWorkOptions): void {
		// The work id is the replay key: a request replayed with the same id is the same
		// hand-off, not a second one. `dropWork` removes the id, so it can be opened again.
		if (works()[id] !== undefined) return;
		const above = parent === undefined ? undefined : works()[parent];
		works()[id] = {
			...(from ? { from } : {}),
			...(to ? { to } : {}),
			...(room ? { room } : {}),
			...(above ? { parent } : {}),
			...(fromRoom ? { fromRoom } : {}),
			...(name ? { name } : {}),
			...(child ? { child } : {}),
			open: [],
			results: [],
			at: Date.now(),
		};
		if (above !== undefined) above.open.push(id);
		save();
	}

	// The publish duty of a result: pending from the moment it exists. The room the work
	// was handed on in is where the user reads it; without a room the asker's answer
	// carries it, so only the top of a chain keeps a duty.
	const openDuty = (id: string, work: Work, name: string, text: string): void => {
		const room = work.room ?? work.fromRoom;
		if (room === undefined && work.parent !== undefined) return;
		duties()[id] = {
			id,
			state: "pending",
			at: Date.now(),
			...(work.from !== undefined ? { by: work.from } : {}),
			...(room !== undefined ? { room } : {}),
			...(work.parent !== undefined ? { parent: work.parent } : {}),
			name,
			text: headOf(text, TEXT_KEPT),
		};
		pruneDuties();
	};

	// Delivered duty and every result folded into it. One line that reaches the user
	// settles the whole chain it summarized.
	function deliver(id: string): boolean {
		const duty = duties()[id];
		if (duty === undefined) return false;
		duty.state = "delivered";
		duty.at = Date.now();
		delete duty.reason;
		for (const child of Object.values(duties()))
			if (child.parent === id && child.state !== "delivered") {
				child.state = "delivered";
				child.at = duty.at;
				delete child.reason;
			}
		return true;
	}

	// A duty that is dropped instead of delivered says so; it is never silently removed.
	function abandon(id: string, reason: string): void {
		const duty = duties()[id];
		if (duty === undefined || duty.state === "delivered") return;
		duty.state = "abandoned";
		duty.at = Date.now();
		duty.reason = reason;
		for (const child of Object.values(duties()))
			if (child.parent === id && child.state !== "delivered") {
				child.state = "abandoned";
				child.at = duty.at;
				child.reason = reason;
			}
	}

	// Old duties go first. One still owed is kept until its retention runs out, and is
	// then marked abandoned with the reason instead of being forgotten. Past the count
	// limit the oldest owed duty becomes the same explicit failure, so a busy team's
	// state file stays bounded without a duty vanishing unannounced.
	function pruneDuties(): void {
		const kept = Object.values(duties()).sort((left, right) => left.at - right.at);
		const now = Date.now();
		for (const duty of kept) {
			if (duty.state === "delivered" || duty.state === "abandoned") continue;
			if (now - duty.at > DUTY_TTL_MS)
				abandon(duty.id, "the user was not confirmed to have received this result within 7 days");
		}
		const all = Object.values(duties()).sort((left, right) => left.at - right.at);
		for (const duty of all.slice(0, Math.max(0, all.length - DUTIES_KEPT))) {
			if (duty.state === "pending" || duty.state === "taken")
				abandon(duty.id, "the publish ledger reached its retention limit before delivery was confirmed");
		}
		for (const duty of Object.values(duties()).sort((left, right) => left.at - right.at)) {
			if (Object.keys(duties()).length <= DUTIES_KEPT) break;
			if (duty.state === "delivered" || duty.state === "abandoned") delete duties()[duty.id];
		}
	}

	// The answer to work `id` is on its way, with `result` from `name`. Returns the work
	// it goes on with. That work keeps waiting until a turn reads the answer (`taken`).
	function closeWork(id: string, name: string, text: string): string | undefined {
		const work = works()[id];
		if (work === undefined) return undefined;
		// The result exists from here on; its delivery to the user is a duty that survives
		// taken, the parent's answer and the removal of this work record.
		openDuty(id, work, name, text);
		delete works()[id];
		// What it still waits for comes back to it alone.
		for (const child of Object.values(works())) if (child.parent === id) delete child.parent;
		const above = work.parent === undefined ? undefined : works()[work.parent];
		if (above !== undefined) {
			// The whole result goes into a file of its own before the team file names it.
			const file = keepResult(id, text);
			above.results.push({
				id,
				name,
				text: headOf(text, TEXT_KEPT),
				...(work.child ? { child: work.child } : {}),
				...(text.length > TEXT_KEPT ? { length: text.length } : {}),
				...(file ? { file } : {}),
				at: Date.now(),
			});
			whole.set(id, text);
		}
		for (const result of work.results ?? []) whole.delete(result.id);
		// Old state can still name these files until the replacement state lands.
		// A failed save must leave them available to the next host.
		void rt
			.save()
			.then(() => {
				for (const result of work.results ?? []) dropResult(result.file);
			})
			.catch(() => {});
		return above === undefined ? undefined : work.parent;
	}

	// The subagent run a settlement notice names. The notice carries only the child's id,
	// and a child's runs end one after another, so it is the earliest settled run of that
	// child not read yet, else a run of it still out.
	const subWorkRun = (id: string): { id: string; parent: string; at?: number } | undefined => {
		let settled: { id: string; parent: string; at: number } | undefined;
		let running: { id: string; parent: string } | undefined;
		for (const [workId, work] of Object.entries(works())) {
			for (const openId of work.open) {
				const result = work.results?.find((item) => item.id === openId);
				if ((result?.child ?? works()[openId]?.child ?? openId) !== id) continue;
				if (result === undefined) running ??= { id: openId, parent: workId };
				else if (settled === undefined || (result.at ?? 0) < settled.at)
					settled = { id: openId, parent: workId, at: result.at ?? 0 };
			}
		}
		return settled ?? running;
	};

	// A settled run is handed back like a teammate's reply: its closing text joins the
	// results of the work it hung under. `id` is the run's id, `child` the child's, which
	// named the sub-work before runs did.
	function settleSubWork(id: string, text: string, child: string): string | undefined {
		const key = works()[id] !== undefined ? id : child;
		const work = works()[key];
		if (work === undefined) return undefined;
		const { parent } = work;
		closeWork(key, work.name ?? "subagent", text);
		return parent;
	}

	// A fast child can settle before its tool result identifies the call that made it.
	const nameSubWork = (id: string, name: string): void => {
		const found: Work | WorkResult | undefined =
			Object.entries(works()).find(([key, work]) => (work.child ?? key) === id)?.[1] ??
			Object.values(works())
				.flatMap((work) => work.results ?? [])
				.find((result) => (result.child ?? result.id) === id);
		if (found === undefined || found.name === name) return;
		found.name = name;
		save();
	};

	const dropWork = (id: string): void => {
		const work = works()[id];
		if (work === undefined) return;
		const { parent } = work;
		// Dropping the work removes the answer that would have carried these results: the
		// duties become explicit failures instead of vanishing with it.
		for (const result of work.results ?? [])
			abandon(result.id, `the work was dropped before ${result.name}'s result reached the user`);
		abandon(id, "the work was dropped before its result reached the user");
		delete works()[id];
		const above = parent === undefined ? undefined : works()[parent];
		if (above !== undefined) above.open = above.open.filter((other) => other !== id);
		for (const result of work.results ?? []) whole.delete(result.id);
		void rt
			.save()
			.then(() => {
				for (const result of work.results ?? []) dropResult(result.file);
			})
			.catch(() => {});
	};

	function taken(workId: string, id: string): void {
		const work = works()[workId];
		if (work === undefined || !work.open.includes(id)) return;
		work.open = work.open.filter((other) => other !== id);
		// The asking Bot read the result. That is not the user reading it: the publish
		// duty stays open until the answer that carries it is delivered.
		const duty = duties()[id];
		if (duty !== undefined && duty.state === "pending") {
			duty.state = "taken";
			duty.at = Date.now();
		}
		save();
	}

	// A delivery the restart delayed is marked, so the answer that comes back for
	// the work says the request only arrived then.
	function lateWork(id: string): void {
		const work = works()[id];
		if (work === undefined || work.late === true) return;
		work.late = true;
		save();
	}

	// The reply carrying a result never reached the asker: the failure reaches it
	// as an input instead (turns), which ends the wait when it is read like any
	// reply. The result kept with the work it was for is marked, so the answer
	// that goes up names it.
	function answerMissed(id: string): void {
		for (const work of Object.values(works())) {
			if (!work.open.includes(id)) continue;
			const result = (work.results ?? []).find((item) => item.id === id);
			if (result !== undefined) result.failed = true;
			save();
			return;
		}
	}

	const owns = (botId: string, workId?: string): boolean => workId !== undefined && works()[workId]?.to === botId;
	const waits = (workId?: string): boolean => (workId === undefined ? 0 : (works()[workId]?.open.length ?? 0)) > 0;

	function hold(workId: string, text: string): void {
		const work = works()[workId];
		if (work === undefined || text === "") return;
		work.held = headOf(text, TEXT_KEPT);
		save();
	}

	// Who asked for the work, as the turn that answers a request sees its trigger.
	const askedBy = (workId?: string): WorkAsker | undefined => {
		if (workId === undefined) return undefined;
		const work = works()[workId];
		if (work === undefined) return undefined;
		return {
			kind: "bot",
			role: "request",
			exchangeId: workId,
			senderSessionId: work.from,
			...(work.fromRoom ? { senderRoomId: work.fromRoom } : {}),
		};
	};

	// The answer that goes up: what the Bot said last for this work, then what came back.
	function answerText(workId: string, reply: string, botName: string): string {
		const work = works()[workId];
		const said = reply !== "" ? reply : (work?.held ?? "");
		const results = (work?.results ?? []).map((result) => {
			const { text, whole: complete } = resultText(result);
			const cut = complete ? "" : `\n[cut; ${result.length} characters in all, the rest was not kept]`;
			if (result.failed === true)
				return `${result.name} could not send its reply to you; what it had answered:\n${text}${cut}`;
			return `${result.name}:\n${text}${cut}`;
		});
		const body =
			results.length === 0
				? said || `${botName} finished without a reply.`
				: [
						said || `${botName} finished and wrote nothing more.`,
						`[Handed back to ${botName} for this work]`,
						...results,
					].join("\n\n");
		// The request reached its target only after a restart; the answer says so.
		return work?.late === true
			? `[This request reached ${botName} only after DeepSeek Harness restarted.]\n\n${body}`
			: body;
	}

	// The Bots waiting for the result of these works: whoever asked for each, and on up.
	function upstreamOf(workIds: readonly string[]): Set<string> {
		const bots = new Set<string>();
		for (const workId of workIds) {
			const seen = new Set<string>();
			for (let id: string | undefined = workId; id !== undefined && !seen.has(id); ) {
				const work: Work | undefined = works()[id];
				if (work === undefined) break;
				seen.add(id);
				if (work.from) bots.add(work.from);
				id = work.parent;
			}
		}
		return bots;
	}

	// Two requests from one sender belong to the same work when they were sent for it.
	const sameWork = (id: string | undefined, parent: string | undefined): boolean => {
		const above = parent === undefined ? undefined : works()[parent];
		return (id === undefined ? undefined : works()[id]?.parent) === (above === undefined ? undefined : parent);
	};

	// The works their Bots wait on, outside a turn that does them (`busy`): each with what
	// it handed on that has not come back yet. One that came back waits only to be read.
	const held = (busy: ReadonlySet<string>): { id: string; work: Work; out: Work[] }[] =>
		Object.entries(works())
			.filter(([id, work]) => work.to !== undefined && work.open.length > 0 && !busy.has(id))
			.map(([id, work]) => ({
				id,
				work,
				out: work.open.map((childId) => works()[childId]).filter((child): child is Work => child !== undefined),
			}));

	const busyWith = (sessionIds: readonly string[]): Set<string> => {
		const busy = new Set<string>();
		for (const sessionId of sessionIds) {
			const entry = live().get(sessionId);
			if (entry?.turn === undefined) continue;
			const workId = workOf(entry.info);
			if (workId !== undefined) busy.add(workId);
		}
		return busy;
	};

	// Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
	function waitingView(): WaitingView {
		const view: WaitingView = {};
		const add = (list: string[], id: string | undefined): void => {
			if (id !== undefined && !list.includes(id)) list.push(id);
		};
		const busy = busyWith([...live().keys()]);
		for (const { work, out } of held(busy)) {
			if (out.length === 0) continue;
			const target = work.to;
			if (target === undefined) continue;
			let entry = view[target];
			if (entry === undefined) {
				entry = { bots: [], rooms: [], for: [] };
				view[target] = entry;
			}
			for (const child of out) add(child.room ? entry.rooms : entry.bots, child.room ?? child.to);
			add(entry.for, work.from);
		}
		return view;
	}

	// A deleted Bot answers no more work and waits for none.
	function forgetBot(botId: string): WorkAsker[] {
		const waiting: WorkAsker[] = [];
		for (const [id, work] of Object.entries(works())) {
			if (work.to !== botId) continue;
			const asker = askedBy(id);
			if (asker !== undefined) waiting.push(asker);
		}
		for (const [id, work] of Object.entries(works())) if (work.from === botId && work.to !== botId) dropWork(id);
		return waiting;
	}

	// What a Bot is doing, in one line for the Bots that work with it.
	function statusOf(botId: string): string {
		const chat = rt.chatOf(botId);
		const sessions = [...new Set([chat, ...rt.groupSessionsOf(botId)])];
		const place = (sessionId: string): string => {
			const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId);
			return room ? `in group "${room.name}"` : "in its own chat";
		};
		const forWhom = (sessionId: string, info?: WorkInfo): string => {
			if (rt.groupOwners.has(sessionId))
				return info?.askedBy && nameOf(info.askedBy) ? `, for ${nameOf(info.askedBy)}` : "";
			const askedWork = workOf(info);
			const asker =
				info?.role === "request" || info?.role === "stopped"
					? info.senderSessionId
					: askedWork === undefined
						? undefined
						: works()[askedWork]?.from;
			if (asker !== undefined) return nameOf(asker) ? `, for ${nameOf(asker)}` : "";
			return info === undefined ? ", for the user" : "";
		};
		const doing = (entry?: LiveEntry): string => {
			const what = rt.doingOf?.(entry) ?? {};
			if (what.tool) return `: running ${what.tool}${what.target ? ` on ${what.target}` : ""}`;
			return what.said ? `: "${what.said.slice(0, 100)}"` : "";
		};
		const lines: string[] = [];
		const approval = (rt.approvalsView?.() ?? []).find((entry: { botId?: string }) => entry.botId === botId);
		const switching = [...(rt.switchJobs?.() ?? [])].find((job: { botId?: string }) => job.botId === botId);
		const running = sessions.filter((sessionId) => live().get(sessionId)?.turn !== undefined);
		if (approval !== undefined)
			lines.push(
				`waiting for the user's approval to run ${approval.tool || "a tool"} ${place(approval.sessionId)} (${minutes(approval.at)})`,
			);
		else if (switching !== undefined)
			lines.push(
				`moving on to a fresh part of its ${switching.roomId ? `conversation in group "${rt.roomOf(switching.roomId)?.name ?? "?"}"` : "own chat"}`,
			);
		for (const sessionId of approval === undefined && switching === undefined ? running : []) {
			const entry = live().get(sessionId);
			lines.push(
				`working ${place(sessionId)} ${minutes(entry?.since ?? Date.now())}${forWhom(sessionId, entry?.info)}${doing(entry)}`,
			);
		}
		for (const { work, out } of held(busyWith(running))) {
			if (work.to !== botId) continue;
			const forName = nameOf(work.from) ? `, for ${nameOf(work.from)}` : "";
			const on = [
				...new Set(
					out.map((child) =>
						child.room
							? `group "${rt.roomOf(child.room)?.name ?? "a group"}"`
							: (child.name ?? nameOf(child.to) ?? "a teammate"),
					),
				),
			];
			lines.push(
				on.length > 0
					? `waiting for ${on.join(" and ")} to hand back work${forName}`
					: `about to go on with work${forName}, whose results came back`,
			);
		}
		if (lines.length === 0) lines.push("idle");
		if (state.questions[chat] !== undefined)
			lines.push("a question card in its own chat waits for the user's answer");
		if (state.views[chat] !== undefined) lines.push("a view card in its own chat waits for the user's answer");
		const unread = new Map<string, number>();
		for (const args of rt.unreadOf?.(chat) ?? []) {
			const name = nameOf(args.fromId);
			if (name !== undefined) unread.set(name, (unread.get(name) ?? 0) + 1);
		}
		if (unread.size > 0)
			lines.push(`not read yet: ${[...unread].map(([name, count]) => `${count} from ${name}`).join(", ")}`);
		return lines.join("; ");
	}

	// The publish ledger as other modules read and settle it. Groups call
	// `deliverWorkInRoom` when a Bot's line reaches the group log, which is where the
	// user reads it.
	const publishOf = (id?: string): PublishDutyRecord | undefined => (id === undefined ? undefined : duties()[id]);
	const publishDuties = (): PublishDutyRecord[] => Object.values(duties());

	// Close every result still owed, with the reason. A stop that leaves duties pending would let a
	// later turn deliver work the user believes they cancelled.
	const abandonDuties = (reason: string): number => {
		let closed = 0;
		for (const duty of Object.values(duties())) {
			if (duty.state !== "pending" && duty.state !== "taken") continue;
			abandon(duty.id, reason);
			closed += 1;
		}
		return closed;
	};
	const deliverWork = (id: string): boolean => {
		const done = deliver(id);
		pruneDuties();
		if (done) save();
		return done;
	};
	function deliverWorkInRoom(roomId: string, botId?: string): number {
		let count = 0;
		for (const duty of Object.values(duties())) {
			if (duty.room !== roomId || duty.state === "delivered" || duty.state === "abandoned") continue;
			if (botId !== undefined && duty.by !== botId) continue;
			if (deliver(duty.id)) count += 1;
		}
		pruneDuties();
		if (count > 0) save();
		return count;
	}

	Object.assign(rt, {
		workOf,
		openWork,
		closeWork,
		dropWork,
		takenWork: taken,
		publishOf,
		publishDuties,
		abandonDuties,
		deliverWork,
		deliverWorkInRoom,
		lateWork,
		answerMissed,
		ownsWork: owns,
		waitsWork: waits,
		holdWork: hold,
		workAsker: askedBy,
		answerText,
		upstreamOf,
		sameWork,
		forgetBotWork: forgetBot,
		statusOf,
		waitingView,
		settleSubWork,
		subWorkRun,
		nameSubWork,
	});
}
