// The avatar library: photos the user imported once, kept in the Bot data folder so the
// same picture can be picked for several Bots and outlives the Bot that used it. Every
// image is named by the hash of its bytes, so the same picture is stored once, and the
// index and the images are written whole, so a half-written file is never read.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFile } from "../core/files.ts";
import type { Runtime } from "../core/runtime.ts";
import { type AvatarMime, avatarBytes } from "./avatar.ts";

const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};
const HASH = /^[0-9a-f]{64}$/;
const MAX_PHOTOS = 500;
// How many photos one answer carries. A window asks for the rest when it wants them,
// so a big library does not become one huge reply.
const MAX_LISTED = 48;
const NAME_MAX = 120;
const INDEX_VERSION = 1;

/** One photo in the library; `id` is the hash of the image bytes. */
export interface AvatarLibraryEntry {
	id: string;
	name: string;
	mime: AvatarMime;
	bytes: number;
	createdAt: number;
}

/** One photo as the window draws it: the entry plus the image itself. */
export interface AvatarLibraryItem extends AvatarLibraryEntry {
	image: string;
}

/** A page of the library; `next` is where the next page starts even after a missing file. */
export interface AvatarLibraryView {
	items: AvatarLibraryItem[];
	total: number;
	next: number;
}

/** What one import did, photo by photo. */
export interface AvatarLibraryImport {
	imported: AvatarLibraryEntry[];
	duplicates: { id: string; name: string }[];
	failed: { name: string; message: string }[];
}

/** One photo offered for import, as the window sends it. */
export interface AvatarLibraryPhoto {
	name?: unknown;
	image?: unknown;
}

const messageOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: String(error);

export function install(rt: Runtime): void {
	const root = typeof rt.home === "string" ? join(rt.home, "avatars") : undefined;
	const files = root === undefined ? undefined : join(root, "files");
	const indexPath = root === undefined ? undefined : join(root, "index.json");

	const fileOf = (entry: { id: string; mime: string }): string =>
		join(files as string, `${entry.id}.${EXTENSIONS[entry.mime]}`);

	// One write at a time: two imports that overlap would each read the index, and the
	// second write would drop what the first one added.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.then(
			() => {},
			() => {},
		);
		return run;
	};

	// The index on disk, with the entries that can be trusted: an id that is a hash, a
	// known type, and a name that is text.
	const readIndex = async (): Promise<AvatarLibraryEntry[]> => {
		if (indexPath === undefined) return [];
		let parsed: { items?: unknown } | undefined;
		try {
			parsed = JSON.parse(await readFile(indexPath, "utf8")) as { items?: unknown };
		} catch {
			return [];
		}
		const items: unknown[] = Array.isArray(parsed?.items) ? (parsed.items as unknown[]) : [];
		return items
			.filter(
				(entry): entry is { id: string; mime: AvatarMime; name?: unknown; bytes?: unknown; createdAt?: unknown } =>
					typeof (entry as { id?: unknown } | null)?.id === "string" &&
					HASH.test((entry as { id: string }).id) &&
					EXTENSIONS[(entry as { mime?: string }).mime ?? ""] !== undefined,
			)
			.map((entry) => ({
				id: entry.id,
				name: String(entry.name ?? "").slice(0, NAME_MAX),
				mime: entry.mime,
				bytes: Number(entry.bytes) || 0,
				createdAt: Number(entry.createdAt) || 0,
			}));
	};

	const writeIndex = async (items: AvatarLibraryEntry[]): Promise<void> => {
		await mkdir(root as string, { recursive: true });
		const temp = `${indexPath as string}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify({ version: INDEX_VERSION, items }, null, 2), "utf8");
		await replaceFile(temp, indexPath as string);
	};

	const writeImage = async (entry: AvatarLibraryEntry, bytes: Buffer): Promise<void> => {
		await mkdir(files as string, { recursive: true });
		const path = fileOf(entry);
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temp, bytes);
		await replaceFile(temp, path);
	};

	const there = async (path: string): Promise<boolean> =>
		stat(path).then(
			() => true,
			() => false,
		);

	// One photo at a time, so a photo that cannot be read does not lose the others. The
	// picture is checked as an image, and the same bytes are kept once.
	const importPhotos = (items: readonly AvatarLibraryPhoto[]): Promise<AvatarLibraryImport> =>
		serial(async () => {
			if (root === undefined) throw new Error("This host keeps no Bot data folder, so it has no avatar library.");
			const index = await readIndex();
			const result: AvatarLibraryImport = { imported: [], duplicates: [], failed: [] };
			for (const item of items) {
				const name = String(item?.name ?? "")
					.trim()
					.slice(0, NAME_MAX);
				try {
					const { bytes, mime } = avatarBytes(item?.image);
					const id = createHash("sha256").update(bytes).digest("hex");
					const known = index.find((entry) => entry.id === id);
					if (known) {
						// The same picture again: the one that is there stays, and its file is put
						// back when it went missing.
						if (!(await there(fileOf(known)))) await writeImage(known, bytes);
						result.duplicates.push({ id: known.id, name: known.name });
						continue;
					}
					if (index.length >= MAX_PHOTOS)
						throw new Error(`The avatar library holds at most ${MAX_PHOTOS} photos.`);
					const entry: AvatarLibraryEntry = {
						id,
						name: name || "photo",
						mime: mime as AvatarMime,
						bytes: bytes.length,
						createdAt: Date.now(),
					};
					await writeImage(entry, bytes);
					await writeIndex([...index, entry]);
					index.push(entry);
					result.imported.push(entry);
				} catch (error) {
					result.failed.push({ name, message: messageOf(error) });
				}
			}
			return result;
		});

	// The photos the user can pick, with the image itself, so the window needs one
	// request to draw the library. The newest come first, and a library with many photos
	// is asked for page by page.
	const libraryView = async ({
		offset = 0,
		limit = MAX_LISTED,
	}: {
		offset?: unknown;
		limit?: unknown;
	} = {}): Promise<AvatarLibraryView> => {
		const index = await readIndex();
		const ordered = [...index].reverse().sort((a, b) => b.createdAt - a.createdAt);
		const start = Math.max(0, Math.floor(Number(offset)) || 0);
		const count = Math.min(MAX_LISTED, Math.max(1, Math.floor(Number(limit)) || MAX_LISTED));
		const items: AvatarLibraryItem[] = [];
		const page = ordered.slice(start, start + count);
		for (const entry of page) {
			const bytes = await readFile(fileOf(entry)).catch(() => undefined);
			if (bytes === undefined) continue;
			items.push({ ...entry, image: `data:${entry.mime};base64,${bytes.toString("base64")}` });
		}
		// The next page starts where this one stopped, even when a photo went missing.
		return { items, total: ordered.length, next: start + page.length };
	};

	// A photo leaves the library; the Bots that use it keep their own copy.
	const deletePhoto = (id: string): Promise<boolean> =>
		serial(async () => {
			const index = await readIndex();
			const entry = index.find((item) => item.id === id);
			if (entry === undefined) return false;
			await writeIndex(index.filter((item) => item.id !== id));
			await rm(fileOf(entry), { force: true });
			return true;
		});

	Object.assign(rt, {
		avatarLibraryView: libraryView,
		avatarLibraryImport: importPhotos,
		avatarLibraryDelete: deletePhoto,
	});
}
