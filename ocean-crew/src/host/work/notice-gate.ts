// Receipts for proactive notices, and the one gate every notice passes before it is sent.
// The policy lives in notify.ts and is pure; this module supplies it with the time, the
// saved receipts and the user's preferences, then records a receipt only once a transport
// has accepted the notice. Nothing else in the host sends an unsolicited message.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	decideNotification,
	type HeldReason,
	type NotificationDecision,
	type NotificationEvent,
	type NotificationInput,
	type NotificationKind,
	type NotificationPreferences,
	type NotificationReceipt,
} from "./notify.ts";

/** How many receipts are kept: dedupe needs history, not an archive. */
export const RECEIPTS_KEPT = 200;

export interface ReceiptLog {
	read(): Promise<NotificationReceipt[]>;
	record(receipt: NotificationReceipt): Promise<void>;
}

const asReceipt = (value: unknown): NotificationReceipt | undefined => {
	if (value === null || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.dedupeKey !== "string" || raw.dedupeKey === "") return undefined;
	if (typeof raw.kind !== "string" || raw.kind === "") return undefined;
	if (typeof raw.acceptedAt !== "number" || !Number.isFinite(raw.acceptedAt)) return undefined;
	return { dedupeKey: raw.dedupeKey, kind: raw.kind as NotificationKind, acceptedAt: raw.acceptedAt };
};

export function receiptLog(home: string): ReceiptLog {
	const path = join(home, "notice-receipts.json");
	let writing: Promise<void> = Promise.resolve();
	const read = async (): Promise<NotificationReceipt[]> => {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!Array.isArray(parsed)) return [];
			return parsed.flatMap((entry) => {
				const receipt = asReceipt(entry);
				return receipt === undefined ? [] : [receipt];
			});
		} catch {
			return [];
		}
	};
	const record = async (receipt: NotificationReceipt): Promise<void> => {
		const next = writing.then(async () => {
			const kept = [receipt, ...(await read()).filter((held) => held.dedupeKey !== receipt.dedupeKey)].slice(
				0,
				RECEIPTS_KEPT,
			);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(kept, null, "\t")}\n`, "utf8");
		});
		writing = next.catch(() => undefined);
		await next;
	};
	return { read, record };
}

export interface NoticeGate {
	/**
	 * Decide one notice. `send` runs only when the policy delivers it; its receipt is recorded
	 * only when it resolves, so a failed send is retried as news rather than swallowed.
	 */
	offer(event: NotificationEvent, send: () => Promise<void>): Promise<NotificationDecision>;
	/** The receipts, newest first; the settings page reads them to explain what was sent. */
	receipts(): Promise<NotificationReceipt[]>;
}

export interface NoticeGateOptions {
	home: string;
	/** Read per call: the preference can change while the host runs. */
	preferences: () => NotificationPreferences;
	now?: () => number;
	quietHours?: () => NotificationInput["quietHours"];
	warn?: (message: string, error: unknown) => void;
}

export function noticeGate({ home, preferences, now = Date.now, quietHours, warn }: NoticeGateOptions): NoticeGate {
	const log = receiptLog(home);
	return {
		async offer(event, send) {
			let receipts: NotificationReceipt[] = [];
			try {
				receipts = await log.read();
			} catch (error) {
				warn?.("ocean-crew: notice receipts unreadable: %s", error);
			}
			const decision = decideNotification({
				now: now(),
				event,
				preferences: preferences(),
				...(quietHours?.() === undefined ? {} : { quietHours: quietHours() }),
				history: { receipts },
			});
			if (!decision.deliver) return decision;
			try {
				await send();
			} catch (error) {
				warn?.("ocean-crew: notice not delivered: %s", error);
				return decision;
			}
			await log
				.record({ dedupeKey: decision.dedupeKey, kind: decision.kind, acceptedAt: now() })
				.catch((error: any) => warn?.("ocean-crew: notice receipt not saved: %s", error?.message ?? error));
			return decision;
		},
		receipts: () => log.read(),
	};
}

/** Why a notice was held, as the settings page explains it. */
export const heldLabel = (reason: HeldReason): string => reason;
