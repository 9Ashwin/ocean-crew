// What went wrong in this browser, for Settings → Feedback and the report it builds.
// Calls whose failures the interface swallows (polls, previews) still land here.
import { language, t } from "./i18n.ts";

const MAX = 30;
// The same failure again within this window bumps a count instead of a new line.
const REPEAT_MS = 5 * 60 * 1000;

/** One browser failure as the menu and the report show it. */
export interface ClientErrorEntry {
	time: number;
	level: string;
	text: string;
	code?: string;
	count?: number;
}

const entries: ClientErrorEntry[] = [];
// An API failure is noted where it happens; the menu or form that shows it must not add it again.
const noted = new WeakSet<object>();

export const markNoted = <T>(error: T): T => {
	if (error !== null && typeof error === "object") noted.add(error as object);
	return error;
};

export function noteClientError(where: string, error: unknown): void {
	if (error !== null && typeof error === "object") {
		if (noted.has(error as object)) return;
		noted.add(error as object);
	}
	const message = String((error as { message?: unknown } | null)?.message ?? error ?? "error").slice(0, 300);
	const code =
		typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : undefined;
	const text = `${where}: ${message}`;
	const now = Date.now();
	const last = entries.at(-1);
	if (last !== undefined && last.text === text && now - last.time < REPEAT_MS) {
		last.time = now;
		last.count = (last.count ?? 1) + 1;
		return;
	}
	entries.push({ time: now, level: "error", text, ...(code ? { code } : {}) });
	if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

// A catch handler that keeps the failure without bothering the user.
export const quietly =
	(where: string) =>
	(error: unknown): void =>
		noteClientError(where, error);

export const clearClientErrors = (): void => {
	entries.length = 0;
};

export const clientErrors = (): ClientErrorEntry[] =>
	entries.map((entry) =>
		(entry.count ?? 1) > 1 ? { ...entry, text: `${entry.text} (×${entry.count})` } : { ...entry },
	);

export function clientFacts(): { surface: string; language: string; userAgent: string } {
	return {
		surface: (window as unknown as { dshDesktop?: unknown }).dshDesktop ? "DSH Desktop" : "DSH Web",
		language: language(),
		userAgent: navigator.userAgent,
	};
}

// Short words for the provider-neutral failure codes of DSH's LLM layer.
const FAILURES: Record<string, string> = {
	MISSING_CREDENTIAL: "The model has no API key",
	INVALID_CREDENTIAL: "The API key is not in the right format",
	AUTH: "The API key was rejected",
	QUOTA: "The account is out of quota",
	ACCOUNT_QUOTA: "The account is out of quota",
	ACCOUNT_SIGN_IN_REQUIRED: "The DeepSeek account needs a sign-in",
	ACCOUNT_SIGNED_OUT: "The DeepSeek account is signed out",
	ACCOUNT_TOKEN_INVALID: "The DeepSeek account sign-in has expired",
	RATE_LIMIT: "Too many requests to the model",
	CONTEXT_WINDOW_EXCEEDED: "The conversation is too long for the model",
	INVALID_REQUEST: "The model service refused the request",
	SERVER: "The model service failed",
	TIMEOUT: "The model took too long to answer",
	TRANSPORT: "Could not reach the model service",
	SESSION: "Its group conversation could not open",
	SESSION_RESET: "Its group conversation could not open, so it starts a new one next time",
};

// The short words for a known code, or undefined.
export const knownFailure = (code: string | undefined): string | undefined =>
	Object.hasOwn(FAILURES, code ?? "") ? t(FAILURES[code as string]) : undefined;

export function failureLabel(code: string | undefined, message: string): string {
	return knownFailure(code) ?? (message || code || t("Unknown error"));
}

// GitHub refuses very long addresses; past this the diagnostics go by the clipboard.
const URL_LIMIT = 7000;
export const WHAT_MAX = 2000;
const PASTE_NOTE = "Ocean Crew copied the diagnostics to the clipboard. Paste them here.";
const REST_NOTE =
	"The recent errors do not fit in the link. Ocean Crew copied the diagnostics to the clipboard: paste them below this line.";

export function issueUrl(
	base: string,
	{ what = "", diagnostics }: { what?: string; diagnostics: string },
): { url: string; inline: boolean } {
	const text = what.trim().slice(0, WHAT_MAX);
	const title = text.split("\n")[0].slice(0, 80);
	const build = (body: string): string =>
		`${base}?${new URLSearchParams({ template: "bug.yml", ...(title ? { title } : {}), ...(text ? { what: text } : {}), diagnostics: body })}`;
	const full = build(diagnostics);
	if (full.length <= URL_LIMIT) return { url: full, inline: true };
	// The versions table leads the report and stays short; only the errors make it long,
	// and a report that lost the versions is hard to act on.
	const facts = build(`${diagnostics.split("\n\n")[0]}\n\n${REST_NOTE}`);
	return { url: facts.length <= URL_LIMIT ? facts : build(PASTE_NOTE), inline: false };
}
