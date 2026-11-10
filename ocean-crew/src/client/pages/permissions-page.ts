// Settings → Permissions: the tools the user allowed without a card. Every strict call becomes a
// card the first time; this page is where a repeated allow becomes standing, and where it is
// taken back. The list lives in the team state, so it survives a restart with the rest.
import { createElement as h, useEffect, useState } from "react";
import { t } from "../core/i18n.ts";
import { TrashIcon } from "../look/icons.ts";

const POLL_MS = 30_000;

export function PermissionsPage({ actions, Section, Row }: any) {
	const [grants, setGrants] = useState<any[] | undefined>(undefined);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState("");
	const [tool, setTool] = useState("");
	const [target, setTarget] = useState("");
	const [adding, setAdding] = useState(false);
	useEffect(() => {
		let stopped = false;
		let timer: any;
		const load = () =>
			actions
				.sideEffectGrants?.()
				?.then((view: any) => {
					if (stopped) return;
					setGrants(Array.isArray(view?.grants) ? view.grants : []);
					setFailed(false);
				})
				.catch(() => {
					if (!stopped) {
						setFailed(true);
						setGrants([]);
					}
				});
		void load();
		timer = setInterval(load, POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [actions]);

	const grant = async () => {
		const name = tool.trim();
		if (name === "") return;
		setBusy("add");
		try {
			const view: any = await actions.sideEffectGrant?.({
				tool: name,
				...(target.trim() === "" ? {} : { target: target.trim() }),
			});
			if (Array.isArray(view?.grants)) setGrants(view.grants);
			setTool("");
			setTarget("");
			setAdding(false);
		} finally {
			setBusy("");
		}
	};

	const revoke = async (grant: any) => {
		const key = `${grant.tool}:${grant.target ?? ""}`;
		setBusy(key);
		try {
			await actions.sideEffectRevoke?.({
				tool: grant.tool,
				...(grant.target === undefined ? {} : { target: grant.target }),
			});
			setGrants((held) => (held ?? []).filter((entry) => `${entry.tool}:${entry.target ?? ""}` !== key));
		} finally {
			setBusy("");
		}
	};

	const list = grants ?? [];
	return h(
		Section,
		{ key: "grants", title: t("Allowed without asking") },
		h(
			"p",
			{ className: "bt-set-hint" },
			t(
				"A tool that sends, deletes or pays asks first. Allowing it here covers every later call, until you remove it.",
			),
		),
		failed
			? h("p", { className: "bt-set-hint", "data-danger": "" }, t("The permission list could not be read."))
			: null,
		adding
			? h(
					"div",
					{ className: "bt-grant-form" },
					h("input", {
						className: "bt-input",
						value: tool,
						placeholder: t("Tool name, as the card showed it"),
						"aria-label": t("Tool name"),
						onChange: (event: any) => setTool(event.target.value),
					}),
					h("input", {
						className: "bt-input",
						value: target,
						placeholder: t("Only this target (optional)"),
						"aria-label": t("Target"),
						onChange: (event: any) => setTarget(event.target.value),
					}),
					h(
						"button",
						{
							type: "button",
							className: "bt-soft bt-soft-sm",
							disabled: busy !== "" || tool.trim() === "",
							onClick: () => void grant(),
						},
						t("Allow"),
					),
				)
			: h(
					"button",
					{ type: "button", className: "bt-soft bt-soft-sm", onClick: () => setAdding(true) },
					t("Allow a tool without asking"),
				),
		list.length === 0
			? h("p", { className: "bt-set-hint" }, t("Nothing is allowed without asking. Every strict call shows a card."))
			: list.map((grant: any) =>
					h(
						Row,
						{
							key: `${grant.tool}:${grant.target ?? ""}`,
							title: grant.tool,
							hint: grant.target ?? t("Any target"),
						},
						h(
							"button",
							{
								type: "button",
								className: "bt-mini",
								disabled: busy !== "",
								title: t("Remove this permission"),
								"aria-label": t("Remove this permission"),
								onClick: () => void revoke(grant),
							},
							h(TrashIcon),
						),
					),
				),
	);
}

export const PERMISSIONS_CSS = `
/* The form that grants a tool: two fields and one button, on its own line. */
.bt-grant-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 2px}
.bt-grant-form .bt-input{flex:1 1 160px;min-width:120px;max-width:260px}
`;
