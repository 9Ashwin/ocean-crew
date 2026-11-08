// The mailbox connector: presets and secret names, the IMAP/SMTP transport's retire
// semantics, the mail_* tools and cards, account add/remove rules, and the Gmail REST
// backend.
// through `deps.modules`); no network leaves the test process.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { install as installConnectors } from "../src/host/connectors/index.ts";
import { install as installMail } from "../src/host/connectors/mail/index.ts";
import { IMAP_ID, mailSecretName, presetOf } from "../src/host/connectors/mail/presets.ts";
import { connectGmail, connectImap, imapOptions } from "../src/host/connectors/mail/transport.ts";
import type { Runtime } from "../src/host/core/runtime.ts";
import { emptyTeam } from "../src/shared/state.ts";
import { type FakeContext, fakeContext } from "./fake-ctx.ts";

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const addressAt = (domain: string): string => `me@${domain}`;

interface FakeSession {
	calls: any[][];
	kind: string;
	usable: boolean;
	search(args: any): Promise<any[]>;
	read(args: any): Promise<{ messages: any[] }>;
	draft(args: any): Promise<{ folder: string }>;
	send(args: any): Promise<{ messageId: string }>;
	update(args: any): Promise<void>;
	saveAttachment(args: any): Promise<{ path: string }>;
	close(): Promise<void>;
}

const fakeSession = (): FakeSession => {
	const calls: any[][] = [];
	return {
		calls,
		kind: "imap",
		usable: true,
		async search(args) {
			calls.push(["search", args]);
			return [];
		},
		async read(args) {
			calls.push(["read", args]);
			return { messages: [] };
		},
		async draft(args) {
			calls.push(["draft", args]);
			return { folder: "Drafts" };
		},
		async send(args) {
			calls.push(["send", args]);
			return { messageId: "<m@x>" };
		},
		async update(args) {
			calls.push(["update", args]);
		},
		async saveAttachment(args) {
			calls.push(["saveAttachment", args]);
			return { path: args.to };
		},
		async close() {
			calls.push(["close"]);
		},
	};
};

interface Harness {
	ctx: FakeContext;
	rt: Runtime & Record<string, any>;
	state: Record<string, any>;
	secrets: Map<string, string>;
	warnings: unknown[][];
}

function runtime(
	t: TestContext,
	options: {
		connect?: (account: any, deps: any) => Promise<any>;
		fetch?: (url: string) => Promise<Response>;
		saved?: Record<string, unknown>;
	} = {},
): Harness {
	const ctx = fakeContext();
	const state = emptyTeam() as Record<string, any>;
	state.bots.m1 = { id: "m1", sessionId: "m1", name: "Chief", role: "Chief of Staff", instructions: "", createdAt: 1 };
	state.connectors = options.saved ?? {};
	const secrets = new Map<string, string>();
	const warnings: unknown[][] = [];
	const rt = {
		ctx,
		state,
		config: { github: false, mail: { connect: options.connect, fetch: options.fetch } },
		warn: (...args: unknown[]) => warnings.push(args),
		load: async () => {},
		save: async () => {},
		readOnly: () => undefined,
		botOf: (id?: string) => (id === undefined ? undefined : state.bots[id]),
		selfOf: (id?: string) => (id === undefined ? undefined : id === "m1" ? "m1" : undefined),
		chatOwners: new Map([["m1", "m1"]]),
		groupOwners: new Map(),
		teamTools: [],
		loadSecrets: async () => {},
		secretValue: (name: string) => secrets.get(name),
		secretEndpoint: async (endpoint: string, body: any) => {
			if (endpoint === "secret-set") secrets.set(body.name, body.value);
			else if (endpoint === "secret-delete") secrets.delete(body.name);
		},
		deliver: async () => {},
		reapplyToolMasks: () => {},
		authChanged: () => {},
		sessionFolder: () => undefined,
		addTeamTool: (tool: any) => {
			if (!(rt as any).teamTools.some((entry: any) => entry.name === tool.name)) (rt as any).teamTools.push(tool);
		},
		removeTeamTool: (name: string) => {
			const list = (rt as any).teamTools as any[];
			const at = list.findIndex((entry) => entry.name === name);
			if (at !== -1) list.splice(at, 1);
		},
	} as unknown as Runtime & Record<string, any>;
	installConnectors(rt);
	t.after(async () => {
		await ctx.dispose();
	});
	return { ctx, rt, state, secrets, warnings };
}

const tool = (rt: Runtime & Record<string, any>, name: string): any =>
	(rt.teamTools as any[]).find((entry) => entry.name === name);

test("presets and secret names follow the address domain", () => {
	assert.equal(presetOf(addressAt("qq.com"))?.id, "qq");
	// Written in parts so the fixture is not a real address even to a scanner.
	assert.equal(presetOf(["ME", "163.com"].join("@"))?.id, "163");
	assert.equal(presetOf(addressAt("gmail.com"))?.id, "gmail");
	assert.equal(presetOf(addressAt("icloud.com"))?.id, "icloud");
	assert.equal(presetOf(addressAt("other.example")), undefined);
	assert.equal(mailSecretName(addressAt("qq.com"), "PASSWORD"), "MAIL_ME_QQ_COM_PASSWORD");
	const long = mailSecretName(`${"a".repeat(60)}@example.com`, "TOKEN");
	assert.ok(long.length <= 64, String(long.length));
	assert.equal(addressAt("qq.com"), ["me", "qq.com"].join("@"));
});

test("163 and 126 presets send the IMAP ID identity", () => {
	for (const domain of ["163.com", "126.com"]) {
		const options = imapOptions(
			{ id: "x", address: addressAt(domain), imap: { host: `imap.${domain}`, port: 993, secure: true } },
			{ password: "x" },
		);
		assert.deepEqual(options.id, IMAP_ID);
		assert.equal((options.id as { vendor: string }).vendor, "Ocean Crew");
	}
});

// --- transport retire semantics -------------------------------------------

const transport = ({
	connect = async () => {},
	verify = async () => {},
}: {
	connect?: () => Promise<void>;
	verify?: () => Promise<void>;
} = {}) => {
	let imap: any;
	class ImapFlow extends EventEmitter {
		usable = false;
		closed = false;
		constructor() {
			super();
			imap = this;
		}
		async connect() {
			await connect();
			this.usable = true;
		}
		close() {
			this.closed = true;
			this.usable = false;
			this.emit("close");
		}
		async logout() {
			this.close();
		}
	}
	const smtp = Object.assign(new EventEmitter(), {
		verify,
		sendMail: async () => ({ messageId: "<m@x>" }),
		closed: false,
		close: () => {
			smtp.closed = true;
		},
	});
	return {
		modules: {
			ImapFlow: ImapFlow as any,
			nodemailer: { createTransport: () => smtp },
			mailparser: { simpleParser: async () => ({}) },
		},
		get imap() {
			return imap;
		},
		smtp,
	};
};

const account = {
	id: "a",
	address: "test@invalid.test",
	imap: { host: "127.0.0.1", port: 1 },
	smtp: { host: "127.0.0.1", port: 1 },
};

test("idle IMAP errors and close retire the session without escaping", async () => {
	const fake = transport();
	let gone = 0;
	const session = await connectImap(account, {
		modules: fake.modules,
		onGone: () => {
			gone += 1;
		},
	});
	assert.equal(session.usable, true);
	assert.doesNotThrow(() => fake.imap.emit("error", new Error("Socket timeout")));
	assert.equal(session.usable, false);
	fake.imap.emit("close");
	assert.equal(gone, 1);
	assert.equal(fake.smtp.closed, true);
});

test("SMTP errors cannot escape and close both transports", async () => {
	const fake = transport();
	const session = await connectImap(account, { modules: fake.modules });
	assert.doesNotThrow(() => fake.smtp.emit("error", new Error("SMTP dropped")));
	assert.equal(session.usable, false);
	assert.equal(fake.imap.closed, true);
	assert.equal(fake.smtp.closed, true);
});

test("IMAP connect and SMTP verify start together", async () => {
	const imapGate = Promise.withResolvers<void>();
	const smtpStarted = Promise.withResolvers<void>();
	const fake = transport({ connect: () => imapGate.promise, verify: async () => smtpStarted.resolve() });
	const pending = connectImap(account, { modules: fake.modules });
	try {
		await Promise.race([
			smtpStarted.promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP waited for IMAP")), 100)),
		]);
	} finally {
		imapGate.resolve();
		await (await pending).close?.();
	}
});

for (const side of ["IMAP", "SMTP"]) {
	test(`${side} verification failure closes both transports, including a late connection`, async () => {
		const gate = Promise.withResolvers<void>();
		const fail = async (): Promise<void> => {
			throw new Error(`${side} refused`);
		};
		const fake = transport({
			connect: side === "IMAP" ? fail : () => gate.promise,
			verify: side === "SMTP" ? fail : () => gate.promise,
		});
		const pending = connectImap(account, { modules: fake.modules });
		try {
			await assert.rejects(
				Promise.race([
					pending,
					new Promise((_, reject) => setTimeout(() => reject(new Error("verification did not reject")), 100)),
				]),
				new RegExp(`${side} refused`),
			);
		} finally {
			gate.resolve();
			await pending.catch(() => undefined);
		}
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fake.imap.closed, true);
		assert.equal(fake.imap.usable, false);
		assert.equal(fake.smtp.closed, true);
	});
}

// --- the host's lazy module fallback --------------------------------------

// The packages a connection without injected modules loads, as the host loader sees
// them: imapflow and mailparser expose members directly, nodemailer through `default`.
const loadedPackages = (fake: ReturnType<typeof transport>, calls: string[]): ((specifier: string) => Promise<any>) => {
	return async (specifier: string) => {
		calls.push(specifier);
		if (specifier === "imapflow") return { ImapFlow: fake.modules.ImapFlow };
		if (specifier === "nodemailer") return { default: fake.modules.nodemailer };
		if (specifier === "mailparser") return { simpleParser: fake.modules.mailparser.simpleParser };
		throw new Error(`unexpected package ${specifier}`);
	};
};

test("a connection without injected modules loads imapflow, nodemailer and mailparser", async () => {
	const fake = transport();
	const calls: string[] = [];
	const session = await connectImap(account, { load: loadedPackages(fake, calls) });
	assert.deepEqual(calls, ["imapflow", "nodemailer", "mailparser"]);
	assert.equal(session.usable, true);
	await session.close?.();
});

test("injected modules win and nothing is loaded", async () => {
	const fake = transport();
	const calls: string[] = [];
	const session = await connectImap(account, {
		modules: fake.modules,
		load: loadedPackages(fake, calls),
	});
	assert.deepEqual(calls, []);
	assert.equal(session.usable, true);
	await session.close?.();
});

test("a caller that injects one module still has the others loaded", async () => {
	const fake = transport();
	const calls: string[] = [];
	const session = await connectImap(account, {
		modules: { ImapFlow: fake.modules.ImapFlow },
		load: loadedPackages(fake, calls),
	});
	assert.deepEqual(calls, ["nodemailer", "mailparser"]);
	assert.equal(session.usable, true);
	await session.close?.();
});

test("a missing mail package is one clear error, not a silent no-op", async () => {
	const refused = async (specifier: string): Promise<any> => {
		throw new Error(`Cannot find package '${specifier}'`);
	};
	await assert.rejects(connectImap(account, { load: refused }), /are not wired in this build/);
	// A package present but without the members the transport needs fails the same way.
	const empty = async (): Promise<any> => ({});
	await assert.rejects(connectImap(account, { load: empty }), /are not wired in this build/);
});

test("the CommonJS default shape is accepted for the loaded packages", async () => {
	const fake = transport();
	const session = await connectImap(account, {
		load: async (specifier: string) => {
			if (specifier === "imapflow") return { default: { ImapFlow: fake.modules.ImapFlow } };
			if (specifier === "nodemailer") return { createTransport: fake.modules.nodemailer.createTransport };
			return { default: { simpleParser: fake.modules.mailparser.simpleParser } };
		},
	});
	assert.equal(session.usable, true);
	await session.close?.();
});

// --- the mail host ---------------------------------------------------------

test("mail add verifies before saving, picks the preset, saves the secret and registers the tools", async (t) => {
	const sessions = new Map<string, FakeSession>();
	const connect = async (wanted: any, deps: any): Promise<FakeSession> => {
		if (deps.password === "WRONG") throw new Error("535 authentication failed");
		const session = fakeSession();
		sessions.set(wanted.address, session);
		return session;
	};
	const { rt, secrets } = runtime(t, { connect });
	await assert.rejects(
		rt.connectorEndpoint("mail-account-add", { address: addressAt("163.com"), password: "WRONG" }),
		/password was refused/i,
	);
	assert.equal((rt.mailView() as any).accounts.length, 0);
	const view = (await rt.connectorEndpoint("mail-account-add", {
		address: addressAt("163.com"),
		password: "RIGHT",
	})) as any;
	assert.equal(view.accounts[0].provider, "163");
	assert.equal(view.accounts[0].address, addressAt("163.com"));
	assert.equal(secrets.get(mailSecretName(addressAt("163.com"), "PASSWORD")), "RIGHT");
	assert.ok(tool(rt, "mail_send") && tool(rt, "mail_draft"));
	// A wrong code is explained in plain words.
	await assert.rejects(
		rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com") }),
		/authorization code or app password/,
	);
	assert.ok(sessions.size >= 1);
});

test("mail_search reconnects once after an idle drop or an unusable cached session", async (t) => {
	const made: Array<FakeSession & { gone: () => void }> = [];
	const connect = async (_account: any, deps: any): Promise<any> => {
		const session = fakeSession() as FakeSession & { gone: () => void };
		session.gone = () => deps.onGone();
		made.push(session);
		return session;
	};
	const { rt } = runtime(t, { connect });
	await rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "CODE" });
	const search = tool(rt, "mail_search");
	made[0].gone();
	assert.equal(await search.execute({}, { agent: { id: "m1" } }), "No matching mail.");
	assert.equal(made.length, 2);
	made[0].gone(); // A late close from the old connection must not drop the new one.
	await search.execute({}, { agent: { id: "m1" } });
	assert.equal(made.length, 2);
	made[1].usable = false;
	await search.execute({}, { agent: { id: "m1" } });
	assert.equal(made.length, 3);
});

test("mail add updates the same address and keeps its verified session for tools", async (t) => {
	const made: Array<{ account: any; password: string; session: FakeSession }> = [];
	const connect = async (wanted: any, deps: any): Promise<FakeSession> => {
		const session = fakeSession();
		made.push({ account: wanted, password: deps.password, session });
		return session;
	};
	const { rt, secrets } = runtime(t, { connect });
	const first = (await rt.connectorEndpoint("mail-account-add", {
		address: addressAt("qq.com"),
		password: "FIRST",
	})) as any;
	const id = first.accounts[0].id;
	await tool(rt, "mail_search").execute({}, { agent: { id: "m1" } });
	assert.equal(made.length, 1);
	assert.equal(
		made[0].session.calls.some((call) => call[0] === "close"),
		false,
	);
	const updated = (await rt.connectorEndpoint("mail-account-add", {
		address: addressAt("qq.com").toUpperCase(),
		password: "SECOND",
		provider: "other",
		imapHost: "imap.example.test",
		smtpHost: "smtp.example.test",
	})) as any;
	assert.equal(updated.accounts.length, 1);
	assert.equal(updated.accounts[0].id, id);
	assert.equal(made.length, 2);
	assert.equal(made[1].account.imap.host, "imap.example.test");
	assert.equal(secrets.get(mailSecretName(addressAt("qq.com"), "PASSWORD")), "SECOND");
	assert.equal(
		made[0].session.calls.some((call) => call[0] === "close"),
		true,
	);
	await tool(rt, "mail_search").execute({}, { agent: { id: "m1" } });
	assert.equal(made.length, 2);
});

test("concurrent adds for one address share verification and its result", async (t) => {
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let made = 0;
	const connect = async (): Promise<FakeSession> => {
		made += 1;
		started.resolve();
		await gate.promise;
		return fakeSession();
	};
	const { rt } = runtime(t, { connect });
	const first = rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "CODE" });
	await started.promise;
	const second = rt.connectorEndpoint("mail-account-add", {
		address: addressAt("qq.com").toUpperCase(),
		password: "CODE",
	});
	await new Promise((resolve) => setImmediate(resolve));
	gate.resolve();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(made, 1);
	assert.deepEqual(a, b);
	assert.equal((rt.mailView() as any).accounts.length, 1);
});

test("mail send needs the card; cancel sends nothing; Send applies fields and rules; allowed recipients skip the card", async (t) => {
	const sessions = new Map<string, FakeSession>();
	const connect = async (wanted: any): Promise<FakeSession> => {
		const session = fakeSession();
		sessions.set(wanted.address, session);
		return session;
	};
	const { rt } = runtime(t, { connect });
	await rt.connectorEndpoint("mail-account-add", { address: addressAt("163.com"), password: "PASS" });
	const send = tool(rt, "mail_send");
	let concluded = false;
	const exec = {
		agent: { id: "m1" },
		callId: "call-1",
		concludeTurn: () => {
			concluded = true;
		},
	};
	const asked = await send.execute({ to: "you@test.dev", subject: "Hi", body: "Body text" }, exec);
	assert.match(String(asked), /send card|on screen/i);
	assert.equal(concluded, true);
	const request = (rt.state.mailRequests as any).m1.at(-1);
	assert.equal(request.status, "pending");
	assert.equal(
		sessions.get(addressAt("163.com"))?.calls.some((call) => call[0] === "send"),
		false,
	);
	// Cancel: nothing is sent; a new card, then Send, sends once.
	assert.equal(await rt.connectorEndpoint("mail-send-answer", { requestId: request.id, choice: "cancel" }), true);
	assert.equal(sessions.get(addressAt("163.com"))?.calls.filter((call) => call[0] === "send").length, 0);
	await send.execute(
		{ to: "you@test.dev", subject: "Hi2", body: "B" },
		{ agent: { id: "m1" }, callId: "call-2", concludeTurn: () => {} },
	);
	const request2 = (rt.state.mailRequests as any).m1.at(-1);
	await rt.connectorEndpoint("mail-send-answer", {
		requestId: request2.id,
		choice: "send",
		fields: { to: "edited@test.dev", cc: "cc@test.dev", subject: "Hi2 edited", body: "Edited B" },
		rule: "allow-recipient",
	});
	const sent = sessions.get(addressAt("163.com"))?.calls.filter((call) => call[0] === "send") ?? [];
	assert.equal(sent.length, 1);
	assert.equal(sent[0][1].to, "edited@test.dev");
	assert.equal(sent[0][1].cc, "cc@test.dev");
	assert.equal(sent[0][1].subject, "Hi2 edited");
	assert.equal(sent[0][1].text, "Edited B");
	assert.deepEqual((rt.mailView() as any).allowedRecipients, ["edited@test.dev", "cc@test.dev"]);
	// Allowed recipients skip the draft card and send right away; an unknown recipient still requires confirmation.
	let concludedAllowed = false;
	const autoReply = await send.execute(
		{ to: "edited@test.dev", subject: "Auto", body: "Quick" },
		{
			agent: { id: "m1" },
			callId: "call-3",
			concludeTurn: () => {
				concludedAllowed = true;
			},
		},
	);
	assert.match(String(autoReply), /Sent "Auto" to edited@test\.dev/);
	assert.equal(concludedAllowed, false);
	assert.equal(sessions.get(addressAt("163.com"))?.calls.filter((call) => call[0] === "send").length, 2);
	let concludedMixed = false;
	await send.execute(
		{ to: "edited@test.dev", cc: "stranger@test.dev", subject: "Mixed", body: "Hold" },
		{
			agent: { id: "m1" },
			callId: "call-4",
			concludeTurn: () => {
				concludedMixed = true;
			},
		},
	);
	assert.equal(concludedMixed, true, "any unapproved recipient in cc still requires confirmation");
	// Turning off drafts for a Bot sends without confirmation; restoring Needs approval brings the card back.
	await rt.connectorEndpoint("mail-rule-set", { mode: "no-draft", botId: "m1" });
	assert.deepEqual((rt.mailView() as any).noDraftFor, ["m1"]);
	let concludedNoDraft = false;
	await send.execute(
		{ to: "anyone@test.dev", subject: "NoDraft", body: "Go" },
		{
			agent: { id: "m1" },
			callId: "call-5",
			concludeTurn: () => {
				concludedNoDraft = true;
			},
		},
	);
	assert.equal(concludedNoDraft, false);
	await rt.connectorEndpoint("mail-rule-set", {
		botId: "m1",
		noDraft: false,
		removeRecipient: "edited@test.dev, cc@test.dev",
	});
	assert.deepEqual((rt.mailView() as any).noDraftFor, []);
	assert.deepEqual((rt.mailView() as any).allowedRecipients, []);
	// A draft never draws a card.
	const before = ((rt.state.mailRequests as any).m1 ?? []).length;
	assert.match(
		String(await tool(rt, "mail_draft").execute({ to: "a@b.c", subject: "D", body: "x" }, exec)),
		/Draft saved/,
	);
	assert.equal(((rt.state.mailRequests as any).m1 ?? []).length, before);
});

test("mail_send refuses attachments outside the working folder", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ocean-crew-maildir-"));
	writeFileSync(join(dir, "inside.txt"), "hi");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { rt } = runtime(t, { connect: async () => fakeSession() });
	rt.sessionFolder = () => dir;
	await rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "PASS" });
	const send = tool(rt, "mail_send");
	const answer = await send.execute(
		{ to: "x@y.dev", subject: "S", body: "B", attachments: ["../../etc/passwd"] },
		{ agent: { id: "m1" }, callId: "c1", concludeTurn: () => {} },
	);
	assert.match(String(answer), /working folder/);
	const inside = await send.execute(
		{ to: "x@y.dev", subject: "S", body: "B", attachments: ["inside.txt"] },
		{ agent: { id: "m1" }, callId: "c2", concludeTurn: () => {} },
	);
	assert.match(String(inside), /send card|on screen/i);
});

test("mail add explains refused and unsafe logins in plain words", async (t) => {
	let mode = "ok";
	const connect = async (): Promise<FakeSession> => {
		if (mode === "flag") {
			const error = new Error("NO") as Error & { authenticationFailed?: boolean };
			error.authenticationFailed = true;
			throw error;
		}
		if (mode === "qq")
			throw new Error("Login fail. Account is abnormal, service is not open, password is incorrect.");
		if (mode === "unsafe") throw new Error("Unsafe Login");
		if (mode === "refused") throw new Error("connect ECONNREFUSED 127.0.0.1:993");
		return fakeSession();
	};
	const { rt } = runtime(t, { connect });
	mode = "flag";
	await assert.rejects(
		rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "CODE" }),
		/password was refused/i,
	);
	mode = "unsafe";
	await assert.rejects(
		rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "CODE" }),
		/Unsafe Login/,
	);
	mode = "refused";
	await assert.rejects(
		rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "CODE" }),
		/^Error: Could not reach the mail server at 127\.0\.0\.1:993\. Check the server address\.$/,
	);
	assert.equal((rt.mailView() as any).accounts.length, 0);
});

test("mail account remove drops the secret and unregisters the tools; a shared address keeps it", async (t) => {
	const address = addressAt("qq.com");
	const row = (id: string): any => ({
		id,
		address,
		provider: "qq",
		auth: "password",
		imap: { host: "imap.qq.com", port: 993, secure: true },
		smtp: { host: "smtp.qq.com", port: 465, secure: true },
		createdAt: 1,
	});
	const { rt, state, secrets } = runtime(t, {
		connect: async () => fakeSession(),
		saved: { mail: { accounts: { ma: row("ma"), mb: row("mb") } } },
	});
	assert.equal(state.connectors !== undefined, true);
	secrets.set(mailSecretName(address, "PASSWORD"), "PASSP");
	assert.ok(tool(rt, "mail_send"));
	await rt.connectorEndpoint("mail-account-remove", { id: "ma" });
	assert.equal(secrets.get(mailSecretName(address, "PASSWORD")), "PASSP");
	assert.deepEqual(
		(rt.mailView() as any).accounts.map((entry: any) => entry.id),
		["mb"],
	);
	assert.ok(tool(rt, "mail_send"));
	await rt.connectorEndpoint("mail-account-remove", { id: "mb" });
	assert.equal(secrets.get(mailSecretName(address, "PASSWORD")), undefined);
	assert.equal(tool(rt, "mail_send"), undefined);
});

test("the mailbox turned off for a Bot refuses its tools", async (t) => {
	const { rt } = runtime(t, { connect: async () => fakeSession() });
	await rt.connectorEndpoint("mail-account-add", { address: addressAt("qq.com"), password: "PASS" });
	await rt.connectorEndpoint("connector-set", { id: "mail", offFor: ["m1"] });
	assert.equal(
		await tool(rt, "mail_search").execute({}, { agent: { id: "m1" } }),
		"The mailbox is turned off for you.",
	);
});

// --- Gmail REST backend ----------------------------------------------------

test("gmail transport: search, read, draft, send, modify, trash, and one refresh on 401", async () => {
	const calls: string[] = [];
	let refreshes = 0;
	let authed = false;
	const fakeFetch = async (url: string): Promise<Response> => {
		calls.push(url);
		if (!authed && url.includes("/messages/1?format=full")) {
			authed = true;
			return new Response("unauth", { status: 401 });
		}
		if (url.includes("/messages?") || url.includes("maxResults")) return json({ messages: [{ id: "1" }] });
		if (url.includes("metadataHeaders"))
			return json({
				id: "1",
				labelIds: ["UNREAD"],
				payload: {
					headers: [
						{ name: "Subject", value: "S" },
						{ name: "From", value: "a@b" },
					],
				},
			});
		if (url.includes("?format=full"))
			return json({
				id: "1",
				threadId: "t1",
				payload: {
					headers: [{ name: "Subject", value: "S" }],
					parts: [{ mimeType: "text/plain", body: { data: Buffer.from("hi").toString("base64") } }],
				},
			});
		if (url.includes("/drafts")) return json({ id: "d1" });
		if (url.includes("/messages/send")) return json({ id: "s1" });
		if (url.includes("/modify")) return json({});
		if (url.includes("/trash")) return json({});
		return json({});
	};
	const gmail = connectGmail(
		{ id: "g", address: addressAt("gmail.com") },
		{
			token: () => "G1",
			fetch: fakeFetch,
			refresh: async () => {
				refreshes += 1;
				return true;
			},
		},
	);
	const rows = await gmail.search({ subject: "x" });
	assert.equal(rows.length, 1);
	assert.equal((await gmail.read({ uid: "1" })).messages[0].text, "hi");
	assert.ok((await gmail.draft({ to: "a@b", subject: "d", text: "x" })).folder);
	await gmail.send({ to: "a@b", subject: "s", text: "x" });
	await gmail.update({ uid: "1", seen: true });
	await gmail.update({ uid: "1", move: "trash" });
	// The 401 on the first read was refreshed exactly once, then retried.
	assert.equal(refreshes, 1);
	assert.ok(calls.some((call) => call.includes("/drafts")));
	assert.ok(calls.some((call) => call.includes("/trash")));
	assert.ok(calls.some((call) => call.includes("/modify")));
});

test("Google mailbox refresh reports success and failure without credentials or addresses", async () => {
	const logs: unknown[][] = [];
	const secrets = new Map<string, string>();
	const address = addressAt("gmail.com");
	secrets.set(mailSecretName(address, "REFRESH"), "google-refresh-private");
	let fail = false;
	const rt = {
		state: emptyTeam(),
		readOnly: () => undefined,
		secretValue: (key: string) => secrets.get(key),
		warn: (...args: unknown[]) => logs.push(args),
		config: {
			mail: {
				fetch: async (url: string) => {
					if (String(url).includes("well-known")) return json(AS_METADATA);
					if (String(url).includes("/token"))
						return fail
							? json({ error: "invalid_grant" }, 400)
							: json({ access_token: "google-access-private", token_type: "Bearer" });
					return new Response("", { status: 404 });
				},
			},
		},
	} as unknown as Runtime & Record<string, any>;
	const mail = installMail(rt, {
		offFor: () => [],
		secrets: {
			writeSecret: async (key, value) => {
				secrets.set(key, value);
			},
			value: (key) => secrets.get(key),
		},
		reason: (error) => String(error),
	});
	assert.equal(await mail._internals.refreshGoogle({ id: "g", address }), true);
	fail = true;
	assert.equal(await mail._internals.refreshGoogle({ id: "g", address }), false);
	assert.match(JSON.stringify(logs), /succeeded.*manual\/Google/);
	assert.match(JSON.stringify(logs), /failed.*manual\/Google/);
	assert.equal(JSON.stringify(logs).includes("private"), false);
	assert.equal(JSON.stringify(logs).includes(address), false);
});

const AS_METADATA = {
	issuer: "https://accounts.google.com",
	authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
	token_endpoint: "https://oauth2.googleapis.com/token",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
};
