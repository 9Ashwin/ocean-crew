// A companion's mood as the window shows it: one emoji badge on the avatar and the label the
// header pill and the settings page use. English keys go through the interface dictionary.
export const MOOD_EMOJI: Record<string, string> = {
	warm: "💗",
	playful: "😜",
	calm: "🌊",
	proud: "😌",
	pout: "😤",
	excited: "✨",
};

/** The dictionary key for a mood; unknown ids fall back to the id itself. */
export const MOOD_LABEL: Record<string, string> = {
	warm: "Warm",
	playful: "Playful",
	calm: "Calm",
	proud: "Proud",
	pout: "Pouting",
	excited: "Excited",
};

export const moodEmoji = (mood?: string): string => (mood === undefined ? "" : (MOOD_EMOJI[mood] ?? ""));

export const moodLabelKey = (mood?: string): string => (mood === undefined ? "" : (MOOD_LABEL[mood] ?? mood));
