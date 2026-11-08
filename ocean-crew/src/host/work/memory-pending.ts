// The record of a memory change that is about to be published.
//
// A change touches more than one file (the entry, the Index that links a topic, the
// change log), and each of them is written on its own, so an interruption can leave
// half of it done: an entry without its row in the change log, a topic without its
// link. This keeps the record of what the change will do, so the change can be
// finished later instead of being half done.
//
// The record is written before the change is published, and it is what accepts the
// change: before the record is there, nothing has changed. It holds the files to
// write, the files to remove, and the row that goes with them in the change log, so
// finishing a change later is the same work as publishing it in the first place.

import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// The record inside the memory folder.
export const PENDING_FILE = "pending.json";
// A record that cannot be read or understood stops the memory: what it would have
// changed is unknown, so nothing goes on until it is fixed.
const PENDING = "memory/pending";
// A change is one entry, so its record stays small; a larger one was not written by
// this.
const MAX_BYTES = 1_048_576;

// One file the change writes or removes, named relative to the memory folder so the
// folder can be moved and the name can never leave it.
export interface PendingStep {
	action: "write" | "remove";
	path: string;
	text?: string;
}

// The row of the change log that goes with the change; `id` is the operation id.
export interface PendingRow {
	id: string;
	time: string;
	op: string;
	scope: string;
	[key: string]: unknown;
}

export interface PendingRecord {
	id: string;
	time: string;
	op: string;
	scope: string;
	steps: PendingStep[];
	row: PendingRow;
}

export interface RecordInput {
	id: string;
	time: string;
	op: string;
	scope: string;
	steps: PendingStep[];
	row: Record<string, unknown>;
}

export function pendingPath(root: string): string {
	return join(root, PENDING_FILE);
}

// A path inside the memory folder, as the record holds it: relative, so the folder
// can be moved, and never outside it.
export function inside(root: string, path: string): string {
	const base = resolve(root);
	const full = resolve(base, path);
	if (full !== base && !full.startsWith(base + sep)) throw new Error(`the path ${path} is outside the memory folder`);
	return full;
}

// The path of a file in the memory folder, as the record holds it.
export function relativePath(root: string, path: string): string {
	return relative(resolve(root), resolve(path)).split(sep).join("/");
}

// The record of a change: what it does, and the row that goes with it.
export function record({ id, time, op, scope, steps, row }: RecordInput): PendingRecord {
	return { id, time, op, scope, steps, row: { time, id, ...row } as PendingRow };
}

// The record of a change, as it is written down. A record that would be too large is
// refused: the memory folder holds one change at a time, and a record that cannot be
// read back would stop the memory for good. The size is the same one the read side
// uses, so a record that is written can always be read.
export function serialize(record: PendingRecord): string {
	const text = JSON.stringify(record);
	const size = Buffer.byteLength(text);
	if (size > MAX_BYTES) {
		throw Object.assign(
			new Error(
				`The memory change is too large to record (${size} of ${MAX_BYTES} bytes). Make the memory file smaller first.`,
			),
			{ code: "memory/too-large" },
		);
	}
	return text;
}

// The record waiting to be finished, if there is one. A record that cannot be read
// or understood is an error, not an empty record: the change it holds is unknown,
// and a change that is half done must not be passed over.
export function read(root: string): PendingRecord | undefined {
	const path = pendingPath(root);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as { code?: string })?.code === "ENOENT") return undefined;
		const code = (error as { code?: string })?.code ?? (error as Error)?.message;
		throw Object.assign(new Error(`${PENDING_FILE} could not be read (${code})`), { code: PENDING });
	}
	if (Buffer.byteLength(text) > MAX_BYTES) {
		throw Object.assign(new Error(`${PENDING_FILE} is larger than a memory change record`), { code: PENDING });
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw Object.assign(new Error(`${PENDING_FILE} is not readable (${(error as Error).message})`), {
			code: PENDING,
		});
	}
	if (!wellFormed(value)) {
		throw Object.assign(new Error(`${PENDING_FILE} is not a memory change record`), { code: PENDING });
	}
	return value;
}

const wellFormed = (value: unknown): value is PendingRecord => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<PendingRecord>;
	if (typeof record.id !== "string" || record.id === "") return false;
	if (typeof record.op !== "string" || typeof record.scope !== "string") return false;
	if (!Array.isArray(record.steps) || record.steps.length === 0) return false;
	if (
		!record.steps.every(
			(step) =>
				step !== null &&
				typeof step === "object" &&
				typeof step.path === "string" &&
				step.path !== "" &&
				(step.action === "remove"
					? step.text === undefined
					: step.action === "write" && typeof step.text === "string"),
		)
	)
		return false;
	if (record.row === null || typeof record.row !== "object" || Array.isArray(record.row)) return false;
	return typeof (record.row as PendingRow).id === "string" && (record.row as PendingRow).id !== "";
};
