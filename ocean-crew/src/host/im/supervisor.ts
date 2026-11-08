// One pure decision per connection per health check. The IM host layer owns the
// runners, queues and timers; this module only says whether to start, stop,
// restart or leave a connection alone, and when the next attempt is due.
// The backoff ladder and the three-way failure classification follow dsh-im's
// connection supervisor (MIT; dsh-im is listed in NOTICE); its controller layer
// is not needed because im/index.ts already keeps the runner slots and a single
// serialized sync chain.

export const RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000, 5_000, 10_000, 30_000]);

/** What one health check decided for one connection. */
export type SupervisorAction = "start" | "stop" | "restart" | "none";

/** One connection's last reported state, as the supervisor reads it. */
export interface SupervisorEntry {
	desired?: boolean;
	running?: boolean;
	state?: string;
	messageError?: boolean;
	attempts?: number;
	nextRetryAt?: number;
}

export interface SupervisorDecision {
	action: SupervisorAction;
	attempts: number;
	nextRetryAt: number;
}

// Pause before attempt number `attempts` (1-based); the last delay repeats.
export function retryDelay(attempts: unknown): number {
	const tries = Number.isFinite(attempts) && (attempts as number) > 0 ? Math.floor(attempts as number) : 1;
	return RETRY_DELAYS_MS[Math.min(tries - 1, RETRY_DELAYS_MS.length - 1)];
}

/**
 * Decide what one health check does with one connection.
 * - desired: the connection should be connected (enabled, has secrets, writable host)
 * - running: a runner object currently holds its slot
 * - state: last reported state, 'off' | 'connecting' | 'ready' | 'error'
 * - messageError: the error came from one refused message, not from the link
 * - attempts: attempts since the last success
 * - nextRetryAt: earliest time for the next attempt, ms epoch (0 = now)
 */
export function nextAction(now: number, entry: SupervisorEntry = {}): SupervisorDecision {
	const desired = entry.desired === true;
	const running = entry.running === true;
	const state = typeof entry.state === "string" ? entry.state : "off";
	const attempts =
		Number.isFinite(entry.attempts) && (entry.attempts as number) > 0 ? Math.floor(entry.attempts as number) : 0;
	const due =
		Number.isFinite(entry.nextRetryAt) && (entry.nextRetryAt as number) > 0 ? (entry.nextRetryAt as number) : 0;
	if (!desired) return { action: running ? "stop" : "none", attempts: 0, nextRetryAt: 0 };
	if (state === "ready" && running) return { action: "none", attempts: 0, nextRetryAt: 0 };
	if (state === "error") {
		// A refused message is not a broken link: reconnect only after the link
		// itself failed, otherwise one bad chat would restart the connection forever.
		if (running && entry.messageError === true) return { action: "none", attempts, nextRetryAt: 0 };
		if (now < due) return { action: "none", attempts, nextRetryAt: due };
		const tries = attempts + 1;
		// Without a runner a failed connect left nothing to restart: a start is the retry.
		return { action: running ? "restart" : "start", attempts: tries, nextRetryAt: now + retryDelay(tries) };
	}
	if (!running) return { action: "start", attempts, nextRetryAt: 0 };
	return { action: "none", attempts, nextRetryAt: due };
}

// 'permanent': the platform refused it, so retrying the same message cannot help.
// 'unknown': the send failed in a way that must not be retried blindly (a timeout,
// a closed adapter); one message is dropped and the connection stays up.
// 'retry': network-ish failure, the message waits in the queue and is sent again.
export type FailClass = "permanent" | "unknown" | "retry";

export function failClass(error: unknown): FailClass {
	const failure = error as
		| { permanent?: unknown; status?: unknown; unknown?: unknown; stopped?: unknown }
		| null
		| undefined;
	if (
		failure?.permanent === true ||
		(typeof failure?.status === "number" && failure.status >= 400 && failure.status < 500 && failure.status !== 429)
	)
		return "permanent";
	if (failure?.unknown === true || failure?.stopped === true) return "unknown";
	return "retry";
}
