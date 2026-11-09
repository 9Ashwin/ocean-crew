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
	/** Push an answer a scheduled prompt asked for to the Bot's latest IM chat. */
	imNotify?: boolean;
	/** Text to speech: which provider, model, voice and secret the `speak` tool uses. */
	tts?: {
		enabled?: boolean;
		baseUrl?: string;
		secret?: string;
		model?: string;
		voice?: string;
		language?: string;
		format?: string;
		instructions?: string;
	};
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
	ocrModel?: string;
	textOnlyModels?: string[];
	handoffListTokens?: number;
	handoffRecentTokens?: number;
	timeRefreshIntervalMs?: number;
	timeZone?: string;
	diagnosticsFile?: boolean;
}
