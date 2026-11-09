// Settings → Companion: turn a Bot into a character the user talks to, with its own card,
// voice, mood and closeness. The relationship numbers are read-only here except for reset.
import { createElement as h, useEffect, useState } from "react";
import { t } from "../core/i18n.ts";

const limit = (value: string, max: number): string => value.slice(0, max);

const moodLabel = (mood: string): string =>
	t(
		(
			{
				warm: "Warm",
				playful: "Playful",
				calm: "Calm",
				proud: "Proud",
				pout: "Pouting",
				excited: "Excited",
			} as Record<string, string>
		)[mood] ?? mood,
	);

const listText = (items: string[]): string => items.join("、");
const listOf = (value: string): string[] =>
	value
		.split(/[、,，\n]+/)
		.map((item) => item.trim())
		.filter((item) => item !== "");

const field = (label: string, hint: string, control: any, Row: any, key: string) =>
	h(Row, { key, label, hint }, control);

const input = (props: any) => h("input", { className: "bt-input", ...props });
const area = (props: any) => h("textarea", { className: "bt-input bt-input-area", ...props });

export function CompanionSettingsPage({ actions, Section, Row }: any) {
	const [view, setView] = useState<any>(null);
	const [failed, setFailed] = useState("");
	const [selected, setSelected] = useState("");
	const [draft, setDraft] = useState<any>({});
	const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
	const [note, setNote] = useState("");
	const load = () => {
		if (typeof actions.companionView !== "function") {
			setFailed(t("The companion settings need a newer Ocean Crew build; restart DSH."));
			return;
		}
		actions
			.companionView()
			.then((next: any) => {
				setView(next);
				setSelected((current: string) => current || (next?.bots?.[0]?.id ?? ""));
			})
			.catch((error: any) => setFailed(String(error?.message ?? error)));
	};
	useEffect(() => {
		void load();
	}, []);
	if (failed !== "") return h("div", { className: "bt-set-hint" }, failed);
	if (view === null) return h("div", { className: "bt-set-hint" }, t("Loading…"));
	const bot = (view.bots ?? []).find((entry: any) => entry.id === selected);
	const companion = bot?.companion ?? null;
	const character = companion?.character ?? {};
	const edit = (key: string, value: any) => setDraft((current: any) => ({ ...current, [key]: value }));
	const value = (key: string) =>
		Object.hasOwn(draft, key)
			? draft[key]
			: key === "likes"
				? listText(character.likes ?? [])
				: key === "dislikes"
					? listText(character.dislikes ?? [])
					: (character[key] ?? "");
	const save = async (patch: any) => {
		setNote("");
		try {
			const next = await actions.companionSet(selected, patch);
			setView(next);
			setDraft({});
		} catch (error: any) {
			setNote(String(error?.message ?? error));
		}
	};
	const saveCard = async (key: string) => {
		const raw = draft[key];
		if (raw === undefined) return;
		const field: Record<string, any> = { [key]: key === "likes" || key === "dislikes" ? listOf(String(raw)) : raw };
		await save(key === "voiceId" ? field : { character: field });
	};
	const card = (key: string, label: string, hint: string, control: any) =>
		field(label, hint, control, Row, `${selected}-${key}`);
	return [
		h(
			Section,
			{ key: "bot", title: t("Companion") },
			field(
				t("Bot"),
				t("Which Bot becomes a character in its own chat"),
				h(
					"select",
					{
						className: "bt-input",
						value: selected,
						onChange: (event: any) => {
							setSelected(event.target.value);
							setDraft({});
							setNote("");
						},
					},
					...(view.bots ?? []).map((entry: any) =>
						h(
							"option",
							{ key: entry.id, value: entry.id },
							entry.companion ? `${entry.name} · ${entry.companion.character.name}` : entry.name,
						),
					),
				),
				Row,
				"bot",
			),
			field(
				t("Companion mode"),
				t("The Bot speaks as this character, keeps a mood, and grows closer over time"),
				h("input", {
					type: "checkbox",
					checked: companion?.enabled === true,
					onChange: (event: any) => void save({ enabled: event.target.checked }),
				}),
				Row,
				"enabled",
			),
			note === "" ? null : h("div", { key: "note", className: "bt-set-hint" }, note),
		),
		companion === null
			? null
			: h(
					Section,
					{ key: "card", title: t("Character card") },
					card(
						"name",
						t("Name"),
						t("What the character calls itself"),
						input({
							value: value("name"),
							onChange: (event: any) => edit("name", limit(event.target.value, 20)),
							onBlur: () => void saveCard("name"),
						}),
					),
					card(
						"bio",
						t("Who they are"),
						t("One or two lines the model keeps in mind"),
						area({
							value: value("bio"),
							rows: 3,
							onChange: (event: any) => edit("bio", limit(event.target.value, 200)),
							onBlur: () => void saveCard("bio"),
						}),
					),
					card(
						"style",
						t("How they talk"),
						t("Sentence length, tone, pet phrases"),
						area({
							value: value("style"),
							rows: 2,
							onChange: (event: any) => edit("style", limit(event.target.value, 200)),
							onBlur: () => void saveCard("style"),
						}),
					),
					card(
						"likes",
						t("Likes"),
						t("Separate with 、 or ,"),
						input({
							value: value("likes"),
							onChange: (event: any) => edit("likes", event.target.value),
							onBlur: () => void saveCard("likes"),
						}),
					),
					card(
						"dislikes",
						t("Dislikes"),
						t("Separate with 、 or ,"),
						input({
							value: value("dislikes"),
							onChange: (event: any) => edit("dislikes", event.target.value),
							onBlur: () => void saveCard("dislikes"),
						}),
					),
					card(
						"greeting",
						t("Greeting"),
						t("Shown when the character opens a chat"),
						area({
							value: value("greeting"),
							rows: 2,
							onChange: (event: any) => edit("greeting", limit(event.target.value, 200)),
							onBlur: () => void saveCard("greeting"),
						}),
					),
					card(
						"voiceId",
						t("Voice"),
						t("Leave empty to use the voice from Settings → Voice"),
						h(
							"div",
							{ className: "bt-actions" },
							h(
								"select",
								{
									className: "bt-input",
									value: companion.voiceId ?? "",
									onChange: (event: any) => void save({ voiceId: event.target.value }),
								},
								h("option", { value: "" }, t("Settings → Voice")),
								...voices.map((voice) => h("option", { key: voice.id, value: voice.id }, voice.name)),
								companion.voiceId !== undefined && !voices.some((voice: any) => voice.id === companion.voiceId)
									? h("option", { value: companion.voiceId }, companion.voiceId)
									: null,
							),
							h(
								"button",
								{
									type: "button",
									className: "bt-soft bt-soft-sm",
									onClick: () =>
										actions
											.ttsVoices?.()
											.then((list: any) => setVoices(list ?? []))
											.catch((error: any) => setNote(String(error?.message ?? error))),
								},
								t("Load voices"),
							),
						),
					),
				),
		companion === null
			? null
			: h(
					Section,
					{ key: "relationship", title: t("Relationship") },
					h(
						"div",
						{ key: "state", className: "bt-set-row" },
						h(
							"div",
							{ className: "bt-set-copy" },
							h("span", null, `${moodLabel(companion.mood)} · ${companion.affection}/100`),
							h(
								"span",
								{ className: "bt-set-hint" },
								t("Closeness grows a little with every message, and a little more when the user is warm"),
							),
						),
					),
					h(
						"div",
						{ key: "bar", className: "bt-set-row" },
						h(
							"div",
							{ className: "bt-set-copy" },
							h("div", { className: "bt-comp-bar" }, h("span", { style: { width: `${companion.affection}%` } })),
						),
					),
					field(
						t("Reset"),
						t("Keeps the character card, starts the relationship over"),
						h(
							"button",
							{ type: "button", className: "bt-soft bt-soft-sm", onClick: () => void save({ reset: true }) },
							t("Start over"),
						),
						Row,
						"reset",
					),
				),
	];
}
