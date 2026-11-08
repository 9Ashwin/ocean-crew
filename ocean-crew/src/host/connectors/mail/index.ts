// The mailbox connector: mail accounts (IMAP+SMTP app password, or Gmail with Google
// sign-in) in state.connectors.mail.accounts, the mail_* Bot tools, the send card, and
// the mail-* endpoints. Transports come from transport.ts; `rt.config.mail.connect`
// injects fakes in tests, and `rt.config.mail.modules` supplies imapflow/nodemailer/
// mailparser in a packaged build.
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import { defineTool as defineDshTool } from "@deepseek-ai/dsh-tools";
import type { Runtime, TeamTool } from "../../core/runtime.ts";
import { beginBrowser, discover, exchange, invalidGrant, refreshTokens } from "../oauth.ts";

type oauthDiscovery = Awaited<ReturnType<typeof discover>>;

import { mailSecretName, PRESETS, presetOf } from "./presets.ts";
import {
	connectGmail,
	connectImap,
	type MailAccount,
	type MailModules,
	type MailSession,
	type SearchArgs,
} from "./transport.ts";

const GOOGLE_SCOPES =
	"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify";
const MAX_REQUESTS = 20;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The mail side of the connector host: catalog lookup, tool switches and secrets. */
export interface MailHost {
	offFor(id: string): string[];
	secrets: {
		writeSecret(name: string, value: string, purpose: string): Promise<void>;
		value(name: string): string | undefined;
	};
	reason(error: unknown): string;
}

interface MailStored {
	accounts?: Record<string, MailAccount>;
	allowedRecipients?: string[];
	noDraftFor?: string[];
	offFor?: string[];
}

interface MailRequest {
	id: string;
	callId?: string;
	sessionId?: string;
	account: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
	attachments: string[];
	dir?: string;
	attachmentDetails: Array<{ name: string; size?: number }>;
	replyTo?: string;
	status: "pending" | "sent" | "canceled" | "failed";
	askedAt: number;
	settledAt?: number;
	error?: string;
}

interface MailConfig {
	connect?: (account: MailAccount, deps: { password?: string; onGone?: () => void }) => Promise<MailSession>;
	fetch?: FetchFn;
	modules?: MailModules;
}

interface ToolExec {
	agent?: { id?: string; session?: unknown };
	callId?: string;
	concludeTurn?: () => void;
}

export interface MailAccountView {
	id: string;
	address: string;
	provider?: string;
	auth?: string;
	state: "ready" | "error";
	error?: string;
}

export interface MailView {
	accounts: MailAccountView[];
	google: boolean;
	allowedRecipients: string[];
	noDraftFor: string[];
	pending?: Array<{ kind: "browser"; url?: string; address?: string }>;
}

export interface MailApi {
	hasAccounts(): boolean;
	mailView(): MailView;
	connect(account: MailAccount): Promise<MailSession>;
	endpoint(name: string, body: Record<string, any>): Promise<unknown>;
	dispose(): Promise<void>;
	_internals: {
		sessions: Map<string, MailSession>;
		refreshGoogle(account: MailAccount): Promise<boolean>;
		mailSecretName: typeof mailSecretName;
	};
}

const output = {
	schema: { type: "string" },
	render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
		{ type: "text", text: String(value) },
	],
};

interface ToolOptions {
	name: string;
	description: string;
	parameters: Record<string, any>;
	execute: (args: Record<string, any>, exec: ToolExec) => unknown | Promise<unknown>;
}

// The same bridge tools.ts uses for runtime.ts's loose TeamTool: one cast in one place.
const defineTeamTool = (options: ToolOptions): TeamTool =>
	defineDshTool({ ...options, output } as never) as unknown as TeamTool;

function parseAddresses(raw: unknown): string[] {
	const out: string[] = [];
	for (const part of String(raw ?? "").split(/[,;]+/)) {
		const text = part.trim();
		if (text === "") continue;
		const angle = text.match(/<([^<>\s@]+@[^<>\s@]+)>/i);
		const addr = (angle ? angle[1] : text).trim().toLowerCase();
		if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) && !out.includes(addr)) out.push(addr);
	}
	return out;
}

function allAddressesAllowed(to: unknown, cc: unknown, bcc: unknown, allowed: unknown): boolean {
	const set = new Set((Array.isArray(allowed) ? allowed : []).map((address) => String(address).toLowerCase()));
	if (set.size === 0) return false;
	const parts = [to, cc, bcc]
		.flatMap((raw) => String(raw ?? "").split(/[,;]+/))
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return false;
	for (const part of parts) {
		const angle = part.match(/<([^<>\s@]+@[^<>\s@]+)>/i);
		const addr = (angle ? angle[1] : part).trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || !set.has(addr)) return false;
	}
	return true;
}

export function install(rt: Runtime, host: MailHost): MailApi {
	const state = rt.state;
	const sessions = new Map<string, MailSession>();
	const connecting = new Map<string, Promise<MailSession>>();
	const adding = new Map<string, Promise<MailView>>();

	const runtimeFn = (name: string): ((...args: any[]) => any) | undefined => {
		const value = (rt as Record<string, any>)[name];
		return typeof value === "function" ? value : undefined;
	};
	const loadSecrets = async (): Promise<void> => {
		await runtimeFn("loadSecrets")?.();
	};
	const secretValue = (name: string): string | undefined => {
		const value = runtimeFn("secretValue")?.(name);
		return typeof value === "string" ? value : undefined;
	};
	const mailConfig = (): MailConfig => (rt.config as unknown as { mail?: MailConfig }).mail ?? {};
	const mailOf = (): MailStored => {
		const connectors = state.connectors as Record<string, unknown> | undefined;
		const mail = connectors?.mail;
		return mail !== null && typeof mail === "object" && !Array.isArray(mail) ? (mail as MailStored) : {};
	};
	const saveMail = async (mail: MailStored): Promise<void> => {
		state.connectors = { ...(state.connectors ?? {}), mail };
		await rt.save();
	};
	const requestsOf = (): Record<string, MailRequest[]> => {
		state.mailRequests ??= {};
		return state.mailRequests as Record<string, MailRequest[]>;
	};

	const accounts = (): Record<string, MailAccount> => mailOf().accounts ?? {};
	const accountList = (): MailAccount[] => Object.values(accounts());
	const hasAccounts = (): boolean => accountList().length > 0;
	const accountOf = (ref: unknown): MailAccount | undefined => {
		const list = accountList();
		if (ref === undefined || ref === "") return list.length === 1 ? list[0] : undefined;
		return list.find((account) => account.address.toLowerCase() === String(ref).toLowerCase() || account.id === ref);
	};

	const googleClient = (): { id?: string; secret?: string } => ({
		id: process.env.MINI_BOT_GOOGLE_OAUTH_CLIENT_ID,
		secret: process.env.MINI_BOT_GOOGLE_OAUTH_CLIENT_SECRET,
	});
	const googleReady = (): boolean => Boolean(googleClient().id && googleClient().secret);

	async function openImap(account: MailAccount, password: string): Promise<MailSession> {
		const factory =
			mailConfig().connect ??
			((wanted: MailAccount, deps: { password?: string; onGone?: () => void }) =>
				connectImap(wanted, {
					...deps,
					...(mailConfig().modules === undefined ? {} : { modules: mailConfig().modules }),
				}));
		let session: MailSession | undefined;
		session = await factory(account, {
			password,
			onGone: () => {
				if (sessions.get(account.id) === session) sessions.delete(account.id);
			},
		});
		if (session.usable === false) throw new Error("The mail connection closed during verification");
		sessions.set(account.id, session);
		return session;
	}

	async function connect(account: MailAccount): Promise<MailSession> {
		const key = account.id;
		const live = sessions.get(key);
		if (live !== undefined && live.usable !== false) return live;
		if (live !== undefined) {
			sessions.delete(key);
			await live.close?.();
		}
		const pendingConnect = connecting.get(key);
		if (pendingConnect !== undefined) return pendingConnect;
		const make = async (): Promise<MailSession> => {
			if (account.auth === "google") {
				const token = (): string | undefined => secretValue(mailSecretName(account.address, "TOKEN"));
				const session = connectGmail(account, {
					token,
					fetch: mailConfig().fetch,
					refresh: () => refreshGoogle(account),
				});
				sessions.set(key, session);
				return session;
			}
			const password = secretValue(mailSecretName(account.address, "PASSWORD"));
			if (password === undefined) throw new Error(`The password for ${account.address} is not saved`);
			return openImap(account, password);
		};
		const pending = make();
		connecting.set(key, pending);
		try {
			return await pending;
		} finally {
			connecting.delete(key);
		}
	}

	// Gmail tokens refresh through the same OAuth rules as connectors.
	async function refreshGoogle(account: MailAccount): Promise<boolean> {
		if (rt.readOnly() !== undefined) {
			await loadSecrets();
			return false;
		}
		const refresh = secretValue(mailSecretName(account.address, "REFRESH"));
		if (refresh === undefined) return false;
		try {
			const client = googleClient();
			const tokens = await refreshTokens(
				{ authorizationServerUrl: "https://accounts.google.com", resource: "https://accounts.google.com" },
				{ client_id: String(client.id), client_secret: client.secret },
				refresh,
				{ scope: GOOGLE_SCOPES, fetch: mailConfig().fetch },
			);
			await host.secrets.writeSecret(
				mailSecretName(account.address, "TOKEN"),
				tokens.access_token,
				`Mailbox ${account.address}`,
			);
			if (typeof tokens.refresh_token === "string" && tokens.refresh_token !== "") {
				await host.secrets
					.writeSecret(
						mailSecretName(account.address, "REFRESH"),
						tokens.refresh_token,
						`Mailbox ${account.address}`,
					)
					.catch(() => undefined);
			}
			rt.warn("ocean-crew: connector mail token refresh succeeded (client: manual/Google)");
			return true;
		} catch (error) {
			if (invalidGrant(error)) account.error = "Sign in again";
			rt.warn(
				"ocean-crew: connector mail token refresh failed (client: manual/Google; %s)",
				invalidGrant(error) ? "invalid_grant" : "refresh error",
			);
			return false;
		}
	}

	const workDir = (exec: ToolExec): string | undefined => {
		try {
			const read = runtimeFn("sessionFolder");
			return read?.(exec.agent?.session ?? exec.agent) as string | undefined;
		} catch {
			return undefined;
		}
	};

	const toolExec = async (
		exec: ToolExec,
		args: Record<string, any>,
		run: (session: MailSession, account: MailAccount, bot: { id: string; private?: boolean }) => Promise<string>,
	): Promise<string> => {
		await rt.load();
		const self = rt.selfOf(exec.agent?.id);
		const bot = rt.botOf(self);
		if (!bot) return "Only Bots on the team can use the mail tools.";
		if ((mailOf().offFor ?? []).includes(bot.id)) return "The mailbox is turned off for you.";
		const account = accountOf(args.account);
		if (account === undefined)
			return accountList().length === 0
				? "No mail account is added yet."
				: `Name the account: ${accountList()
						.map((item) => item.address)
						.join(", ")}`;
		try {
			const session = await connect(account);
			return await run(session, account, bot);
		} catch (error) {
			sessions.delete(account.id);
			throw error;
		}
	};

	const tools: TeamTool[] = [
		defineTeamTool({
			name: "mail_search",
			description:
				"Search mail in a connected mailbox. Returns matching messages with uid, from, to, subject, and date.",
			parameters: {
				account: { type: "string", description: "Account address; needed only when more than one is added" },
				from: { type: "string" },
				to: { type: "string" },
				subject: { type: "string" },
				text: { type: "string" },
				since: { type: "string", description: "ISO date" },
				before: { type: "string", description: "ISO date" },
				unread: { type: "boolean" },
				folder: { type: "string", description: "Folder name, default INBOX" },
				limit: { type: "number", description: "Max results, default 20" },
			},
			async execute(args: Record<string, any>, exec: ToolExec) {
				return toolExec(exec, args, async (session) => {
					const rows = await session.search({
						folder: args.folder,
						from: args.from,
						to: args.to,
						subject: args.subject,
						text: args.text,
						since: args.since,
						before: args.before,
						unread: args.unread === true,
						limit: args.limit ?? 20,
					} as SearchArgs);
					if (rows.length === 0) return "No matching mail.";
					return rows
						.map(
							(row) =>
								`- [${row.uid}] ${row.date} ${row.from} → ${row.to} — ${row.subject}${row.seen ? "" : " (unread)"}${row.flagged ? " ★" : ""}`,
						)
						.join("\n");
				});
			},
		}),
		defineTeamTool({
			name: "mail_read",
			description:
				"Read one message or its whole thread: headers, text body, and attachment names. save_attachments writes the files into your working folder.",
			parameters: {
				account: { type: "string", description: "Account address; needed only when more than one is added" },
				uid: { type: "string", required: true, description: "Message uid from mail_search" },
				folder: { type: "string" },
				thread: { type: "boolean" },
				save_attachments: { type: "boolean", description: "Save every attachment into your working folder" },
			},
			async execute(args: Record<string, any>, exec: ToolExec) {
				return toolExec(exec, args, async (session) => {
					const { messages } = await session.read({
						uid: String(args.uid),
						folder: args.folder,
						thread: args.thread === true,
					});
					const saved: string[] = [];
					if (args.save_attachments === true) {
						const dir = workDir(exec);
						const taken = new Set<string>();
						const safe = (raw: unknown): string => {
							let name =
								basename(String(raw ?? ""))
									.replace(/[\0-\x1f\\]/g, "_")
									.replace(/^\.+/, "") || "attachment";
							while (taken.has(name)) name = `_${name}`;
							taken.add(name);
							return name;
						};
						for (const message of messages) {
							for (const attachment of message.attachments ?? []) {
								if (dir === undefined) break;
								const name = safe(attachment.filename);
								await session.saveAttachment({
									uid: message.uid,
									folder: message.folder,
									filename: attachment.filename,
									to: join(dir, name),
								});
								saved.push(name);
							}
						}
					}
					const body = messages
						.map((message) =>
							[
								`From: ${message.from}\nTo: ${message.to}${message.cc ? `\nCc: ${message.cc}` : ""}\nDate: ${message.date}\nSubject: ${message.subject}`,
								message.attachments?.length
									? `Attachments: ${message.attachments
											.map((attachment) => `${attachment.filename} (${attachment.size} bytes)`)
											.join(", ")}`
									: "",
								message.text,
							]
								.filter(Boolean)
								.join("\n"),
						)
						.join("\n\n---\n\n");
					return saved.length > 0 ? `${body}\n\nSaved attachments: ${saved.join(", ")}` : body;
				});
			},
		}),
		defineTeamTool({
			name: "mail_draft",
			description: "Save a draft in the mailbox Drafts folder. It is not sent.",
			parameters: {
				account: { type: "string" },
				to: { type: "string", required: true },
				cc: { type: "string" },
				bcc: { type: "string" },
				subject: { type: "string", required: true },
				body: { type: "string", required: true },
			},
			async execute(args: Record<string, any>, exec: ToolExec) {
				return toolExec(exec, args, async (session, account) => {
					await session.draft({ to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.body });
					return `Draft saved in ${account.address}'s Drafts folder. It was not sent.`;
				});
			},
		}),
		defineTeamTool({
			name: "mail_send",
			description:
				"Send an email. The user sees a card in your own chat with the full message and must press Send; nothing goes out before that. Showing the card ends your turn; a note arrives with the answer.",
			parameters: {
				account: { type: "string" },
				to: { type: "string", required: true },
				cc: { type: "string" },
				bcc: { type: "string" },
				subject: { type: "string", required: true },
				body: { type: "string", required: true },
				attachments: { type: "array", items: { type: "string" }, description: "File names in your working folder" },
				reply_to: { type: "string", description: "Message uid this answers" },
			},
			async execute(args: Record<string, any>, exec: ToolExec) {
				await rt.load();
				const self = rt.selfOf(exec.agent?.id);
				const bot = rt.botOf(self);
				if (!bot) return "Only Bots on the team can use mail_send.";
				if ((mailOf().offFor ?? []).includes(bot.id)) return "The mailbox is turned off for you.";
				const account = accountOf(args.account);
				if (account === undefined)
					return accountList().length === 0
						? "No mail account is added yet."
						: `Name the account: ${accountList()
								.map((item) => item.address)
								.join(", ")}`;
				const agentId = exec.agent?.id;
				if (agentId !== undefined && rt.groupOwners.has(agentId)) {
					return "Send cards only work in your own chat. Draft it here with mail_draft, or call mail_send in your own chat.";
				}
				if (agentId === undefined || !rt.chatOwners.has(agentId))
					return "Send cards only work in your current own chat.";
				const readOnly = rt.readOnly();
				if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`;
				const dir = workDir(exec);
				const names = (Array.isArray(args.attachments) ? args.attachments : [])
					.map(String)
					.filter((name: string) => name !== "");
				const bad = names.filter((name) => {
					if (dir === undefined) return true;
					try {
						const inside = realpathSync(resolve(dir, name));
						return inside !== realpathSync(dir) && !inside.startsWith(realpathSync(dir) + sep);
					} catch {
						return true;
					}
				});
				if (bad.length > 0) return `Attachments must be files in your working folder: ${bad.join(", ")} is not.`;
				const requests = requestsOf();
				let list = requests[bot.id];
				if (list === undefined) {
					list = [];
					requests[bot.id] = list;
				}
				const request: MailRequest = {
					id: randomUUID(),
					...(exec.callId ? { callId: exec.callId } : {}),
					sessionId: agentId,
					account: account.id,
					to: String(args.to ?? ""),
					cc: String(args.cc ?? ""),
					bcc: String(args.bcc ?? ""),
					subject: String(args.subject ?? ""),
					body: String(args.body ?? ""),
					attachments: names,
					dir,
					attachmentDetails: names.map((name: string) => {
						try {
							return { name, size: dir === undefined ? undefined : statSync(join(dir, name)).size };
						} catch {
							return { name };
						}
					}),
					replyTo: args.reply_to ? String(args.reply_to) : undefined,
					status: "pending",
					askedAt: Date.now(),
				};
				const skipDraft =
					!bot.private &&
					((mailOf().noDraftFor ?? []).includes(bot.id) ||
						allAddressesAllowed(request.to, request.cc, request.bcc, mailOf().allowedRecipients));
				if (skipDraft) {
					const session = await connect(account);
					const attachments = request.attachments.map((name) => ({
						filename: name,
						path: realpathSync(resolve(dir ?? "", name)),
					}));
					await session.send({
						to: request.to,
						cc: request.cc || undefined,
						bcc: request.bcc || undefined,
						subject: request.subject,
						text: request.body,
						attachments,
						...(request.replyTo ? { inReplyTo: request.replyTo } : {}),
					});
					request.status = "sent";
					request.settledAt = Date.now();
					list.push(request);
					trimRequests(list);
					await rt.save();
					return `Sent "${request.subject}" to ${request.to} from ${account.address}.`;
				}
				for (const old of list) {
					if (old.status === "pending") {
						old.status = "canceled";
						old.settledAt = Date.now();
					}
				}
				list.push(request);
				trimRequests(list);
				await rt.save();
				exec.concludeTurn?.();
				return `The send card for "${request.subject}" is on screen. Nothing is sent until the user presses Send; a note arrives with the answer.`;
			},
		}),
		defineTeamTool({
			name: "mail_update",
			description:
				"Mark a message read or unread, flag or unflag it, or move it to another folder or the Trash. Mail is never deleted permanently.",
			parameters: {
				account: { type: "string" },
				uid: { type: "string", required: true },
				folder: { type: "string" },
				seen: { type: "boolean" },
				flagged: { type: "boolean" },
				move: { type: "string", description: 'Folder name, or "trash"' },
			},
			async execute(args: Record<string, any>, exec: ToolExec) {
				return toolExec(exec, args, async (session) => {
					await session.update({
						uid: String(args.uid),
						folder: args.folder,
						seen: args.seen,
						flagged: args.flagged,
						move: args.move,
					});
					return "Done.";
				});
			},
		}),
	];

	const trimRequests = (list: MailRequest[]): void => {
		while (list.length > MAX_REQUESTS) {
			const at = list.findIndex((entry) => entry.status !== "pending");
			list.splice(at === -1 ? 0 : at, 1);
		}
	};

	// Mail tools are registered only while at least one account exists.
	let toolsOn = false;
	const syncTools = (): void => {
		const want = hasAccounts();
		if (want === toolsOn) return;
		toolsOn = want;
		for (const tool of tools) {
			if (want) runtimeFn("addTeamTool")?.(tool);
			else runtimeFn("removeTeamTool")?.(tool.name);
		}
	};

	const tell = async (botId: string, text: string): Promise<void> => {
		if (rt.botOf(botId) === undefined) return;
		const deliver = runtimeFn("deliver");
		if (deliver === undefined) return;
		await deliver({ toId: botId, role: "mail", text }).catch((error: unknown) =>
			rt.warn("ocean-crew: mail note to %s failed: %s", botId, error),
		);
	};

	const applyRules = (patch: Record<string, any>): void => {
		const mail = mailOf();
		let allowed = [...(mail.allowedRecipients ?? [])];
		let noDraft = [...(mail.noDraftFor ?? [])];
		const addAddrs = (raw: unknown): void => {
			for (const addr of parseAddresses(Array.isArray(raw) ? raw.join(", ") : raw)) {
				if (!allowed.includes(addr)) allowed.push(addr);
			}
		};
		const dropAddrs = (raw: unknown): void => {
			const drop = new Set(parseAddresses(Array.isArray(raw) ? raw.join(", ") : raw));
			allowed = allowed.filter((addr) => !drop.has(addr));
		};
		if (patch.mode === "allow-recipient") {
			addAddrs(patch.recipients ?? patch.address ?? "");
			if (typeof patch.botId === "string") noDraft = noDraft.filter((id) => id !== patch.botId);
		} else if (patch.mode === "no-draft") {
			if (typeof patch.botId === "string" && rt.botOf(patch.botId) && !noDraft.includes(patch.botId))
				noDraft.push(patch.botId);
		} else if (patch.mode === "require-approval") {
			if (typeof patch.botId === "string") noDraft = noDraft.filter((id) => id !== patch.botId);
			if (patch.recipients || patch.address) dropAddrs(patch.recipients ?? patch.address);
		}
		if (patch.addRecipient) addAddrs(patch.addRecipient);
		if (patch.removeRecipient) dropAddrs(patch.removeRecipient);
		if (typeof patch.botId === "string" && typeof patch.noDraft === "boolean") {
			noDraft = patch.noDraft
				? rt.botOf(patch.botId) && !noDraft.includes(patch.botId)
					? [...noDraft, patch.botId]
					: noDraft
				: noDraft.filter((id) => id !== patch.botId);
		}
		state.connectors = {
			...(state.connectors ?? {}),
			mail: { ...mail, allowedRecipients: allowed, noDraftFor: noDraft },
		};
	};

	const endpoints: Record<string, (body: Record<string, any>) => Promise<unknown>> = {
		async "mail-account-add"(body) {
			const address = String(body.address ?? "")
				.trim()
				.toLowerCase();
			if (body.google === true) {
				if (!googleReady()) throw new Error("Google sign-in is not available in this build");
				if (address !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
					throw new Error("Enter an email address");
				return beginGoogle(address);
			}
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Enter an email address");
			const shared = adding.get(address);
			if (shared !== undefined) return shared;
			const pending = (async (): Promise<MailView> => {
				const password = String(body.password ?? "").trim();
				if (password === "") throw new Error("Enter the authorization code or app password");
				const preset = presetOf(address);
				const provider = typeof body.provider === "string" ? body.provider : (preset?.id ?? "other");
				const chosen = PRESETS.find((item) => item.id === provider);
				const imap =
					chosen && provider !== "other"
						? chosen.imap
						: {
								host: String(body.imapHost ?? "").trim(),
								port: Number(body.imapPort) || 993,
								secure: body.imapTls !== false,
							};
				const smtp =
					chosen && provider !== "other"
						? chosen.smtp
						: {
								host: String(body.smtpHost ?? "").trim(),
								port: Number(body.smtpPort) || 465,
								secure: body.smtpTls !== false,
							};
				if (imap.host === "" || smtp.host === "") throw new Error("Enter the IMAP and SMTP hosts");
				const existing = accountOf(address);
				const id = existing?.id ?? `m${randomUUID().slice(0, 8)}`;
				const account: MailAccount = {
					...existing,
					id,
					address,
					provider,
					auth: "password",
					imap,
					smtp,
					createdAt: existing?.createdAt ?? Date.now(),
				};
				delete account.error;
				// Log in once before saving, so a bad password never lands in state.
				const old = sessions.get(id);
				let session: MailSession;
				try {
					session = await openImap(account, password);
				} catch (error) {
					throw new Error(mailError(error));
				}
				await old?.close?.().catch(() => undefined);
				try {
					await host.secrets.writeSecret(mailSecretName(address, "PASSWORD"), password, `Mailbox ${address}`);
					await saveMail({ ...mailOf(), accounts: { ...accounts(), [id]: account } });
				} catch (error) {
					if (sessions.get(id) === session) sessions.delete(id);
					await session.close?.();
					throw error;
				}
				syncTools();
				return mailView();
			})();
			adding.set(address, pending);
			try {
				return await pending;
			} finally {
				adding.delete(address);
			}
		},
		async "mail-account-remove"(body) {
			const account = accountOf(body.id ?? body.address);
			if (account === undefined) throw new Error("No such account");
			await loadSecrets();
			// Secrets are per address; a duplicate row from before adds were merged still needs them.
			const shared = accountList().some((other) => other.id !== account.id && other.address === account.address);
			if (!shared) {
				for (const suffix of ["PASSWORD", "TOKEN", "REFRESH"]) {
					const name = mailSecretName(account.address, suffix);
					if (secretValue(name) !== undefined) {
						const endpoint = runtimeFn("secretEndpoint");
						if (endpoint !== undefined) await endpoint("secret-delete", { name }).catch(() => undefined);
					}
				}
			}
			const rest = { ...accounts() };
			delete rest[account.id];
			await saveMail({ ...mailOf(), accounts: rest });
			const session = sessions.get(account.id);
			sessions.delete(account.id);
			await session?.close?.().catch(() => undefined);
			dropGooglePending(account.address);
			syncTools();
			return mailView();
		},
		async "mail-rule-set"(body) {
			applyRules(body ?? {});
			await rt.save();
			return mailView();
		},
		async "mail-send-answer"(body) {
			const found = (() => {
				for (const [botId, list] of Object.entries(requestsOf())) {
					const request = list.find((entry) => entry.id === String(body.requestId ?? ""));
					if (request !== undefined) return { botId, request };
				}
				return undefined;
			})();
			if (found === undefined || found.request.status !== "pending")
				throw new Error("This card was already answered");
			const { botId, request } = found;
			if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)) {
				if (typeof body.fields.to === "string" && body.fields.to.trim() !== "") request.to = body.fields.to.trim();
				if (typeof body.fields.cc === "string") request.cc = body.fields.cc.trim();
				if (typeof body.fields.bcc === "string") request.bcc = body.fields.bcc.trim();
				if (typeof body.fields.subject === "string") request.subject = body.fields.subject.trim();
				if (typeof body.fields.body === "string") request.body = body.fields.body;
			}
			if (typeof body.rule === "string") {
				applyRules({
					mode: body.rule,
					botId,
					recipients: [request.to, request.cc, request.bcc].filter(Boolean).join(", "),
				});
			}
			if (body.choice !== "send") {
				request.status = "canceled";
				request.settledAt = Date.now();
				await rt.save();
				await tell(botId, `The user canceled sending "${request.subject}". Nothing was sent.`);
				return true;
			}
			const account = accounts()[request.account];
			if (account === undefined) {
				request.status = "failed";
				request.settledAt = Date.now();
				await rt.save();
				await tell(botId, `The account for "${request.subject}" is gone, so nothing was sent.`);
				return true;
			}
			try {
				const session = await connect(account);
				const attachments = (request.attachments ?? []).map((name) => {
					const inside = realpathSync(resolve(request.dir ?? "", name));
					if (
						request.dir === undefined ||
						(inside !== realpathSync(request.dir) && !inside.startsWith(realpathSync(request.dir) + sep))
					)
						throw new Error(`Attachment ${name} is outside the working folder`);
					return { filename: name, path: inside };
				});
				await session.send({
					to: request.to,
					cc: request.cc || undefined,
					bcc: request.bcc || undefined,
					subject: request.subject,
					text: request.body,
					attachments,
					...(request.replyTo ? { inReplyTo: request.replyTo } : {}),
				});
				request.status = "sent";
				request.settledAt = Date.now();
				await rt.save();
				await tell(botId, `The user sent "${request.subject}" to ${request.to} from ${account.address}.`);
			} catch (error) {
				request.status = "failed";
				request.settledAt = Date.now();
				request.error = host.reason(error);
				await rt.save();
				await tell(botId, `Sending "${request.subject}" failed: ${request.error}. You can try mail_send again.`);
			}
			return true;
		},
		async "mail-sign-in-code"(body) {
			return googleCode(body);
		},
	};

	// --- Google sign-in ------------------------------------------------------

	interface GooglePending {
		discovery: oauthDiscovery;
		address?: string;
		key: string;
		listener?: Server;
		redirectUri?: string;
		codeVerifier?: string;
		state?: string;
		url?: string;
	}
	const googlePendings = new Map<string, GooglePending>();
	const dropGooglePending = (key: string): void => {
		const pending = googlePendings.get(key);
		if (pending === undefined) return;
		googlePendings.delete(key);
		pending.listener?.close();
	};
	async function beginGoogle(address: string): Promise<MailView> {
		const client = googleClient();
		const discovery = await discover("https://accounts.google.com", {
			originFallback: true,
			fetch: mailConfig().fetch ?? fetch,
		});
		dropGooglePending(address);
		const pending: GooglePending = { discovery, address: address || undefined, key: address };
		googlePendings.set(address, pending);
		const listener = createServer((req, res) => {
			req.on("error", () => res.destroy());
			res.on("error", () => req.destroy());
			let url: URL;
			try {
				url = new URL(req.url ?? "/", "http://127.0.0.1");
			} catch {
				res.writeHead(400);
				res.end();
				return;
			}
			if (url.pathname !== "/callback") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			if (!url.searchParams.get("code")) {
				res.end(
					'<p style="font-family:sans-serif">Google sign-in did not finish — go back to Ocean Crew and try again.</p>',
				);
				rt.warn("ocean-crew: mail Google sign-in failed: %s", url.searchParams.get("error") ?? "no code");
				return;
			}
			res.end('<p style="font-family:sans-serif">Signed in — you can close this tab.</p>');
			void googleCode({ address, input: url.toString() }).catch((error: unknown) =>
				rt.warn("ocean-crew: mail Google sign-in failed: %s", host.reason(error)),
			);
		});
		listener.on("error", (error) => {
			if (listener.listening)
				rt.warn(
					"ocean-crew: mail Google sign-in listener failed: %s",
					(error as NodeJS.ErrnoException).code ?? "error",
				);
		});
		await new Promise<void>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(0, "127.0.0.1", resolve);
		});
		pending.listener = listener;
		const port = (listener.address() as { port: number }).port;
		pending.redirectUri = `http://127.0.0.1:${port}/callback`;
		const stateParam = randomUUID();
		const { url, codeVerifier } = await beginBrowser(
			discovery,
			{ client_id: String(client.id), client_secret: client.secret },
			pending.redirectUri,
			{ state: stateParam, scope: GOOGLE_SCOPES },
		);
		pending.codeVerifier = codeVerifier;
		pending.state = stateParam;
		pending.url = url;
		return mailView();
	}
	async function googleCode(body: Record<string, any>): Promise<MailView> {
		const address = String(body.address ?? "").toLowerCase();
		const pending = googlePendings.get(address) ?? [...googlePendings.values()][0];
		if (pending === undefined) throw new Error("No Google sign-in is waiting");
		const input = String(body.input ?? "").trim();
		const url = /^https?:/i.test(input) ? new URL(input) : undefined;
		const code = url ? url.searchParams.get("code") : input;
		if (!code) throw new Error("The address has no code");
		const given = url?.searchParams.get("state");
		if (given !== null && given !== undefined && pending.state !== undefined && given !== pending.state)
			throw new Error("The sign-in answer is not for this attempt");
		googlePendings.delete(pending.key);
		pending.listener?.close();
		const client = googleClient();
		const tokens = await exchange(
			pending.discovery,
			{ client_id: String(client.id), client_secret: client.secret },
			{
				code,
				codeVerifier: pending.codeVerifier ?? "",
				redirectUri: pending.redirectUri ?? "",
				iss: url?.searchParams.get("iss") ?? undefined,
			},
			{ fetch: mailConfig().fetch },
		);
		const email = pending.address || (await googleEmail(tokens.access_token));
		const id = `g${randomUUID().slice(0, 8)}`;
		const account: MailAccount = { id, address: email, provider: "gmail", auth: "google", createdAt: Date.now() };
		await saveMail({ ...mailOf(), accounts: { ...accounts(), [id]: account } });
		await host.secrets.writeSecret(mailSecretName(email, "TOKEN"), tokens.access_token, `Mailbox ${email}`);
		if (typeof tokens.refresh_token === "string")
			await host.secrets.writeSecret(mailSecretName(email, "REFRESH"), tokens.refresh_token, `Mailbox ${email}`);
		await rt.save();
		syncTools();
		return mailView();
	}
	async function googleEmail(token: string): Promise<string> {
		const response = await (mailConfig().fetch ?? fetch)("https://openidconnect.googleapis.com/v1/userinfo", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const body = (await response.json().catch(() => ({}))) as { email?: unknown };
		if (typeof body.email !== "string") throw new Error("Google did not say which account this is");
		return body.email.toLowerCase();
	}

	const mailView = (): MailView => ({
		accounts: accountList().map((account) => ({
			id: account.id,
			address: account.address,
			provider: account.provider,
			auth: account.auth,
			state: account.error ? "error" : "ready",
			...(account.error ? { error: account.error } : {}),
		})),
		google: googleReady(),
		allowedRecipients: mailOf().allowedRecipients ?? [],
		noDraftFor: mailOf().noDraftFor ?? [],
		...(googlePendings.size > 0
			? {
					pending: [...googlePendings.values()].map((pending) => ({
						kind: "browser" as const,
						url: pending.url,
						address: pending.address,
					})),
				}
			: {}),
	});

	syncTools();

	return {
		hasAccounts,
		mailView,
		connect,
		async endpoint(name, body) {
			await loadSecrets();
			const endpoint = endpoints[name];
			if (endpoint === undefined) throw new Error(`Unknown endpoint ${name}`);
			return endpoint(body ?? {});
		},
		async dispose() {
			const live = [...sessions.values()];
			sessions.clear();
			for (const pending of googlePendings.values()) pending.listener?.close();
			googlePendings.clear();
			await Promise.all(live.map((session) => session.close?.().catch(() => undefined)));
		},
		_internals: { sessions, refreshGoogle, mailSecretName },
	};
}

function mailError(error: unknown): string {
	const candidate = error as { responseText?: unknown; message?: unknown; authenticationFailed?: unknown };
	const text = String(candidate?.responseText ?? candidate?.message ?? error);
	if (/Unsafe Login/i.test(text))
		return "The mail service refused the login (Unsafe Login). Enable IMAP/SMTP in the mailbox settings and use its authorization code, not the account password.";
	if (candidate?.authenticationFailed === true || /Login fail|authentication|invalid credentials|535|534/i.test(text))
		return "The password was refused. Use the mailbox app password or authorization code, not the account password.";
	const unreachable = /\b(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b\s*(\S+)?/.exec(text);
	if (unreachable)
		return unreachable[1]
			? `Could not reach the mail server at ${unreachable[1]}. Check the server address.`
			: "Could not reach the mail server. Check the server address.";
	return text.slice(0, 300);
}
