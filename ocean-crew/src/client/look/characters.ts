// Characters: Ocean Crew's avatars. A character is a small model seen from a
// three-quarter view and flattened into layers in a 100-unit box: the body, decals in
// fixed colors, a shade on the side away from the light, and a highlight facing it. The
// eyes [cx, cy, width, height, tilt] are cut out of every layer, so they show whatever
// sits behind the avatar.
//
// The team draws 12 sea characters (marine-assets.ts, `marine-*`): each renders through
// renderMarineMark and carries the same state motion every shape gets. A stored shape that
// is not one of them (a photo mark aside) falls back to the Bot's own default character.
import { GRADIENTS, INKS, inkFill, isHex } from "./inks.ts";
import { CREATURES, DEFAULT_LOOK, PALETTE, renderMarineMark } from "./marine-assets.ts";

/** One entry of the marine character table the picker offers. */
export interface CharacterSummary {
	label: string;
	marine: true;
}

// The characters the picker offers: the sea set from marine-assets.ts.
export const CHARACTERS: Readonly<Record<string, CharacterSummary>> = Object.fromEntries(
	CREATURES.map((creature) => [creature.id, { label: creature.label, marine: true as const }]),
);

// The picker shows every character at once, five to a row. A Bot with no choice gets one
// of the friendliest seven; the whale stays the Main Bot's.
export const PICKER_SHAPES: readonly string[] = CREATURES.map((creature) => creature.id);
export const PICKER_COLUMNS = 5;
export const DEFAULT_SHAPES: readonly string[] = [
	"marine-turtle",
	"marine-fish",
	"marine-ray",
	"marine-octopus",
	"marine-crab",
	"marine-seahorse",
	"marine-puffer",
];
export const FALLBACK_SHAPE = "marine-fish";
// The team's first Main Bot, and the plugin's own mark in the sidebar.
export const MAIN_LOOK = Object.freeze({ shape: DEFAULT_LOOK.shape, color: DEFAULT_LOOK.color });
// Character colors in picker order. Black, the gradients, and the dull gray and brown are
// never defaults; the user must pick them.
export const CHARACTER_COLORS: readonly string[] = PALETTE.map((token) => token.id);
export const DEFAULT_COLORS: readonly string[] = CHARACTER_COLORS.filter(
	(color) => !["black", "gray", "brown"].includes(color) && !GRADIENTS[color],
);
export const isColor = (color: unknown): color is string =>
	isHex(color) || (typeof color === "string" && Object.hasOwn(INKS, color));

/** One shape the marks can draw; a registered shape supplies `body` instead of `path`. */
export interface ShapeDef {
	id: string;
	label: string;
	size: number;
	marine?: boolean;
	body?: (paint: string) => string;
	eyes: number[][];
	wrap?: string;
}

/** A shape another plugin registers through themes.ts. */
export interface RegisteredShapeInput {
	label?: string;
	size?: number;
	body(paint: string): string;
	eyes?: { at?: Array<[number, number]>; w?: number; h?: number; tilt?: number };
	wrap?: string;
}

// Registered shapes join the characters: `body(paint)` returns SVG markup in a `size` box
// and `eyes` lists the two capsules.
export const SHAPES: Record<string, ShapeDef> = {};
for (const creature of CREATURES) {
	SHAPES[creature.id] = { id: creature.id, label: creature.label, size: 100, marine: true, eyes: [] };
}
export const hasShape = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(SHAPES, id);
export const shapeId = (id: unknown): string => (hasShape(id) ? id : FALLBACK_SHAPE);
export const shapeOf = (id: unknown): ShapeDef => SHAPES[shapeId(id)];

// A marine color is a palette id or a #rrggbb value; a saved ink that predates the sea
// characters (charcoal, rose, ...) paints as its light hex, so an old Bot keeps its color.
const paletteIds = new Set(PALETTE.map((token) => token.id));
const marineColor = (color: string): string => {
	if (paletteIds.has(color) || isHex(color)) return color;
	const ink = INKS[color];
	return ink === undefined ? "deepseek" : ink[0];
};
// The placeholder each cached marine markup carries for the mark's own element ids; a
// duplicate id resolves to its first copy, so every mounted mark substitutes its own.
const MARINE_PREFIX = "btmarinex";
const marineMarkup = (shape: string, color: string): string =>
	renderMarineMark(shape, { color: marineColor(color), prefix: MARINE_PREFIX }).replaceAll(MARINE_PREFIX, MASK_ID);

// The shape's body, painted; masks pass black and rings take the current color.
export function bodyOf(def: ShapeDef, paint: string): string {
	if (def.marine) return `<g class="bt-b">${marineMarkup(def.id, paint)}</g>`;
	try {
		return def.body?.(paint) ?? "";
	} catch {
		return "";
	}
}

// The default look comes from the Bot id (FNV-1a, then mulberry32 for the color and
// murmur3's fmix32 for the shape), so it is the same on every device.
export function fnv1a(text: string): number {
	let value = 2166136261;
	for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
	return value >>> 0;
}
export function defaultColor(id: string): string {
	const t = (fnv1a(id) + 1831565813) | 0;
	let n = Math.imul(t ^ (t >>> 15), 1 | t);
	n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
	return DEFAULT_COLORS[Math.floor((((n ^ (n >>> 14)) >>> 0) / 4294967296) * DEFAULT_COLORS.length)];
}
export function defaultShape(id: string): string {
	let value = fnv1a(id) | 0;
	value = Math.imul(value ^ (value >>> 16), 73244475);
	value = Math.imul(value ^ (value >>> 13), 3266489909);
	return DEFAULT_SHAPES[((value ^ (value >>> 16)) >>> 0) % DEFAULT_SHAPES.length];
}

// A stored shape or color wins; then the id. With no Bot it is a black fallback character.
export const colorOf = (bot?: { color?: unknown; id?: unknown } | null): string =>
	isColor(bot?.color) ? (bot.color as string) : bot?.id ? defaultColor(String(bot.id)) : "black";
export function lookOf(
	bot?: {
		avatar?: { shape?: unknown; image?: string } | null;
		id?: unknown;
		color?: unknown;
	} | null,
): { shape: string; image?: string; color: string } {
	const avatar = bot?.avatar ?? {};
	return {
		shape: hasShape(avatar.shape) ? shapeId(avatar.shape) : bot?.id ? defaultShape(String(bot.id)) : FALLBACK_SHAPE,
		image: avatar.image,
		color: colorOf(bot),
	};
}

const eyeMarkup = ([cx, cy, w, h, tilt]: number[]): string =>
	`<g transform="translate(${cx} ${cy}) rotate(${tilt})"><rect class="bt-eye" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}"/></g>`;
// A closed, happy eye (an upturned arc) in the same spot, shown while the mark is petted.
const happyEyeMarkup = ([cx, cy, w, h, tilt]: number[]): string =>
	`<g transform="translate(${cx} ${cy}) rotate(${tilt})"><path class="bt-eye-happy" opacity="0" d="M${-w * 0.62} ${h * 0.14}Q0 ${-h * 0.42} ${w * 0.62} ${h * 0.14}" fill="none" stroke="#000" stroke-width="${w * 0.5}" stroke-linecap="round"/></g>`;
// A mask covering three boxes, so a bob or squash never clips the body at the edge.
export const maskBox = (size: number): string =>
	`maskUnits="userSpaceOnUse" x="${-size}" y="${-size}" width="${size * 3}" height="${size * 3}"`;
export const holes = (def: ShapeDef, eyes: string): string =>
	`<rect x="${-def.size}" y="${-def.size}" width="${def.size * 3}" height="${def.size * 3}" fill="#fff"/>${eyes}`;

// MASK_ID stands for each mark's own mask id: a duplicate id resolves to its first copy,
// which stops painting once that copy unmounts or sits in a hidden subtree.
export const MASK_ID = "%MASK%";
let markSerial = 0;
export const nextMarkSerial = (): number => {
	markSerial += 1;
	return markSerial;
};
export const markupCache = new Map<string, string>();
export function characterMarkup(shape: string, color: string): string {
	const key = `${shape}|${color}`;
	let markup = markupCache.get(key);
	if (markup === undefined) {
		const def = shapeOf(shape);
		if (def.marine) {
			markup = marineMarkup(def.id, color);
		} else {
			// A shapes plugin registers a body: the eyes sit in the mask, untransformed by
			// their placement, so CSS blinks and glances never replace where they sit.
			const eyes = `<g class="bt-gaze"><g class="bt-eyes" fill="#000">${def.eyes.map(eyeMarkup).join("")}${def.eyes.map(happyEyeMarkup).join("")}</g></g>`;
			const stops = GRADIENTS[color];
			const gradient = stops
				? `<linearGradient id="${MASK_ID}g" gradientUnits="userSpaceOnUse" x1="18" y1="10" x2="78" y2="92">${stops.map(([offset, value]) => `<stop offset="${offset}" stop-color="${value}"/>`).join("")}</linearGradient>`
				: "";
			const body = `<g mask="url(#${MASK_ID})">${bodyOf(def, stops ? `url(#${MASK_ID}g)` : inkFill(color))}</g>`;
			markup = `<defs>${gradient}<mask id="${MASK_ID}" ${maskBox(def.size)}>${holes(def, eyes)}</mask></defs><g class="bt-b">${def.wrap ? `<g transform="${def.wrap}">${body}</g>` : body}</g>`;
		}
		markupCache.set(key, markup);
	}
	return markup;
}
const svgUrl = (inner: string, size: number): string =>
	`url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${inner}</svg>`)}")`;
export const maskCache = new Map<string, string>();
export function maskOf(shape: string): string {
	let mask = maskCache.get(shape);
	if (mask === undefined) {
		const def = shapeOf(shape);
		if (def.marine) {
			mask = svgUrl(renderMarineMark(def.id, { color: "black", prefix: "btmask" }), def.size);
		} else {
			const body = `<g mask="url(#e)">${bodyOf(def, "#000")}</g>`;
			mask = svgUrl(
				`<mask id="e" ${maskBox(def.size)}>${holes(def, def.eyes.map(eyeMarkup).join("").replaceAll('class="bt-eye"', 'fill="#000"'))}</mask>${def.wrap ? `<g transform="${def.wrap}">${body}</g>` : body}`,
				def.size,
			);
		}
		maskCache.set(shape, mask);
	}
	return mask;
}
export const DEFAULT_MASK = maskOf(FALLBACK_SHAPE);
