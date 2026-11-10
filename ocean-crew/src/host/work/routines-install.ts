// Wiring for event-triggered routines: the Bot can create and remove them, an incoming IM message
// starts the ones that match, and the turn it opens is framed as a scheduled task so the run
// records and the "[PASS]" silence rule from the schedule work apply without a second mechanism.
import type { Runtime } from "../core/runtime.ts";
import { fireRoutine, routinesOf } from "./routines.ts";

export function install(rt: Runtime): void {
	const routines = routinesOf(rt);
	Object.assign(rt, {
		routines,
		routinesView: () => routines.list(),
		// The IM inbound path calls this for every message it accepted from the user.
		routineMessages: (text: string, chatKey?: string) => routines.matchesMessage(text, chatKey),
		fireRoutine: (routine: any, match: any) => fireRoutine(rt, routine, match),
	});
}
