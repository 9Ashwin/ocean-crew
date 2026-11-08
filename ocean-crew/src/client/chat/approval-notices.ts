// A system notification for each approval that starts waiting while this window is in
// the background or shows another conversation. Only where the platform already allows
// notifications: Ocean Crew never asks for the permission.

import { t } from "../core/i18n.ts";

/** One approval waiting for the user. */
export interface ApprovalNoticeEntry {
	id: string;
	at?: number;
	roomId?: string;
	botId?: string;
	sessionId?: string;
	tool?: string;
}

/** The live work snapshot the sidebar reads approvals from. */
export interface ApprovalWork {
	getSnapshot(): { approvals?: ApprovalNoticeEntry[] };
	subscribe(listener: () => void): () => void;
}

export interface ApprovalRosterSnapshot {
	byId: Record<string, { name?: string } | undefined>;
	roomsById: Record<string, { name?: string } | undefined>;
}

export interface ApprovalRoster {
	getSnapshot(): ApprovalRosterSnapshot;
}

export interface NoticeApprovalsInput {
	work: ApprovalWork;
	roster: ApprovalRoster;
	shownSession(): string | undefined;
	openSession(place: string): void;
	since?: number;
}

export function noticeApprovals({
	work,
	roster,
	shownSession,
	openSession,
	since = Date.now(),
}: NoticeApprovalsInput): () => void {
	const told = new Set<string>();
	const notify = (): void => {
		const approvals = work.getSnapshot().approvals ?? [];
		for (const id of told) {
			if (!approvals.some((entry) => entry.id === id)) told.delete(id);
		}
		if (typeof Notification !== "function" || Notification.permission !== "granted") return;
		for (const entry of approvals) {
			if (told.has(entry.id)) continue;
			told.add(entry.id);
			// Waiting before this window opened is no news: the sidebar shows it.
			if ((entry.at ?? 0) < since) continue;
			const place = entry.roomId ?? entry.sessionId;
			if (document.visibilityState === "visible" && shownSession() === place) continue;
			const { byId, roomsById } = roster.getSnapshot();
			const room = entry.roomId ? roomsById[entry.roomId] : undefined;
			const note = new Notification(
				t("{name} is waiting for your approval", { name: byId[entry.botId ?? ""]?.name ?? t("A Bot") }),
				{
					body: [room?.name, entry.tool].filter(Boolean).join(" · "),
					tag: `ocean-crew-approval-${entry.id}`,
				},
			);
			note.onclick = () => {
				window.focus();
				openSession(entry.roomId ?? entry.botId ?? entry.sessionId ?? "");
				note.close();
			};
		}
	};
	notify();
	return work.subscribe(notify);
}
