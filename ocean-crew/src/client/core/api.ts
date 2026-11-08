// The browser half's only way to the host: one POST to /api/bot, with the error codes and
// messages the interface acts on. A failure the user must see is noted for the report.
import { markNoted, noteClientError } from "./diagnostics.ts";
import { hostText, t } from "./i18n.ts";

const ROUTE = "api/bot";
// Refusals carry a message meant for the user, who sees it where they acted.
const REFUSALS = new Set(["bot/refused", "bot/invalid", "bot/read-only", "bot/not-found", "bot/browser-off"]);

/** An error from the host or the network, with the machine code the interface reads. */
export interface ApiError extends Error {
	code?: string;
	cause?: unknown;
}

interface ApiReply {
	ok?: boolean;
	value?: unknown;
	error?: { code?: string; message?: string };
}

export const call = async (endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<any> => {
	let response: Response;
	try {
		// Document-relative so the Web UI keeps working under a mounted base path.
		response = await fetch(ROUTE, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ endpoint, payload: payload ?? null }),
			signal,
		});
	} catch (error) {
		if ((error as { name?: string } | null)?.name === "AbortError") throw error;
		noteClientError(
			endpoint,
			Object.assign(new Error(`network error: ${(error as Error)?.message ?? error}`), { code: "NETWORK" }),
		);
		// The browser's own text ("Failed to fetch", "Load failed") does not say what failed.
		throw markNoted(
			Object.assign(new Error(t("Could not reach DSH. Check that it is still running.")), {
				code: "NETWORK",
				cause: error,
			}) as ApiError,
		);
	}
	if (!response.ok) {
		const error: ApiError = Object.assign(new Error(hostText(`HTTP ${response.status}`)), {
			code: `HTTP_${response.status}`,
		});
		noteClientError(endpoint, error);
		throw error;
	}
	const result: ApiReply = await response.json();
	if (!result.ok) {
		const code = result.error?.code ?? "bot/error";
		const message = hostText(result.error?.message ?? "Request failed");
		const error: ApiError = Object.assign(
			new Error(code === "bot/internal" ? `${message} ${t("Settings → Feedback has the details.")}` : message),
			{ code },
		);
		if (!REFUSALS.has(code)) {
			noteClientError(endpoint, Object.assign(new Error(result.error?.message ?? "Request failed"), { code }));
			markNoted(error);
		}
		throw error;
	}
	return result.value;
};
