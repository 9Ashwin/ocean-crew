// Plain helpers for the Create Bot form and the Runs on card, kept free of React so tests
// can load them.

/** A roster's Bot names and model catalog, as the form reads them. */
export interface DraftRoster {
	bots: Array<{ name: string }>;
	models?: Array<{ ref?: string; needsKey?: boolean; [key: string]: unknown }>;
	prefs?: { defaultBotModel?: string };
	defaultModel?: string;
}

/** One of the picker's characters: a shape and a color. */
export interface BotLook {
	shape: string;
	color: string;
}

export interface CreatePayloadInput {
	name: string;
	look: BotLook;
	image?: string | null;
	model?: string;
	effort?: string | null;
	brief?: string;
	// The form passes whether the user chose the look themselves; the payload does not
	// carry it, and the host has no field for it.
	ownLook?: boolean;
	[key: string]: unknown;
}

export function freshBotName(roster: DraftRoster, base = "New Bot"): string {
	const taken = new Set(roster.bots.map((bot) => bot.name.toLowerCase()));
	if (!taken.has(base.toLowerCase())) return base;
	let index = 2;
	while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1;
	return `${base} ${index}`;
}

// The form starts on the team default model from settings when it is served, then
// the DSH default, else the first one.
export function startModel(roster: DraftRoster): string {
	const usable = (roster.models ?? []).filter((model) => model.needsKey !== true);
	return (
		(
			usable.find((model) => model.ref === roster.prefs?.defaultBotModel) ??
			usable.find((model) => model.ref === roster.defaultModel) ??
			usable[0]
		)?.ref ?? ""
	);
}

// A chosen model is always sent: the host fixes it on the Bot at creation.
export function createPayload({
	name,
	look,
	image,
	model,
	effort,
	brief,
}: CreatePayloadInput): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		name,
		color: look.color,
		avatar: image ? { shape: look.shape, image } : { shape: look.shape },
	};
	if (model) payload.model = model;
	if (effort !== undefined) payload.effort = effort;
	if (brief) payload.brief = brief;
	return payload;
}
