// Request identity behaviour: a named request is sent once, a repeat gives the first
// receipt back, and an outcome that is not known is never sent again. The cases port the
// they drive the module's
// own API, because `message_bot` (which consumes it) belongs to the tools module.
import assert from "node:assert/strict";
import fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	install as installRequests,
	NAME_MAX,
	type RequestAdmission,
	type RequestIdentity,
} from "../src/host/chat/requests.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { install as installStore } from "../src/host/core/store.ts";

interface TestContext {
	after(fn: () => Promise<void> | void): void;
}

interface TestHost {
	rt: Runtime & Record<string, any>;
	home: string;
	statePath: string;
	warnings: unknown[][];
	dispose(): Promise<void>;
}

// The request every case in this file names, unless it is testing a different content.
const payload = { to: "b", message: "do the thing" };

const tempHome = (t: TestContext): string => {
	const home = fs.mkdtempSync(join(tmpdir(), "ocean-crew-requests-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
};

// The plugin in a home of its own, with the real store under it: its saves, its lock and
// its read-only state are what the admission receipts rely on. A second boot over the
// same home is a restart.
async function boot(home: string, seeded?: unknown): Promise<TestHost> {
	const statePath = join(home, "state.json");
	if (seeded !== undefined) fs.writeFileSync(statePath, JSON.stringify(seeded));
	const warnings: unknown[][] = [];
	const disposers: Array<() => unknown> = [];
	const ctx = {
		logger: { warn: (...args: unknown[]) => warnings.push(args) },
		effect(execute: () => unknown) {
			const dispose = execute();
			if (typeof dispose === "function") disposers.push(dispose as () => unknown);
		},
	};
	const rt = {
		ctx,
		home,
		statePath,
		warn: (...args: unknown[]) => warnings.push(args),
	} as unknown as Runtime & Record<string, any>;
	installStore(rt);
	installRequests(rt);
	await rt.load();
	let disposed = false;
	const host: TestHost = {
		rt,
		home,
		statePath,
		warnings,
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const dispose of disposers.splice(0).reverse()) await dispose();
		},
	};
	return host;
}

const saved = (host: TestHost): any => JSON.parse(fs.readFileSync(host.statePath, "utf8"));

const savedRequests = (host: TestHost): Record<string, any> => saved(host).requests ?? {};

const identity = (
	host: TestHost,
	name: string,
	request: unknown = payload,
	extra: { caller?: string; context?: string } = {},
): RequestIdentity =>
	host.rt.requestIdentity({ caller: "a", context: "chat", name, payload: request, ...extra }) as RequestIdentity;

const admit = (
	host: TestHost,
	request: RequestIdentity,
	work: () => Promise<unknown>,
): Promise<RequestAdmission | undefined> =>
	host.rt.admitRequest(request, work) as Promise<RequestAdmission | undefined>;

const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the team file");
		await delay(5);
	}
};

test("a request is named by its caller, its conversation and its name, and fingerprinted by what it asks", async (t) => {
	const host = await boot(tempHome(t));
	const first = identity(host, "r-1");
	const again = identity(host, "r-1");
	assert.equal(first.key, "a\u0000chat\u0000r-1");
	assert.equal(again.print, first.print);
	// The same name with other content is another request, and the name is still taken.
	const other = identity(host, "r-1", { to: "b", message: "do another thing" });
	assert.equal(other.key, first.key);
	assert.notEqual(other.print, first.print);
	// The same name from another caller or another conversation is another request.
	assert.notEqual(identity(host, "r-1", payload, { caller: "b" }).key, first.key);
	assert.notEqual(identity(host, "r-1", payload, { context: "room:r1" }).key, first.key);
	assert.equal(NAME_MAX, 200);
});

test("the same request is sent once; a repeat gives the first receipt back", async (t) => {
	const host = await boot(tempHome(t));
	let sent = 0;
	const request = identity(host, "r-1");
	assert.equal(await host.rt.knownRequest(request), undefined);
	assert.deepEqual(
		await admit(host, request, async () => {
			sent += 1;
			return "Delivered to Writer.";
		}),
		{ status: "sent", receipt: "Delivered to Writer." },
	);
	// A repeat, even with a freshly made identity, never reaches the work.
	const again = await admit(host, identity(host, "r-1"), async () => {
		sent += 1;
		return "a second delivery";
	});
	assert.deepEqual(again, { status: "replay", receipt: "Delivered to Writer." });
	assert.equal(sent, 1);
	assert.deepEqual(await host.rt.knownRequest(identity(host, "r-1")), {
		status: "replay",
		receipt: "Delivered to Writer.",
	});
	// The receipt is kept in the team file, under the caller's own name.
	const records = Object.values(savedRequests(host));
	assert.equal(records.length, 1);
	assert.equal(records[0].outcome, "delivered");
	assert.equal(records[0].receipt, "Delivered to Writer.");
	assert.equal(records[0].key, undefined);
	assert.equal(typeof records[0].run, "string");
	assert.equal(typeof records[0].at, "number");
});

test("the same name with other content is refused, and nothing goes out", async (t) => {
	const host = await boot(tempHome(t));
	let sent = 0;
	await admit(host, identity(host, "r-1"), async () => {
		sent += 1;
		return "Delivered.";
	});
	const conflict = await admit(host, identity(host, "r-1", { to: "b", message: "do another thing" }), async () => {
		sent += 1;
		return "Delivered.";
	});
	assert.deepEqual(conflict, { status: "conflict" });
	assert.equal(sent, 1);
	// `knownRequest` reports the conflict before the caller even tries to admit it.
	assert.deepEqual(await host.rt.knownRequest(identity(host, "r-1", { to: "b", message: "do another thing" })), {
		status: "conflict",
	});
});

test("two callers, or two conversations, may use the same request name", async (t) => {
	const host = await boot(tempHome(t));
	let sent = 0;
	const work = async (): Promise<string> => {
		sent += 1;
		return `Delivered ${sent}.`;
	};
	assert.deepEqual(await admit(host, identity(host, "r-1"), work), { status: "sent", receipt: "Delivered 1." });
	assert.deepEqual(await admit(host, identity(host, "r-1", payload, { caller: "c" }), work), {
		status: "sent",
		receipt: "Delivered 2.",
	});
	assert.deepEqual(await admit(host, identity(host, "r-1", payload, { context: "room:r1" }), work), {
		status: "sent",
		receipt: "Delivered 3.",
	});
	assert.equal(sent, 3);
});

test("two calls at once with the same name admit it once", async (t) => {
	const host = await boot(tempHome(t));
	let sent = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const work = async (): Promise<string> => {
		sent += 1;
		await gate;
		return "Delivered to Writer.";
	};
	const first = admit(host, identity(host, "r-1"), work);
	const second = admit(host, identity(host, "r-1"), async () => {
		sent += 1;
		return "a second delivery";
	});
	// The first call writes its receipt before the message goes out; let it finish then.
	await waitFor(() => Object.keys(savedRequests(host)).length === 1);
	release();
	assert.deepEqual(await first, { status: "sent", receipt: "Delivered to Writer." });
	assert.deepEqual(await second, { status: "replay", receipt: "Delivered to Writer." });
	assert.equal(sent, 1);
});

test("a repeat after a restart gives the receipt back and sends nothing", async (t) => {
	const home = tempHome(t);
	const first = await boot(home);
	const receipt = await admit(first, identity(first, "r-1"), async () => "Delivered to Writer.");
	assert.deepEqual(receipt, { status: "sent", receipt: "Delivered to Writer." });
	await first.dispose();
	const again = await boot(home);
	assert.deepEqual(await again.rt.knownRequest(identity(again, "r-1")), {
		status: "replay",
		receipt: "Delivered to Writer.",
	});
	let sent = 0;
	assert.deepEqual(
		await admit(again, identity(again, "r-1"), async () => {
			sent += 1;
			return "a second delivery";
		}),
		{ status: "replay", receipt: "Delivered to Writer." },
	);
	assert.equal(sent, 0);
});

test("a request that was in the air when the host stopped is not sent again", async (t) => {
	const home = tempHome(t);
	const first = await boot(home);
	const request = identity(first, "r-1");
	const inFlight = admit(first, request, () => new Promise(() => {}));
	inFlight.catch(() => {});
	// The receipt of an admission is written before the message goes out.
	await waitFor(() => savedRequests(first)[request.key]?.outcome === "pending");
	assert.equal(first.rt.state.requests[request.key].outcome, "pending");
	await first.dispose();
	// Another run sees a pending receipt: the outcome is not known, so it is not sent.
	const again = await boot(home);
	assert.deepEqual(await again.rt.knownRequest(identity(again, "r-1")), { status: "uncertain" });
	let sent = 0;
	assert.deepEqual(
		await admit(again, identity(again, "r-1"), async () => {
			sent += 1;
			return "a second delivery";
		}),
		{ status: "uncertain" },
	);
	assert.equal(sent, 0);
});

test("a name whose receipt is no longer kept is not used again", async (t) => {
	const home = tempHome(t);
	const first = await boot(home);
	await admit(first, identity(first, "r-1"), async () => "Delivered to Writer.");
	await first.dispose();
	// The receipt falls out of what is kept; the name itself stays taken.
	const savedState = saved(first);
	for (const record of Object.values(savedState.requests ?? {}) as Array<{ receipt?: unknown }>)
		record.receipt = undefined;
	fs.writeFileSync(first.statePath, JSON.stringify(savedState));
	const again = await boot(home);
	let sent = 0;
	assert.deepEqual(
		await admit(again, identity(again, "r-1"), async () => {
			sent += 1;
			return "a second delivery";
		}),
		{ status: "expired" },
	);
	assert.equal(sent, 0);
});

test("a host that cannot save the team refuses a named request, and admits it once it can", async (t) => {
	const host = await boot(tempHome(t));
	// Another dsh holds the team: this window may read it but not record new admissions.
	fs.writeFileSync(
		join(host.home, "state.lock"),
		JSON.stringify({ pid: process.ppid, host: hostname(), token: "other-writer", since: Date.now() }),
	);
	await host.rt.refresh();
	assert.match(String(host.rt.readOnly()), /another dsh/);
	let sent = 0;
	assert.deepEqual(
		await admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "Delivered.";
		}),
		{ status: "readonly" },
	);
	assert.equal(sent, 0);
	assert.equal(Object.keys(host.rt.state.requests).length, 0);
	assert.deepEqual(savedRequests(host), {});
	// The other dsh closes; this one takes the team over and the same name may be sent.
	fs.rmSync(join(host.home, "state.lock"));
	await host.rt.refresh();
	assert.equal(host.rt.readOnly(), undefined);
	assert.deepEqual(
		await admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "Delivered.";
		}),
		{ status: "sent", receipt: "Delivered." },
	);
	assert.equal(sent, 1);
});

test("a receipt that cannot be saved stops the request before it is sent", async (t) => {
	const host = await boot(tempHome(t));
	const store = host.rt.save;
	let sent = 0;
	host.rt.save = async () => {
		throw new Error("the disk is full");
	};
	await assert.rejects(
		admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "Delivered.";
		}),
		/the disk is full/,
	);
	assert.equal(sent, 0);
	assert.equal(Object.keys(host.rt.state.requests).length, 0);
	assert.ok(host.warnings.some((args) => /receipt of the request was not saved/.test(String(args))));
	assert.deepEqual(savedRequests(host), {});
	// Nothing went out, so the name is free again.
	host.rt.save = store;
	assert.deepEqual(
		await admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "Delivered.";
		}),
		{ status: "sent", receipt: "Delivered." },
	);
	assert.equal(sent, 1);
});

test("a request that went nowhere before sending is free to be admitted again", async (t) => {
	const host = await boot(tempHome(t));
	let sent = 0;
	const request = identity(host, "r-1");
	const out = await admit(host, request, async () => {
		sent += 1;
		request.unsent = true;
		return "The message was too long to send.";
	});
	assert.deepEqual(out, { status: "sent", receipt: "The message was too long to send." });
	// The pending record is gone, from memory and from the team file.
	assert.equal(Object.keys(host.rt.state.requests).length, 0);
	assert.deepEqual(savedRequests(host), {});
	// With the name free, the same request may be admitted and sent for real.
	assert.deepEqual(
		await admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "Delivered.";
		}),
		{ status: "sent", receipt: "Delivered." },
	);
	assert.equal(sent, 2);
});

test("a request whose delivery failed is not sent again", async (t) => {
	const host = await boot(tempHome(t));
	let sent = 0;
	const request = identity(host, "r-1");
	await assert.rejects(
		admit(host, request, async () => {
			sent += 1;
			throw new Error("dsh is down");
		}),
		/dsh is down/,
	);
	assert.equal(sent, 1);
	// The message may have gone out, so the outcome is not known and it is not retried.
	assert.equal(host.rt.state.requests[request.key].outcome, "uncertain");
	assert.deepEqual(
		await admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "a second delivery";
		}),
		{ status: "uncertain" },
	);
	assert.equal(sent, 1);
	assert.equal(savedRequests(host)[request.key].outcome, "uncertain");
});

test("a receipt whose delivery save is skipped stays pending for the next host", async (t) => {
	const home = tempHome(t);
	const host = await boot(home);
	const store = host.rt.save;
	let calls = 0;
	host.rt.save = async (options?: { required?: boolean }) => {
		calls += 1;
		// The pending receipt is saved; the receipt of a delivery is best effort.
		if (calls === 2) throw new Error("the write is skipped during shutdown");
		return store(options);
	};
	assert.deepEqual(await admit(host, identity(host, "r-1"), async () => "Delivered."), {
		status: "sent",
		receipt: "Delivered.",
	});
	host.rt.save = store;
	await host.dispose();
	// The next host finds the admission still pending: the outcome is not known.
	const again = await boot(home);
	assert.equal(savedRequests(again)[identity(again, "r-1").key].outcome, "pending");
	assert.deepEqual(await again.rt.knownRequest(identity(again, "r-1")), { status: "uncertain" });
});

test("a request whose unsent note cannot be saved becomes uncertain, not free", async (t) => {
	const host = await boot(tempHome(t));
	const store = host.rt.save;
	let calls = 0;
	host.rt.save = async (options?: { required?: boolean }) => {
		calls += 1;
		// The pending receipt is saved; removing it fails.
		if (calls === 2) throw new Error("the disk is full");
		return store(options);
	};
	const request = identity(host, "r-1");
	const out = await admit(host, request, async () => {
		request.unsent = true;
		return "The message was too long to send.";
	});
	assert.deepEqual(out, { status: "sent", receipt: "The message was too long to send." });
	assert.equal(host.rt.state.requests[request.key].outcome, "uncertain");
	assert.ok(host.warnings.some((args) => /removal of the request receipt was not saved/.test(String(args))));
	host.rt.save = store;
	let sent = 0;
	assert.deepEqual(
		await admit(host, identity(host, "r-1"), async () => {
			sent += 1;
			return "a second delivery";
		}),
		{ status: "uncertain" },
	);
	assert.equal(sent, 0);
});

test("old identities survive age and receipt volume without permitting another delivery", async (t) => {
	const host = await boot(tempHome(t));
	const original = identity(host, "original", { message: "do it" });
	await admit(host, original, async () => "first receipt");
	const records = host.rt.state.requests as unknown as Record<string, any>;
	const record = records[original.key];
	assert.ok(record !== undefined);
	record.at = 0;
	// A big team file: many other receipts, none of them this request.
	for (let i = 0; i < 2001; i += 1)
		records[`other-${i}`] = { at: i, outcome: "delivered", fingerprint: "x", receipt: "kept" };
	const fresh = identity(host, "fresh", { message: "next" });
	await admit(host, fresh, async () => "next receipt");
	let sent = 0;
	assert.deepEqual(
		await admit(host, identity(host, "original", { message: "do it" }), async () => {
			sent += 1;
			return "duplicate delivery";
		}),
		{ status: "replay", receipt: "first receipt" },
	);
	assert.equal(sent, 0);
});
