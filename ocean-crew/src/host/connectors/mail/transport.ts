// Mail transports. `connectImap(account, deps)` returns one account session behind a
// small interface the tools and tests share; tests inject fakes through
// `rt.config.mail.connect`.
//
// the

// fails with one clear error instead of a module-resolution stack at startup. Callers
// that already hold the modules (tests, `config.mail.modules`) pass them through
// `deps.modules` and no package is loaded.
import { writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { IMAP_ID } from "./presets.ts";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// --- transport module seams -------------------------------------------------

export interface ImapEnvelopeAddress {
	address?: string;
	name?: string;
}

export interface ImapEnvelope {
	from?: ImapEnvelopeAddress[];
	to?: ImapEnvelopeAddress[];
	cc?: ImapEnvelopeAddress[];
	subject?: string;
	date?: Date;
	messageId?: string;
	inReplyTo?: string;
}

export interface ImapMessage {
	uid: number;
	envelope?: ImapEnvelope;
	flags?: Set<string>;
	source?: Buffer;
}

export interface ImapMailbox {
	specialUse?: string;
	path: string;
}

export interface ImapFlowLike {
	usable: boolean;
	on(event: string, listener: (...args: any[]) => void): unknown;
	connect(): Promise<void>;
	close(): void;
	logout(): Promise<void>;
	list(): Promise<ImapMailbox[]>;
	getMailboxLock(folder: string): Promise<{ release(): void }>;
	fetchOne(uid: number | string, query: unknown, options?: { uid?: boolean }): Promise<ImapMessage | false>;
	fetch(range: unknown, query: unknown, options?: { uid?: boolean }): AsyncIterable<ImapMessage>;
	search(query: unknown, options?: { uid?: boolean }): Promise<number[] | false>;
	messageFlagsAdd(uid: number | string, flags: string[], options: { uid?: boolean }): Promise<unknown>;
	messageFlagsRemove(uid: number | string, flags: string[], options: { uid?: boolean }): Promise<unknown>;
	messageMove(uid: number | string, target: string, options: { uid?: boolean }): Promise<unknown>;
	append(folder: string, raw: Buffer | string, flags: string[]): Promise<unknown>;
}

export interface ImapFlowConstructor {
	new (options: Record<string, unknown>): ImapFlowLike;
}

export interface SmtpTransportLike {
	on(event: string, listener: (...args: any[]) => void): unknown;
	verify(): Promise<unknown>;
	sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>;
	close(): void;
}

export interface NodemailerLike {
	createTransport(options: Record<string, unknown>): SmtpTransportLike;
}

export interface ParsedAddressList {
	text?: string;
}

export interface ParsedAttachment {
	filename?: string;
	size?: number;
	content: Buffer;
	partId?: string;
}

export interface ParsedMail {
	messageId?: string;
	subject?: string;
	from?: ParsedAddressList;
	to?: ParsedAddressList;
	cc?: ParsedAddressList;
	date?: Date;
	text?: string;
	references?: string | string[];
	attachments?: ParsedAttachment[];
}

export interface MailModules {
	ImapFlow?: ImapFlowConstructor;
	nodemailer?: NodemailerLike;
	mailparser?: { simpleParser(source: Buffer | string): Promise<ParsedMail> };
}

// --- the session interface tools and the mail host share --------------------

export interface MailAccount {
	id: string;
	address: string;
	provider?: string;
	auth?: string;
	imap?: { host: string; port: number; secure?: boolean };
	smtp?: { host: string; port: number; secure?: boolean; starttls?: boolean };
	error?: string;
	[key: string]: unknown;
}

export interface SearchArgs {
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	since?: string;
	before?: string;
	unread?: boolean;
	limit?: number;
}

export interface MailSearchRow {
	uid: number | string;
	folder: string;
	from: string;
	to: string;
	subject: string;
	date: string;
	seen: boolean;
	flagged: boolean;
}

export interface MailAttachmentInfo {
	filename: string;
	size: number;
	partId?: string;
	attachmentId?: string;
}

export interface MailMessage {
	uid: number | string;
	folder: string;
	messageId: string;
	subject: string;
	from: string;
	to: string;
	cc: string;
	date: string;
	text: string;
	references: string[];
	attachments: MailAttachmentInfo[];
	threadId?: string;
}

export interface MailDraftArgs {
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	text?: string;
}

export interface MailSendArgs extends MailDraftArgs {
	attachments?: Array<{ filename: string; path: string }>;
	inReplyTo?: string;
	references?: string[];
}

export interface MailUpdateArgs {
	uid: number | string;
	folder?: string;
	seen?: boolean;
	flagged?: boolean;
	move?: string;
}

export interface MailSession {
	kind: "imap" | "gmail";
	readonly usable?: boolean;
	close?(): Promise<void>;
	search(args: SearchArgs): Promise<MailSearchRow[]>;
	read(args: { uid: number | string; folder?: string; thread?: boolean }): Promise<{ messages: MailMessage[] }>;
	saveAttachment(args: {
		uid: number | string;
		folder?: string;
		filename?: string;
		to: string;
	}): Promise<{ path: string; filename: string; bytes: number }>;
	draft(args: MailDraftArgs): Promise<{ folder: string; id?: string }>;
	send(args: MailSendArgs): Promise<{ messageId?: string }>;
	update(args: MailUpdateArgs): Promise<void>;
}

/** Loads one mail package by name; tests substitute a fake loader. */
export type MailModuleLoader = (specifier: string) => Promise<Record<string, any>>;

export interface TransportDeps {
	password?: string;
	modules?: MailModules;
	onGone?: () => void;
	load?: MailModuleLoader;
}

// --- IMAP + SMTP ------------------------------------------------------------

// IMAP + SMTP (imapflow + nodemailer). One live IMAP connection per account is kept by
// the caller (QQ throttles frequent logins); on a dropped connection the caller
// reconnects once.
export const imapOptions = (account: MailAccount, deps: TransportDeps = {}): Record<string, unknown> => ({
	host: account.imap?.host,
	port: account.imap?.port,
	secure: account.imap?.secure !== false,
	auth: { user: account.address, pass: deps.password },
	// RFC 2971: 163/126 refuse logins without the client identity.
	id: IMAP_ID,
	logger: false,
	socketTimeout: 60_000,
});

const NOT_WIRED = "The mail transport modules (imapflow, nodemailer and mailparser) are not wired in this build";

// The host build's loader: the three packages are dependencies of the plugin, so a
// connection loads them lazily, once, instead of at import time.
const loadPackage: MailModuleLoader = (specifier) => import(specifier) as Promise<Record<string, any>>;

// A CommonJS package seen through import() may expose its members on `default`; accept

const hostModule = async <T>(
	loader: MailModuleLoader,
	specifier: string,
	read: (namespace: Record<string, any>) => T | undefined,
): Promise<T> => {
	let namespace: Record<string, any>;
	try {
		namespace = await loader(specifier);
	} catch (error) {
		throw new Error(NOT_WIRED, { cause: error });
	}
	const found = read(namespace);
	if (found === undefined) throw new Error(NOT_WIRED);
	return found;
};

// Whatever the caller injected wins; a module it left out is loaded by the host, as the
// Nothing is loaded when all
// three are already held.
const requireModules = async (deps: TransportDeps): Promise<Required<MailModules>> => {
	const held = deps.modules;
	const loader = deps.load ?? loadPackage;
	const ImapFlow =
		held?.ImapFlow ??
		(await hostModule(loader, "imapflow", (namespace) => {
			const found = namespace.ImapFlow ?? namespace.default?.ImapFlow;
			return typeof found === "function" ? (found as ImapFlowConstructor) : undefined;
		}));
	const nodemailer =
		held?.nodemailer ??
		(await hostModule(loader, "nodemailer", (namespace) => {
			const found = namespace.createTransport !== undefined ? namespace : namespace.default;
			return typeof found?.createTransport === "function" ? (found as NodemailerLike) : undefined;
		}));
	const mailparser =
		held?.mailparser ??
		(await hostModule(loader, "mailparser", (namespace) => {
			const found = namespace.simpleParser !== undefined ? namespace : namespace.default;
			return typeof found?.simpleParser === "function" ? (found as MailModules["mailparser"]) : undefined;
		}));
	return { ImapFlow, nodemailer, mailparser };
};

const smtpOptions = (
	account: MailAccount,
	deps: TransportDeps,
	retire: () => void,
	gone: () => boolean,
	sockets: Set<Socket>,
): Record<string, unknown> => ({
	host: account.smtp?.host,
	port: account.smtp?.port,
	secure: account.smtp?.secure === true,
	requireTLS: account.smtp?.starttls === true,
	auth: { user: account.address, pass: deps.password },
	// Nodemailer's close() does not cancel a non-pooled verify(). Own its sockets through
	// the transport hook so an IMAP failure also cancels that login.
	getSocket(
		options: { host?: string; port?: number; connectionTimeout?: number },
		done: (error: Error | null, info?: { connection: Socket }) => void,
	): void {
		if (gone()) {
			done(new Error("The mail connection is closed"));
			return;
		}
		const socket = new Socket();
		sockets.add(socket);
		let answered = false;
		const fail = (error: Error): void => {
			if (!answered) {
				answered = true;
				done(error);
			}
		};
		socket.once("error", fail);
		socket.on("error", retire);
		socket.once("close", () => {
			sockets.delete(socket);
			fail(new Error("The SMTP connection closed"));
		});
		// Preserve Nodemailer's documented default connection timeout.
		socket.setTimeout(options.connectionTimeout ?? 120_000, () =>
			socket.destroy(new Error("SMTP connection timeout")),
		);
		socket.connect({ host: String(options.host ?? ""), port: Number(options.port ?? 0) }, () => {
			if (answered) return;
			answered = true;
			socket.setTimeout(0);
			done(null, { connection: socket });
		});
	},
});

export async function connectImap(account: MailAccount, deps: TransportDeps = {}): Promise<MailSession> {
	const { ImapFlow, nodemailer, mailparser } = await requireModules(deps);
	const imap = new ImapFlow(imapOptions(account, deps));
	let gone = false;
	const sockets = new Set<Socket>();
	const retire = (): void => {
		if (gone) return;
		gone = true;
		imap.close();
		for (const socket of sockets) socket.destroy();
		smtp?.close();
		deps.onGone?.();
	};
	imap.on("error", retire);
	imap.on("close", retire);
	const smtp = nodemailer.createTransport(smtpOptions(account, deps, retire, () => gone, sockets));
	smtp.on("error", retire);
	try {
		await Promise.all([
			imap.connect().then(() => {
				if (gone) imap.close();
			}),
			smtp.verify().then(() => {
				if (gone) smtp.close();
			}),
		]);
		if (gone) throw new Error("The mail connection closed during verification");
	} catch (error) {
		retire();
		throw error;
	}

	const folders = async (): Promise<{ inbox: string; drafts?: string; trash?: string }> => {
		const list = await imap.list();
		const pick = (use: string, names: string[]): string | undefined =>
			list.find((box) => box.specialUse === use)?.path ??
			list.find((box) => names.some((name) => box.path.toLowerCase() === name))?.path;
		return {
			inbox: "INBOX",
			drafts: pick("\\Drafts", ["drafts", "draft"]),
			trash: pick("\\Trash", ["trash", "deleted messages", "deleted", "已删除"]),
		};
	};
	let folderCache: { inbox: string; drafts?: string; trash?: string } | undefined;
	const special = async (): Promise<{ inbox: string; drafts?: string; trash?: string }> => {
		folderCache ??= await folders();
		return folderCache;
	};

	const toRow = (msg: ImapMessage, folder: string): MailSearchRow => ({
		uid: msg.uid,
		folder,
		from: msg.envelope?.from?.map((a) => a.address ?? a.name).join(", ") ?? "",
		to: msg.envelope?.to?.map((a) => a.address ?? a.name).join(", ") ?? "",
		subject: msg.envelope?.subject ?? "",
		date: msg.envelope?.date?.toISOString?.() ?? "",
		seen: msg.flags?.has("\\Seen") === true,
		flagged: msg.flags?.has("\\Flagged") === true,
	});

	interface ParsedMessage extends MailMessage {
		parsed: ParsedMail;
	}
	const parseMessage = async (uid: number | string, folder: string): Promise<ParsedMessage> => {
		const lock = await imap.getMailboxLock(folder);
		try {
			const message = await imap.fetchOne(uid, { source: true, envelope: true, bodyStructure: true }, { uid: true });
			if (message === false) throw new Error("No such message");
			const parsed = await mailparser.simpleParser(message.source ?? Buffer.alloc(0));
			const references = Array.isArray(parsed.references)
				? parsed.references
				: parsed.references !== undefined
					? [parsed.references]
					: [];
			return {
				uid,
				folder,
				messageId: parsed.messageId ?? message.envelope?.messageId ?? "",
				subject: parsed.subject ?? "",
				from: parsed.from?.text ?? "",
				to: parsed.to?.text ?? "",
				cc: parsed.cc?.text ?? "",
				date: parsed.date?.toISOString?.() ?? "",
				text: parsed.text ?? "",
				references,
				attachments: (parsed.attachments ?? []).map((a, i) => ({
					filename: a.filename ?? `attachment-${i + 1}`,
					size: a.size ?? a.content.length,
					partId: a.partId,
				})),
				parsed,
			};
		} finally {
			lock.release();
		}
	};

	const strip = ({ parsed: _parsed, ...message }: ParsedMessage): MailMessage => message;

	return {
		kind: "imap",
		get usable() {
			return !gone && imap.usable;
		},
		async close() {
			try {
				if (!gone) await imap.logout();
			} catch {
				// Dropped already.
			} finally {
				retire();
			}
		},
		async search({ folder = "INBOX", from, to, subject, text, since, before, unread, limit = 20 }) {
			const query: Record<string, unknown> = {};
			if (from) query.from = from;
			if (to) query.to = to;
			if (subject) query.subject = subject;
			if (text) query.text = text;
			if (since) query.since = new Date(since);
			if (before) query.before = new Date(before);
			if (unread) query.seen = false;
			const lock = await imap.getMailboxLock(folder);
			try {
				const uids = await imap.search(query, { uid: true });
				const wanted = (Array.isArray(uids) ? uids : []).slice(-limit);
				if (wanted.length === 0) return [];
				const rows: MailSearchRow[] = [];
				for await (const msg of imap.fetch(wanted, { envelope: true, flags: true }, { uid: true }))
					rows.push(toRow(msg, folder));
				return rows;
			} finally {
				lock.release();
			}
		},
		async read({ uid, folder = "INBOX", thread = false }) {
			const main = await parseMessage(uid, folder);
			if (!thread) return { messages: [strip(main)] };
			const lock = await imap.getMailboxLock(folder);
			try {
				const related: ParsedMessage[] = [];
				const ids = new Set<string>([main.messageId, ...main.references]);
				for await (const msg of imap.fetch("1:*", { envelope: true }, { uid: true })) {
					const mid = msg.envelope?.messageId;
					const inReply = msg.envelope?.inReplyTo;
					if (msg.uid === uid || (inReply !== undefined && ids.has(inReply)))
						related.push(await parseMessage(msg.uid, folder));
					if (mid !== undefined && ids.has(mid)) ids.add(mid);
				}
				related.sort((a, b) => String(a.date).localeCompare(String(b.date)));
				return { messages: [strip(main), ...related.filter((m) => m.uid !== uid).map(strip)] };
			} finally {
				lock.release();
			}
		},
		async saveAttachment({ uid, folder = "INBOX", filename, to }) {
			const message = await parseMessage(uid, folder);
			const parts = message.parsed.attachments ?? [];
			const part = parts.find((a) => (a.filename ?? "") === filename) ?? parts[0];
			if (part === undefined) throw new Error("No such attachment");
			await writeFile(to, part.content);
			return { path: to, filename: part.filename ?? filename ?? "", bytes: part.size ?? part.content.length };
		},
		async draft({ to, cc, bcc, subject, text }) {
			const { drafts } = await special();
			if (drafts === undefined) throw new Error("This account has no Drafts folder");
			const raw = composeRaw(account.address, { to, cc, bcc, subject, text });
			await imap.append(drafts, raw, ["\\Seen"]);
			return { folder: drafts };
		},
		async send({ to, cc, bcc, subject, text, attachments = [], inReplyTo, references }) {
			const info = await smtp.sendMail({
				from: account.address,
				to,
				cc,
				bcc,
				subject,
				text,
				...(inReplyTo ? { inReplyTo, references: references ?? [inReplyTo] } : {}),
				attachments,
			});
			return { messageId: info.messageId };
		},
		async update({ uid, folder = "INBOX", seen, flagged, move }) {
			const lock = await imap.getMailboxLock(folder);
			try {
				if (seen !== undefined)
					await (seen
						? imap.messageFlagsAdd(uid, ["\\Seen"], { uid: true })
						: imap.messageFlagsRemove(uid, ["\\Seen"], { uid: true }));
				if (flagged !== undefined)
					await (flagged
						? imap.messageFlagsAdd(uid, ["\\Flagged"], { uid: true })
						: imap.messageFlagsRemove(uid, ["\\Flagged"], { uid: true }));
				if (move !== undefined) {
					const { trash } = await special();
					const target = move === "trash" ? trash : move;
					if (target === undefined) throw new Error("This account has no Trash folder");
					await imap.messageMove(uid, target, { uid: true });
				}
			} finally {
				lock.release();
			}
		},
	};
}

// --- Gmail REST API ---------------------------------------------------------

// Gmail REST API backend for accounts signed in with Google. Same interface.
export function connectGmail(
	account: MailAccount,
	deps: { token: () => string | undefined; fetch?: FetchFn; refresh?: () => Promise<boolean> },
): MailSession {
	const request = deps.fetch ?? fetch;
	const send = async (path: string, init: RequestInit = {}): Promise<Record<string, any>> => {
		const response = await request(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${deps.token() ?? ""}`,
				"Content-Type": "application/json",
				...(init.headers ?? {}),
			},
		});
		if (response.status === 401 && deps.refresh) {
			if ((await deps.refresh()) === true) return send(path, init);
		}
		if (!response.ok) throw new Error(`Gmail answered ${response.status}`);
		try {
			return (await response.json()) as Record<string, any>;
		} catch {
			return {};
		}
	};
	const header = (list: Array<{ name: string; value: string }> | undefined, name: string): string =>
		list?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
	const decode = (data: string | undefined): string =>
		data === undefined ? "" : Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
	const walk = (
		part: any,
		out: { text: string; attachments: MailAttachmentInfo[] } = { text: "", attachments: [] },
	): typeof out => {
		if (part === undefined || part === null) return out;
		if (part.mimeType === "text/plain" && part.body?.data) out.text += decode(part.body.data);
		if (part.filename)
			out.attachments.push({
				filename: part.filename,
				size: part.body?.size ?? 0,
				attachmentId: part.body?.attachmentId,
			});
		for (const child of part.parts ?? []) walk(child, out);
		return out;
	};
	const toMessage = (full: any): MailMessage => {
		const headers = full.payload?.headers ?? [];
		const body = walk(full.payload);
		return {
			uid: full.id,
			folder: "gmail",
			messageId: header(headers, "Message-ID"),
			subject: header(headers, "Subject"),
			from: header(headers, "From"),
			to: header(headers, "To"),
			cc: header(headers, "Cc"),
			date: header(headers, "Date"),
			text: body.text,
			attachments: body.attachments,
			threadId: full.threadId,
			references: [header(headers, "References"), header(headers, "In-Reply-To")].filter(Boolean),
		};
	};
	return {
		kind: "gmail",
		async close() {},
		async search({ folder, from, to, subject, text, since, before, unread, limit = 20 }) {
			const q = [
				from ? `from:${from}` : "",
				to ? `to:${to}` : "",
				subject ? `subject:${subject}` : "",
				text ?? "",
				since ? `after:${Math.floor(new Date(since).getTime() / 1000)}` : "",
				before ? `before:${Math.floor(new Date(before).getTime() / 1000)}` : "",
				unread ? "is:unread" : "",
				folder && folder !== "INBOX" ? `in:${folder}` : "",
			]
				.filter(Boolean)
				.join(" ");
			const list = await send(`/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`);
			const rows: MailSearchRow[] = [];
			for (const ref of list.messages ?? []) {
				const full = await send(
					`/messages/${ref.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
				);
				const headers = full.payload?.headers ?? [];
				rows.push({
					uid: full.id,
					folder: "gmail",
					from: header(headers, "From"),
					to: header(headers, "To"),
					subject: header(headers, "Subject"),
					date: header(headers, "Date"),
					seen: !(full.labelIds ?? []).includes("UNREAD"),
					flagged: (full.labelIds ?? []).includes("STARRED"),
				});
			}
			return rows;
		},
		async read({ uid, thread = false }) {
			const full = await send(`/messages/${uid}?format=full`);
			const main = toMessage(full);
			if (!thread) return { messages: [main] };
			const all = await send(`/threads/${full.threadId}?format=full`);
			const messages: MailMessage[] = (all.messages ?? []).map(toMessage);
			messages.sort((a, b) => String(a.date).localeCompare(String(b.date)));
			return { messages: messages.length > 0 ? messages : [main] };
		},
		async saveAttachment({ uid, filename, to }) {
			const full = await send(`/messages/${uid}?format=full`);
			const { attachments } = walk(full.payload);
			const part = attachments.find((a) => a.filename === filename) ?? attachments[0];
			if (part === undefined) throw new Error("No such attachment");
			const data = await send(`/messages/${uid}/attachments/${part.attachmentId}`);
			await writeFile(
				to,
				Buffer.from(
					String(data.data ?? "")
						.replace(/-/g, "+")
						.replace(/_/g, "/"),
					"base64",
				),
			);
			return { path: to, filename: part.filename, bytes: part.size };
		},
		async draft(args) {
			const raw = await composeRawAsync(account.address, args);
			const draft = await send("/drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
			return { folder: "DRAFT", id: draft.id as string };
		},
		async send(args) {
			const raw = await composeRawAsync(account.address, args);
			const sent = await send("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
			return { messageId: sent.id as string };
		},
		async update({ uid, seen, flagged, move }) {
			if (move === "trash" || move === "TRASH") {
				await send(`/messages/${uid}/trash`, { method: "POST" });
				return;
			}
			const add: string[] = [];
			const remove: string[] = [];
			if (seen === true) remove.push("UNREAD");
			if (seen === false) add.push("UNREAD");
			if (flagged === true) add.push("STARRED");
			if (flagged === false) remove.push("STARRED");
			if (move !== undefined) {
				remove.push("INBOX");
				add.push(String(move).toUpperCase());
			}
			await send(`/messages/${uid}/modify`, {
				method: "POST",
				body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
			});
		},
	};
}

// --- raw message assembly ---------------------------------------------------

const base64Lines = (text: string): string => {
	const encoded = Buffer.from(text, "utf8").toString("base64");
	const lines: string[] = [];
	for (let at = 0; at < encoded.length; at += 76) lines.push(encoded.slice(at, at + 76));
	return lines.join("\r\n");
};

const encodeSubject = (subject: string): string =>
	/[^\x20-\x7e]/.test(subject) ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=` : subject;

// A plain-text RFC 822 message. the

// that make a reply thread.
const composeRaw = (
	from: string,
	{ to, cc, bcc, subject, text }: { to?: string; cc?: string; bcc?: string; subject?: string; text?: string },
): Buffer => {
	const headers = [
		`From: ${from}`,
		`To: ${String(to ?? "")}`,
		...(cc ? [`Cc: ${cc}`] : []),
		...(bcc ? [`Bcc: ${bcc}`] : []),
		`Subject: ${encodeSubject(String(subject ?? ""))}`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
		"Content-Transfer-Encoding: base64",
	];
	return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${base64Lines(String(text ?? ""))}\r\n`, "utf8");
};

const composeRawAsync = async (from: string, args: MailSendArgs): Promise<string> => {
	const raw = composeRaw(from, args);
	return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
