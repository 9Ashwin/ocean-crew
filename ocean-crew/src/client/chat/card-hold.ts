// Keep an edited dock card in place when its history cell mounts. Only the request's
// identity is shared; drafts and secret values stay in the component.

import { useLayoutEffect, useRef } from "react";

export type DockKind = string;

/** The shell callbacks a held dock card asks to keep its place. */
export interface DockHoldActions {
	noteHeldCard?: (sessionId: string, kind: DockKind, requestId: string, hold: 1 | -1) => void;
}

export function useDockHold(
	sessionId: string,
	kind: DockKind,
	requestId: string,
	actions: DockHoldActions,
	inline: boolean,
): () => void {
	const release = useRef<(() => void) | null>(null);
	const note = actions.noteHeldCard;
	useLayoutEffect(
		() => () => {
			const stop = release.current;
			release.current = null;
			stop?.();
		},
		[sessionId, kind, requestId, note, inline],
	);
	return () => {
		if (inline || release.current || !note) return;
		release.current = () => note(sessionId, kind, requestId, -1);
		note(sessionId, kind, requestId, 1);
	};
}
