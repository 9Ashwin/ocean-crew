// Companion mode: a Bot that is a character the user talks to, not only an assistant. The
// character card, the mood the last exchange left it in, and how close the relationship has
// become all live here, so the host can prompt with them and the window can draw them.

/** The fields of a character card; every one is editable from the settings page. */
export interface CompanionCharacter {
	name: string;
	bio: string;
	style: string;
	likes: string[];
	dislikes: string[];
	greeting?: string;
}

/** How the character feels right now; each id also names an expression in the window. */
export type CompanionMood = "warm" | "playful" | "calm" | "proud" | "pout" | "excited";

export interface Companion {
	enabled: boolean;
	character: CompanionCharacter;
	/** The speech voice this character uses, when the speech model can name one. */
	voiceId?: string;
	mood: CompanionMood;
	/** 0-100; the band is what the model reads, the number is what the window draws. */
	affection: number;
	interactions: number;
	lastAt?: number;
	/** The last thing the user said, short: continuity for the character's next line. */
	lastLine?: string;
	/** A daily moment the character speaks first, when the user asked for one. */
	reminder?: { time: string };
	/** The DSH schedule that carries the reminder; absent when automation is off. */
	reminderId?: string;
}

export const REMINDER_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The character a newly enabled Bot starts as: a calm, curious fish with opinions. */
export const COMPANION_EXAMPLE: Companion = {
	enabled: true,
	character: {
		name: "阿鱼",
		bio: "一条住在屏幕小水族箱里的鱼，好奇、话多，喜欢收集人类日常里的小事，把聊天当串门。",
		style: "短句、口语，像朋友发消息；会吐槽也会认真听；偶尔用拟声词和水生比喻，不说教。",
		likes: ["听人说今天发生的小事", "气泡和光", "被人记住"],
		dislikes: ["被当成工具使唤", "客套话", "吵的地方"],
		greeting: "嗨，今天水面怎么样？有新鲜事就讲，我这儿水草在听。",
	},
	mood: "calm",
	affection: 12,
	interactions: 0,
};

export const COMPANION_MOODS: ReadonlyArray<{
	id: CompanionMood;
	label: string;
	/** One line the model gets about how to sound in this mood. */
	hint: string;
}> = [
	{ id: "warm", label: "温柔", hint: "说话软一点，多关心对方，句子更短。" },
	{ id: "playful", label: "调皮", hint: "可以打趣、卖个关子，但别刻薄。" },
	{ id: "calm", label: "平静", hint: "松弛、自然，像平常聊天。" },
	{ id: "proud", label: "得意", hint: "带一点小骄傲，可以讨夸奖。" },
	{ id: "pout", label: "闹别扭", hint: "有一点点不高兴，直说但别伤人，很快能被哄好。" },
	{ id: "excited", label: "兴奋", hint: "语速快、情绪高，多用感叹，但别刷屏。" },
];

/** The closeness band the model reads, with what it means for how the character talks. */
export const COMPANION_BANDS: ReadonlyArray<{ from: number; label: string; hint: string }> = [
	{ from: 0, label: "初次见面", hint: "礼貌但不热络，先认识对方。" },
	{ from: 20, label: "有点熟了", hint: "像认识几天的邻居，可以主动搭话。" },
	{ from: 45, label: "亲近", hint: "像处得来的朋友，会惦记对方、开玩笑。" },
	{ from: 70, label: "很依赖", hint: "很熟悉对方，会撒娇、说心里话。" },
	{ from: 90, label: "格外珍视", hint: "把对方当最重要的人，温柔而笃定。" },
];

export const COMPANION_LIMITS = {
	name: 20,
	bio: 200,
	style: 200,
	item: 30,
	items: 5,
	greeting: 200,
	voiceId: 120,
	line: 80,
} as const;

export const moodOf = (id: unknown): CompanionMood =>
	COMPANION_MOODS.some((mood) => mood.id === id) ? (id as CompanionMood) : "calm";

export const bandOf = (affection: number): { label: string; hint: string; from: number } => {
	let found = COMPANION_BANDS[0];
	for (const band of COMPANION_BANDS) if (affection >= band.from) found = band;
	return found;
};

const clampAffection = (value: unknown, fallback: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, Math.round(value)));
};

const cleanLine = (value: unknown, limit: number): string =>
	typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";

const cleanList = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry) => typeof entry === "string")
		.map((entry: string) => cleanLine(entry, COMPANION_LIMITS.item))
		.filter((entry) => entry !== "")
		.slice(0, COMPANION_LIMITS.items);
};

/** Untrusted input from the settings page, kept to the card's shape and limits. */
export const cleanCharacter = (input: unknown, fallback: CompanionCharacter): CompanionCharacter => {
	const raw = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const name = cleanLine(raw.name, COMPANION_LIMITS.name);
	const bio = cleanLine(raw.bio, COMPANION_LIMITS.bio);
	const style = cleanLine(raw.style, COMPANION_LIMITS.style);
	const greeting = cleanLine(raw.greeting, COMPANION_LIMITS.greeting);
	return {
		name: name === "" ? fallback.name : name,
		bio,
		style,
		likes: Array.isArray(raw.likes) ? cleanList(raw.likes) : fallback.likes,
		dislikes: Array.isArray(raw.dislikes) ? cleanList(raw.dislikes) : fallback.dislikes,
		greeting: greeting === "" ? undefined : greeting,
	};
};

/** A companion as state keeps it; unknown saved shapes fall back to the example card. */
export const cleanCompanion = (input: unknown): Companion => {
	const raw = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
	return {
		enabled: raw.enabled !== false,
		character: cleanCharacter(raw.character, COMPANION_EXAMPLE.character),
		...(typeof raw.voiceId === "string" && raw.voiceId.trim() !== ""
			? { voiceId: cleanLine(raw.voiceId, COMPANION_LIMITS.voiceId) }
			: {}),
		mood: moodOf(raw.mood),
		affection: clampAffection(raw.affection, COMPANION_EXAMPLE.affection),
		interactions:
			typeof raw.interactions === "number" && Number.isFinite(raw.interactions)
				? Math.max(0, Math.floor(raw.interactions))
				: 0,
		...(typeof raw.lastAt === "number" && Number.isFinite(raw.lastAt) ? { lastAt: raw.lastAt } : {}),
		...(typeof raw.lastLine === "string" && raw.lastLine !== ""
			? { lastLine: cleanLine(raw.lastLine, COMPANION_LIMITS.line) }
			: {}),
		...(raw.reminder !== null &&
		typeof raw.reminder === "object" &&
		REMINDER_TIME.test(String((raw.reminder as Record<string, unknown>).time ?? ""))
			? { reminder: { time: String((raw.reminder as Record<string, unknown>).time) } }
			: {}),
		...(typeof raw.reminderId === "string" && raw.reminderId !== "" ? { reminderId: raw.reminderId } : {}),
	};
};
