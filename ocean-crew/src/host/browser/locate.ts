// The Bot browser drives the Chrome the machine already has installed. The plugin
// depends on playwright-core, which ships no browser of its own, so a missing
// browserExecutablePath is resolved here instead of failing at launch.
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const EXECUTABLE = process.platform === "win32" ? constants.F_OK : constants.X_OK;

function candidates(): string[] {
	if (process.platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		];
	}
	if (process.platform === "win32") {
		return [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
			.filter((base): base is string => typeof base === "string" && base !== "")
			.map((base) => join(base, "Google", "Chrome", "Application", "chrome.exe"));
	}
	return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
}

/** How a caller can make resolution testable and independent of the real machine. */
export interface LocateOptions {
	exists?: (path: string) => boolean;
	pathEnv?: string | undefined;
}

// Resolve the browser binary: the configured path first, then the platform's usual
// install locations and PATH. Undefined means "let Playwright decide" (it then reports
// its own missing-executable error). `exists` is injectable for tests.
export function findChrome(
	explicit?: string | null,
	{
		exists = (path: string): boolean => {
			try {
				accessSync(path, EXECUTABLE);
				return true;
			} catch {
				return false;
			}
		},
		pathEnv = process.env.PATH,
	}: LocateOptions = {},
): string | undefined {
	const list: string[] = [];
	if (typeof explicit === "string" && explicit !== "") list.push(explicit);
	for (const candidate of candidates()) {
		if (isAbsolute(candidate)) {
			list.push(candidate);
			continue;
		}
		for (const directory of String(pathEnv ?? "").split(delimiter)) {
			if (directory !== "") list.push(join(directory, candidate));
		}
	}
	for (const path of new Set(list)) if (exists(path)) return path;
	return undefined;
}
