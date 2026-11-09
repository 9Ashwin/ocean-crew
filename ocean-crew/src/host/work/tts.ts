// Text to speech: a Bot can speak a short line into its IM chat. The provider is Breeze
// Blue's HTTP API; the API key lives in the plugin's secret store, never in config, state
// or a tool result. No SDK is pulled in: the endpoint is one JSON POST returning audio.

import type { Runtime } from "../core/runtime.ts";

const DEFAULT_BASE = "https://api.breeze.blue";
const DEFAULT_SECRET = "BREEZE_API_KEY";
// The provider's default per-request character limit; longer text is split, not rejected.
const MAX_CHARS = 1000;
const VOICES_TTL_MS = 10 * 60_000;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const SPEAK_TIMEOUT_MS = 60_000;

interface TtsConfig {
	enabled?: boolean;
	autoReply?: boolean;
	voiceItem?: boolean;
	baseUrl?: string;
	secret?: string;
	model?: string;
	voice?: string;
	language?: string;
	format?: string;
	instructions?: string;
}

const refusals = {
	invalid: (message: string) => Object.assign(new Error(message), { code: "bot/invalid" }),
	unavailable: (message: string) => Object.assign(new Error(message), { code: "bot/unavailable" }),
	refused: (message: string) => Object.assign(new Error(message), { code: "bot/refused" }),
};

// Speak in the provider's own sentence-sized requests and glue the audio together: one
// long request over the limit is refused outright, and truncating speech loses words.
const splitSpeech = (text: string): string[] => {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > MAX_CHARS) {
		const window = rest.slice(0, MAX_CHARS);
		const at = Math.max(
			window.lastIndexOf(". "),
			window.lastIndexOf("! "),
			window.lastIndexOf("? "),
			window.lastIndexOf("\n"),
		);
		const cut = at > MAX_CHARS / 2 ? at + 1 : MAX_CHARS;
		chunks.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest !== "") chunks.push(rest);
	return chunks;
};

export function install(rt: Runtime): void {
	// Settings saved from the app win over the profile's defaults: the page is where a
	// user picks a voice without editing the profile patch.
	const settings = (): TtsConfig => ({
		...(((rt.config as Record<string, any>)?.tts ?? {}) as TtsConfig),
		...(((rt.state as Record<string, any>)?.tts ?? {}) as TtsConfig),
	});
	const secretName = (): string => String(settings().secret ?? DEFAULT_SECRET);
	const enabled = (): boolean => settings().enabled !== false && rt.secretValue?.(secretName()) !== undefined;
	const base = (): string => String(settings().baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
	// The provider names the output container; a caller may override it (Feishu draws a
	// voice bubble only from opus, while a plain audio file plays as-is on any platform).
	const format = (override?: string): string =>
		String(override ?? settings().format ?? "mp3").replace(/[^a-z0-9_]/gi, "");

	let voices: { at: number; first: string | undefined } | undefined;

	// Without a configured voice, the account's first saved voice is used; the lookup is
	// cached, and a failure says what to configure instead of guessing an id.
	const voice = async (key: string): Promise<string> => {
		const wanted = settings().voice;
		if (typeof wanted === "string" && wanted !== "") return wanted;
		if (voices === undefined || Date.now() - voices.at > VOICES_TTL_MS) {
			let first: string | undefined;
			try {
				const response = await fetch(`${base()}/v1/voices`, {
					headers: { "xi-api-key": key },
					signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
				});
				if (response.ok) {
					const body: any = await response.json().catch(() => undefined);
					const list = Array.isArray(body?.voices) ? body.voices : Array.isArray(body) ? body : [];
					first = typeof list[0]?.voice_id === "string" ? list[0].voice_id : undefined;
				}
			} catch {
				first = undefined;
			}
			voices = { at: Date.now(), first };
		}
		if (voices.first === undefined)
			throw refusals.unavailable("No TTS voice is configured: set `tts.voice` to one of your saved voices");
		return voices.first;
	};

	const speak = async (text: string, formatOverride?: string): Promise<{ bytes: Buffer; name: string }> => {
		const raw = String(text ?? "").trim();
		if (raw === "") throw refusals.invalid("Nothing to speak");
		const key = rt.secretValue?.(secretName());
		if (key === undefined || key === "")
			throw refusals.unavailable(`The ${secretName()} secret is not set; save the speech API key first`);
		const chosen = await voice(key);
		const chunks = splitSpeech(raw);
		const parts: Buffer[] = [];
		for (const chunk of chunks) {
			const url = `${base()}/v1/text-to-speech/${encodeURIComponent(chosen)}?output_format=${encodeURIComponent(format(formatOverride))}`;
			const body: Record<string, unknown> = { text: chunk };
			if (typeof settings().model === "string" && settings().model !== "") body.model_id = settings().model;
			if (typeof settings().language === "string" && settings().language !== "")
				body.language_code = settings().language;
			if (typeof settings().instructions === "string" && settings().instructions !== "")
				body.instructions = settings().instructions;
			let response: any;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: { "xi-api-key": key, "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
				});
			} catch (error: any) {
				throw refusals.refused(`The speech service did not answer: ${String(error?.message ?? error)}`);
			}
			if (!response.ok) {
				const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
				throw refusals.refused(
					`The speech service refused (${response.status})${detail === "" ? "" : `: ${detail}`}`,
				);
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.byteLength === 0) throw refusals.refused("The speech service returned no audio");
			parts.push(bytes);
		}
		const audio = Buffer.concat(parts);
		if (audio.byteLength > MAX_VOICE_BYTES)
			throw refusals.invalid("The spoken answer is too long to send as one voice message");
		return { bytes: audio, name: `voice.${format(formatOverride)}` };
	};

	const view = () => {
		const current = settings();
		return {
			enabled: current.enabled !== false,
			hasSecret: rt.secretValue?.(secretName()) !== undefined,
			secret: secretName(),
			baseUrl: current.baseUrl ?? DEFAULT_BASE,
			model: current.model ?? "",
			voice: current.voice ?? "",
			language: current.language ?? "",
			format: current.format ?? "mp3",
			instructions: current.instructions ?? "",
			voiceItem: current.voiceItem === true,
			autoReply: current.autoReply === true,
		};
	};
	// Saved settings are a small closed set of scalars; anything else is ignored, and a
	// speech change drops the cached voice lookup.
	const set = async (patch: Record<string, unknown>): Promise<ReturnType<typeof view>> => {
		await rt.load();
		const state = rt.state as Record<string, any>;
		const next: TtsConfig = { ...(state.tts ?? {}) };
		const words = ["baseUrl", "model", "voice", "language", "format", "instructions", "secret"] as const;
		for (const key of words) if (typeof patch[key] === "string") next[key] = patch[key].trim();
		if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
		if (typeof patch.voiceItem === "boolean") next.voiceItem = patch.voiceItem;
		if (typeof patch.autoReply === "boolean") next.autoReply = patch.autoReply;
		state.tts = next;
		voices = undefined;
		await rt.save();
		return view();
	};
	const listVoices = async (): Promise<Array<{ id: string; name: string }>> => {
		const key = rt.secretValue?.(secretName());
		if (key === undefined || key === "")
			throw refusals.unavailable(`The ${secretName()} secret is not set; save the speech API key first`);
		let response: any;
		try {
			response = await fetch(`${base()}/v1/voices`, {
				headers: { "xi-api-key": key },
				signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
			});
		} catch (error: any) {
			throw refusals.refused(`The speech service did not answer: ${String(error?.message ?? error)}`);
		}
		if (!response.ok) throw refusals.refused(`The speech service refused (${response.status})`);
		const body: any = await response.json().catch(() => undefined);
		const list = Array.isArray(body?.voices) ? body.voices : Array.isArray(body) ? body : [];
		return list
			.filter((entry: any) => typeof entry?.voice_id === "string")
			.map((entry: any) => ({ id: String(entry.voice_id), name: String(entry.name ?? entry.voice_id) }));
	};
	const test = async (): Promise<{ ms: number; name: string }> => {
		const started = Date.now();
		const audio = await speak("你好，这是一条语音测试。");
		return { ms: Date.now() - started, name: audio.name };
	};

	Object.assign(rt, {
		speak,
		speakEnabled: enabled,
		ttsSettingsView: view,
		ttsSettingsSet: set,
		ttsVoices: listVoices,
		ttsTest: test,
	});
}
