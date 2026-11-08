// Status reactions on the message that asked for the work: a processing mark
// while the Bot runs, then the outcome. The lifecycle follows dsh-im's
// status-reaction module (MIT; dsh-im is listed in NOTICE): transitions are
// serialized per message and every provider failure is swallowed, so a
// reaction never holds up a reply.

export const STATUS_REACTIONS = Object.freeze({
	processing: "OnIt",
	success: "DONE",
	error: "ERROR",
});

/** The operation names of the reaction lifecycle. */
export interface StatusReaction {
	success(): Promise<void>;
	error(): Promise<void>;
	clear(): Promise<void>;
	settled(): Promise<void>;
}

/** The adapter operations a status reaction runs through. */
export interface StatusReactionOptions {
	add?: (emoji: string) => unknown;
	remove?: (id: string) => unknown;
	emojis?: { processing: string; success: string; error: string };
	warn?: (error: unknown) => void;
}

export function startStatusReaction({
	add,
	remove,
	emojis = STATUS_REACTIONS,
	warn,
}: StatusReactionOptions = {}): StatusReaction | undefined {
	// A platform without both operations gets no reaction at all: the adapter says so
	// by leaving one of them out.
	if (typeof add !== "function" || typeof remove !== "function") return undefined;
	let current: string | null = null;
	let closed = false;
	let tail: Promise<void> = Promise.resolve();
	const step = (operation: () => Promise<void>): Promise<void> => {
		tail = tail.then(operation).catch((error: unknown) => {
			warn?.(error);
		});
		return tail;
	};
	const transition = (emoji: string): Promise<void> =>
		step(async () => {
			if (current !== null) {
				const previous = current;
				current = null;
				await remove(previous);
			}
			if (typeof emoji !== "string" || emoji === "") return;
			const id = await add(emoji);
			if (typeof id === "string" && id !== "") current = id;
		});
	transition(emojis.processing);
	const finish = (emoji: string): Promise<void> => {
		if (!closed) {
			closed = true;
			transition(emoji);
		}
		return tail;
	};
	return Object.freeze({
		success: () => finish(emojis.success),
		error: () => finish(emojis.error),
		clear: () => finish(""),
		settled: () => tail,
	});
}
