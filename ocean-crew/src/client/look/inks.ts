// Inks (light, dark) for characters, names, and mentions.

export const INKS: Readonly<Record<string, readonly [string, string]>> = {
	deepseek: ["#4D6BFE", "#6A84FF"],
	charcoal: ["#141416", "#F1F2F4"],
	graphite: ["#2D2D2D", "#D6D6DA"],
	rose: ["#EC2F6B", "#FF5A7A"],
	sky: ["#0AA8D6", "#2EE6E0"],
	tangerine: ["#FF6900", "#FF8A2E"],
	cobalt: ["#082DFF", "#5C78FF"],
	black: ["#000000", "#FFFFFF"],
	brown: ["#9A6B44", "#7C5332"],
	red: ["#FF3E51", "#E02135"],
	orange: ["#FF6B1A", "#FF5E00"],
	yellow: ["#FFB020", "#F59E0B"],
	green: ["#10B981", "#059669"],
	cyan: ["#06B6D4", "#0891B2"],
	blue: ["#2563EB", "#3B82F6"],
	violet: ["#8B5CF6", "#7C3AED"],
	magenta: ["#F43F85", "#E11D74"],
	gray: ["#8A8F98", "#6E737B"],
	aurora: ["#00B8D4", "#2EE6E0"],
};

// Gradient colors paint a character from its top left to its bottom right; their ink
// above is the text color. Aurora is the first star mascot's gradient.
export const GRADIENTS: Readonly<Record<string, readonly (readonly [number, string])[]>> = {
	aurora: [
		[0, "#A4FFB0"],
		[0.42, "#00F0E4"],
		[1, "#2E9EF7"],
	],
};

export const ACCENT_INKS: readonly string[] = [
	"deepseek",
	"charcoal",
	"graphite",
	"rose",
	"sky",
	"tangerine",
	"cobalt",
];

export const isHex = (color: unknown): boolean => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color);

export const luminance = (hex: string): number =>
	[1, 3, 5]
		.map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
		.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
		.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);

const inkName = (color: string): string => (INKS[color] ? color : "gray");

export const inkFill = (color: string): string => (isHex(color) ? color : `var(--bt-ink-${inkName(color)})`);

// Text in a Bot's color; pure black reads as a heading, so it falls back to gray.
export const inkText = (color: string): string => (color === "black" ? "var(--bt-ink-gray)" : inkFill(color));

// A color as a CSS background, for swatches and masked marks.
export const paintCss = (color: string): string => {
	const stops = GRADIENTS[color];
	if (stops !== undefined)
		return `linear-gradient(135deg,${stops.map(([offset, value]) => `${value} ${offset * 100}%`).join(",")})`;
	return inkFill(color);
};
