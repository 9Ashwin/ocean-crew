// Client copy: the Chinese dictionary, the language switch, host messages, and the rule
// that every literal the client translates has a Chinese entry.
// Most of the client UI is landing in

// today and grows with them; i18n.ts's own text contains no t() literals to scan.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DICTIONARY, dateLocale, hostText, installLocale, language, NAMESPACE, t } from "../src/client/core/i18n.ts";

const CLIENT_DIR = new URL("../src/client/", import.meta.url);

interface FakeLocale {
	register(namespace: string, locale: string, dictionary: Record<string, string>): () => boolean;
	bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
	getLocale(): { active: string };
}

function fakeLocale(active: string): FakeLocale {
	const dictionaries = new Map<string, Record<string, string>>();
	return {
		register: (namespace, locale, dictionary) => {
			dictionaries.set(`${namespace}:${locale}`, dictionary);
			return () => dictionaries.delete(`${namespace}:${locale}`);
		},
		bind: (namespace) => (key, params) => {
			const text = (active === "zh" ? dictionaries.get(`${namespace}:zh`)?.[key] : undefined) ?? key;
			return params
				? text.replaceAll(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
				: text;
		},
		getLocale: () => ({ active }),
	};
}

test("every literal the client translates has a Chinese entry", () => {
	const missing: string[] = [];
	const files = readdirSync(CLIENT_DIR, { recursive: true })
		.map(String)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
	for (const name of files) {
		const text = readFileSync(new URL(name, CLIENT_DIR), "utf8");
		for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
			const key = match[2].replace(/\\'/g, "'");
			if (!Object.hasOwn(DICTIONARY.zh, key)) missing.push(`${name}: ${key}`);
		}
		for (const match of text.matchAll(/\bhostText\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
			const message = match[2];
			// A host message is translated by the dictionary, by a host pattern, or falls
			// back to English; a literal that does neither would stay English in Chinese.
			if (Object.hasOwn(DICTIONARY.zh, message)) continue;
			const matched = hostText(" ".length === 0 ? "" : message) !== message;
			if (!matched && /^(?:A Bot named|The team needs|Model |Could not reach|An entry holds)/.test(message))
				missing.push(`${name}: hostText ${message}`);
		}
	}
	assert.deepEqual(missing, []);
});

test("copy follows the DSH language and stays English without a locale service", () => {
	assert.equal(NAMESPACE, "ocean-crew");
	assert.equal(t("Message {name}", { name: "Chief" }), "Message Chief");
	assert.equal(language(), "en");
	assert.equal(dateLocale(), "en-US");
	const off = installLocale(fakeLocale("zh"));
	try {
		assert.equal(language(), "zh");
		assert.equal(dateLocale(), "zh-CN");
		assert.equal(t("Message {name}", { name: "Chief" }), "给 Chief 发消息");
		assert.equal(t("Model"), "模型");
		assert.equal(t("Main Bot"), "主 Bot");
		// Unknown parameters keep their slots; an unknown key stays the key.
		assert.equal(t("Waiting for {names}"), "等 {names} 交回");
		assert.equal(t("Nothing to translate"), "Nothing to translate");
		assert.equal(hostText("A Bot named Writer already exists"), "已经有叫 Writer 的 Bot 了");
		assert.equal(hostText("The team needs at least one Main Bot"), "团队至少要有一个主 Bot");
		assert.equal(hostText("Something new"), "Something new");
		// Whole memory messages, not only their first words, become Chinese.
		assert.equal(
			hostText(
				"An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.",
			),
			"一条记忆最多 300 个字符，这条有 301 个",
		);
		assert.equal(
			hostText(
				"Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic.",
			),
			"主记忆会超过 4000 个字符的上限，请先删掉一些",
		);
		assert.equal(hostText("There is no entry 9."), "没有第 9 条");
		assert.equal(
			hostText("Could not reach the mail server at mail.example.com. Check the server address."),
			"连不上邮件服务器 mail.example.com，请检查服务器地址。",
		);
	} finally {
		off();
	}
	assert.equal(t("Model"), "Model");
	assert.equal(language(), "en");
	assert.equal(hostText("A Bot named Writer already exists"), "A Bot named Writer already exists");
});

test("the dictionary keeps the whole Chinese copy, and host entries are part of it", () => {
	// A spot check that the port kept the dictionary whole rather than a prefix. The

	assert.equal(Object.keys(DICTIONARY.zh).length, 1528);
	for (const key of [
		"Main Bot",
		"Model",
		"Settings",
		"A group chat needs at least two Bots",
		"The team needs at least one Main Bot",
	]) {
		assert.equal(typeof DICTIONARY.zh[key], "string", key);
		assert.notEqual(DICTIONARY.zh[key], "", key);
	}
	// Host-only entries are merged into the same dictionary.
	assert.equal(DICTIONARY.zh["Unknown Bot"], "找不到这个 Bot");
});

test("installing a locale that cannot register copy changes nothing", () => {
	assert.equal(installLocale(undefined)(), undefined);
	assert.equal(language(), "en");
	const noBind = { register: () => () => true } as unknown as Parameters<typeof installLocale>[0];
	assert.equal(installLocale(noBind)(), undefined);
	assert.equal(t("Model"), "Model");
});
