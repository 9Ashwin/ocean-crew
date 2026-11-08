// The actions every window that draws the Bot views shares: dialogs and panels (the `ui`
// source), requests to the host, and the notes the transcript keeps. The shell around the
// views adds navigation and its own panels. `after` reads the team again once a request is
// done; `partFor` maps a Bot id, or any part of its chat, to its current part.
import { noteClientError } from "../core/diagnostics.ts";
import type { CardCounts, RosterView, Source } from "./sources.ts";
import { countCards, heldCardKey } from "./sources.ts";

/** A request to the `api/bot` channel; the shell's own `call` does the transport. */
export type HostCall = (endpoint: string, payload?: unknown) => Promise<any>;

/** The state cell of the shell panel. */
export interface UiStateSource {
	set(next: (state: any) => any): void;
	getSnapshot?(): any;
}

export interface TeamActionsInput {
	call: HostCall;
	after: <T>(promise: Promise<T>) => Promise<T>;
	partFor: (id: string) => string;
	roster: Source<RosterView>;
	ui: UiStateSource;
	live: Source<any>;
	cards: Source<CardCounts>;
	heldCards: Source<CardCounts>;
	turnClock: Source<any>;
	panelFolded?: (view: string) => boolean;
}

export function teamActions({
	call,
	after,
	partFor,
	roster,
	ui,
	live,
	cards,
	heldCards,
	turnClock,
	panelFolded,
}: TeamActionsInput) {
	// A memory is a Bot's or a group chat's; both are opened by id.
	const memoryOf = (id: string) => (roster.getSnapshot().roomsById[id] ? { roomId: id } : { botId: id });
	// An action that shows the panel lands the yield with it: when a folded panel's explicit
	// opener fires, the column gives way in the same set. `view` is the next view, since its
	// minimum decides what fits; a yield already given stays.
	const yieldTo = (state: any, view: string): boolean => state.panelYield === true || panelFolded?.(view) === true;
	// The panel on a side chat's view, on the chat the strip tab or menu named.
	const openSideChat = (sessionId: string, chatId?: string | null) => {
		ui.set((state) => ({
			...state,
			details: sessionId,
			view: "side",
			side: chatId ?? null,
			renaming: false,
			tab: null,
			panelYield: yieldTo(state, "side"),
		}));
	};
	// `id` opens one Bot (page 'bots') or one group chat (page 'groups').
	const openSettings = (page = "general", id: string | null = null) => {
		ui.set((state) => ({ ...state, settings: { page, id }, menu: null, palette: null, newChat: null }));
	};
	return {
		openNewChat: (mode: string) => {
			ui.set((state) => ({ ...state, newChat: mode, menu: null, palette: null }));
		},
		openPalette: (query = "") => {
			ui.set((state) => ({ ...state, palette: { query, token: Date.now() }, newChat: null, menu: null }));
		},
		// The token keeps a late exit timer from closing a palette opened again since.
		closePalette: (token?: number) => {
			ui.set((state) =>
				state.palette && (token === undefined || state.palette.token === token)
					? { ...state, palette: null }
					: state,
			);
		},
		openExchange: (a?: string, b?: string) => {
			if (a && b) ui.set((state) => ({ ...state, exchange: [a, b] }));
		},
		closeVoice: () => {
			ui.set((state) => (state.voice ? { ...state, voice: null } : state));
		},
		toggleDetails: (id: string, force?: boolean) => {
			ui.set((state) => {
				const details = force || state.details !== id || state.view !== "details" ? id : null;
				// A folded panel is open but not shown: its opener then means "show it" (the
				// column yields it room), not "close it".
				if (details === null && panelFolded?.("details") === true) {
					return { ...state, renaming: false, tab: null, details: id, view: "details", panelYield: true };
				}
				return { ...state, renaming: false, tab: null, details, view: "details" };
			});
		},
		// The open panel follows the main view; a subject with no browser (a group chat, an
		// outside Session) settles on the details view. So does one that does not own the open
		// side chat.
		followPanel: (id: string) => {
			ui.set((state) => {
				if (!state.details || state.details === id) return state;
				const snap = roster.getSnapshot();
				const view =
					state.view === "browser" && snap.byId[id] === undefined
						? "details"
						: state.view === "side" &&
								!(snap.sideChats?.[snap.byId[id]?.id] ?? []).some((chat: any) => chat?.id === state.side)
							? "details"
							: state.view;
				return { ...state, details: id, view, renaming: false, tab: null };
			});
		},
		showDetails: (id: string, tab: string | null = null) => {
			ui.set((state) => ({
				...state,
				details: id,
				view: "details",
				renaming: false,
				tab,
				panelYield: yieldTo(state, "details"),
			}));
		},
		// Opening the conversation would move focus to its composer and blur the name field.
		renameBot: (id: string) => {
			ui.set((state) => ({
				...state,
				details: id,
				view: "details",
				renaming: true,
				tab: null,
				panelYield: yieldTo(state, "details"),
			}));
		},
		openSettings,
		// Ocean Crew's own Models page: the providers DSH serves, their keys and models.
		openModels: () => openSettings("models"),
		closeSettings: () => {
			ui.set((state) => (state.settings ? { ...state, settings: null } : state));
		},
		openMemory: (id: string) => {
			ui.set((state) => ({ ...state, memory: id, menu: null, palette: null }));
		},
		closeMemory: () => {
			ui.set((state) => (state.memory ? { ...state, memory: null } : state));
		},
		openConnectors: () => {
			ui.set((state) => ({
				...state,
				settings: { page: "connectors", id: null },
				menu: null,
				palette: null,
				newChat: null,
			}));
		},
		setPanelView: (view: string) => {
			if (view !== "details" && view !== "browser" && view !== "side") return;
			ui.set((state) =>
				state.details && state.view !== view ? { ...state, view, panelYield: yieldTo(state, view) } : state,
			);
		},
		// A side chat on the panel's own view, opened from the strip, the `···` menus or
		// `/side`. Closing the panel keeps the chats; only a tab's × deletes.
		openSideChat,
		// The roster is pulled before the panel opens on a new chat: a view on a chat the
		// roster does not hold yet folds back into details.
		newSideChat: async (sessionId: string) => {
			const value = await after(call("side-new", { sessionId }));
			openSideChat(sessionId, value?.chatId);
			return value;
		},
		sideCall: (name: string, body: unknown) => after(call(name, body)),
		askSide: (sessionId: string, chatId: string, text: string) =>
			after(call("side-ask", { sessionId, chatId, text })),
		cancelSide: (chatId: string, entryId: string) => after(call("side-cancel", { chatId, entryId })),
		closeSideChat: (chatId: string) => {
			ui.set((state) =>
				state.details && state.view === "side" && state.side === chatId
					? { ...state, view: "details", side: null }
					: state,
			);
			return after(call("side-close", { chatId }));
		},
		closePanel: () => {
			ui.set((state) =>
				state.details
					? { ...state, details: null, view: "details", renaming: false, tab: null, side: null }
					: state,
			);
		},
		quote: (sessionId: string, text: string) => {
			ui.set((state) => ({ ...state, quote: { sessionId, text, token: Date.now() } }));
		},
		clearQuote: (token: number) => {
			ui.set((state) => (state.quote?.token === token ? { ...state, quote: null } : state));
		},
		setFlags: (id: string, flags: Record<string, unknown>) => after(call("set-flags", { id, ...flags })),
		deleteRoom: (id: string) => after(call("delete-room", { id })),
		openMenu: (menu: unknown) => {
			ui.set((state) => ({ ...state, menu, palette: null }));
		},
		closeMenu: () => {
			ui.set((state) => (state.menu ? { ...state, menu: null } : state));
		},
		closeOverlay: () => {
			ui.set((state) => ({
				...state,
				newChat: null,
				exchange: null,
				details: state.newChat || state.exchange ? state.details : null,
			}));
		},
		createBot: (payload: unknown) => after(call("create-bot", payload)),
		// The avatar library: photos the user imported once, kept by the host.
		avatarLibrary: (options: unknown = {}) => call("avatar-library", options),
		importAvatars: (items: unknown[]) => call("avatar-import", { items }),
		deleteAvatar: (id: string) => call("avatar-delete", { id }),
		createRoom: (members: string[], options: Record<string, unknown> = {}) =>
			after(call("create-room", { members, ...options })),
		updateBot: (id: string, patch: Record<string, unknown>) => after(call("update-bot", { id, ...patch })),
		refreshModels: () => after(call("models")).catch(() => {}),
		// One local agent's models: the first look starts its CLI, later ones read what it said.
		agentModels: (route: unknown) => after(call("local-agent-models", { route })).catch(() => {}),
		efforts: (ref: string) => call("efforts", { ref }),
		// Model providers and their API keys; DSH keeps them, and a key only travels to the host.
		providers: () => call("providers"),
		setProviderKey: (provider: string, value: string | null) => after(call("provider-key", { provider, value })),
		addProvider: (body: unknown) => after(call("provider-add", body)),
		providerModels: (body: unknown) => call("provider-models", body),
		removeProvider: (provider: string) => after(call("provider-remove", { provider })),
		// After a failed turn: the Bot answers the user's last unanswered message, which is
		// never sent again.
		resume: (botId: string) => after(call("resume", { botId })),
		folders: () => call("folders"),
		folderPick: () => call("folder-pick"),
		folderList: (path?: string) => call("folder-list", { path: path ?? "" }),
		setTeamWorkspace: (path: string) => after(call("team-workspace", { path })),
		resetTeam: () => after(call("reset-team", {})),
		deleteBot: (id: string) => after(call("delete-bot", { id })),
		releasePrivate: (id: string) => after(call("private-release", { id })),
		duplicateBot: (id: string) => after(call("duplicate-bot", { id })),
		setPrefs: (prefs: unknown) => after(call("set-prefs", prefs)),
		setMain: (id: string, main = true, options: Record<string, unknown> = {}) =>
			after(call("set-main", { id, main, ...options })),
		updateRoom: (id: string, patch: Record<string, unknown>) => after(call("update-room", { id, ...patch })),
		send: (sessionId: string, text: string) => after(call("send", { sessionId: partFor(sessionId), text })),
		answerQuestion: (sessionId: string, questionId: string, answer: unknown) =>
			after(call("answer-question", { sessionId: partFor(sessionId), questionId, answer })),
		dismissQuestion: (sessionId: string) => after(call("dismiss-question", { sessionId })),
		answerView: (sessionId: string, viewId: string, action: unknown, values: unknown) =>
			after(call("view-reply", { sessionId: partFor(sessionId), viewId, action, values })),
		dismissView: (sessionId: string) => after(call("dismiss-view", { sessionId: partFor(sessionId) })),
		deleteBtw: (sessionId: string, cardId: string) => after(call("btw-delete", { sessionId, cardId })),
		answerApproval: (id: string, choice: unknown) => after(call("approval-answer", { id, choice })),
		computerSetEnabled: (enabled: boolean) => after(call("computer-set-enabled", { enabled })),
		computerSetLevel: (botId: string, level: unknown) => after(call("computer-set-level", { botId, level })),
		computerRevokeApp: (botId: string, appKey: string) => after(call("computer-revoke-app", { botId, appKey })),
		computerProviderRetry: () => after(call("computer-provider-retry", {})),
		computerSystemStatus: () => call("computer-system-status", {}),
		computerPermission: (permission: unknown) => call("computer-permission", { permission }),
		computerStop: (botId: string, all = false) => after(call("computer-stop", all ? { all: true } : { botId })),
		computerTakeover: (botId: string) => after(call("computer-takeover", { botId })),
		computerHandback: (botId: string) => after(call("computer-handback", { botId })),
		computerAllowForeground: (botId: string) => call("computer-allow-foreground", { botId }),
		computerAppAnswer: (id: string, answer: unknown) => call("computer-app-answer", { id, answer }),
		computerHoldAnswer: (botId: string, { callId, outcome }: { callId?: string; outcome?: unknown } = {}) =>
			after(call("computer-hold-answer", { botId, ...(callId !== undefined ? { callId } : {}), outcome })),
		computerShot: (attachmentId: string) => call("computer-shot", { attachmentId }),
		computerUserActive: (idleSeconds: number) => call("computer-user-active", { idleSeconds }),
		stopMemberWork: (roomId: string, botId: string) => after(call("stop-member-work", { roomId, botId })),
		stopRoomWork: (roomId: string) => after(call("stop-room-work", { roomId })),
		goalDraft: (roomId: string, text: string) => after(call("goal-draft", { roomId, text })),
		goalControl: (roomId: string, goalId: string, action: string, stopWork?: boolean) =>
			after(call("goal-control", { roomId, goalId, action, ...(stopWork ? { stopWork: true } : {}) })),
		// The goal island: `goalCompose` holds the room whose draft form is open, `goalOpen`
		// the room whose panel is open.
		composeGoal: (roomId: string) => {
			ui.set((state) => ({ ...state, goalCompose: roomId, goalOpen: roomId }));
		},
		closeGoalCompose: () => {
			ui.set((state) => (state.goalCompose ? { ...state, goalCompose: null } : state));
		},
		toggleGoal: (roomId: string) => {
			ui.set((state) => ({ ...state, goalOpen: state.goalOpen === roomId ? null : roomId }));
		},
		closeGoal: () => {
			ui.set((state) => (state.goalOpen ? { ...state, goalOpen: null } : state));
		},
		// Values go out in these requests and never come back in a response.
		secretSet: (payload: unknown) => after(call("secret-set", payload)),
		secretAllow: (requestId: string) => after(call("secret-allow", { requestId })),
		secretCancel: (requestId: string) => after(call("secret-cancel", { requestId })),
		secretUpdate: (name: string, { scope, purpose }: { scope?: unknown; purpose?: unknown } = {}) =>
			after(call("secret-update", { name, scope, purpose })),
		secretDelete: (name: string) => after(call("secret-delete", { name })),
		connectorConnect: (id: string, payload: Record<string, unknown> = {}) =>
			after(call("connector-connect", { id, ...payload })),
		connectorDisconnect: (id: string) => after(call("connector-disconnect", { id })),
		connectorRetry: (id: string) => after(call("connector-retry", { id })),
		connectorSignInCode: (id: string, input: unknown) => after(call("connector-sign-in-code", { id, input })),
		connectorCancel: (id: string) => after(call("connector-cancel", { id })),
		connectorClient: (id: string, clientId: string, clientSecret: string) =>
			after(call("connector-client", { id, clientId, clientSecret })),
		connectorSet: (id: string, patch: Record<string, unknown>) => after(call("connector-set", { id, ...patch })),
		connectorAdd: (spec: unknown) => after(call("connector-add", spec)),
		connectorRemove: (id: string) => after(call("connector-remove", { id })),
		connectorImportScan: () => call("connector-import-scan", {}),
		connectorImport: (items: unknown[]) => after(call("connector-import", { items })),
		connectorRequestCancel: (requestId: string) => after(call("connector-request-cancel", { requestId })),
		mailAccountAdd: (payload: unknown) => after(call("mail-account-add", payload)),
		mailAccountRemove: (id: string) => after(call("mail-account-remove", { id })),
		mailRuleSet: (payload: unknown) => after(call("mail-rule-set", payload)),
		mailSendAnswer: (requestId: string, choice: unknown, extra: Record<string, unknown> = {}) =>
			after(call("mail-send-answer", { requestId, choice, ...extra })),
		mailSignInCode: (payload: unknown) => after(call("mail-sign-in-code", payload)),
		imAdd: (payload: unknown) => after(call("im-add", payload)),
		imUpdate: (id: string, patch: Record<string, unknown>) => after(call("im-update", { id, ...patch })),
		imRemove: (id: string) => after(call("im-remove", { id })),
		imPair: (id: string, senderId: string, allow: boolean) => after(call("im-pair", { id, senderId, allow })),
		imUnpair: (id: string, senderId: string) => after(call("im-unpair", { id, senderId })),
		imChat: (id: string, body: Record<string, unknown>) => after(call("im-chat", { id, ...body })),
		imRetry: (id: string) => after(call("im-retry", { id })),
		imLoginStart: (payload: unknown) => call("im-login-start", payload),
		imLoginWait: (payload: unknown) => call("im-login-wait", payload),
		saveCapability: (capability: unknown) => after(call("capability-save", capability)),
		deleteCapability: (name: string) => after(call("capability-delete", { name })),
		approveCapability: (name: string) => after(call("capability-approve", { name })),
		setBotCapability: (botId: string, name: string, attached: boolean) =>
			after(call("bot-capability", { botId, name, attached })),
		schedules: () => call("schedules"),
		scheduleCreate: (task: unknown) => call("schedule-create", task),
		scheduleDelete: (sessionId: string, id: string) => call("schedule-delete", { sessionId, id }),
		exchange: (a: string, b: string) => call("exchange", { a, b }).catch(() => []),
		exchangeText: (id: string) => call("exchange-text", { id }).catch(() => undefined),
		fileText: (file: unknown) => call("file-text", { file }).catch(() => undefined),
		roomProgress: (roomId: string) => call("room-progress", { roomId }).catch(() => []),
		earlier: (sessionId: string, cursor?: string | null) => call("earlier", { sessionId, cursor: cursor ?? null }),
		// Hours come back in this browser's time zone, so days start at local midnight.
		usage: () => call("usage", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
		// `summarize` starts a summary when the entries changed; `regenerate` always does.
		memoryView: (id: string, flags: Record<string, unknown> = {}) =>
			call("memory-view", { ...memoryOf(id), ...flags }),
		memoryAsk: (id: string, text: string) => call("memory-ask", { ...memoryOf(id), text }),
		memoryForget: (id: string, entry: { scope: unknown; topic: unknown; text: unknown }) =>
			call("memory-forget", { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text }),
		memoryHistory: (id: string, before?: unknown) =>
			call("memory-history", { ...memoryOf(id), ...(before === undefined ? {} : { before }) }),
		memoryRestore: (id: string, rowId: string) => call("memory-restore", { ...memoryOf(id), id: rowId }),
		diagnostics: (payload: unknown) => call("diagnostics", payload),
		diagnosticsLog: () => call("diagnostics-log"),
		diagnosticsClear: () => call("diagnostics-clear"),
		repoStars: () => call("repo-stars"),
		// A failed action away from any form (a menu, the palette) shows as a toast.
		reportError: (error: any, where = "action") => {
			noteClientError(where, error);
			ui.set((state) => ({ ...state, toast: { text: error?.message ?? String(error), token: Date.now() } }));
		},
		dismissToast: (token?: number) => {
			ui.set((state) =>
				state.toast && (token === undefined || state.toast.token === token) ? { ...state, toast: null } : state,
			);
		},
		noteTurnTime: (sessionId: string | undefined, turn: number, key: "first" | "last", time: number) => {
			if (sessionId === undefined || !Number.isFinite(turn) || !Number.isFinite(time)) return;
			turnClock.set((state: any) => {
				const turns = state[sessionId] ?? {};
				const entry = turns[turn] ?? {};
				const next = key === "first" && entry.first !== undefined ? Math.min(entry.first, time) : time;
				if (entry[key] === next) return state;
				return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, [key]: next } } };
			});
		},
		noteTurnPeer: (sessionId: string | undefined, turn: number, peerId: string) => {
			if (sessionId === undefined || !Number.isFinite(turn)) return;
			turnClock.set((state: any) => {
				const turns = state[sessionId] ?? {};
				const entry = turns[turn] ?? {};
				if (entry.peer === peerId) return state;
				return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, peer: peerId } } };
			});
		},
		noteLive: (sessionId: string | undefined, id: string, entry: any) => {
			if (sessionId === undefined) return;
			live.set((state: any) => {
				const own = state[sessionId] ?? {};
				const prev = own[id];
				if (
					entry === null
						? prev === undefined
						: prev !== undefined && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 })
				)
					return state;
				const next = { ...own };
				if (entry === null) delete next[id];
				else next[id] = { ...entry, at: prev?.at ?? Date.now() };
				return { ...state, [sessionId]: next };
			});
		},
		noteCards: (sessionId: string | undefined, callIds: string[], delta: number) => {
			if (sessionId !== undefined) cards.set((state: CardCounts) => countCards(state, sessionId, callIds, delta));
		},
		noteHeldCard: (sessionId: string | undefined, kind: string, requestId: string, delta: number) => {
			if (sessionId !== undefined) {
				heldCards.set((state: CardCounts) => countCards(state, sessionId, [heldCardKey(kind, requestId)], delta));
			}
		},
		clearLive: (sessionId: string) => {
			live.set((state: any) => {
				if (!state[sessionId]) return state;
				const next = { ...state };
				delete next[sessionId];
				return next;
			});
		},
	};
}
