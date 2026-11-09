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
	const config = (): TtsConfig => ((rt.config as Record<string, any>)?.tts ?? {}) as TtsConfig;
	const enabled = (): boolean => config().enabled !== false && rt.secretValue?.(secretName()) !== undefined;
	const secretName = (): string => String(config().secret ?? DEFAULT_SECRET);
	const base = (): string => String(config().baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
	// The provider names the output container; a caller may override it (Feishu draws a
	// voice bubble only from opus, while a plain audio file plays as-is on any platform).
	const format = (override?: string): string =>
		String(override ?? config().format ?? "mp3").replace(/[^a-z0-9_]/gi, "");

	let voices: { at: number; first: string | undefined } | undefined;

	// Without a configured voice, the account's first saved voice is used; the lookup is
	// cached, and a failure says what to configure instead of guessing an id.
	const voice = async (key: string): Promise<string> => {
		const wanted = config().voice;
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
			if (typeof config().model === "string" && config().model !== "") body.model_id = config().model;
			if (typeof config().language === "string" && config().language !== "") body.language_code = config().language;
			if (typeof config().instructions === "string" && config().instructions !== "")
				body.instructions = config().instructions;
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

	Object.assign(rt, { speak, speakEnabled: enabled });
}
