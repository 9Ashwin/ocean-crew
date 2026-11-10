// A reaction the companion chose, as the platform names it. The window shows an emoji character; a
// chat platform takes its own key. Only keys that are known to exist on the platform are listed: an
// unknown key is refused by the service, and a refused reaction must never look like a feature that
// works. An emoji with no key is simply not marked in that chat — the window still shows it.

/** Feishu's `emoji_type` for each mark the companion uses. */
export const FEISHU_REACTIONS: Record<string, string> = {
	"❤️": "HEART",
	"🥰": "BLUSH",
	"😂": "LAUGH",
	"🌙": "MOON",
	"🫂": "HUG",
	"😋": "YUMMY",
	"🥺": "PLEAD",
	"🔥": "FIRE",
	"🤔": "THINKING",
	"😮": "WOW",
};

/** The platform key for one mark, or undefined when this platform has no key for it. */
export function reactionKey(emoji: string): string | undefined {
	const key = FEISHU_REACTIONS[String(emoji ?? "").trim()];
	return key === undefined || key === "" ? undefined : key;
}
