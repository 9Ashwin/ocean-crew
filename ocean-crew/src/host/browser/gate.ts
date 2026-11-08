// The per-call store the browser tools run inside. mount.ts puts the call's authorize
// callback in it and session.ts reads it back, so an action can only run inside the
// tool call that asked for it.
import { AsyncLocalStorage } from "node:async_hooks";

/** One state-changing action a page is about to submit. */
export interface BrowserAction {
	kind: string;
	label: string;
	origin?: string;
	host?: string;
}

export type BrowserGate = (action: BrowserAction) => void | Promise<void>;

export const gateScope = new AsyncLocalStorage<BrowserGate | undefined>();
