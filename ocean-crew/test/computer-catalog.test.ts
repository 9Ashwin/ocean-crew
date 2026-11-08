// The computer-use provider catalog: which call is observe/background/foreground, and
// which level admits it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classify,
	DRIVER_GLOBAL,
	DRIVER_REFUSED,
	isComputerTool,
	LEVELS,
	levelAllows,
} from "../src/host/computer/catalog.ts";

test("the catalog classifies every provider call into observe, background, foreground", () => {
	for (const method of [
		"getCapabilities",
		"listApps",
		"findApps",
		"getApp",
		"listWindows",
		"getState",
		"screenshot",
		"permissionStatus",
		"applicationIcons",
	]) {
		assert.deepEqual(classify("cua", { method }), { provider: "cua", kind: "observe", method });
	}
	for (const method of ["activate", "hover", "requestPermission", "openPermissionSettings"]) {
		assert.equal(classify("cua", { method })?.kind, "foreground", method);
	}
	for (const method of [
		"click",
		"scroll",
		"drag",
		"setValue",
		"selectText",
		"performSecondaryAction",
		"typeText",
		"paste",
		"pressKey",
		"show",
		"launchApp",
	]) {
		assert.equal(classify("cua", { method })?.kind, "background", method);
	}
	// Unknown methods and a missing method fail closed to foreground.
	assert.equal(classify("cua", { method: "reboot" })?.kind, "foreground");
	assert.equal(classify("cua", {})?.kind, "foreground");
	for (const name of [
		"list_apps",
		"list_windows",
		"get_window_state",
		"get_accessibility_tree",
		"get_screen_size",
		"check_permissions",
	]) {
		assert.equal(classify(`cua_driver_native__${name}`, {})?.kind, "observe", name);
	}
	for (const name of ["bring_to_front", "move_cursor", "escalate_session", "set_agent_cursor_enabled"]) {
		assert.equal(classify(`cua_driver_native__${name}`, {})?.kind, "foreground", name);
	}
	for (const name of [
		"click",
		"double_click",
		"right_click",
		"drag",
		"type_text",
		"press_key",
		"hotkey",
		"set_value",
		"scroll",
		"launch_app",
		"kill_app",
		"invoke_menu",
		"browser_click",
		"browser_type",
	]) {
		assert.equal(classify(`cua_driver_native__${name}`, {})?.kind, "background", name);
	}
	assert.equal(classify("cua_driver_native__click", { foreground: true })?.kind, "foreground");
	assert.equal(classify("cua_driver_native__mystery", {})?.kind, "foreground");
	assert.equal(classify("message_bot", {}), undefined);
	assert.equal(isComputerTool("message_bot"), false);
	assert.equal(isComputerTool("cua"), true);
	assert.equal(isComputerTool("cua_driver_native__click"), true);
	// The driver's refused and global sets keep their members.
	assert.equal(DRIVER_REFUSED.has("set_config"), true);
	assert.equal(DRIVER_GLOBAL.has("list_windows"), true);
});

test("levels admit their kinds and nothing above", () => {
	assert.equal(levelAllows("off", "observe"), false);
	assert.equal(levelAllows("view", "observe"), true);
	assert.equal(levelAllows("view", "background"), false);
	assert.equal(levelAllows("background", "background"), true);
	assert.equal(levelAllows("background", "foreground"), false);
	assert.equal(levelAllows("foreground", "foreground"), true);
	assert.deepEqual([...LEVELS], ["off", "view", "background", "foreground"]);
});
