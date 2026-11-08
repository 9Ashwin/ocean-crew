// The shared capabilities page (MCP servers, skills, packs) and the per-Bot card that
// attaches them.
import { Fragment, createElement as h, useEffect, useState } from "react";
import { t } from "../core/i18n.ts";

export type CapabilityKind = "mcp" | "skill" | "pack";

/** One saved capability as the roster reports it. */
export interface CapabilityItem {
	name: string;
	kind: CapabilityKind;
	description?: string;
	transport?: string;
	approved?: boolean;
	items?: string[];
	args?: string[];
	env?: Record<string, unknown>;
	headers?: Record<string, unknown>;
	content?: string;
	[key: string]: unknown;
}

export interface CapabilityStatus {
	state: "ready" | "needs-approval" | "error" | string;
	error?: string;
}

export interface CapabilityRoster {
	capabilities?: CapabilityItem[];
	capabilityStatuses?: Record<string, Record<string, CapabilityStatus | undefined> | undefined>;
}

export interface CapabilityActions {
	saveCapability(payload: Record<string, unknown>): Promise<unknown>;
	deleteCapability(name: string): Promise<unknown>;
	approveCapability(name: string): Promise<unknown>;
	setBotCapability(botId: string, name: string, enabled: boolean): Promise<unknown>;
}

/** The capability draft the form edits. */
export interface CapabilityDraft {
	name: string;
	kind: CapabilityKind;
	description: string;
	transport: string;
	command: string;
	argsText: string;
	envText: string;
	url: string;
	headersText: string;
	content: string;
	items: string[];
	originalName?: string;
}

const blank = (): CapabilityDraft => ({
	name: "",
	kind: "mcp",
	description: "",
	transport: "stdio",
	command: "",
	argsText: "",
	envText: "{}",
	url: "",
	headersText: "{}",
	content: "",
	items: [],
});

const parseMap = (text: string, label: string): Record<string, unknown> => {
	let value: unknown;
	try {
		value = JSON.parse(text || "{}");
	} catch {
		throw new Error(t("{label} must be valid JSON.", { label }));
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(t("{label} must be a JSON object.", { label }));
	return value as Record<string, unknown>;
};

const statusText = (status: CapabilityStatus | undefined): string | undefined =>
	!status
		? undefined
		: status.state === "ready"
			? t("Ready")
			: status.state === "needs-approval"
				? t("Needs approval")
				: status.state === "error"
					? t("Could not connect: {error}", { error: status.error ?? "" })
					: t("Connecting…");

interface FieldProps {
	label: string;
	value: string;
	onChange(value: string): void;
	multiline?: boolean;
	disabled?: boolean;
	placeholder?: string;
}

function Field({ label, value, onChange, multiline = false, disabled = false, placeholder }: FieldProps): any {
	return h(
		"label",
		{ className: "bt-set-row bt-bs-row bt-bs-stack" },
		h("span", { className: "bt-set-copy" }, h("span", { className: "bt-bs-label" }, t(label))),
		h(multiline ? "textarea" : "input", {
			className: multiline ? "bt-input bt-input-area" : "bt-input",
			value,
			disabled,
			maxLength: label === "Name" ? 32 : undefined,
			placeholder,
			spellCheck: false,
			onChange: (event: any) => onChange(event.target.value),
		}),
	);
}

interface CapabilityFormProps {
	draft: CapabilityDraft;
	setDraft(updater: (previous: CapabilityDraft) => CapabilityDraft): void;
	items: CapabilityItem[];
	actions: CapabilityActions;
	onClose(): void;
}

function CapabilityForm({ draft, setDraft, items, actions, onClose }: CapabilityFormProps): any {
	const [error, setError] = useState("");
	const set = (key: string, value: unknown): void => setDraft((previous) => ({ ...previous, [key]: value }));
	const submit = async (event: any): Promise<void> => {
		event.preventDefault();
		setError("");
		let payload: Record<string, unknown>;
		try {
			payload = { name: draft.name.trim(), kind: draft.kind, description: draft.description };
			if (draft.kind === "mcp" && draft.transport === "stdio") {
				payload.transport = "stdio";
				payload.command = draft.command;
				payload.args = draft.argsText.split("\n").filter((line) => line !== "");
				payload.env = parseMap(draft.envText, t("Environment"));
			} else if (draft.kind === "mcp") {
				payload.transport = "streamable-http";
				payload.url = draft.url;
				payload.headers = parseMap(draft.headersText, t("Headers"));
			} else if (draft.kind === "skill") payload.content = draft.content;
			else payload.items = draft.items;
		} catch (failure: any) {
			setError(failure?.message ?? String(failure));
			return;
		}
		try {
			await actions.saveCapability(payload);
			onClose();
		} catch (failure: any) {
			setError(failure?.message ?? String(failure));
		}
	};
	const available = items.filter((item) => item.name !== draft.name && ["mcp", "skill"].includes(item.kind));
	return h(
		"form",
		{ className: "bt-set-card bt-task-form", onSubmit: submit },
		h(Field, {
			label: "Name",
			value: draft.name,
			disabled: draft.originalName !== undefined,
			onChange: (value: string) => set("name", value),
			placeholder: "my-tool",
		}),
		h(
			"label",
			{ className: "bt-set-row bt-bs-row" },
			h("span", { className: "bt-set-copy" }, h("span", { className: "bt-bs-label" }, t("Type"))),
			h(
				"select",
				{
					className: "bt-select bt-task-bot",
					value: draft.kind,
					disabled: draft.originalName !== undefined,
					onChange: (event: any) => set("kind", event.target.value),
				},
				["mcp", "skill", "pack"].map((kind) =>
					h(
						"option",
						{ key: kind, value: kind },
						t(kind === "mcp" ? "MCP server" : kind === "skill" ? "Skill" : "Pack"),
					),
				),
			),
		),
		h(Field, {
			label: "Description",
			value: draft.description,
			onChange: (value: string) => set("description", value),
		}),
		draft.kind === "mcp"
			? h(
					"label",
					{ className: "bt-set-row bt-bs-row" },
					h("span", { className: "bt-set-copy" }, h("span", { className: "bt-bs-label" }, t("Connection"))),
					h(
						"select",
						{
							className: "bt-select bt-task-bot",
							value: draft.transport,
							onChange: (event: any) => set("transport", event.target.value),
						},
						h("option", { value: "stdio" }, t("Local command")),
						h("option", { value: "streamable-http" }, t("HTTP server")),
					),
				)
			: null,
		draft.kind === "mcp" && draft.transport === "stdio"
			? h(
					Fragment,
					null,
					h(Field, { label: "Command", value: draft.command, onChange: (value: string) => set("command", value) }),
					h(Field, {
						label: "Arguments (one per line)",
						value: draft.argsText,
						onChange: (value: string) => set("argsText", value),
						multiline: true,
					}),
					h(Field, {
						label: "Environment (JSON)",
						value: draft.envText,
						onChange: (value: string) => set("envText", value),
						multiline: true,
						placeholder: t('{"API_KEY": "$DSH_SECRET_MY_KEY"}'),
					}),
				)
			: null,
		draft.kind === "mcp" && draft.transport === "streamable-http"
			? h(
					Fragment,
					null,
					h(Field, { label: "URL", value: draft.url, onChange: (value: string) => set("url", value) }),
					h(Field, {
						label: "Headers (JSON)",
						value: draft.headersText,
						onChange: (value: string) => set("headersText", value),
						multiline: true,
						placeholder: t('{"API_KEY": "$DSH_SECRET_MY_KEY"}'),
					}),
				)
			: null,
		draft.kind === "skill"
			? h(Field, {
					label: "Skill instructions",
					value: draft.content,
					onChange: (value: string) => set("content", value),
					multiline: true,
				})
			: null,
		draft.kind === "pack"
			? h(
					Fragment,
					null,
					available.length === 0
						? h(
								"div",
								{ className: "bt-set-row" },
								h("span", { className: "bt-set-hint" }, t("Save an MCP server or skill first.")),
							)
						: available.map((item) =>
								h(
									"label",
									{ key: item.name, className: "bt-set-row bt-bs-row" },
									h("span", { className: "bt-set-copy" }, h("span", { className: "bt-bs-label" }, item.name)),
									h("input", {
										type: "checkbox",
										checked: draft.items.includes(item.name),
										onChange: (event: any) =>
											set(
												"items",
												event.target.checked
													? [...draft.items, item.name]
													: draft.items.filter((name) => name !== item.name),
											),
									}),
								),
							),
				)
			: null,
		error
			? h(
					"div",
					{ className: "bt-set-row" },
					h("span", { className: "bt-danger bt-set-hint", role: "alert" }, error),
				)
			: null,
		h(
			"div",
			{ className: "bt-set-row bt-task-foot" },
			h("button", { type: "button", className: "bt-soft bt-soft-sm", onClick: onClose }, t("Cancel")),
			h(
				"button",
				{ type: "submit", className: "bt-send bt-soft-sm" },
				draft.originalName ? t("Save changes") : t("Add capability"),
			),
		),
	);
}

interface CapabilityRowProps {
	item: CapabilityItem;
	onEdit(): void;
	onDelete(): void;
	onApprove(): void;
	confirming: boolean;
}

function CapabilityRow({ item, onEdit, onDelete, onApprove, confirming }: CapabilityRowProps): any {
	const detail =
		item.kind === "pack"
			? `${t("Pack")}: ${(item.items ?? []).join(", ") || t("No items")}`
			: item.kind === "mcp"
				? item.transport === "stdio"
					? t("Local command")
					: t("HTTP server")
				: t("Skill");
	const secondary =
		item.kind === "pack"
			? [item.description, (item.items ?? []).join(", ") || t("No items")].filter(Boolean).join(" · ")
			: item.description || detail;
	return h(
		"div",
		{ className: "bt-connector" },
		h(
			"div",
			{ className: "bt-connector-head" },
			h(
				"span",
				{ className: "bt-connector-text" },
				h("span", { className: "bt-connector-name" }, item.name),
				h("span", { className: "bt-connector-status" }, secondary),
			),
			h(
				"span",
				{ className: "bt-connector-actions" },
				item.kind === "mcp" && item.transport === "stdio" && !item.approved
					? h("button", { type: "button", className: "bt-soft bt-soft-sm", onClick: onApprove }, t("Allow"))
					: null,
				h("button", { type: "button", className: "bt-soft bt-soft-sm", onClick: onEdit }, t("Edit")),
				h(
					"button",
					{ type: "button", className: "bt-soft bt-soft-sm", onClick: onDelete },
					confirming ? t("Click again to delete.") : t("Delete"),
				),
			),
		),
	);
}

export interface CapabilitiesPageProps {
	roster: CapabilityRoster;
	actions: CapabilityActions;
	run(promise: Promise<unknown>): void;
}

export function CapabilitiesPage({ roster, actions, run }: CapabilitiesPageProps): any {
	const items = [...(roster.capabilities ?? [])].sort((a, b) => a.name.localeCompare(b.name));
	const [draft, setDraft] = useState<CapabilityDraft | null>(null);
	const [confirming, setConfirming] = useState("");
	useEffect(() => {
		if (!confirming) return undefined;
		const timer = setTimeout(() => setConfirming(""), 4000);
		return () => clearTimeout(timer);
	}, [confirming]);
	const startNew = (): void => setDraft(blank());
	const edit = (item: CapabilityItem): void =>
		setDraft({
			...blank(),
			...item,
			originalName: item.name,
			argsText: (item.args ?? []).join("\n"),
			envText: JSON.stringify(item.env ?? {}, null, 2),
			headersText: JSON.stringify(item.headers ?? {}, null, 2),
			items: [...(item.items ?? [])],
		});
	const remove = (item: CapabilityItem): void => {
		if (confirming !== item.name) {
			setConfirming(item.name);
			return;
		}
		setConfirming("");
		void run(actions.deleteCapability(item.name));
	};
	return h(
		"section",
		{ className: "bt-set-section" },
		h("h3", null, t("Shared capabilities")),
		draft
			? h(CapabilityForm, {
					draft,
					setDraft: setDraft as (updater: (previous: CapabilityDraft) => CapabilityDraft) => void,
					items,
					actions,
					onClose: () => setDraft(null),
				})
			: h(
					"div",
					{ className: "bt-actions" },
					h("button", { type: "button", className: "bt-soft bt-soft-sm", onClick: startNew }, t("Add capability")),
				),
		h(
			"div",
			{ className: "bt-set-card bt-connectors-card" },
			items.length === 0
				? h("div", { className: "bt-set-row" }, h("span", { className: "bt-set-hint" }, t("No capabilities saved")))
				: items.map((item) =>
						h(CapabilityRow, {
							key: item.name,
							item,
							confirming: confirming === item.name,
							onEdit: () => edit(item),
							onDelete: () => remove(item),
							onApprove: () => void run(actions.approveCapability(item.name)),
						}),
					),
		),
	);
}

export interface BotCapabilitiesCardProps {
	bot: { id: string; capabilities?: string[] };
	roster: CapabilityRoster;
	actions: CapabilityActions;
	run(promise: Promise<unknown>): void;
	/** The settings card wrapper: renders its title and children. */
	Card: any;
	/** The on/off row: a label, an optional hint, and the switch. */
	SwitchRow: any;
}

export function BotCapabilitiesCard({ bot, roster, actions, run, Card, SwitchRow }: BotCapabilitiesCardProps): any {
	const items = [...(roster.capabilities ?? [])].sort(
		(a, b) => Number(b.kind === "pack") - Number(a.kind === "pack") || a.name.localeCompare(b.name),
	);
	const attached = new Set(bot.capabilities ?? []);
	const statuses = roster.capabilityStatuses?.[bot.id] ?? {};
	if (items.length === 0) return null;
	return h(
		Card,
		{ title: t("Capabilities") },
		items.map((item) =>
			h(SwitchRow, {
				key: item.name,
				label: item.name,
				hint: attached.has(item.name) ? statusText(statuses[item.name]) : undefined,
				on: attached.has(item.name),
				onChange: (enabled: boolean) => void run(actions.setBotCapability(bot.id, item.name, enabled)),
			}),
		),
	);
}
