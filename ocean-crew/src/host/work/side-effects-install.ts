// Wiring for the side-effect gate: one gate per host, consulted from DSH's own tool pipeline so
// a call that sends, deletes or pays becomes the approval card the user already knows. The
// decision is an `ask`, which DSH resolves through its approval seam — this module draws no card
// of its own. Whether the answer was a grant is read from what happens next: an allowed call
// dispatches, a refused one does not.
import { listenGlobal } from "../core/events.ts";
import type { Runtime } from "../core/runtime.ts";
import { sideEffectGate } from "./side-effects-gate.ts";
import { fenceUntrusted, isUntrustedTool } from "./untrusted.ts";

export function install(rt: Runtime): void {
	const gate = sideEffectGate(rt);
	Object.assign(rt, {
		sideEffectGate: gate,
		sideEffectGrants: () => gate.grants(),
	});

	// Before the tool runs: a strict call asks; a call the user already declined is refused with
	// the reason the model reads, so the refusal is neither silent nor repeatable.
	rt.ctx.on("tools/pre-execute", async (exec: any, next: () => Promise<any>): Promise<any> => {
		const decision = await next();
		if (decision.kind !== "allow") return decision;
		if (!rt.isBotSession(exec.agent?.id)) return decision;
		const blocked = gate.blockedBy(exec);
		if (blocked !== undefined) return { kind: "deny", reason: blocked };
		if (!gate.needsAnswer(exec)) return decision;
		gate.markAsked(exec);
		return { kind: "ask", reason: gate.questionFor(exec) };
	});

	// A call that reaches dispatch is one the user allowed: that is the only grant signal there
	// is, and it is what makes a later refusal in the same turn terminable.
	rt.ctx.on("tools/execute", async (exec: any, next: () => Promise<any>): Promise<any> => {
		if (exec.agent !== undefined && rt.isBotSession(exec.agent?.id)) gate.markDispatched(exec);
		return next();
	});

	// Outside content is data: the result is fenced with a nonce it cannot forge, and the turn is
	// marked so its own sends show a card even when the user granted that tool.
	rt.ctx.on("tools/post-execute", async (exec: any, result: any, next: () => Promise<any>): Promise<any> => {
		const decision = await next();
		if (decision.kind !== "accept") return decision;
		const sessionId = exec.agent?.session?.id;
		if (typeof sessionId !== "string" || !rt.isBotSession(exec.agent?.id)) return decision;
		if (!isUntrustedTool(String(exec.name ?? ""))) return decision;
		const blocks: any[] = Array.isArray(decision.content) ? decision.content : [];
		let fenced = false;
		const next_ = blocks.map((block: any) => {
			if (block?.type !== "text" || typeof block.text !== "string") return block;
			fenced = true;
			return { ...block, text: fenceUntrusted(block.text) };
		});
		if (!fenced) return decision;
		gate.markUntrusted(sessionId);
		return { ...decision, content: next_ };
	});

	// A finished turn closes the cards it left open: they can no longer be answered, so the next
	// attempt in a later turn asks again instead of reading an old unanswered card as a refusal.
	listenGlobal(rt.ctx, "session/event", (session: any, event: any) => {
		if (event?.type !== "turn/end") return;
		const sessionId = session?.id;
		if (typeof sessionId === "string") gate.expireTurn(sessionId, undefined);
	});

	// The settings page reads and edits the standing grants through the channel.
	rt.sideEffectEndpoint = async (endpoint: string, body: any): Promise<any> => {
		if (endpoint === "side-effect-grants") return { grants: gate.grants() };
		if (endpoint === "side-effect-grant") {
			await gate.grant(String(body?.tool ?? ""), typeof body?.target === "string" ? body.target : undefined);
			return { grants: gate.grants() };
		}
		if (endpoint === "side-effect-revoke") {
			await gate.revoke(String(body?.tool ?? ""), typeof body?.target === "string" ? body.target : undefined);
			return { grants: gate.grants() };
		}
		throw Object.assign(new Error(`Unknown endpoint ${endpoint}`), { code: "bot/not-found" });
	};
}
