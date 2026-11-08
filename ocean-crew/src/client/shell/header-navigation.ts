// The conversation header's navigation face: the shell registers that cell itself with a
// store and an inject, and a plain slot registration would replace it without its view
// selection. This follows the shell's registration and re-registers over it.

import { freePriority, type PriorityEntry } from "./surface.ts";

type SlotEntry = Record<string, any>;
type NavigationFace = () => Record<string, any>;

const navigationEntry = (entries: readonly SlotEntry[]): SlotEntry | undefined =>
	entries.find((entry) => entry.store && typeof entry.inject === "function");

// Reuse the replaced header's public navigation face and store: activating a
// Conversation target alone does not change its persisted View selection.
export function headerNavigation(entries: readonly SlotEntry[], face: NavigationFace): SlotEntry {
	const source = navigationEntry(entries);
	return {
		...(source ? { store: source.store } : {}),
		inject: (...args: unknown[]) => {
			const navigation = source?.inject(...args) ?? {};
			const own = face();
			return { ...navigation, ...own, hooks: { ...navigation.hooks, ...own.hooks } };
		},
	};
}

export interface HeaderSlots {
	entries(name: string): SlotEntry[];
	register(entry: Record<string, any>, component: unknown): () => void;
	subscribe(name: string, listener: () => void): () => void;
}

export function installHeaderNavigation(
	slots: HeaderSlots,
	face: NavigationFace,
	component: unknown,
	priority: number,
): () => void {
	const name = "conversation.session.header";
	let source: SlotEntry | undefined;
	let dispose: (() => void) | undefined;
	const refresh = (): void => {
		const entries = slots.entries(name).filter((entry) => entry.component !== component);
		const next = navigationEntry(entries);
		if (dispose && source === next) return;
		dispose?.();
		source = next;
		dispose = slots.register(
			{
				name,
				priority: freePriority(entries as unknown as PriorityEntry[], { priority }),
				...headerNavigation(entries, face),
			},
			component,
		);
	};
	// Slot declaration precedes the owner's registration. Follow that arrival,
	// and later host reloads, without treating our own registration as a source.
	const unsubscribe = slots.subscribe(name, refresh);
	try {
		refresh();
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return () => {
		unsubscribe();
		dispose?.();
	};
}
