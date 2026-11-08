// `POST /api/bot`: a closed endpoint set behind one buffered JSON call. The client
// sends `{ endpoint, payload }` and always receives HTTP 200 with either a value or
// an error; `code` is machine-readable, `message` is user-facing text.

export const ERROR_CODES = [
	"bot/invalid",
	"bot/not-found",
	"bot/stale",
	"bot/read-only",
	"bot/forbidden",
	"bot/unavailable",
	"bot/busy",
	"bot/missing",
	"bot/browser-off",
	"bot/internal",
	"bot/refused",
	"bot/error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
	code: ErrorCode;
	message: string;
	details?: unknown;
}

export type ApiResponse<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface ApiRequest<Payload = unknown> {
	endpoint: string;
	payload: Payload;
}

// The read endpoints a read-only host still answers.
export const READ_ENDPOINTS = [
	"state",
	"chat",
	"run-stats",
	"room-progress",
	"exchange",
	"exchange-text",
	"file-text",
	"usage",
	"schedules",
	"memory-view",
	"browser-wait",
	"browser-result",
	"diagnostics-log",
	"approval-answer",
	"thinking",
] as const;
