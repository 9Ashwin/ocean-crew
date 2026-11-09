// Motion in the default "normal" level: companion expressions — the mood glow, the eye
// shapes, the speaking motion and the excited hop — must be visible without switching to
// "lively", and quiet must hold them still. These are source assertions: the stylesheet is
// one string shipped to the window, and the motion levels are CSS selectors on
// body[data-bt-motion], so the structure of those rules is the behavior under test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...path: string[]): string => readFileSync(join(PLUGIN, "src", "client", ...path), "utf8");
const styles = read("look", "styles.ts");
const mark = read("look", "mark.ts");
const index = read("index.ts");

const lines = (text: string): string[] => text.split("\n");

/** The first rule line naming `selector`; the file writes one rule per line. */
function firstRule(css: string, selector: string): { line: string; at: number } {
	const rows = lines(css);
	for (let at = 0; at < rows.length; at += 1) if (rows[at].includes(selector)) return { line: rows[at], at };
	assert.fail(`no rule with ${selector}`);
}

/** Every rule line that starts with `prefix` and names `selector`. */
function rulesFrom(css: string, prefix: string, selector: string): string[] {
	return lines(css).filter((line) => line.startsWith(prefix) && line.includes(selector));
}

const duration = (text: string, rule: string): number => {
	const at = text.indexOf(rule);
	assert.ok(at >= 0, `missing ${rule}`);
	const match = /animation-duration:\s*([\d.]+)s/.exec(text.slice(at, text.indexOf("}", at)));
	assert.ok(match !== null, `missing duration in ${rule}`);
	return Number(match[1]);
};

// ---------------------------------------------------------------------------
// The default shapes move: marine layers live inside the animated body group.

test("marine characters are wrapped in the body group the motion rules animate", () => {
	// Marine characters render mb-* layers (mb-body, mb-markings, mb-eyes) and had no .bt-b
	// group, so every motion rule targeting .bt-b skipped the default shapes.
	assert.match(mark, /shapeOf\(look\.shape\)\.marine \? `<g class="bt-b">\$\{markup\}<\/g>` : markup/);
	assert.match(mark, /const markup = characterMarkup\(look\.shape, look\.color\)/);
	// The state motions that were invisible now land on that group.
	for (const state of ["thinking", "searching", "working", "sending"]) {
		const rule = firstRule(styles, `.bt-mark[data-state=${state}] .bt-b{`);
		assert.match(rule.line, /animation:bt-/);
	}
});

// ---------------------------------------------------------------------------
// Companion expression at the default (normal) level.

test("the mood glow breathes at the default level, not only at lively", () => {
	const glow = firstRule(styles, ".bt-mark[data-mood]::after{");
	assert.ok(!glow.line.includes("data-bt-motion"), "the glow must not be gated on a motion level");
	assert.match(glow.line, /animation:bt-companion-glow 4\.6s/);
	assert.match(
		styles,
		/@keyframes bt-companion-glow\{0%,100%\{opacity:\.42;scale:\.97\}[^\n]*opacity:\.7;scale:1\.04\}/,
	);
});

test("an excited companion hops visibly at the default level", () => {
	const hop = firstRule(styles, ".bt-mark[data-mood=excited] :is(.bt-b,.bt-mark-img){");
	assert.ok(!hop.line.includes("data-bt-motion"), "the hop must not be gated on a motion level");
	assert.match(hop.line, /animation:bt-companion-hop 2\.8s/);
	// The hop has to be seen at a 36px mark: it lifts the whole character nearly a tenth.
	assert.match(styles, /@keyframes bt-companion-hop\{[^\n]*translate:0 -9%/);
	// A photo companion hops too; it has no body group, only the image.
	assert.ok(hop.line.includes(".bt-mark-img"));
});

test("a speaking companion talks at the default level, with or without a mood", () => {
	// The gate is `body:not([data-bt-motion=quiet])`: quiet is the only level without the
	// motion, so normal and lively both play it.
	const talk = firstRule(styles, "body:not([data-bt-motion=quiet]) .bt-mark.bt-speaking :is(.bt-b,.bt-mark-img){");
	assert.match(talk.line, /^body:not\(\[data-bt-motion=quiet\]\) /);
	// The voice is the signal: every mark playing a companion voice talks, not only one
	// that also wears a mood color.
	assert.ok(!talk.line.includes("[data-mood]"), "the talk motion must not require a mood");
	assert.match(talk.line, /animation:bt-companion-talk 0?\.34s/);
	// A stronger motion than the old 1.5% wiggle, plus a short delay before it plays.
	assert.match(styles, /@keyframes bt-companion-talk\{[^\n]*translate:0 3%;scale:1\.03 \.97\}/);
	// Talking wins over the state's own motion: the rule sits after the state rules.
	const work = firstRule(styles, ".bt-mark[data-state=working] .bt-b{");
	const at = styles.indexOf(".bt-mark.bt-speaking :is(.bt-b,.bt-mark-img){animation:bt-companion-talk");
	assert.ok(at > work.at, "the speaking rule must override the state motion");
});

test("the eye shapes reach both character layers", () => {
	// Marine characters keep their eyes in per-eye groups; without their own transform box
	// a mood scale would pull them toward the top-left of the viewBox.
	const boxes = firstRule(styles, ".bt-mark .bt-b,.bt-mark .bt-eye,");
	assert.ok(boxes.line.includes(".bt-mark .mb-eye"));
	assert.ok(boxes.line.includes(".bt-mark .mb-eyes"));
	assert.match(
		styles,
		/\.bt-mark \.bt-eye,\.bt-mark \.bt-eyes,\.bt-mark \.mb-eye,\.bt-mark \.mb-eyes\{transform-origin:center\}/,
	);
	// Every mood squint names the marine eye group and the geometric one.
	for (const line of lines(styles).filter(
		(row) => row.startsWith(".bt-mark[data-mood=") && row.includes(":is(.mb-eye,.bt-eyes)"),
	))
		assert.match(line, /^\.bt-mark\[data-mood=\w+\] :is\(\.mb-eye,\.bt-eyes\)\{/);
	assert.ok(
		lines(styles).filter((row) => row.startsWith(".bt-mark[data-mood=") && row.includes(":is(.mb-eye,.bt-eyes)"))
			.length >= 5,
	);
});

// ---------------------------------------------------------------------------
// Levels: lively quickens the same motions, quiet holds them still.

test("lively plays the same companion motions quicker", () => {
	const glow = firstRule(styles, ".bt-mark[data-mood]::after{");
	const glowBase = /animation:bt-companion-glow ([\d.]+)s/.exec(glow.line);
	assert.ok(glowBase !== null);
	const livelyGlow = duration(styles, "body[data-bt-motion=lively] .bt-mark[data-mood]::after{");
	assert.ok(livelyGlow < Number(glowBase[1]), "lively glow is quicker than normal");
	const livelyHop = duration(
		styles,
		"body[data-bt-motion=lively] .bt-mark[data-mood=excited] :is(.bt-b,.bt-mark-img){",
	);
	const hop = firstRule(styles, ".bt-mark[data-mood=excited] :is(.bt-b,.bt-mark-img){");
	const hopBase = /animation:bt-companion-hop ([\d.]+)s/.exec(hop.line);
	assert.ok(hopBase !== null);
	assert.ok(livelyHop < Number(hopBase[1]));
	const livelyTalk = duration(styles, "body[data-bt-motion=lively] .bt-mark.bt-speaking :is(.bt-b,.bt-mark-img){");
	const talk = firstRule(styles, ".bt-mark.bt-speaking :is(.bt-b,.bt-mark-img){");
	const talkBase = /animation:bt-companion-talk ([\d.]+)s/.exec(talk.line);
	assert.ok(talkBase !== null);
	assert.ok(livelyTalk < Number(talkBase[1]));
});

test("quiet holds the companion still while keeping its expression", () => {
	const still = (selector: string): string => {
		const rows = rulesFrom(styles, "body[data-bt-motion=quiet] ", selector);
		assert.ok(rows.length > 0, `missing quiet rule for ${selector}`);
		return rows.join("\n");
	};
	assert.match(still(".bt-mark[data-mood]::after"), /animation:none/);
	assert.match(still(".bt-mark[data-mood=excited] :is(.bt-b,.bt-mark-img)"), /animation:none/);
	assert.match(still(".bt-mark.bt-speaking :is(.bt-b,.bt-mark-img)"), /animation:none/);
	// The face itself stays: the glow color and the eye shape are expressions, not motion.
	assert.match(styles, /body\[data-bt-motion=quiet\] \.bt-mark\[data-mood\]::after\{animation:none;opacity:\.55/);
	assert.match(styles, /\.bt-mark\[data-mood=warm\] :is\(\.mb-eye,\.bt-eyes\)\{scale:1 \.9\}/);
	// Quiet removes motion, never the mood color or the eye shape itself.
	assert.equal(
		lines(styles).some(
			(row) =>
				row.startsWith("body[data-bt-motion=quiet] ") && /\[data-mood=\w+\]/.test(row) && row.includes("mb-eye"),
		),
		false,
	);
});

test("System Reduce Motion still disables the companion animations", () => {
	assert.match(
		styles,
		/@media \(prefers-reduced-motion:reduce\)\{\.bt-mark \*\{animation:none!important;transition:none!important\}\}/,
	);
});

// ---------------------------------------------------------------------------
// State motions reach the marine eyes too.

test("state motions animate the marine eye layers", () => {
	for (const [selector, animation] of [
		[".bt-mark[data-state=thinking] :is(.bt-eyes,.mb-eyes){", "bt-squint"],
		[".bt-mark[data-state=searching] :is(.bt-eyes,.mb-eyes){", "bt-scan"],
		[".bt-mark[data-state=working] :is(.bt-eye,.mb-eye){", "bt-blink"],
		[".bt-mark:is([data-state=orbit],[data-state=waiting]) :is(.bt-eyes,.mb-eyes){", "bt-roll"],
	]) {
		const rule = firstRule(styles, selector);
		assert.ok(rule.line.includes(`animation:${animation}`), selector);
	}
});

// ---------------------------------------------------------------------------
// The mood badge and the header pill are not motion-dependent.

test("the mood badge and header mood pill stay visible at every motion level", () => {
	const badge = firstRule(styles, ".bt-mood-badge{");
	assert.ok(!badge.line.includes("data-bt-motion"), "the badge must not be motion-gated");
	const pill = firstRule(styles, ".bt-pill-mood{");
	assert.ok(!pill.line.includes("data-bt-motion"), "the header mood pill must not be motion-gated");
	// The avatar badge renders from the companion mood alone.
	assert.match(mark, /companion\?\.mood !== undefined && badge && size >= 22/);
	assert.match(mark, /"data-mood": bot\?\.companion\?\.mood/);
	// mark.ts reads the motion level only to still the pointer gaze, never the mood.
	const motionReads = lines(mark).filter((row) => row.includes("btMotion"));
	assert.equal(motionReads.length, 1);
	assert.match(motionReads[0], /dataset\.btMotion === "quiet"/);
});

// ---------------------------------------------------------------------------
// The default level is the one users get.

test("normal is the default motion level and the level written to the window", () => {
	assert.match(
		index,
		/const motion = prefs\.motion === "quiet" \|\| prefs\.motion === "lively" \? prefs\.motion : "normal"/,
	);
	assert.match(index, /document\.body\.dataset\.btMotion = motion/);
});

// ---------------------------------------------------------------------------
// The wrapper exists in the rendered mark, not only in the source.

const harness = process.env.DSH_HARNESS ?? join(PLUGIN, "..", "dev", "harness");
const requireHarness = createRequire(join(harness, "package.json"));
const { build } = requireHarness("esbuild");
const { outputFiles } = await build({
	stdin: { contents: "export { BotMark } from './src/client/look/mark.ts';", resolveDir: PLUGIN },
	bundle: true,
	format: "cjs",
	platform: "browser",
	write: false,
	logLevel: "silent",
	external: ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"],
});
const reactShim = {
	createContext: (initial: unknown) => ({ value: initial }),
	useContext: (context: { value: unknown }) => context.value,
	useCallback: (fn: unknown) => fn,
	useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
	createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
	Fragment: "fragment",
	useEffect() {},
	useLayoutEffect() {},
	useState: (initial: unknown) => [initial, () => {}],
	useMemo: (make: () => unknown) => make(),
	useRef: (current: unknown) => ({ current }),
	useId: () => "id",
};

/** One BotMark as the window would receive it. */
function markTree(bot: Record<string, unknown>): any {
	const loaded = { exports: {} as any };
	runInNewContext(outputFiles[0].text, {
		module: loaded,
		exports: loaded.exports,
		require: (name: string) => (name === "react" ? reactShim : {}),
		console,
		setTimeout,
		clearTimeout,
	});
	return loaded.exports.BotMark({ bot, size: 44 });
}

/** The svg a BotMark draws, as the window would receive it. */
function markSvg(bot: Record<string, unknown>): string {
	const span = markTree(bot);
	return span.children[0].props.dangerouslySetInnerHTML.__html as string;
}

test("the rendered mark wraps marine layers in the animated body group exactly once", () => {
	const html = markSvg({ id: "b1", companion: { mood: "excited" } });
	assert.ok(html.startsWith('<g class="bt-b">'), html.slice(0, 60));
	assert.ok(html.includes('class="mb-body"'));
	assert.equal(html.split('<g class="bt-b">').length - 1, 1);
	// A photo companion draws an image, not layers; it has no body group of its own and the
	// motion rules reach it through .bt-mark-img.
	const photo = markTree({ id: "b2", avatar: { shape: "dolphin", image: "data:image/png;base64,AA" } });
	assert.equal(photo.children[0].props.className, "bt-mark-img");
	assert.equal(JSON.stringify(photo).includes("bt-b"), false);
});

test("the mark carries its companion mood, which is what the expression rules select", () => {
	const span = (() => {
		const loaded = { exports: {} as any };
		runInNewContext(outputFiles[0].text, {
			module: loaded,
			exports: loaded.exports,
			require: (name: string) => (name === "react" ? reactShim : {}),
			console,
			setTimeout,
			clearTimeout,
		});
		return loaded.exports.BotMark({ bot: { id: "b3", companion: { mood: "warm" } }, size: 32 });
	})();
	assert.equal(span.props["data-mood"], "warm");
	assert.equal(span.props["data-bot"], "b3");
	const plain = (() => {
		const loaded = { exports: {} as any };
		runInNewContext(outputFiles[0].text, {
			module: loaded,
			exports: loaded.exports,
			require: (name: string) => (name === "react" ? reactShim : {}),
			console,
			setTimeout,
			clearTimeout,
		});
		return loaded.exports.BotMark({ bot: { id: "b4" }, size: 32 });
	})();
	assert.equal(plain.props["data-mood"], undefined);
});
