// Avatar library behaviour: the same picture is kept once under the hash of its bytes,
// imports serialize so overlapping batches do not drop each other, the library survives
// restarts and deletion of the Bots that used it, and pages stay small.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install } from "../src/host/work/avatar-library.ts";

type TestRuntime = Runtime & Record<string, any>;

// Only the magic bytes matter to the reader; the rest of a fixture need not decode.
const file = (magic: Buffer, size = 32): Buffer => Buffer.concat([magic, Buffer.alloc(size, 7)]);
const PNG = file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const JPEG = file(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const asDataUrl = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString("base64")}`;
const pngUrl = asDataUrl("image/png", PNG);
const jpegUrl = asDataUrl("image/jpeg", JPEG);
const photo = (name: string, bytes: Buffer): { name: string; image: string } => ({
	name,
	image: asDataUrl("image/png", bytes),
});

interface Host {
	rt: TestRuntime;
	home: string;
}

function boot(home: string): Host {
	const warnings: unknown[][] = [];
	const rt = {
		home,
		warn: (...args: unknown[]) => warnings.push(args),
	} as unknown as TestRuntime;
	install(rt);
	return { rt, home };
}

const tempHome = (t: TestContext): string => {
	const home = mkdtempSync(join(tmpdir(), "ocean-crew-avlib-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};

const avatarsDir = (home: string): string => join(home, "avatars");
const filesIn = (home: string): string[] => readdirSync(join(home, "avatars", "files"));

test("a photo imported once is kept, and the same photo again does not make a second entry", async (t) => {
	const host = boot(tempHome(t));
	const first = await host.rt.avatarLibraryImport([{ name: "team.png", image: pngUrl }]);
	assert.deepEqual(
		first.imported.map((entry: { name: string }) => entry.name),
		["team.png"],
	);
	assert.deepEqual(first.duplicates, []);
	assert.deepEqual(first.failed, []);
	const library = await host.rt.avatarLibraryView();
	assert.equal(library.items.length, 1);
	assert.equal(library.items[0].name, "team.png");
	// The window gets the image itself, so it needs one request to draw the library.
	assert.equal(library.items[0].image, pngUrl);
	// The same picture again, even under another name, is the picture that is there.
	const again = await host.rt.avatarLibraryImport([
		{ name: "other.png", image: pngUrl },
		{ name: "second.jpg", image: jpegUrl },
	]);
	assert.equal(again.imported.length, 1);
	assert.equal(again.duplicates.length, 1);
	assert.equal(again.duplicates[0].name, "team.png");
	assert.equal(again.failed.length, 0);
	const after = await host.rt.avatarLibraryView();
	assert.equal(after.items.length, 2);
	assert.deepEqual(after.items.map((item: { name: string }) => item.name).sort(), ["second.jpg", "team.png"]);
});

test("a batch import partly succeeds: the good photos land, and the bad one is named", async (t) => {
	const host = boot(tempHome(t));
	const result = await host.rt.avatarLibraryImport([
		{ name: "one.png", image: pngUrl },
		{ name: "notes.png", image: "data:image/png;base64,bm90IGFuIGltYWdl" },
		{ name: "two.jpg", image: jpegUrl },
	]);
	assert.equal(result.imported.length, 2);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].name, "notes.png");
	assert.match(result.failed[0].message, /must be a PNG, JPEG, WebP, or GIF image/);
	const library = await host.rt.avatarLibraryView();
	assert.deepEqual(library.items.map((item: { name: string }) => item.name).sort(), ["one.png", "two.jpg"]);
	// An image over the limit is refused by name too.
	const huge = asDataUrl("image/png", Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(200_000)]));
	const over = await host.rt.avatarLibraryImport([{ name: "huge.png", image: huge }]);
	assert.equal(over.imported.length, 0);
	assert.equal(over.failed.length, 1);
	assert.match(over.failed[0].message, /too large/);
	assert.equal((await host.rt.avatarLibraryView()).items.length, 2);
});

test("a photo is named from its bytes, and no temporary file is left behind", async (t) => {
	const host = boot(tempHome(t));
	await host.rt.avatarLibraryImport([{ name: "team.png", image: pngUrl }]);
	const files = filesIn(host.home);
	assert.equal(files.length, 1);
	assert.match(files[0], /^[0-9a-f]{64}\.png$/);
	// The index and the images are written whole, so no temp file is left behind.
	assert.deepEqual(readdirSync(avatarsDir(host.home)).sort(), ["files", "index.json"]);
});

test("an image whose index write failed is not treated as an imported duplicate", async (t) => {
	const host = boot(tempHome(t));
	// A folder where the index file should be: neither the index nor an entry can land.
	mkdirSync(join(avatarsDir(host.home), "index.json"), { recursive: true });
	const result = await host.rt.avatarLibraryImport([
		{ name: "first.png", image: pngUrl },
		{ name: "again.png", image: pngUrl },
	]);
	assert.equal(result.failed.length, 2);
	assert.equal(result.imported.length, 0);
	assert.equal(result.duplicates.length, 0);
	assert.equal((await host.rt.avatarLibraryView()).total, 0);
	rmSync(join(avatarsDir(host.home), "index.json"), { recursive: true });
	const retry = await host.rt.avatarLibraryImport([
		{ name: "first.png", image: pngUrl },
		{ name: "again.png", image: pngUrl },
	]);
	assert.equal(retry.imported.length, 1);
	assert.equal(retry.duplicates.length, 1);
	assert.equal((await host.rt.avatarLibraryView()).total, 1);
});

test("imports that overlap all land, and none is lost to another one", async (t) => {
	const host = boot(tempHome(t));
	// Ten imports at once: each reads the index and writes it back, so without a queue
	// the ones that overlap would drop each other's photos.
	const photos = Array.from({ length: 10 }, (_, index) =>
		photo(`photo-${index}.png`, Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
	);
	const results = await Promise.all(photos.map((item) => host.rt.avatarLibraryImport([item])));
	assert.equal(
		results.every((result: { failed: unknown[] }) => result.failed.length === 0),
		true,
	);
	const library = await host.rt.avatarLibraryView();
	assert.equal(library.total, 10);
	assert.equal(library.items.length, 10);
	assert.deepEqual(
		library.items.map((item: { name: string }) => item.name).sort(),
		photos.map((item) => item.name).sort(),
	);
	// Every photo is on disk once, and the index names them all.
	assert.equal(filesIn(host.home).length, 10);
});

test("the library answers page by page, so a big library is not one huge reply", async (t) => {
	const host = boot(tempHome(t));
	const photos = Array.from({ length: 60 }, (_, index) =>
		photo(`photo-${index}.png`, Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
	);
	await host.rt.avatarLibraryImport(photos);
	const first = await host.rt.avatarLibraryView();
	assert.equal(first.total, 60);
	assert.ok(first.items.length <= 48, `the first answer carries ${first.items.length} photos, not the whole library`);
	// The newest come first; the next page starts where this one stopped.
	assert.equal(first.items[0].name, "photo-59.png");
	assert.equal(first.next, first.items.length);
	const second = await host.rt.avatarLibraryView({ offset: first.next, limit: 10 });
	assert.equal(second.items.length, 10);
	assert.equal(second.total, 60);
	assert.equal(second.next, first.next + 10);
	const names = new Set(first.items.map((item: { name: string }) => item.name));
	assert.equal(
		second.items.every((item: { name: string }) => !names.has(item.name)),
		true,
	);
	// A page past the end is empty, not an error.
	assert.equal((await host.rt.avatarLibraryView({ offset: 60 })).items.length, 0);
});

test("the library outlives a restart", async (t) => {
	const home = tempHome(t);
	const first = boot(home);
	await first.rt.avatarLibraryImport([{ name: "team.png", image: pngUrl }]);
	// A new host on the same data reads the library again.
	const second = boot(home);
	const library = await second.rt.avatarLibraryView();
	assert.equal(library.items.length, 1);
	assert.equal(library.items[0].image, pngUrl);
});

test("a photo that leaves the library leaves the Bots that use it alone", async (t) => {
	const host = boot(tempHome(t));
	await host.rt.avatarLibraryImport([{ name: "team.png", image: pngUrl }]);
	const entry = (await host.rt.avatarLibraryView()).items[0];
	// A Bot that copied the photo keeps its own copy in state.json; the library file is
	// only the library's.
	const removed = await host.rt.avatarLibraryDelete(entry.id);
	assert.equal(removed, true);
	assert.equal((await host.rt.avatarLibraryView()).items.length, 0);
	assert.deepEqual(filesIn(host.home), []);
	// A photo that is not there is not removed twice.
	assert.equal(await host.rt.avatarLibraryDelete(entry.id), false);
});

test("a missing image file is skipped in the view and put back by a duplicate import", async (t) => {
	const host = boot(tempHome(t));
	await host.rt.avatarLibraryImport([{ name: "team.png", image: pngUrl }]);
	const entry = (await host.rt.avatarLibraryView()).items[0];
	rmSync(join(avatarsDir(host.home), "files", `${entry.id}.png`));
	// The index still names it, so the total counts it, but the page skips the photo.
	const after = await host.rt.avatarLibraryView();
	assert.equal(after.total, 1);
	assert.equal(after.items.length, 0);
	// Importing the same picture again puts the file back without a second entry.
	const again = await host.rt.avatarLibraryImport([{ name: "team-copy.png", image: pngUrl }]);
	assert.equal(again.duplicates.length, 1);
	assert.equal(again.imported.length, 0);
	assert.equal((await host.rt.avatarLibraryView()).items[0].image, pngUrl);
});

test("the library holds at most 500 photos", async (t) => {
	const home = tempHome(t);
	mkdirSync(avatarsDir(home), { recursive: true });
	const items = Array.from({ length: 500 }, (_, index) => ({
		id: `${index}`.padStart(64, "0"),
		name: `photo-${index}.png`,
		mime: "image/png",
		bytes: 100,
		createdAt: index,
	}));
	writeFileSync(join(avatarsDir(home), "index.json"), JSON.stringify({ version: 1, items }));
	const host = boot(home);
	assert.equal((await host.rt.avatarLibraryView()).total, 500);
	const result = await host.rt.avatarLibraryImport([{ name: "one-more.png", image: pngUrl }]);
	assert.equal(result.imported.length, 0);
	assert.equal(result.failed.length, 1);
	assert.match(result.failed[0].message, /at most 500 photos/);
});

test("a corrupt index reads as an empty library, and the next import repairs it", async (t) => {
	const home = tempHome(t);
	mkdirSync(avatarsDir(home), { recursive: true });
	writeFileSync(join(avatarsDir(home), "index.json"), "{not json");
	const host = boot(home);
	assert.equal((await host.rt.avatarLibraryView()).total, 0);
	const result = await host.rt.avatarLibraryImport([{ name: "team.png", image: pngUrl }]);
	assert.equal(result.imported.length, 1);
	// The rewritten index is parseable again.
	const saved = JSON.parse(readFileSync(join(avatarsDir(home), "index.json"), "utf8"));
	assert.equal(saved.version, 1);
});

test("an unnamed photo gets a fixed name, and a long one is cut", async (t) => {
	const host = boot(tempHome(t));
	const result = await host.rt.avatarLibraryImport([
		{ image: pngUrl },
		{ name: `${"x".repeat(200)}.png`, image: jpegUrl },
	]);
	assert.equal(result.imported[0].name, "photo");
	assert.equal(result.imported[1].name.length, 120);
});
