// Browser storage keys. The panel, theme and tab data live in localStorage under these
// names; nothing older than the current plugin shape exists to migrate from.
export const STORAGE = {
	unread: "ocean-crew:unread",
	reactions: "ocean-crew:reactions",
	seen: "ocean-crew:seen",
	prefs: "ocean-crew:prefs",
	surface: "ocean-crew:surface",
	agentSessions: "ocean-crew:agent-sessions",
	sidebar: "ocean-crew:sidebar",
};

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}
