// Overlays: the escape stack every dialog shares, and the left edge overlays that
// replace the conversation.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Escape closes only the newest open layer, so a dialog over the details pane does
// not take the pane down with it.
const escapeLayers: Array<{ current: () => void }> = [];
const onEscapeKey = (event: KeyboardEvent): void => {
	if (event.key === "Escape") escapeLayers.at(-1)?.current();
};

export function useEscape(onClose: () => void): void {
	const ref = useRef<() => void>(onClose);
	ref.current = onClose;
	useEffect(() => {
		if (escapeLayers.length === 0) window.addEventListener("keydown", onEscapeKey);
		escapeLayers.push(ref);
		return () => {
			escapeLayers.splice(escapeLayers.indexOf(ref), 1);
			if (escapeLayers.length === 0) window.removeEventListener("keydown", onEscapeKey);
		};
	}, []);
}

// New chat and Bot exchanges show in place of the conversation, right of the sidebar.
export function usePaneLeft(): number {
	const [paneLeft, setPaneLeft] = useState<number>(280);
	useLayoutEffect(() => {
		const column = (document.querySelector('[class*="_footArea"]') as HTMLElement | null)?.parentElement;
		if (column) setPaneLeft(Math.round(column.getBoundingClientRect().right));
	}, []);
	return paneLeft;
}
