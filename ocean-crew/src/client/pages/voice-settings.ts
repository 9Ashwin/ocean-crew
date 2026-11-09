// Settings → Voice: the spoken-answer model. It chooses what the `speak` tool talks with
// and whether answers are also spoken; the API key itself stays in Settings → Secrets.
import { createElement as h, useEffect, useState } from "react";
import { t } from "../core/i18n.ts";

const field = (label: string, hint: string, control: any, Row: any, key?: string) =>
	h(Row, { key, label, hint }, control);

const input = (props: any) => h("input", { className: "bt-input", ...props });

const FORMATS: ReadonlyArray<readonly [string, string]> = [
	["mp3", "MP3"],
	["opus", "Opus"],
	["wav", "WAV"],
	["aac", "AAC"],
];

export function VoiceSettingsPage({ actions, Section, Row }: any) {
	const [view, setView] = useState<any>(null);
	const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [draft, setDraft] = useState<any>({});
	const edit = (key: string, value: any) => setDraft((current: any) => ({ ...current, [key]: value }));
	const value = (key: string) => (Object.hasOwn(draft, key) ? draft[key] : (view?.[key] ?? ""));
	const [failed, setFailed] = useState("");
	const load = () => {
		if (typeof actions.ttsSettings !== "function") {
			setFailed(t("The voice settings need a newer Ocean Crew build; restart DSH."));
			return;
		}
		actions
			.ttsSettings()
			.then((next: any) => setView(next))
			.catch((error: any) => setFailed(String(error?.message ?? error)));
	};
	useEffect(() => {
		void load();
	}, []);
	const save = async (patch: any) => {
		setBusy(true);
		setNote("");
		try {
			const next = await actions.ttsSet?.(patch);
			setView(next);
			setDraft((current: any) => {
				const left = { ...current };
				for (const key of Object.keys(patch)) delete left[key];
				return left;
			});
		} catch (error: any) {
			setNote(String(error?.message ?? error));
		} finally {
			setBusy(false);
		}
	};
	const loadVoices = async () => {
		setBusy(true);
		setNote("");
		try {
			setVoices((await actions.ttsVoices?.()) ?? []);
		} catch (error: any) {
			setNote(String(error?.message ?? error));
		} finally {
			setBusy(false);
		}
	};
	const test = async () => {
		setBusy(true);
		setNote("");
		try {
			const result = await actions.ttsTest?.();
			setNote(t("Voice test OK") + ` · ${result?.name ?? ""} · ${result?.ms ?? 0}ms`);
		} catch (error: any) {
			setNote(String(error?.message ?? error));
		} finally {
			setBusy(false);
		}
	};
	if (failed !== "") return h("div", { className: "bt-set-hint" }, failed);
	if (view === null) return h("div", { className: "bt-set-hint" }, t("Loading…"));
	const toggle = (key: string) =>
		h("input", {
			type: "checkbox",
			checked: value(key) === true,
			onChange: (event: any) => void save({ [key]: event.target.checked }),
		});
	return [
		h(
			Section,
			{ key: "model", title: t("Voice") },
			field(
				t("Enable spoken answers"),
				view.hasSecret
					? t("The speak tool uses this voice")
					: t("Save the BREEZE_API_KEY secret in Settings → Secrets first"),
				toggle("enabled"),
				Row,
				"enabled",
			),
			field(
				t("Base URL"),
				"",
				input({
					value: value("baseUrl"),
					onChange: (event: any) => edit("baseUrl", event.target.value),
					onBlur: () => value("baseUrl") !== view.baseUrl && void save({ baseUrl: value("baseUrl") }),
				}),
				Row,
				"baseUrl",
			),
			field(
				t("Model"),
				t("For example breeze-tts-2"),
				input({
					value: value("model"),
					placeholder: "breeze-tts-2",
					onChange: (event: any) => edit("model", event.target.value),
					onBlur: () => value("model") !== view.model && void save({ model: value("model") }),
				}),
				Row,
				"model",
			),
			field(
				t("Voice"),
				view.voice === "" ? t("Empty picks the account's first voice") : "",
				h(
					"div",
					{ className: "bt-actions" },
					h(
						"select",
						{
							className: "bt-input",
							value: value("voice"),
							onChange: (event: any) => void save({ voice: event.target.value }),
						},
						h("option", { value: "" }, t("First saved voice")),
						...voices.map((voice) => h("option", { key: voice.id, value: voice.id }, voice.name)),
						view.voice !== "" && !voices.some((voice: any) => voice.id === view.voice)
							? h("option", { value: view.voice }, view.voice)
							: null,
					),
					h(
						"button",
						{ type: "button", className: "bt-soft bt-soft-sm", disabled: busy, onClick: () => void loadVoices() },
						t("Load voices"),
					),
				),
				Row,
				"voice",
			),
			field(
				t("Language"),
				t("ISO 639-1, for example zh or en"),
				input({
					value: value("language"),
					placeholder: "zh",
					onChange: (event: any) => edit("language", event.target.value),
					onBlur: () => value("language") !== view.language && void save({ language: value("language") }),
				}),
				Row,
				"language",
			),
			field(
				t("Audio format"),
				t("Feishu speaks opus; a plain file keeps this format"),
				h(
					"select",
					{
						className: "bt-input",
						value: value("format"),
						onChange: (event: any) => void save({ format: event.target.value }),
					},
					...FORMATS.map(([id, label]) => h("option", { key: id, value: id }, label)),
				),
				Row,
				"format",
			),
			field(
				t("Delivery notes"),
				t("How the voice should sound, in the text's language"),
				input({
					value: value("instructions"),
					placeholder: t("Softly and warmly"),
					onChange: (event: any) => edit("instructions", event.target.value),
					onBlur: () =>
						value("instructions") !== view.instructions && void save({ instructions: value("instructions") }),
				}),
				Row,
				"instructions",
			),
		),
		h(
			Section,
			{ key: "behaviour", title: t("Behaviour") },
			field(
				t("Speak answers instead of typing them"),
				t("A direct chat gets the answer as audio rather than text; a failed speech falls back to text"),
				toggle("autoReply"),
				Row,
				"autoReply",
			),
			field(
				t("WeChat voice bubble"),
				t("Experimental: some WeChat clients do not draw a bot's voice message; off sends an audio file"),
				toggle("voiceItem"),
				Row,
				"voiceItem",
			),
			h(
				"div",
				{ key: "test", className: "bt-actions" },
				h(
					"button",
					{ type: "button", className: "bt-soft bt-soft-sm", disabled: busy, onClick: () => void test() },
					t("Test voice"),
				),
				note === "" ? null : h("span", { className: "bt-set-hint" }, note),
			),
		),
	];
}
