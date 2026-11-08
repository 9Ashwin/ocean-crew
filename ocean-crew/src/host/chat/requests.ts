// Request identities: a request a Bot names itself is sent once, however often it repeats it.
//
// `message_bot` merges what the recipient has not read yet, but a request that was read
// and whose answer was lost could be sent again, and the work would be done twice. A
// caller that names its request (`request_id`) gets that guarantee: the name belongs to
// the caller and to the conversation the request was made from, what the request stands
// for is remembered with a fingerprint of what was asked, and the receipt of the first
// call is given back instead of a second delivery. The receipt is written before the
// message goes out, so a restart cannot turn a lost answer into a second delivery either;
// when the outcome of an admission is not known, the request is not sent again.
//
// Accepted identities stay with the team: expiring one would permit an old retry to
// repeat side effects. Removing receipts needs a separate, explicit retention policy.
import { createHash, randomUUID } from "node:crypto";
import type { Runtime } from "../core/runtime.ts";

/** A request name this long is a mistake, not an identity. */
export const NAME_MAX = 200;

/** One request as its caller names it, with the call it stands for. */
export interface RequestCall {
	/** The Bot that made the request; a Bot keeps its name when its Session moves on. */
	caller: string;
	/** The conversation the request was made from: `chat`, or `room:<id>`. */
	context: string;
	/** The name the caller gave the request. */
	name: string;
	/** What the request asks for, as the call's own arguments; the fingerprint covers it. */
	payload: unknown;
}

/** Where one request lives in its caller's space, and what it asked for. */
export interface RequestIdentity {
	key: string;
	print: string;
	/** Set by the work when nothing went out, so the request may be admitted again. */
	unsent?: boolean;
}

/** What a request that was admitted before means for the caller now. */
export type RequestVerdict =
	| { status: "conflict" }
	| { status: "expired" }
	| { status: "replay"; receipt: unknown }
	| { status: "uncertain" };

/** The answer to one admission: the first call's receipt, or why it was not admitted. */
export type RequestAdmission = RequestVerdict | { status: "readonly" } | { status: "sent"; receipt: unknown };

/** One admitted request as `state.requests` keeps it. */
interface RequestRecord {
	fingerprint: string;
	outcome: "pending" | "delivered" | "uncertain";
	at: number;
	/** The run that admitted it; a pending record from another run has an unknown outcome. */
	run: string;
	receipt?: unknown;
}

type RequestTable = Record<string, RequestRecord>;

// path; the contract here is the one already saved in state.json, so the table is read
// through this local type. The single cast states that gap; no shared file changes.
interface StateWithRequests {
	requests?: RequestTable;
}

export function install(rt: Runtime): void {
	// This run's name: a receipt left pending by another run has an unknown outcome.
	const run = randomUUID();
	const table = rt.state as unknown as StateWithRequests;
	const receipts = (): RequestTable => {
		table.requests ??= {};
		return table.requests;
	};
	// Requests being admitted now, so that two at once admit one.
	const inflight = new Map<string, Promise<unknown>>();

	// What the request asked for, as a short hash: the same name with the same content is
	// the same request, and the same name with other content is a mistake.
	// The payload is the call's own argument object, so stringifying it gives a string.
	const print = (payload: unknown): string =>
		createHash("sha256")
			.update(JSON.stringify(payload) as string)
			.digest("hex");

	// The name of a request in the caller's own space: its Bot, the conversation the
	// request was made from, and the name the caller gave it. The Bot, not its Session: a
	// Bot that moves to a fresh part of its conversation keeps its name.
	const identity = ({ caller, context, name, payload }: RequestCall): RequestIdentity => ({
		key: `${caller}\u0000${context}\u0000${name}`,
		print: print(payload),
	});

	// What a request that was admitted before means for the caller now: its receipt, a
	// conflict, or an outcome that is not known. Undefined when it was never admitted.
	const verdict = (request: RequestIdentity, record: RequestRecord): RequestVerdict | undefined => {
		if (record.fingerprint !== request.print) return { status: "conflict" };
		if (record.outcome === "delivered") {
			// The receipt is gone, but the name stays taken: it is not used again by accident.
			return record.receipt === undefined ? { status: "expired" } : { status: "replay", receipt: record.receipt };
		}
		if (record.outcome === "uncertain") return { status: "uncertain" };
		// Admitted, not settled: the call is still going, or it was cut short.
		return undefined;
	};

	// What is known about a request that was admitted before. Undefined when the request
	// was never admitted.
	const known = async (request: RequestIdentity): Promise<RequestVerdict | undefined> => {
		const record = rt.own(receipts(), request.key);
		if (record === undefined) return undefined;
		const seen = verdict(request, record);
		if (seen !== undefined) return seen;
		// Admitted, not settled: the call is still going in this run, or another run left it
		// in the air, and then its outcome is not known.
		if (record.run !== run) return { status: "uncertain" };
		const promise = inflight.get(request.key);
		if (promise === undefined) return { status: "uncertain" };
		await promise.catch(() => {});
		const settled = rt.own(receipts(), request.key);
		if (settled === undefined) return undefined;
		return verdict(request, settled) ?? { status: "uncertain" };
	};

	// Admits the request once and runs it. `work` sends the message and gives the receipt
	// the caller gets. The receipt is written before the message goes out, so that a restart
	// knows the request was admitted.
	const admit = async (
		request: RequestIdentity,
		work: () => Promise<unknown>,
	): Promise<RequestAdmission | undefined> => {
		// The receipt is looked for and written without an await in between, so that two
		// calls at once cannot both admit the same request.
		const record = rt.own(receipts(), request.key);
		if (record !== undefined) {
			const seen = verdict(request, record);
			if (seen !== undefined) return seen;
			if (record.run !== run) return { status: "uncertain" };
			const promise = inflight.get(request.key);
			if (promise === undefined) return { status: "uncertain" };
			await promise.catch(() => {});
			// The attempt that was going on gave up before it sent anything (its receipt could
			// not be saved), so the request is free to be admitted again.
			if (rt.own(receipts(), request.key) === undefined) return admit(request, work);
			return known(request);
		}
		// A receipt that cannot be saved cannot stop a second delivery later.
		if (rt.readOnly() !== undefined) return { status: "readonly" };
		const fresh: RequestRecord = { fingerprint: request.print, outcome: "pending", at: Date.now(), run };
		receipts()[request.key] = fresh;
		const promise = (async (): Promise<unknown> => {
			try {
				// Ordinary saves may be skipped when this host closes or loses the lock.
				await rt.save({ required: true });
			} catch (error) {
				delete receipts()[request.key];
				rt.warn("ocean-crew: the receipt of the request was not saved: %s", error);
				throw error;
			}
			try {
				const receipt = await work();
				if (request.unsent === true) {
					// The work decided before anything went out: it is not a delivered
					// receipt, so the request is free to be admitted again. The removal has
					// to be saved before that is true: a leftover pending record stays.
					delete receipts()[request.key];
					try {
						await rt.save({ required: true });
					} catch (error) {
						fresh.outcome = "uncertain";
						fresh.at = Date.now();
						receipts()[request.key] = fresh;
						rt.warn("ocean-crew: the removal of the request receipt was not saved: %s", error);
					}
					return receipt;
				}
				fresh.outcome = "delivered";
				fresh.receipt = receipt;
				fresh.at = Date.now();
				await rt.save().catch(() => {});
				return receipt;
			} catch (error) {
				// The message may have gone out; it is not sent again.
				fresh.outcome = "uncertain";
				fresh.at = Date.now();
				await rt.save().catch(() => {});
				throw error;
			}
		})();
		inflight.set(request.key, promise);
		try {
			return { status: "sent", receipt: await promise };
		} finally {
			inflight.delete(request.key);
		}
	};

	Object.assign(rt, { requestIdentity: identity, knownRequest: known, admitRequest: admit });
}
