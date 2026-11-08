// The character layer: the 12 sea characters render through marine-assets, a stored shape
// that is not one of them falls back to the Bot's default, and the look/default/color
// helpers keep their deterministic answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHARACTER_COLORS,
	CHARACTERS,
	characterMarkup,
	colorOf,
	DEFAULT_COLORS,
	DEFAULT_MASK,
	DEFAULT_SHAPES,
	defaultColor,
	defaultShape,
	FALLBACK_SHAPE,
	hasShape,
	isColor,
	lookOf,
	MAIN_LOOK,
	MASK_ID,
	maskOf,
	PICKER_SHAPES,
	shapeId,
	shapeOf,
} from "../src/client/look/characters.ts";
import { inkFill } from "../src/client/look/inks.ts";
import { CREATURES, PALETTE } from "../src/client/look/marine-assets.ts";
import {
	allThemes,
	layoutOf,
	registerShape,
	registerTheme,
	registry,
	shellTokens,
	themeCss,
	widthOf,
} from "../src/client/look/themes.ts";

test("the picker offers the 12 sea characters from marine-assets", () => {
	assert.equal(Object.keys(CHARACTERS).length, 12);
	assert.deepEqual(
		PICKER_SHAPES,
		CREATURES.map((creature) => creature.id),
	);
	assert.equal(PICKER_SHAPES.length, 12);
	for (const [id, entry] of Object.entries(CHARACTERS)) {
		assert.ok(id.startsWith("marine-"), id);
		assert.equal(typeof entry.label, "string");
		assert.equal(entry.marine, true);
	}
	assert.deepEqual(DEFAULT_SHAPES.slice(0, 3), ["marine-turtle", "marine-fish", "marine-ray"]);
	assert.ok(DEFAULT_SHAPES.every((id) => PICKER_SHAPES.includes(id)));
	assert.ok(PICKER_SHAPES.includes(FALLBACK_SHAPE));
	assert.equal(MAIN_LOOK.shape, "marine-whale");
	assert.equal(MAIN_LOOK.color, "deepseek");
});

test("a stored shape that is not a sea character falls back to the Bot's default", () => {
	for (const id of ["whale", "star", "bunny", "fox", "not-a-shape"]) {
		assert.equal(hasShape(id), false, id);
		assert.equal(shapeId(id), FALLBACK_SHAPE, id);
	}
	assert.equal(shapeOf("bunny").marine, true);
	assert.equal(lookOf({ id: "b1", avatar: { shape: "bunny" } }).shape, defaultShape("b1"));
	const markup = characterMarkup("bunny", "deepseek");
	assert.ok(markup.includes("mb-body"));
	assert.ok(markup.includes(MASK_ID));
});

test("sea characters render through marine markup, and the mention mask is an SVG url", () => {
	for (const id of PICKER_SHAPES) {
		assert.equal(shapeOf(id).marine, true);
		const markup = characterMarkup(id, "deepseek");
		assert.ok(markup.includes('class="mb-body"'), id);
		assert.ok(markup.includes(MASK_ID), id);
		assert.ok(maskOf(id).startsWith('url("data:image/svg+xml,'), id);
	}
	assert.ok(characterMarkup(FALLBACK_SHAPE, "aurora").includes("linearGradient"));
	assert.ok(DEFAULT_MASK.includes(encodeURIComponent('viewBox="0 0 100 100"')));
	assert.ok(maskOf("whale").startsWith('url("data:image/svg+xml,'));
});

test("colors: palette ids, hex, and the default tables", () => {
	assert.equal(isColor("deepseek"), true);
	assert.equal(isColor("#a0b1c2"), true);
	assert.equal(isColor("kimi"), false);
	assert.equal(isColor("nope"), false);
	assert.equal(CHARACTER_COLORS.length, PALETTE.length);
	assert.deepEqual(
		CHARACTER_COLORS,
		PALETTE.map((token) => token.id),
	);
	assert.deepEqual(
		DEFAULT_COLORS,
		CHARACTER_COLORS.filter((id) => !["black", "gray", "brown"].includes(id) && id !== "aurora"),
	);
	// A stored ink wins;
	assert.equal(colorOf({ id: "b1", color: "rose" }), "rose");
	assert.equal(colorOf({ id: "b1" }), defaultColor("b1"));
	assert.equal(colorOf(undefined), "black");
	// A color that is not a palette id paints gray, not another ink.
	assert.equal(inkFill("kimi"), "var(--bt-ink-gray)");
	assert.equal(inkFill("qwen"), "var(--bt-ink-gray)");
	assert.equal(inkFill("nope"), "var(--bt-ink-gray)");
});

test("defaults are deterministic per Bot id and stay in the picker", () => {
	for (const id of ["m1", "chief", "writer-2", "a", "a-long-bot-id-123"]) {
		assert.equal(defaultShape(id), defaultShape(id));
		assert.ok(DEFAULT_SHAPES.includes(defaultShape(id)), defaultShape(id));
		assert.equal(defaultColor(id), defaultColor(id));
		assert.ok(DEFAULT_COLORS.includes(defaultColor(id)), defaultColor(id));
	}
	assert.notEqual(`${defaultShape("m1")}${defaultColor("m1")}`, `${defaultShape("m2")}${defaultColor("m2")}`);
});

test("registerShape adds a drawable shape and can be rolled back", () => {
	assert.throws(() => registerShape("Bad Id", { body: () => "" }), /lowercase/);
	assert.throws(() => registerShape("test-shape", { body: () => "" }), /eyes\.at/);
	const remove = registerShape("test-shape", {
		label: "Test",
		body: (paint) => `<path d="M0 0h10v10z" fill="${paint}"/>`,
		eyes: {
			at: [
				[3, 4],
				[7, 4],
			],
			w: 1,
			h: 2,
			tilt: -10,
		},
	});
	assert.equal(hasShape("test-shape"), true);
	assert.equal(shapeOf("test-shape").label, "Test");
	assert.deepEqual(shapeOf("test-shape").eyes, [
		[3, 4, 1, 2, -10],
		[7, 4, 1, 2, -10],
	]);
	assert.ok(characterMarkup("test-shape", "deepseek").includes("M0 0h10v10z"));
	const before = registry.getSnapshot();
	remove();
	assert.equal(hasShape("test-shape"), false);
	assert.ok(registry.getSnapshot() > before);
});

test("themes: presets, CSS tokens, shell tokens, and registered themes", () => {
	const themes = allThemes();
	assert.deepEqual(Object.keys(themes).sort(), ["deepseek", "mono", "moonlight", "paper"]);
	const css = themeCss(themes.deepseek);
	assert.ok(css.startsWith("html body{"));
	assert.ok(css.includes("--bt-accent:#4d6bfe"));
	assert.ok(css.includes("--bt-ink:#141414"));
	assert.ok(css.includes("html body[data-ds-dark-theme]{"));
	// A preset accent takes the preset's dark value; a custom accent stays as it is.
	assert.ok(themeCss(themes.deepseek, "#4D6BFE").includes("--bt-accent:#6A84FF"));
	assert.ok(themeCss(themes.deepseek, "#123456").includes("--bt-accent:#123456"));
	assert.equal(Object.keys(shellTokens(themes.paper)).length, 6);
	assert.equal(layoutOf(undefined), "bubble");
	assert.equal(layoutOf({ layout: "flat" }), "flat");
	assert.equal(layoutOf({ layout: "bubble" }), "bubble");
	assert.equal(widthOf({ width: 60 }), 60);
	assert.equal(widthOf({ width: 20 }), 80);
	const remove = registerTheme("custom", {
		label: "Custom",
		light: themes.mono.light,
		dark: themes.mono.dark,
	});
	assert.equal(allThemes().custom.label, "Custom");
	assert.throws(
		() =>
			registerTheme("bad", {
				label: "Bad",
				light: { ...themes.mono.light, bg: "red" },
				dark: themes.mono.dark,
			}),
		/#rrggbb/,
	);
	remove();
	assert.equal(allThemes().custom, undefined);
});
