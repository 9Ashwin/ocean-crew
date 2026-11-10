// Temporary workers: a child Session started through DSH's own delegation service, never on the
// roster, whose result comes back as a tool answer. The policy this module owns is the cap, the
// timeout, and telling the truth about a worker that did not survive.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "../src/host/core/runtime.ts";
import { WORKERS_PER_BOT, workersOf } from "../src/host/work/workers.ts";

function setup({ providers = ["spawn"], failDispose = false } = {}) {
	const started: any[] = [];
	const disposed: string[] = [];
	let settle: (value: any) => void = () => {};
	const service = {
		providers: () => providers,
		startActivation: async (spec: any) => {
			started.push(spec);
			const childId = `child-${started.length}`;
			return {
				childId,
				dispose: async () => {
					if (failDispose) throw new Error("cannot stop");
					disposed.push(childId);
				},
				result: new Promise((resolve) => {
					settle = resolve;
				}),
			};
		},
	};
	const rt: any = {
		ctx: { get: (name: string) => (name === "subagents" ? service : undefined) },
		warn: () => {},
	} as unknown as Runtime;
	return { rt, workers: workersOf(rt as Runtime), started, disposed, settle: (value: any) => settle(value) };
}

const ask = { parentAgent: {}, parentBotId: "dev", parentSession: "s-dev", task: "read the docs", label: "docs" };

test("a worker is a child of the Bot, started through the delegation service with caller delivery", async () => {
	const { workers, started } = setup();
	const run = await workers.start(ask);
	assert.equal(run.childId, "child-1");
	assert.equal(started[0].provider, "spawn");
	assert.equal(started[0].delivery, "caller", "the Bot decides what to tell the user");
	assert.equal(started[0].request.parent, ask.parentAgent);
	assert.deepEqual(started[0].request.prompt, [{ type: "text", text: "read the docs" }]);
	const view = workers.view();
	assert.equal(view.length, 1);
	assert.equal(view[0].status, "running");
	assert.equal(view[0].parent, "dev");
});

test("a finished worker's answer is its result text, and it is no longer running", async () => {
	const { workers, settle } = setup();
	const run = await workers.start(ask);
	settle({ output: [{ type: "text", text: "three pages read" }], stopReason: "completed" });
	assert.equal(await run.result, "three pages read");
	const view = workers.view();
	assert.equal(view[0].status, "done");
	assert.equal(view[0].output, "three pages read");
});

test("a worker that errors says so instead of returning an empty answer", async () => {
	const { workers, settle } = setup();
	const run = await workers.start(ask);
	settle({ output: [], stopReason: "error" });
	assert.equal(await run.result, "");
	assert.equal(workers.view()[0].status, "failed");
	assert.equal(workers.view()[0].reason, "it ended with an error");
});

test("the cap holds, so one Bot cannot flood the host", async () => {
	const { workers } = setup();
	for (let index = 0; index < WORKERS_PER_BOT; index += 1) await workers.start(ask);
	await assert.rejects(() => workers.start(ask), /already has 3 workers running/);
});

test("stopping a worker disposes it, and a stop that fails is reported", async () => {
	const { workers, disposed } = setup();
	const run = await workers.start(ask);
	assert.equal(await workers.stop(run.childId), true);
	assert.deepEqual(disposed, [run.childId]);
	assert.equal(workers.view()[0].status, "stopped");
	assert.equal(await workers.stopAll(), 0, "nothing left to stop");
});

test("without the delegation service the caller is told, not silently run inline", async () => {
	const rt: any = { ctx: { get: () => undefined }, warn: () => {} } as unknown as Runtime;
	const workers = workersOf(rt);
	await assert.rejects(() => workers.start(ask), /Delegation is not available/);
});
