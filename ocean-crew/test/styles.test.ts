// The stylesheets: the shell and conversation CSS the client injects, and the two
// installers that tag, recompile, and remove them. The modules run in a jsdom document
// through a small esbuild bundle, because the motion module imports React.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, "..", "dev", "harness");
const requireHarness = createRequire(join(harness, "package.json"));
const { JSDOM } = requireHarness("jsdom");
const { build } = requireHarness("esbuild");

// The styles module and the motion constants it interpolates, bundled once with React,
// React DOM and the DSH primitives left external (a page supplies them).
const { outputFiles } = await build({
	stdin: {
		contents:
			"export { SHELL_CSS, CONVERSATION_CSS, installStyles, installCompiledStyles } from './src/client/look/styles.ts'; export { MENTION_ORIGIN } from './src/client/core/text.ts';" +
			"export { SPRING_TAP, SPRING_SHAPE, SPRING_POP } from './src/client/look/motion.ts';",
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
	createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
	Fragment: "fragment",
	useEffect() {},
	useLayoutEffect() {},
	useState: (initial: unknown) => [initial, () => {}],
	useMemo: (make: () => unknown) => make(),
	useRef: (current: unknown) => ({ current }),
	useId: () => "id",
};

interface Bench {
	window: any;
	module: any;
	styles: any;
}

function bench(): Bench {
	const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>");
	const module = { exports: {} };
	runInNewContext(outputFiles[0].text, {
		module,
		exports: module.exports,
		document: window.document,
		MutationObserver: window.MutationObserver,
		HTMLLinkElement: window.HTMLLinkElement,
		window,
		setTimeout,
		clearTimeout,
		require: (name: string) => (name === "react" ? react : {}),
	});
	return { window, module, styles: module.exports };
}

const tags = (document: any): any[] => [...document.head.querySelectorAll("style")];

test("the shell and conversation CSS carry the same selectors and tokens", () => {
	const { styles } = bench();
	assert.equal(typeof styles.SHELL_CSS, "string");
	assert.equal(typeof styles.CONVERSATION_CSS, "string");
	assert.equal(styles.MENTION_ORIGIN, "https://bots.local/");
	for (const selector of [
		".bt-mark",
		".bt-badge",
		".bt-mark-img",
		".bt-bubble",
		".bt-cluster",
		".bt-pill",
		".bt-think",
	]) {
		if (!styles.SHELL_CSS.includes(selector) && !styles.CONVERSATION_CSS.includes(selector)) {
			// Some selectors live in one sheet only; each must appear somewhere.
			assert.fail(`missing ${selector}`);
		}
	}
	// Ink variables are generated from the ink table.
	assert.ok(styles.SHELL_CSS.includes("--bt-ink-deepseek:#4D6BFE"));
	assert.ok(styles.SHELL_CSS.includes("--bt-ink-aurora:#00B8D4"));
	assert.ok(styles.SHELL_CSS.includes("body[data-ds-dark-theme]{--bt-ink-"));
	// The mention link wears the fallback marine mask as an SVG url.
	assert.ok(styles.SHELL_CSS.includes(`a[href^="${styles.MENTION_ORIGIN}"]`));
	assert.ok(styles.SHELL_CSS.includes('mask:url("data:image/svg+xml,'));
	// Spring curves reach the CSS as their sampled durations.
	assert.ok(styles.SHELL_CSS.includes(`${styles.SPRING_SHAPE.duration}ms`));
	assert.ok(styles.SHELL_CSS.includes(`${styles.SPRING_TAP.duration}ms`));
	assert.ok(styles.SHELL_CSS.includes(`${styles.SPRING_POP.duration}ms`));
	// The waiting mark sways, so a Bot coordinating teammates moves in its own way.
	assert.match(
		styles.SHELL_CSS,
		/\.bt-mark:is\(\[data-state=orbit\],\[data-state=waiting\]\) \.bt-b\{animation:bt-sway/,
	);
	assert.ok(styles.CONVERSATION_CSS.includes("--bt-msg-w"));
	assert.notEqual(styles.SHELL_CSS, styles.CONVERSATION_CSS);
});

test("installStyles tags a style for the plugin and its group", () => {
	const { window, styles } = bench();
	const style = styles.installStyles("body{color:red}", "test-tag");
	assert.equal(tags(window.document).length, 1);
	assert.equal(style.dataset.dshBot, "test-tag");
	assert.equal(style.dataset.plugin, "ocean-crew");
	assert.equal(style.textContent, "body{color:red}");
	assert.equal(style.isConnected, true);
});

test("installCompiledStyles rewrites fragment selectors and cleans up", () => {
	const { window, styles } = bench();
	// A shell stylesheet (no dshBot tag) defines the hashed class the fragment matches.
	const shell = window.document.createElement("style");
	shell.textContent = "._bubble_12mhf_1{color:blue}";
	window.document.head.appendChild(shell);
	const cleanup = styles.installCompiledStyles('[class*="_bubble_"]{color:red}', "conversation");
	const ours = tags(window.document).filter((style: any) => style.dataset.dshBot === "conversation");
	assert.equal(ours.length, 1);
	assert.ok(ours[0].textContent.includes("._bubble_12mhf_1"));
	assert.equal(ours[0].textContent.includes('[class*="_bubble_"]'), false);
	cleanup();
	assert.equal(tags(window.document).filter((style: any) => style.dataset.dshBot === "conversation").length, 0);
});

test("a style tag removed out from under the installer comes back", async () => {
	const { window, styles } = bench();
	const cleanup = styles.installCompiledStyles("body{color:red}", "removed");
	const style = tags(window.document).find((element: any) => element.dataset.dshBot === "removed");
	style.remove();
	await new Promise((resolve) => setImmediate(resolve));
	const back = tags(window.document).filter((element: any) => element.dataset.dshBot === "removed");
	assert.equal(back.length, 1, "the observer re-appends the removed tag");
	cleanup();
});
