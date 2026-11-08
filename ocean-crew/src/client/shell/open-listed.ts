// DSH's main view opens only a Session that its client list already holds; any other id
// throws `sessions.retain: unknown session`. A part the Host made a moment ago, or any part
// before the first list arrives, waits for the list; a newer navigation — through here or
// elsewhere — drops the wait.

/** The slice of a client list store the opener reads. */
export interface ListedList {
	getSnapshot(): { byId?: Record<string, unknown> | undefined };
	subscribe(listener: () => void): () => void;
}

export interface ListedOpenerOptions {
	list: ListedList;
	open(target: string): void;
	refresh?(): void;
	current?(): string | undefined;
}

export function listedOpener({ list, open, refresh, current }: ListedOpenerOptions): (target: string) => void {
	let drop = (): void => {};
	return (target) => {
		drop();
		drop = () => {};
		const listed = (): boolean => list.getSnapshot().byId?.[target] !== undefined;
		if (listed()) {
			open(target);
			return;
		}
		const from = current?.();
		const off = list.subscribe(() => {
			if (current?.() !== from) {
				off();
				drop = () => {};
				return;
			}
			if (!listed()) return;
			off();
			drop = () => {};
			open(target);
		});
		drop = off;
		refresh?.();
	};
}
