import { createElement as h, useId, useRef, useState } from "react";
import { t } from "../core/i18n.ts";
import { CheckIcon, GlobeIcon } from "../look/icons.ts";
import { heldCardKey } from "../shell/sources.ts";
import { useDockHold } from "./card-hold.ts";
import { CellEmpty } from "./cell-empty.ts";

// -------------------------------------------------------------------------
// Browser handoff: a Bot's browser reached a step only the user can do (a sign-in,
// a payment, a captcha) and the Bot called browser_handoff. The call draws a card
// at its place in the chat, or above the composer when the chat does not draw it.
// Skip and I'm done answer the Bot; Take over opens the browser for the user and
// keeps the card up until one of the other two closes it. The card lives as long as
// the browser's hold carries its call id: the host clears the hold on an answer.

const titleOf = (reason?: string): string => {
	switch (reason) {
		case "login":
			return t("Sign-in needed");
		case "payment":
			return t("Payment needed");
		case "captcha":
			return t("Verification needed");
		default:
			return t("Help needed in the browser");
	}
};

// The page's host is what the user needs to know where the step is; its title and
// content are the page's own and stay out of the card.
function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function useSiteHost(hooks: any, botId: string): string {
	const tabId = hooks.useBrowserTabs?.((map: any) => map[botId]?.active ?? null) ?? null;
	const url = hooks.useBrowserPages?.((map: any) => (tabId == null ? "" : (map[tabId]?.url ?? ""))) ?? "";
	return hostOf(url);
}

// The open handoff. Like a pending question it hides while its answer is on the way
// and comes back if the answer fails; the buttons are guarded so a double click
// answers once.
export function PendingHandoff({ sessionId, bot, hold, hooks, actions, inline }: any) {
	const [closed, setClosed] = useState(false);
	const busyRef = useRef(false);
	const titleId = useId();
	const keep = useDockHold(sessionId, "handoff", hold.callId, actions, inline);
	const host = useSiteHost(hooks, bot.id);
	const taken = hold.by === "user";
	const run = (make: () => Promise<unknown>, close: boolean): void => {
		// The ref, not the state: two clicks in the same frame both read closed=false.
		if (busyRef.current) return;
		busyRef.current = true;
		keep();
		if (close) setClosed(true);
		void Promise.resolve()
			.then(make)
			.catch((error: any) => {
				setClosed(false);
				actions.reportError?.(error, "handoff");
			})
			.finally(() => {
				busyRef.current = false;
			});
	};
	const answer = (outcome: string): void =>
		run(() => actions.browserGiveBack(bot.id, { callId: hold.callId, outcome }), true);
	const takeOver = (): void =>
		run(async () => {
			await actions.browserTakeover(bot.id);
			actions.openBrowser?.(bot.id);
		}, false);
	return h(
		"div",
		{
			className: inline ? "bt-q-inline" : "bt-q-dock",
			style: closed ? { display: "none" } : undefined,
			onFocusCapture: keep,
			onPointerDownCapture: keep,
		},
		h(
			"section",
			{
				className: inline ? "bt-q bt-handoff" : "bt-q bt-q-raised bt-handoff",
				role: "group",
				"aria-labelledby": titleId,
			},
			h(
				"div",
				{ className: "bt-q-head" },
				h(
					"div",
					{ className: "bt-q-text" },
					h("p", { className: "bt-q-title", id: titleId }, titleOf(hold.reason)),
					hold.note ? h("div", { className: "bt-q-detail" }, hold.note) : null,
					host ? h("div", { className: "bt-handoff-site" }, h(GlobeIcon), h("span", null, host)) : null,
					taken
						? h(
								"div",
								{ className: "bt-handoff-state", role: "status" },
								h("span", { className: "bt-handoff-dot", "aria-hidden": true }),
								t("You control this browser"),
							)
						: null,
				),
			),
			h(
				"div",
				{ className: "bt-q-foot" },
				h("button", { type: "button", className: "bt-q-btn", onClick: () => answer("skip") }, t("Skip")),
				taken ? null : h("button", { type: "button", className: "bt-q-btn", onClick: takeOver }, t("Take over")),
				h("button", { type: "button", className: "bt-q-submit", onClick: () => answer("done") }, t("I'm done")),
			),
		),
	);
}

// The browser_handoff call in the transcript. A component of its own so it can read
// the browser sources: ToolCell hands it the hooks.
export function HandoffCall({ sessionId, callId, roster, actions, heldCards, hooks }: any) {
	const bot = roster.byId[sessionId];
	const hold = hooks.useBrowserHolds?.((map: any) => (bot ? map[bot.id] : undefined));
	// Answered, taken back, or never raised on this machine: no card, and no gap where it was.
	if (!bot || hold?.callId !== callId || !actions.browserGiveBack) return h(CellEmpty, { className: "bt-q-gone" });
	if (heldCards?.[heldCardKey("handoff", callId)] > 0) return h(CellEmpty);
	return h(PendingHandoff, { key: callId, sessionId, bot, hold, hooks, actions, inline: true });
}

// A handoff whose call the transcript does not draw (a hidden turn, a history that is
// still loading) waits above the composer. A card the user started on stays there
// until it closes.
export function HandoffDock({
	sessionId,
	useRoster,
	useCards,
	useHeldCards,
	useBrowserHolds,
	useBrowserTabs,
	useBrowserPages,
	actions,
}: any) {
	const bot = useRoster((value: any) => value.byId[sessionId]);
	const hold = useBrowserHolds?.((map: any) => (bot ? map[bot.id] : undefined));
	const drawn = useCards?.((state: any) => state[sessionId]?.[hold?.callId] > 0) === true;
	const held = useHeldCards?.((state: any) => state[sessionId]?.[heldCardKey("handoff", hold?.callId)] > 0) === true;
	if (!bot || hold?.callId === undefined || !actions.browserGiveBack || (drawn && !held)) return null;
	return h(PendingHandoff, {
		key: JSON.stringify([sessionId, hold.callId]),
		sessionId,
		bot,
		hold,
		hooks: { useBrowserTabs, useBrowserPages },
		actions,
		inline: false,
	});
}

// The answered card the transcript keeps: the title and how it ended, read-only.
export function SettledHandoff({ handoff }: any) {
	const skipped = handoff.outcome === "skipped";
	const returned = handoff.outcome === "returned";
	const title = titleOf(handoff.reason);
	return h(
		"div",
		{ className: "bt-q-inline" },
		h(
			"div",
			{
				className: skipped ? "bt-q bt-q-settled bt-q-dismissed" : "bt-q bt-q-settled",
				role: "group",
				"aria-label": title,
			},
			h(
				"div",
				{ className: "bt-q-head" },
				h("div", { className: "bt-q-text" }, h("p", { className: "bt-q-title" }, title)),
				skipped || returned
					? h("span", { className: "bt-q-badge" }, t(skipped ? "Skipped" : "Returned"))
					: h("span", { className: "bt-q-check", title: t("Done") }, h(CheckIcon)),
			),
		),
	);
}

export const HANDOFF_CSS = `
.bt-handoff .bt-q-detail{overflow-wrap:anywhere}
.bt-handoff-site{display:flex;align-items:center;gap:4px;min-width:0;margin-top:4px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-handoff-site svg{flex:none;width:12px;height:12px}
.bt-handoff-site span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-handoff-state{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-handoff-dot{flex:none;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--bt-green)}
.bt-handoff.bt-q-raised .bt-q-head{padding-bottom:12px}
.bt-handoff .bt-q-foot{flex-wrap:wrap}
`;
