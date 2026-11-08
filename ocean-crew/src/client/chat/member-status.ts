import { createElement as h, useLayoutEffect, useRef, useState } from "react";
import { t } from "../core/i18n.ts";
import { BotMark, toolState } from "../look/mark.ts";
import { SPRING_SHAPE, SPRING_TAP, spring, useLinger } from "../look/motion.ts";
import { Elapsed, Shimmer, workPhrase } from "./cells.ts";

// -------------------------------------------------------------------------
// What a group's members are doing: above the group's composer, one capsule for the
// members at work or waiting for an approval; above a Bot's own composer, one for the
// groups it is at work in; and per member in the details panel, where the approvals
// their group turns wait on are answered.

const NO_WORK = { bots: {}, rooms: {}, approvals: [] as any[] };
const FACES_MAX = 3;
const DOCK_EXIT_MS = 160;

/** One member's place in the work of a room. */
export interface MemberWorkEntry {
	id: string;
	approvals: any[];
	doing: any;
	here: boolean;
	state: "ask" | "work" | "idle";
}

// Only work in this group counts here; work elsewhere shows on the Bot's own chat
// (its 'in {group}' capsule and sidebar group tag), not in every group it is in (#473).
export function memberWork(room: any, work: any = NO_WORK): MemberWorkEntry[] {
	const here = work.rooms?.[room.id] ?? [];
	return room.members.map((id: string) => {
		const approvals = (work.approvals ?? []).filter((entry: any) => entry.botId === id);
		const local = here.find((entry: any) => entry.botId === id);
		const doing = local ? { ...local, roomId: room.id } : undefined;
		return {
			id,
			approvals,
			doing,
			here: local !== undefined,
			state: approvals.length > 0 ? "ask" : doing ? "work" : "idle",
		};
	});
}

// The busy members, those waiting for an approval first.
export function busyMembers(room: any, work: any, roster: any): any[] {
	const busy = memberWork(room, work).filter(
		(entry: MemberWorkEntry) => entry.state !== "idle" && roster.byId[entry.id],
	);
	return [
		...busy.filter((entry: MemberWorkEntry) => entry.state === "ask"),
		...busy.filter((entry: MemberWorkEntry) => entry.state === "work"),
	].map((entry: MemberWorkEntry) => ({ ...entry, bot: roster.byId[entry.id] }));
}

// The capsule leaves out the round's current speaker, which its round shows.
const dockMembers = (busy: any[]): any[] =>
	busy.filter((entry: any) => !(entry.state === "work" && entry.here && entry.doing.speaking === true));

export const workState = (doing: any): string => (doing?.switching ? "thinking" : toolState(doing?.tool ?? ""));

// The groups a Bot is at work in.
export function botGroupWork(botId: string, work: any, roster: any): any[] {
	return Object.entries(work.rooms ?? {}).flatMap(([roomId, entries]: [string, any]) => {
		const entry = entries.find((item: any) => item.botId === botId);
		const room = roster.roomsById[roomId];
		return entry && room ? [{ room, doing: entry, since: entry.since }] : [];
	});
}

/** The capsule's two halves: who waits for an approval, and what the first worker does. */
export interface MemberSummary {
	waiting: string;
	doing: string;
}

export function summaryText(busy: any[]): MemberSummary {
	const asks = busy.filter((entry: any) => entry.state === "ask");
	const workers = busy.filter((entry: any) => entry.state === "work");
	const names = asks.slice(0, 2).map((entry: any) => entry.bot.name);
	const waiting =
		asks.length === 0
			? ""
			: asks.length === 1
				? t("{name} is waiting for your approval", { name: names[0] })
				: asks.length === 2
					? t("{first} and {second} are waiting for your approval", { first: names[0], second: names[1] })
					: t("{first}, {second} and {count} more are waiting for your approval", {
							first: names[0],
							second: names[1],
							count: asks.length - 2,
							total: asks.length,
						});
	const first = workers[0];
	const doing = first
		? `${first.bot.name} · ${workPhrase(first.doing)}…${workers.length > 1 ? ` +${workers.length - 1}` : ""}`
		: "";
	return { waiting, doing };
}

// What the capsule shows, as plain data: it outlives the work for its exit.
function dockModel(sessionId: string, roster: any, work: any): any {
	const room = roster.roomsById[sessionId];
	if (room) {
		const busy = dockMembers(busyMembers(room, work, roster));
		if (busy.length === 0) return null;
		const { waiting, doing } = summaryText(busy);
		return {
			open: { details: room.id },
			faces: busy.slice(0, FACES_MAX).map((entry: any) => ({
				id: entry.id,
				ask: entry.state === "ask",
				state: workState(entry.doing),
			})),
			waiting,
			doing,
		};
	}
	const bot = roster.byId[sessionId];
	// A running own chat has its activity row.
	if (!bot || (work.bots?.[bot.id] !== undefined && work.bots[bot.id].roomId === undefined)) return null;
	const groups = botGroupWork(bot.id, work, roster);
	if (groups.length === 0) return null;
	const [first] = groups;
	return {
		open: { session: first.room.id },
		faces: [{ id: bot.id, ask: false, state: workState(first.doing) }],
		waiting: "",
		doing: `${t("in {name}", { name: first.room.name })} · ${workPhrase(first.doing)}…${groups.length > 1 ? ` +${groups.length - 1}` : ""}`,
	};
}

function Face({ bot, ask, state }: any) {
	return h(
		"span",
		{ className: "bt-mw-face", "data-ask": ask || undefined },
		h(BotMark, { bot, size: 20, state: ask ? "alert" : state }),
	);
}

// The capsule springs to the width of what it says; it is measured, so the spring runs
// between two real widths. A capsule that comes back starts from its own width.
function useFitWidth(inner: any, key: string | null): number | null {
	const [width, setWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		setWidth(key && inner.current ? inner.current.offsetWidth : null);
	}, [key]);
	return width;
}

// Above the composer, one capsule for everything at work: it opens the group's details,
// or from a Bot's own chat the group it is at work in.
export function MemberDock({ sessionId, useRoster, useWork, actions }: any) {
	const roster = useRoster((value: any) => value);
	const work = useWork((value: any) => value);
	const live = dockModel(sessionId, roster, work);
	const [kept, leaving] = useLinger(live ? JSON.stringify(live) : null, DOCK_EXIT_MS);
	const model = kept ? JSON.parse(kept) : null;
	const inner = useRef<any>(null);
	const width = useFitWidth(inner, kept);
	if (!model) return null;
	const faces = model.faces
		.map((face: any) => ({ ...face, bot: roster.byId[face.id] }))
		.filter((face: any) => face.bot);
	const label = [model.waiting, model.doing].filter(Boolean).join(" · ");
	const open = (): void =>
		model.open.details ? actions.showDetails(model.open.details) : actions.openSession(model.open.session);
	return h(
		"div",
		{ className: "bt-mw-dock", "data-leaving": leaving || undefined },
		h(
			"button",
			{
				type: "button",
				className: "bt-mw-pill",
				"aria-label": label,
				onClick: open,
				disabled: leaving,
				style: width ? { width } : undefined,
			},
			h(
				"span",
				{ ref: inner, className: "bt-mw-pill-in" },
				h(
					"span",
					{ className: "bt-mw-faces", "aria-hidden": true },
					faces.map((face: any) => h(Face, { key: face.id, ...face })),
				),
				h(
					"span",
					{ key: label, className: "bt-mw-label", "aria-hidden": true },
					model.waiting ? h("span", { className: "bt-mw-ask" }, model.waiting) : null,
					model.waiting && model.doing ? h("span", { className: "bt-mw-dot" }, "·") : null,
					model.doing ? h("span", { className: "bt-mw-doing" }, h(Shimmer, null, model.doing)) : null,
				),
			),
		),
	);
}

// The clock stays whole at the end; only what comes before it is cut.
const stateLine = (className: string, at: number | undefined, ...what: any[]): any =>
	h(
		"span",
		{ className },
		h("span", { className: "bt-member-what" }, ...what),
		typeof at === "number" ? h(Elapsed, { at, className: "bt-member-time" }) : null,
	);

function ApprovalCard({ approval, bot, actions }: any) {
	const [busy, setBusy] = useState(false);
	const answer = (choice: string): void => {
		setBusy(true);
		void Promise.resolve(actions.answerApproval(approval.id, choice))
			.catch((error: any) => actions.reportError(error, "approval"))
			.finally(() => setBusy(false));
	};
	return h(
		"div",
		{
			className: "bt-mw-card",
			role: "group",
			"aria-label": t("{name} is waiting for your approval", { name: bot.name }),
		},
		h("div", { className: "bt-mw-tool" }, approval.tool),
		approval.detail?.text ? h("div", { className: "bt-mw-text" }, approval.detail.text) : null,
		approval.reason ? h("div", { className: "bt-mw-reason" }, approval.reason) : null,
		approval.detail?.code
			? h("code", { className: "bt-mw-code", title: approval.detail.code }, approval.detail.code)
			: null,
		// Own-chat approvals are answerable for IM and the phone app; here the Bot's
		// own DSH card stays the place to answer, so the row still opens that chat.
		approval.answerable && approval.roomId !== undefined
			? h(
					"div",
					{ className: "bt-mw-actions" },
					h(
						"button",
						{ type: "button", className: "bt-q-btn", disabled: busy, onClick: () => answer("reject") },
						t("Reject"),
					),
					h(
						"button",
						{ type: "button", className: "bt-q-submit", disabled: busy, onClick: () => answer("allow") },
						t("Allow once"),
					),
				)
			: h(
					"div",
					{ className: "bt-mw-actions" },
					h(
						"button",
						{ type: "button", className: "bt-q-btn", onClick: () => actions.openSession(bot.id) },
						t("Open {name}'s chat", { name: bot.name }),
					),
				),
	);
}

// A member's second line in the group's details: what it is doing here, or its role.
export function MemberState({ entry, bot }: any) {
	if (entry?.state === "ask")
		return stateLine("bt-member-state bt-mw-ask", entry.approvals[0].at, t("Waiting for your approval"));
	if (entry?.state !== "work") return bot.role ? stateLine("bt-member-state", undefined, bot.role) : null;
	return stateLine("bt-member-state", entry.doing.since, h(Shimmer, null, `${workPhrase(entry.doing)}…`));
}

// Work in this group can be stopped from its details, since the user cannot reach the
// member's group Session otherwise; a turn waiting for an approval still holds its work.
export function StopMemberWork({ entry, bot, room, actions }: any) {
	const [stopping, setStopping] = useState(false);
	if (!entry?.here || (entry.state !== "work" && entry.state !== "ask")) return null;
	const stop = (): void => {
		setStopping(true);
		void Promise.resolve(actions.stopMemberWork(room.id, bot.id))
			.catch((error: any) => actions.reportError(error, "stop"))
			.finally(() => setStopping(false));
	};
	return h(
		"button",
		{
			type: "button",
			className: "bt-member-stop",
			disabled: stopping,
			"aria-label": `${t("Stop")} · ${bot.name}`,
			onClick: stop,
		},
		t("Stop"),
	);
}

// The group's work stops all at once from its details: DSH's own stop reaches only the
// round, and a member the round moved on from keeps working.
export function StopRoomWork({ room, entries, actions }: any) {
	const [stopping, setStopping] = useState(false);
	if (!entries.some((entry: any) => entry.here)) return null;
	const stop = (): void => {
		setStopping(true);
		void Promise.resolve(actions.stopRoomWork(room.id))
			.catch((error: any) => actions.reportError(error, "stop"))
			.finally(() => setStopping(false));
	};
	const label = t("Stop all work in this group");
	return h(
		"button",
		{
			type: "button",
			className: "bt-soft bt-soft-sm",
			disabled: stopping,
			"aria-label": label,
			title: label,
			onClick: stop,
		},
		t("Stop all"),
	);
}

export function MemberApprovals({ entry, bot, actions }: any) {
	if (entry?.state !== "ask") return null;
	return h(
		"div",
		{ className: "bt-member-cards" },
		entry.approvals.map((approval: any) => h(ApprovalCard, { key: approval.id, approval, bot, actions })),
	);
}

export function useMemberWork(room: any, useWork: any): { entries: MemberWorkEntry[] } {
	const work = useWork?.((value: any) => value) ?? NO_WORK;
	return { entries: room ? memberWork(room, work) : [] };
}

export const MEMBER_CSS = `
.bt-mw-dock{display:flex;justify-content:center;margin:0 auto 8px;pointer-events:none}
.bt-mw-pill{pointer-events:auto;position:relative;display:inline-flex;align-items:center;flex:none;box-sizing:border-box;height:32px;max-width:100%;padding:0;border:0;border-radius:999px;overflow:hidden;background:var(--bt-main);box-shadow:0 0 0 .5px var(--bt-line-2),0 2px 8px -2px rgba(0,0,0,.12);color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:18px;cursor:pointer;animation:bt-mw-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .18s ease-out backwards;transition:background-color .12s ease,${spring(SPRING_SHAPE, "width")},${spring(SPRING_TAP, "scale")}}
.bt-mw-pill:hover{background:color-mix(in srgb,var(--bt-ink) 4%,var(--bt-main))}
.bt-mw-pill:active{scale:.97}
.bt-mw-dock[data-leaving] .bt-mw-pill{animation:bt-mw-out .16s cubic-bezier(.4,0,1,1) forwards;pointer-events:none}
.bt-mw-pill-in{display:inline-flex;align-items:center;gap:8px;flex:none;padding:0 13px 0 6px;white-space:nowrap}
.bt-mw-faces{display:inline-flex;align-items:center;flex:none;line-height:0}
.bt-mw-face{position:relative;display:inline-flex;flex:none;border-radius:50%;background:var(--bt-main);box-shadow:0 0 0 2px var(--bt-main);animation:bt-mw-seat .26s cubic-bezier(.34,1.56,.64,1) backwards}
.bt-mw-face+.bt-mw-face{margin-left:-5px}
.bt-mw-face[data-ask]::after{content:"";position:absolute;right:-1px;bottom:-1px;width:7px;height:7px;border-radius:50%;background:#e3a008;box-shadow:0 0 0 1.5px var(--bt-main)}
.bt-mw-label{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:min(420px,58vw);animation:bt-mw-swap .22s ease-out backwards}
.bt-mw-label>*{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-mw-ask{color:#b7791f;flex:none}
.bt-mw-dot{flex:none;color:var(--bt-ink-3)}
.bt-mw-doing{flex:0 1 auto}
body[data-ds-dark-theme] .bt-mw-ask{color:#f0b84a}
@keyframes bt-mw-in{from{transform:translateY(8px) scale(.94)}}
@keyframes bt-mw-out{to{opacity:0;transform:translateY(6px) scale(.96);filter:blur(3px)}}
@keyframes bt-mw-seat{from{opacity:0;scale:.6}}
@keyframes bt-mw-swap{from{opacity:0;filter:blur(4px)}}
.bt-members{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.bt-members-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.bt-members-head>.bt-section-title{margin:0}
/* The button hangs over the title's line, so the list below does not move when it appears. */
.bt-members-head>.bt-soft-sm{margin:-6px 0}
.bt-members-head>.bt-soft-sm:disabled{opacity:.5;cursor:default}
.bt-member{display:flex;flex-direction:column;border-radius:12px;animation:bt-rise .18s ease-out backwards}
.bt-member-row{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 8px;border-radius:12px;transition:background-color .12s ease}
.bt-member-row:hover{background:var(--bt-hover)}
.bt-member-open{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:8px 0;border:0;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-member-open>.bt-mark{flex:none}
.bt-member-text{display:flex;flex-direction:column;min-width:0;gap:1px}
.bt-member-line{display:flex;align-items:center;gap:6px;min-width:0}
.bt-member-name{min-width:0;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-member-line>.bt-tag{font-size:11px;line-height:15px;padding:0 5px}
.bt-member-state{display:flex;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
.bt-member-what{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bt-member-time{flex:none;margin-left:.3em;font-variant-numeric:tabular-nums}
.bt-member-state.bt-mw-ask{color:#b7791f}
body[data-ds-dark-theme] .bt-member-state.bt-mw-ask{color:#f0b84a}
.bt-member-stop{flex:none;height:26px;padding:0 11px;border:0;border-radius:999px;background:var(--bt-main);box-shadow:inset 0 0 0 .5px var(--bt-line-2);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, "scale")}}
.bt-member-stop:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-member-stop:active:not(:disabled){scale:.94}
.bt-member-stop:disabled{opacity:.5;cursor:default}
.bt-member-cards{display:flex;flex-direction:column;gap:6px;padding:2px 8px 8px 50px}
.bt-mw-card{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:12px;background:var(--bt-hover);font-size:12px;line-height:17px;color:var(--bt-ink-2);animation:bt-rise .2s ease-out backwards}
.bt-mw-tool{font-weight:600;color:var(--bt-ink)}
.bt-mw-text{color:var(--bt-ink);overflow-wrap:anywhere}
.bt-mw-reason{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-mw-code{display:block;padding:4px 8px;border-radius:6px;background:var(--bt-main);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-mw-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}
.bt-mw-actions>button{height:28px;padding:0 12px;font-size:12px}
.bt-mw-actions>button:disabled{opacity:.5;cursor:default}
@media (prefers-reduced-motion:reduce){.bt-mw-pill,.bt-mw-face,.bt-mw-label,.bt-member,.bt-mw-card{animation:none}.bt-mw-pill{transition:background-color .12s ease}}
`;
