// Host modules import @deepseek-ai/* packages, which a test process only sees when
// harness-resolve.mjs points them at a DeepSeek Harness. This check fails if that wiring
// (or the `node --import` flag in the test command) breaks.
import assert from "node:assert/strict";
import { test } from "node:test";

test("@deepseek-ai packages resolve from a DeepSeek Harness", () => {
	const harness = process.env.DSH_HARNESS;
	assert.ok(harness, "harness-resolve.mjs sets DSH_HARNESS");
	const url = import.meta.resolve("@deepseek-ai/dsh/package.json");
	assert.match(url, /@deepseek-ai\/dsh\/package\.json$/);
	assert.ok(url.startsWith("file://"), `expected a file URL, got ${url}`);
});
