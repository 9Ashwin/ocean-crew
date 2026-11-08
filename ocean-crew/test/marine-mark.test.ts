// The sea characters: every marine shape renders in every palette color, in both
// themes, through marine-assets; glyph markup, gradients, and the mark components.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { characterMarkup, defaultShape, hasShape, lookOf, maskOf, shapeOf } from "../src/client/look/characters.ts";
import { CREATURES, PALETTE, renderMarineMark, renderMarineSvg } from "../src/client/look/marine-assets.ts";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, "..", "dev", "harness");
const requireHarness = createRequire(join(harness, "package.json"));
const { build } = requireHarness("esbuild");

// The mark components, bundled once with React left external because the client only
// ever imports its platform React.
const { outputFiles } = await build({
	stdin: {
		contents:
			"export { BotMark, BotAvatar, RoomAvatar, botState, toolState } from './src/client/look/mark.ts';" +
			"export { lookOf } from './src/client/look/characters.ts';",
		resolveDir: PLUGIN,
	},
	bundle: true,
	format: "cjs",
	platform: "browser",
	write: false,
	logLevel: "silent",
	external: ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"],
});
const react = {
	createContext: (initial: unknown) => ({ value: initial }),
	useContext: (context: { value: unknown }) => context.value,
	useCallback: (fn: unknown) => fn,
	useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
	createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
		type,
		props: props ?? {},
		children: children.flat(Infinity),
	}),
	Fragment: "fragment",
	useEffect() {},
	useLayoutEffect() {},
	useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
	useMemo: (make: () => unknown) => make(),
	useRef: (current: unknown) => ({ current }),
	useId: () => "id",
};
const module = { exports: {} as any };
runInNewContext(outputFiles[0].text, {
	module,
	exports: module.exports,
	require: (name: string) => (name === "react" ? react : {}),
});
const mark = module.exports as any;

test("marine-assets ships 12 creatures and 13 palette colors", () => {
	assert.equal(CREATURES.length, 12);
	assert.equal(PALETTE.length, 13);
	assert.equal(new Set(CREATURES.map((creature) => creature.id)).size, 12);
	assert.equal(new Set(PALETTE.map((token) => token.id)).size, 13);
});

test("all 12 shapes render in all 13 colors, light and dark", () => {
	for (const creature of CREATURES) {
		for (const token of PALETTE) {
			const light = renderMarineMark(creature.id, { color: token.id, theme: "light" });
			assert.ok(light.includes('class="mb-body"'), `${creature.id}/${token.id}`);
			// Aurora paints from its gradient stops; every other palette color fills flat.
			assert.ok(
				light.includes(token.stops?.[1]?.[1] ?? token.light),
				`${creature.id}/${token.id} light ${token.light}`,
			);
			assert.ok(light.includes('class="mb-eyes"'), creature.id);
			const dark = renderMarineMark(creature.id, { color: token.id, theme: "dark" });
			assert.ok(dark.includes(token.stops?.[1]?.[1] ?? token.dark), `${creature.id}/${token.id} dark ${token.dark}`);
			assert.ok(dark.includes("mb-eye-open"), creature.id);
		}
	}
});

test("aurora paints from its gradient stops, and a hex color is accepted", () => {
	const aurora = renderMarineMark("marine-whale", { color: "aurora" });
	assert.ok(aurora.includes("<linearGradient"));
	for (const stop of ["#A4FFB0", "#00F0E4", "#2E9EF7"]) assert.ok(aurora.includes(stop), stop);
	const custom = renderMarineMark("marine-whale", { color: "#123456" });
	assert.ok(custom.includes('fill="#123456"'));
	assert.ok(!custom.includes("<linearGradient"));
});

test("a closed eye and a gaze offset change the eye markup", () => {
	const open = renderMarineMark("marine-crab", { blink: false, gaze: [0.4, -0.4] });
	assert.ok(open.includes("translate(0.4 -0.4)"));
	const blink = renderMarineMark("marine-crab", { blink: true });
	assert.ok(blink.includes("mb-eye-closed"));
	assert.ok(!blink.includes("mb-eye-open"));
});

test("an unknown shape or color is a clear error", () => {
	assert.throws(() => renderMarineMark("not-a-fish"), /Unknown marine shape/);
	assert.throws(() => renderMarineMark("marine-whale", { color: "chartreuse" }), /palette id or six-digit hex/);
});

test("renderMarineSvg is a standalone SVG at the requested size", () => {
	const svg = renderMarineSvg("marine-turtle");
	assert.ok(svg.includes('viewBox="0 0 100 100"'));
	assert.ok(svg.includes('width="128"'));
	assert.ok(svg.includes('role="img"'));
	const sized = renderMarineSvg("marine-shark", { size: 64 });
	assert.ok(sized.includes('width="64"'));
});

test("the mark layer hands every sea character and palette color through characterMarkup", () => {
	for (const creature of CREATURES) {
		assert.equal(hasShape(creature.id), true);
		assert.equal(shapeOf(creature.id).marine, true);
		for (const token of PALETTE) {
			const markup = characterMarkup(creature.id, token.id);
			assert.ok(markup.includes('class="mb-body"'), `${creature.id}/${token.id}`);
			assert.ok(markup.includes("%MASK%"), creature.id);
			assert.ok(markup.includes(token.stops?.[1]?.[1] ?? token.light), `${creature.id}/${token.id}`);
		}
		assert.ok(maskOf(creature.id).startsWith('url("data:image/svg+xml,'));
		assert.equal(lookOf({ id: "bot", avatar: { shape: creature.id } }).shape, creature.id);
	}
});

test("the mark components choose the earlier state names and draw the sea characters", () => {
	assert.equal(mark.botState(false, "waiting", false), "waiting");
	assert.equal(mark.botState(true, "waiting", false), "working");
	assert.equal(mark.botState(true, "searching", false), "searching");
	assert.equal(mark.botState(false, "waiting", true), "alert");
	assert.equal(mark.botState(false, undefined, false), "idle");
	assert.equal(mark.botState(true, undefined, false), "working");
	assert.equal(mark.botState(true, "nonsense", false), "working");
	assert.equal(mark.toolState("message_bot"), "sending");
	assert.equal(mark.toolState("post_to_group"), "sending");
	assert.equal(mark.toolState("web_search"), "searching");
	assert.equal(mark.toolState("read_file"), "searching");
	assert.equal(mark.toolState("run_command"), "working");
});

test("BotMark draws a marine character with its own mask id, and a broken photo falls back to it", () => {
	const bot = { id: "m1", name: "Chief", color: "aurora", avatar: { shape: "marine-crab" } };
	const span = mark.BotMark({ bot, size: 44, label: "Chief" });
	assert.equal(span.props["data-shape"], "marine-crab");
	assert.equal(span.props["aria-label"], "Chief");
	assert.equal(span.props.style.width, 44);
	const svg = span.children[0];
	assert.equal(svg.type, "svg");
	const html = svg.props.dangerouslySetInnerHTML.__html;
	assert.ok(html.includes("mb-body"));
	assert.ok(html.includes("linearGradient"));
	assert.ok(!html.includes("%MASK%"), "each mark substitutes its own element ids");
	assert.match(html, /bt-mark-\d+/);
	// A stored shape that is not a sea character draws the Bot's default instead.
	const old = mark.BotMark({ bot: { id: "b2", name: "Writer", avatar: { shape: "bunny" } } });
	assert.equal(old.props["data-shape"], defaultShape("b2"));
	assert.ok(String(old.children[0].props.dangerouslySetInnerHTML.__html).includes("mb-body"));
});

test("BotAvatar badges follow the state, and RoomAvatar seats a group", () => {
	const badges = (state: string): string[] =>
		mark
			.BotAvatar({ bot: { id: "b", name: "Writer" }, size: 36, state })
			.children.slice(1)
			.filter(Boolean)
			.map((child: any) => child.props.className);
	assert.deepEqual(badges("waiting"), []);
	assert.deepEqual(badges("working"), ["bt-badge bt-badge-working"]);
	assert.deepEqual(badges("alert"), ["bt-badge bt-badge-alert"]);
	const room = mark.RoomAvatar({
		room: { members: ["m1", "b2"] },
		roster: { byId: { m1: { id: "m1", name: "Chief" }, b2: { id: "b2", name: "Writer" } } },
		size: 36,
	});
	assert.equal(room.props.className, "bt-cluster");
	assert.equal(room.children.length, 2);
	for (const seat of room.children) assert.equal(seat.props.className, undefined, "a seat holds the Bot's mark");
});
