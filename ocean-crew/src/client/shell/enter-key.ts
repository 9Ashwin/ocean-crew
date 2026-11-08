// Enter submits only while the preference sends on Enter; off, a plain Enter is the
// field's own newline and only the send button submits. Before the roster answers,
// the snapshot's prefs come from the window's cache, so a saved `false` already holds.
export interface ComposerPrefs {
	enterToSend?: boolean;
}

export const sendsOnEnter = (prefs: ComposerPrefs | undefined): boolean => prefs?.enterToSend !== false;

export interface ComposerInputActions {
	captureInsertion(): unknown;
	insertText(text: string, span: unknown): unknown;
}

interface ComposerTarget {
	closest?(selector: string): ComposerTarget | null;
	ownerDocument?: { querySelector(selector: string): unknown };
}

export interface ComposerKeyEvent {
	key: string;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	isComposing?: boolean;
	keyCode?: number;
	getModifierState?(key: string): boolean;
	target?: ComposerTarget;
	preventDefault(): void;
	stopImmediatePropagation(): void;
}

// Plain Enter can insert a line instead of submitting. Menus, modified shortcuts,
// and IME confirmation keep the host composer's own behavior.
export function insertComposerNewline(
	event: ComposerKeyEvent,
	inputActions: ComposerInputActions | undefined,
): boolean {
	if (
		event.key !== "Enter" ||
		event.shiftKey ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.isComposing ||
		event.keyCode === 229 ||
		event.getModifierState?.("AltGraph")
	)
		return false;
	const target = event.target;
	if (typeof target?.closest !== "function" || !target.closest('[data-composer-card] [role="textbox"]')) return false;
	if (target.closest("[data-composer-composing]")) return false;
	if (target.ownerDocument?.querySelector('[role="listbox"]')) return false;
	if (typeof inputActions?.captureInsertion !== "function" || typeof inputActions?.insertText !== "function")
		return false;
	event.preventDefault();
	event.stopImmediatePropagation();
	inputActions.insertText("\n", inputActions.captureInsertion());
	return true;
}
