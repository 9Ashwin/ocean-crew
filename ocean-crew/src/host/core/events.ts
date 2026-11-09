// DSH dispatches its agent- and session-scoped events through a context filter: a listener
// registered on the plugin's own context is filtered out unless it is global. DSH's own
// packages register these names with `{ global: true }`; one wrapper keeps that in one
// place so a new listener cannot silently receive nothing.
import type { DshContext } from "./runtime.ts";

/** The DSH events whose dispatch carries a scope filter. */
export const SCOPED_EVENTS = new Set([
	"session/created",
	"session/disposed",
	"session/event",
	"agent/created",
	"agent/disposed",
	"agent/status",
	"agent/assistant-stream",
	"agent/inbox/claimed",
	"agent/inbox/discarded",
	"llm/stream",
	"tools/result",
]);

/** Listen for one event regardless of the context filter its dispatch carries. */
export const listenGlobal = (ctx: DshContext, name: string, listener: (...args: any[]) => unknown): any =>
	(ctx as any).on(name, listener, { global: true });
