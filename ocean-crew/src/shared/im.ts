// An IM adapter speaks one platform and nothing else: pairing, routing, cards,
// queues and retries belong to the host. Two private-chat platforms are kept.

import type { ImPlatformId } from "./state.ts";

export interface ImChat {
	key: string;
	kind: "direct" | "group";
	title: string;
}

export interface ImSender {
	id: string;
	name: string;
}

export interface ImMessage {
	chat: ImChat;
	sender: ImSender;
	text: string;
	images?: { mediaType: string; data: string }[];
	files?: { name: string; data: Uint8Array }[];
	mentioned?: boolean;
	messageId?: string;
}

/** One attachment an answer sends out: its kind, its name and its bytes. */
export interface ImMedia {
	kind: "image" | "file";
	name: string;
	mime?: string;
	data: Uint8Array;
	/** Ask the platform for a voice message; a platform that cannot draw one sends a file. */
	voice?: boolean;
}

export interface ImAction {
	chat: ImChat;
	sender: ImSender;
	data: string;
	messageId?: string;
	/** Values a card form collected for the pressed button, by component name. */
	form?: Record<string, unknown>;
}

export type ImStatusState = "connecting" | "ready" | "error";

export interface ImStatus {
	state: ImStatusState;
	error?: string;
	account?: { id: string; name: string };
}

export interface ImHandlers {
	onMessage(message: ImMessage): void;
	onAction(action: ImAction): void;
	onStatus(status: ImStatus): void;
}

export interface ImButton {
	label: string;
	data: string;
}

/** One input a card form shows; its name is how the answer names it. */
export interface ImCardField {
	kind: "text" | "multi" | "select";
	name: string;
	label: string;
	options?: string[];
	initial?: string | string[];
	multiline?: boolean;
}

/** A card form: what to collect, and the button that submits or cancels it. */
export interface ImCardForm {
	fields: ImCardField[];
	submit: ImButton;
	cancel?: ImButton;
}

export interface ImSendResult {
	messageId?: string;
}

export interface ImAdapter {
	check(fields: Record<string, string>, env: ImEnv): Promise<{ account: { id: string; name: string } }>;
	connect(fields: Record<string, string>, env: ImEnv, handlers: ImHandlers): ImHandle;
	send(
		chat: ImChat,
		message: {
			text: string;
			buttons?: ImButton[];
			media?: ImMedia[];
			card?: boolean;
			title?: string;
			form?: ImCardForm;
		},
	): Promise<ImSendResult>;
	edit?(chat: ImChat, messageId: string, message: { text: string; buttons?: ImButton[] }): Promise<void>;
}

export interface ImHandle {
	stop(): void;
}

// The adapter's only outside channels. Shapes stay minimal so the types do not
// depend on a DOM lib: adapters run in the host's Node process.
export interface ImFetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export interface ImWebSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(event: string, listener: (event: unknown) => void): void;
}

export interface ImEnv {
	fetch(
		input: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string },
	): Promise<ImFetchResponse>;
	WebSocket: new (url: string) => ImWebSocket;
	config: Record<string, unknown>;
	log: { warn(message: string, ...args: unknown[]): void };
	runtime: { get(): unknown; set(patch: unknown): void };
}

export type PlatformAdapters = Partial<Record<ImPlatformId, ImAdapter>>;
