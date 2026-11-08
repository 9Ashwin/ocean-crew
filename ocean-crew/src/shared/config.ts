// The plugin configuration, read from the profile patch's `bot` entry. Every key is
// optional; a module reads only the keys it uses.

export interface PluginConfig {
	home?: string;
	workspace?: string;
	mainName?: string;
	mainRole?: string;
	imReconcileMs?: number;
	imSendTimeoutMs?: number;
	imReactions?: boolean;
	im?: Record<string, unknown>;
	checkRatio?: number;
	memory?: boolean;
	memoryReview?: boolean;
	memoryReviewDelayMs?: number;
	learning?: boolean;
	learningTimes?: Record<string, number>;
	agentsMd?: boolean;
	updateCheck?: boolean;
	updateRegistry?: string;
	github?: boolean;
	browser?: boolean;
	browserPlugin?: "refs" | "script" | "task";
	browserPluginApi?: unknown;
	browserHeadless?: boolean;
	browserComplete?: unknown;
	ocrModel?: string;
	textOnlyModels?: string[];
	handoffListTokens?: number;
	handoffRecentTokens?: number;
	timeRefreshIntervalMs?: number;
	timeZone?: string;
	playwrightUrl?: string;
	browserExecutablePath?: string;
	diagnosticsFile?: boolean;
}
