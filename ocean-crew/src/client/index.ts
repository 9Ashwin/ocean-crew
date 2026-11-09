// The client half. DSH loads this module and calls `apply(ctx)`; it paints the Ocean Crew
// surface over the desktop window, polls the host for the team and hands every view its
// sources and actions.
// DSH's slots are a public shape, and another plugin may share a cell with us.

import { noticeApprovals } from "./chat/approval-notices.ts";
import { BtwDock, BtwTurnTail } from "./chat/btw.ts";
import {
	AssistantCell,
	CellEmpty,
	Nothing,
	ToolCell,
	TriggerCell,
	TurnProcessCell,
	TurnTailCell,
} from "./chat/cells.ts";
import { CONNECTOR_CSS, ConnectorDock, MailDock } from "./chat/connectors.ts";
import { LEARNING_CSS, LearningDock, LearningTurnTail } from "./chat/learning-card.ts";
import { MEMBER_CSS, MemberDock } from "./chat/member-status.ts";
import { QuestionCard, QuestionDock } from "./chat/questions.ts";
import { SECRET_CSS, SecretDock } from "./chat/secret-card.ts";
import { SIDE_CSS, sideSource } from "./chat/side-chat.ts";
import { FailureCell, TURN_ERROR_CSS } from "./chat/turn-error.ts";
import { canDrawUserMessages, USER_MESSAGE_CSS, UserMessageCell } from "./chat/user-message.ts";
import { AnsweredReply, WIDGET_CSS, WidgetDock } from "./chat/widget-cell.ts";
import { call } from "./core/api.ts";
import { noteClientError, quietly } from "./core/diagnostics.ts";
import { installLocale, language, t } from "./core/i18n.ts";
import { STORAGE } from "./core/storage.ts";
import { currentPart, MENTION_ORIGIN } from "./core/text.ts";
import { DEFAULT_MASK, markupCache, maskOf, SHAPES } from "./look/characters.ts";
import { inkText, isHex, paintCss } from "./look/inks.ts";
import { lookOf } from "./look/mark.ts";
import { CONVERSATION_CSS, installCompiledStyles, installStyles, SHELL_CSS } from "./look/styles.ts";
import {
	allThemes,
	flatWidthOf,
	layoutOf,
	registerShape,
	registerTheme,
	registry,
	shellTokens,
	themeCss,
	widthOf,
} from "./look/themes.ts";
import { ABOUT_CSS } from "./pages/about.ts";
import { AGENT_CARDS_CSS } from "./pages/agent-cards.ts";
import { AVATAR_LIBRARY_CSS } from "./pages/avatar-library.ts";
import { BOT_SETTINGS_CSS } from "./pages/bot-settings.ts";
import { CONNECTORS_PAGE_CSS } from "./pages/connectors-page.ts";
import { sameVersion } from "./pages/dsh-offer.ts";
import { ErrorToast, FEEDBACK_CSS } from "./pages/feedback.ts";
import { FOLDER_CSS } from "./pages/folder-menu.ts";
import { GOAL_CSS } from "./pages/goal.ts";
import { GROUP_SETTINGS_CSS } from "./pages/group-settings.ts";
import { IM_CSS } from "./pages/im-page.ts";
import { DeepSeekSignIn, MODEL_CSS, ModelChoiceDock } from "./pages/model-menu.ts";
import { PANEL_CSS } from "./pages/panel.ts";
import { SCHEDULE_CSS } from "./pages/schedules.ts";
import { atSources, CHATS_SOURCE } from "./shell/at-menu.ts";
import { ComposerPlus, menuIcons } from "./shell/composer.ts";
import { steerQueued } from "./shell/enter-steer.ts";
import { DSH_NARROW, frameLayout, readSidebar, toggledPref, writeSidebar } from "./shell/frame-layout.ts";
import { installFrameWatch } from "./shell/frame-watch.ts";
import { HeaderPill } from "./shell/header.ts";
import { installHeaderNavigation } from "./shell/header-navigation.ts";
import { listedOpener } from "./shell/open-listed.ts";
import { Overlays } from "./shell/overlays.ts";
import { QUEUE_CSS, QueueDock } from "./shell/queue-dock.ts";
import {
	columnOpened,
	createSwitchWindow,
	drawerOpened,
	RIGHTBAR_ATTRIBUTES,
	rightColumnOpen,
} from "./shell/right-panel.ts";
import { noteLeft, setUnread, sharedMap, toggleReaction } from "./shell/shared-map.ts";
import {
	AccountLauncher,
	BotReturn,
	BrandMark,
	BrandName,
	FooterAccount,
	holdShellShortcuts,
	MODELS_STEP,
	MODELS_STEP_ORDER,
	OpenModelsStep,
	openHarnessOnboarding,
	openHarnessSettings,
	RETURN_CSS,
	SIDEBAR_CSS,
	TeamSidebar,
	YouAvatar,
} from "./shell/sidebar.ts";
import { createSource, EMPTY_ROSTER, indexRoster, isAgentSession } from "./shell/sources.ts";
import { freePriority, groupsFor, readMode, surfaceGroups, writeMode } from "./shell/surface.ts";
import { teamActions } from "./shell/team-actions.ts";

export const inject = ["sessions", "uiWorkspace", "uiConversation", "slots", "theme", "layout"] as const;

// DSH's client context is not typed by this package yet; the host type check has the DOM
// and React environments, and this entry only runs inside the window.
type ClientContext = any;

export function apply(ctx: ClientContext): void {
	ctx.effect(() => installLocale(ctx.get("locale")), "ocean-crew: interface copy");
	// The window's cached prefs stand in until the first pull answers: a saved
	// `enterToSend: false` then already holds, instead of Enter sending meanwhile.
	const PREFS_KEY = STORAGE.prefs;
	let savedPrefs: Record<string, any> = {};
	try {
		savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
	} catch {
		savedPrefs = {};
	}
	const roster = createSource({ ...EMPTY_ROSTER, prefs: savedPrefs });
	const unreadStore = sharedMap(STORAGE.unread);
	const reactionStore = sharedMap(STORAGE.reactions);
	// When each conversation was last left; a visit compares new turns against it.
	const seenStore = sharedMap(STORAGE.seen);
	let seenAt = seenStore.read();
	// `details` is the panel's subject (a Session id); `view` picks details or a side chat.
	const ui = createSource({
		details: null,
		view: "details",
		renaming: false,
		tab: null,
		side: null,
		newChat: null,
		exchange: null,
		menu: null,
		voice: null,
		palette: null,
		quote: null,
		settings: null,
		memory: null,
		toast: null,
		signIn: null,
		renameAgent: null,
		unread: unreadStore.read(),
		reactions: reactionStore.read(),
		visits: {},
		panelYield: false,
		leftDrawer: false,
		bootFailed: false,
		goalCompose: null,
		goalOpen: null,
	});
	// The left column's kept preference, and the frame geometry the layout rules read: the
	// window and the shell's collapsed track come from installFrameWatch, the open column's
	// width is the user's own.
	let sidebarSaved = readSidebar();
	const sidebarPref = createSource(sidebarSaved.pref);
	const frame = createSource({
		viewport: typeof window === "undefined" ? 0 : window.innerWidth,
		sidebarWidth: sidebarSaved.width,
		collapsedWidth: 0,
		collapsed: false,
	});
	// Bot mode paints the whole team surface; Agent mode withdraws every slot and style so
	// the shell's own interface returns. `plain` stays false until a Bot-mode view hosts a
	// plain session, which drops only the conversation replacements.
	const surface = createSource({ mode: readMode(), plain: false });
	// DSH Agent Session ids from the last pull, so a reload already knows the main view is a
	// plain Session before the team answers.
	let agentSessionCache = new Set<string>();
	try {
		agentSessionCache = new Set(JSON.parse(localStorage.getItem(STORAGE.agentSessions) ?? "[]"));
	} catch {
		agentSessionCache = new Set();
	}
	// Sessions adopted on this window (workspace pick, fork) but not yet in the roster.
	const pendingAdopt = new Map<string, string>();
	const isAgentSessionId = (id: string) =>
		isAgentSession(roster.getSnapshot(), agentSessionCache, id) || pendingAdopt.has(id);
	const agentOfSession = (id: string) => roster.getSnapshot().agentOf[id] ?? pendingAdopt.get(id);
	// The workspace a Session lives in, for follow-up creates and switch detection.
	const workspaces = ctx.get("workspaces");
	const workspaceOf = (sessionId: string) => {
		const items = workspaces?.list?.getSnapshot()?.items ?? [];
		return items.find((item: any) => item.sessionIds?.includes(sessionId))?.workspaceId;
	};
	// A navigation this plugin started: the surface effect trusts the id it lands on.
	let expected: string | null = null;
	const setPlain = (plain: boolean) =>
		surface.set((state: any) => (state.plain === plain ? state : { ...state, plain }));
	// A DSH Agent Session shows the plain conversation: the Bot details and browser panels
	// would follow it and report it is not on the team, so they close.
	const dropPanels = () =>
		ui.set((state: any) =>
			state.details || state.renaming
				? { ...state, details: null, view: "details", renaming: false, tab: null }
				: state,
		);
	// A Bot's chat spans several parts, so when it was last left is kept per Bot.
	const seenKey = (id: string) =>
		roster.getSnapshot().byId?.[id]?.id ?? roster.getSnapshot().roomsById?.[id]?.id ?? id;
	const leaveVisits = (ids: string[]) => {
		seenAt = seenStore.update((seen: any) => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt);
	};
	ctx.effect(() => {
		const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}));
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, "ocean-crew: remember visits on page hide");
	// Unread marks, reactions and visits are shared by every window; one saved elsewhere
	// shows here at once. A `null` key is a cleared storage.
	ctx.effect(() => {
		const onStorage = (event: any) => {
			if (event.storageArea !== localStorage) return;
			if (event.key === null || event.key === unreadStore.key) {
				ui.set((state: any) => ({ ...state, unread: unreadStore.read(state.unread) }));
			}
			if (event.key === null || event.key === reactionStore.key) {
				ui.set((state: any) => ({ ...state, reactions: reactionStore.read(state.reactions) }));
			}
			if (event.key === null || event.key === seenStore.key) seenAt = seenStore.read(seenAt);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, "ocean-crew: follow other windows");
	const activity = createSource({});
	// Per Bot, the turn it runs and its tool; and the approvals waiting for the user.
	const work = createSource({ bots: {}, approvals: [] });
	let workKey = "";
	// The version of the live fields this window last got; while it still names the host's
	// answer, the poll leaves those fields out.
	let liveKey: string | undefined;
	// Per Session, what its transcript has in flight (running tools, a streaming reply).
	const live = createSource({});
	// Per Session, the ask_user and request_secret calls its transcript draws; the docks
	// carry the cards of the other calls.
	const cards = createSource({});
	// Edited dock cards keep their component when history arrives. This source holds only
	// request identities and counts, never drafts or secret values.
	const heldCards = createSource({});
	// Per Session, the first visible time and the end time of each turn the transcript has
	// rendered; time separators compare one turn's end with the next turn's start.
	const turnClock = createSource({});
	let activityKey = "{}";
	// Per Bot, its latest memory change, and `seen`: when this window first saw it, or 0 for
	// a change made before the window opened, which is no news.
	const memoryNews = createSource({});
	let memoryNewsKey: string | undefined;
	const noteMemoryNews = (next: Record<string, any>) => {
		const key = JSON.stringify(next);
		if (key === memoryNewsKey) return;
		const opening = memoryNewsKey === undefined;
		memoryNewsKey = key;
		memoryNews.set((state: any) =>
			Object.fromEntries(
				Object.entries(next).map(([id, entry]: [string, any]) => [
					id,
					state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() },
				]),
			),
		);
	};
	const writeUnread = (id: string, value: boolean) => {
		const unread = unreadStore.update((marks: any) => setUnread(marks, id, value), ui.getSnapshot().unread);
		ui.set((state: any) => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }));
	};
	const refreshed = new Set<string>();
	// Pulls can overlap (the poll and a navigation); an older answer never wins.
	let pulls = 0;
	let applied = 0;
	const pull = async (): Promise<void> => {
		const order = ++pulls;
		const known = roster.getSnapshot();
		const value = await call("state", {
			since: known.revision,
			models: known.modelsKey ?? "",
			live: liveKey,
			locale: language(),
		});
		if (order < applied) return;
		applied = order;
		if (value.liveKey !== undefined) liveKey = value.liveKey;
		if (value.activity !== undefined) {
			const nextActivity = JSON.stringify(value.activity);
			if (nextActivity !== activityKey) {
				activityKey = nextActivity;
				activity.set(value.activity);
			}
		}
		if (value.work !== undefined) {
			const nextWork = JSON.stringify(value.work);
			if (nextWork !== workKey) {
				workKey = nextWork;
				work.set(value.work);
			}
		}
		if (value.memoryNews !== undefined) noteMemoryNews(value.memoryNews);
		const current = roster.getSnapshot();
		// Connector and capability states change without a new revision.
		const liveValue: Record<string, any> = {};
		if (
			value.connectors !== undefined &&
			JSON.stringify(value.connectors) !== JSON.stringify((current as any).connectors ?? [])
		) {
			liveValue.connectors = value.connectors;
		}
		if (
			value.capabilityStatuses !== undefined &&
			JSON.stringify(value.capabilityStatuses) !== JSON.stringify(current.capabilityStatuses ?? {})
		) {
			liveValue.capabilityStatuses = value.capabilityStatuses;
		}
		if (value.learning !== undefined && JSON.stringify(value.learning) !== JSON.stringify(current.learning ?? {})) {
			liveValue.learning = value.learning;
		}
		if (
			value.learningSettled !== undefined &&
			JSON.stringify(value.learningSettled) !== JSON.stringify((current as any).learningSettled ?? {})
		) {
			liveValue.learningSettled = value.learningSettled;
		}
		if (value.btwCards !== undefined && JSON.stringify(value.btwCards) !== JSON.stringify(current.btwCards ?? {})) {
			liveValue.btwCards = value.btwCards;
		}
		if (
			value.sideChats !== undefined &&
			JSON.stringify(value.sideChats) !== JSON.stringify(current.sideChats ?? {})
		) {
			liveValue.sideChats = value.sideChats;
		}
		if (
			value.imStatus !== undefined &&
			JSON.stringify(value.imStatus) !== JSON.stringify((current as any).imStatus ?? {})
		) {
			liveValue.imStatus = value.imStatus;
		}
		if (value.imVia !== undefined && JSON.stringify(value.imVia) !== JSON.stringify((current as any).imVia ?? {})) {
			liveValue.imVia = value.imVia;
		}
		if (
			value.companionReactions !== undefined &&
			JSON.stringify(value.companionReactions) !== JSON.stringify((current as any).companionReactions ?? {})
		) {
			liveValue.companionReactions = value.companionReactions;
		}
		if (Object.keys(liveValue).length > 0 && current.ready) roster.set({ ...current, ...liveValue });
		if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) return;
		// On a browser with no visit record yet, everything already there counts as seen.
		if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map((entry: any) => entry.id));
		roster.set(indexRoster(value));
		try {
			const ids = (value.agents ?? []).flatMap((agent: any) => agent.sessions ?? []);
			localStorage.setItem(STORAGE.agentSessions, JSON.stringify(ids));
			agentSessionCache = new Set(ids);
		} catch {
			/* storage unavailable */
		}
		// Adopted ids are known by the roster now; ones gone from the list were archived.
		const listed = ctx.sessions.list.getSnapshot().byId ?? {};
		for (const id of pendingAdopt.keys()) {
			if (roster.getSnapshot().agentOf[id] !== undefined || listed[id] === undefined) pendingAdopt.delete(id);
		}
		for (const id of [...value.bots.map(currentPart), ...value.rooms.map((room: any) => room.sessionId ?? room.id)]) {
			if (refreshed.has(id)) continue;
			refreshed.add(id);
			void Promise.resolve(ctx.sessions.refreshProjections?.(id)).catch(quietly("refresh projections"));
		}
	};

	ctx.effect(() => {
		let stopped = false;
		let running = false;
		let timer: any;
		let misses = 0;
		const loop = async () => {
			clearTimeout(timer);
			if (running || stopped) return;
			running = true;
			try {
				await pull();
				misses = 0;
				// A late-arriving API clears the failure the misses reported.
				ui.set((state: any) => (state.bootFailed ? { ...state, bootFailed: false } : state));
			} catch (error: any) {
				if (!stopped) {
					console.warn("[ocean-crew] state", error);
					// Only a missing Bot API counts toward a failed start: while the host plugin
					// stays unmounted the route answers 404. A network miss is the host
					// reconnecting, not a start-up failure (#516).
					if (error?.code === "HTTP_404") {
						misses += 1;
						if (misses >= 10 && !roster.getSnapshot().ready) {
							ui.set((state: any) => (state.bootFailed ? state : { ...state, bootFailed: true }));
						}
					}
				}
			} finally {
				running = false;
			}
			if (!stopped) timer = setTimeout(loop, document.hidden ? 10000 : 1500);
		};
		const wake = () => {
			if (!document.hidden) void loop();
		};
		document.addEventListener("visibilitychange", wake);
		void loop();
		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", wake);
		};
	}, "ocean-crew: roster poll");

	// Plugin updates: every window that opens asks the host once (the host keeps its answer
	// for a while), again each hour, and every two seconds while installing.
	const update = createSource({ available: false, phase: "idle" });
	let wakeUpdate = () => {};
	ctx.effect(() => {
		let stopped = false;
		let timer: any;
		const loop = async () => {
			clearTimeout(timer);
			if (stopped) return;
			const value = await call("update-check", { fresh: false }).catch(() => null);
			if (stopped) return;
			if (value) update.set((previous: any) => ({ ...value, app: previous.app, ownApp: previous.ownApp }));
			timer = setTimeout(
				loop,
				value?.phase === "installing" || value?.dsh?.phase === "installing" ? 2000 : 60 * 60_000,
			);
		};
		wakeUpdate = loop;
		void loop();
		return () => {
			stopped = true;
			clearTimeout(timer);
			wakeUpdate = () => {};
		};
	}, "ocean-crew: update check");

	// A packaged DSH updates through its own updater; what that updater found is kept beside
	// the host's answer so the card can match it to the verified DSH.
	const desktop = (window as any).dshDesktop;
	const appUpdates = desktop?.protocolVersion === 1 ? (desktop.updates ?? null) : null;
	if (appUpdates?.status && appUpdates.subscribe) {
		ctx.effect(() => {
			let stopped = false;
			const take = (app: any) => {
				if (!stopped && app) update.set((previous: any) => ({ ...previous, app }));
			};
			void appUpdates.status().then(take, () => {});
			const unsubscribe = appUpdates.subscribe(take);
			return () => {
				stopped = true;
				unsubscribe?.();
			};
		}, "ocean-crew: app update status");
	}

	// The Ocean Crew app's own updater; its state goes beside the host's answer as ownApp,
	// which the About row turns into the app's update state and buttons.
	const ownAppUpdates = (globalThis as any).dsBotApp?.updates ?? null;
	if (ownAppUpdates?.state && ownAppUpdates.subscribe) {
		ctx.effect(() => {
			let stopped = false;
			const take = (ownApp: any) => {
				if (!stopped && ownApp) update.set((previous: any) => ({ ...previous, ownApp }));
			};
			void ownAppUpdates.state().then(take, () => {});
			const unsubscribe = ownAppUpdates.subscribe(take);
			return () => {
				stopped = true;
				unsubscribe?.();
			};
		}, "ocean-crew: own app update state");
	}

	ctx.effect(
		() => () => {
			markupCache.clear();
		},
		"ocean-crew: character markup",
	);

	// Mentions wear each Bot's color and character silhouette (or its photo). A message DSH
	// still draws itself, while it waits to be sent or to join a running turn, shows "@Name"
	// as a file reference; one whose label is a whole Bot name wears the Bot's mark there too
	// (a name with a space is cut by DSH, so it stays as DSH draws it).
	const installMentions = () => {
		const style = installStyles("", "mentions");
		let last = "";
		const render = () => {
			const next = roster
				.getSnapshot()
				.bots.map((bot: any) => {
					const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`;
					const chip = /\s/.test(bot.name)
						? ""
						: `[class*="_userRow"] [data-ref-chip="file"][title="@${bot.name.replace(/["\\]/g, "\\$&")}" i]`;
					const look = lookOf(bot);
					const marks = chip ? `${anchor}::before,${chip}::before` : `${anchor}::before`;
					const markCss = look.image
						? `${marks}{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
						: `${marks}{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`;
					const chipBase = chip
						? `${chip}{color:inherit;font-weight:600}${chip}>svg{display:none}${chip}::before{content:"";display:inline-block;flex:none;width:16px;height:16px;margin-right:3px;vertical-align:-3px;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}`
						: "";
					return `${anchor}{color:${inkText(look.color)}}${chipBase}${markCss}`;
				})
				.join("\n");
			if (next !== last) style.textContent = last = next;
		};
		render();
		const offRoster = roster.subscribe(render);
		const offRegistry = registry.subscribe(render);
		return () => {
			offRoster();
			offRegistry();
			style.remove();
		};
	};

	// The chosen theme lives in the team state so every device shares it; the local copy
	// only avoids a flash of the default theme before the first state pull.
	const installTheme = () => {
		const style = installStyles("", "theme");
		let key = "";
		let releaseTokens: any = null;
		const render = () => {
			const snapshot = roster.getSnapshot();
			const prefs = snapshot.ready ? (snapshot.prefs ?? {}) : savedPrefs;
			const themes = allThemes();
			const id = themes[prefs.theme] ? prefs.theme : "deepseek";
			const accent = isHex(prefs.accent) ? prefs.accent : undefined;
			const motion = prefs.motion === "quiet" || prefs.motion === "lively" ? prefs.motion : "normal";
			const layout = layoutOf(prefs);
			const width = widthOf(prefs);
			const flatWidth = flatWidthOf(prefs);
			document.body.dataset.btMotion = motion;
			document.body.dataset.btLayout = layout;
			document.body.style.setProperty("--bt-msg-w", String(width / 100));
			document.body.style.setProperty("--bt-flat-w", String(flatWidth / 100));
			const next = `${id}|${accent ?? ""}|${motion}|${layout}|${width}|${flatWidth}|${registry.getSnapshot()}`;
			if (next === key) return;
			key = next;
			style.textContent = themeCss(themes[id], accent);
			const release = releaseTokens;
			releaseTokens = ctx.theme.overrideTokens("ocean-crew", shellTokens(themes[id]));
			if (typeof release === "function") release();
			if (snapshot.ready) {
				try {
					localStorage.setItem(
						PREFS_KEY,
						JSON.stringify({
							theme: prefs.theme,
							accent: prefs.accent,
							motion: prefs.motion,
							layout: prefs.layout,
							width: prefs.width,
							flatWidth: prefs.flatWidth,
							thinking: prefs.thinking,
							defaultBotModel: prefs.defaultBotModel,
							enterToSend: prefs.enterToSend,
						}),
					);
				} catch {
					/* storage unavailable */
				}
			}
		};
		render();
		const offRoster = roster.subscribe(render);
		const offRegistry = registry.subscribe(render);
		return () => {
			offRoster();
			offRegistry();
			try {
				if (typeof releaseTokens === "function") releaseTokens();
			} finally {
				delete document.body.dataset.btMotion;
				delete document.body.dataset.btLayout;
				document.body.style.removeProperty("--bt-msg-w");
				document.body.style.removeProperty("--bt-flat-w");
				style.remove();
			}
		};
	};

	ctx.effect(() => {
		const hub = {
			registerShape,
			registerTheme,
			themes: () => Object.keys(allThemes()),
			shapes: () => Object.keys(SHAPES),
		};
		const queued = Array.isArray((window as any).dshBotQueue) ? (window as any).dshBotQueue : [];
		(window as any).dshBot = hub;
		(window as any).dshBotQueue = {
			push: (task: (hub: any) => void) => {
				try {
					task(hub);
				} catch (error) {
					console.warn("[ocean-crew] registration", error);
					noteClientError("registration", error);
				}
			},
		};
		for (const task of queued) (window as any).dshBotQueue.push(task);
		return () => {
			if ((window as any).dshBot === hub) delete (window as any).dshBot;
			delete (window as any).dshBotQueue;
		};
	}, "ocean-crew: registry");

	ctx.inject(["shortcuts"], (scope: any) => {
		scope.effect(() => holdShellShortcuts(scope.shortcuts), "ocean-crew: settings shortcut");
	});

	const after = (promise: Promise<any>): Promise<any> =>
		promise.then(async (value: any) => {
			await pull().catch(() => {});
			return value;
		});
	// A Bot id or a group chat id, or any part of either's chat, opens the current part.
	const partFor = (id: string): string => {
		const snapshot = roster.getSnapshot();
		const bot = snapshot.byId[id];
		if (bot !== undefined) return currentPart(bot);
		const room = snapshot.roomsById[id];
		return room === undefined ? id : (room.sessionId ?? room.id);
	};
	// Sessions owned by an Agent, including ones adopted before the roster caught up.
	const agentSessions = (agentId: string): string[] => {
		const ids = [...(roster.getSnapshot().agentsById[agentId]?.sessions ?? [])];
		for (const [id, owner] of pendingAdopt) if (owner === agentId && !ids.includes(id)) ids.push(id);
		return ids;
	};
	const mainView = () =>
		(Object.values(ctx.sessions.list.getSnapshot().byId ?? {}) as any[]).find(
			(session: any) => (session?.retainedBy?.mainView ?? 0) > 0,
		)?.id;
	const show = listedOpener({
		list: ctx.sessions.list,
		refresh: () => Promise.resolve(ctx.sessions.refresh?.()).catch(quietly("refresh sessions")),
		open: (target: string) => {
			expected = target;
			ctx.uiWorkspace.openSession(target);
		},
		current: mainView,
	}) as (id: string) => void;
	// Whether the open Bot panel is folded away for lack of room: its opener then means
	// "show it" (the column yields), not "close it". A panel shown because the column
	// already yielded is not folded, so its opener closes it.
	const panelFolded = (view?: string): boolean => {
		const state = ui.getSnapshot();
		if (state.details === null) return false;
		const f = frame.getSnapshot();
		return (
			frameLayout({
				viewport: f.viewport,
				sidebarWidth: f.sidebarWidth,
				pref: sidebarPref.getSnapshot(),
				drawer: state.leftDrawer,
				panel: { view: view ?? state.view, yielded: state.panelYield === true },
			}).panel === "folded"
		);
	};
	// Bot mode's view must hold a team conversation; an outside Session wears the Bot skin
	// without one. Runs whenever the surface is (or stays) Bot mode - including a cold
	// start, where no setSurface call ever fires.
	const homeToMainBot = () => {
		const snapshot = roster.getSnapshot();
		if (!snapshot.ready || !snapshot.mainBotId) return;
		const main = mainView();
		if (main !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined) {
			actions.openSession(snapshot.mainBotId);
		}
	};
	const ensureBotHome = () => {
		if (roster.getSnapshot().ready) homeToMainBot();
		else {
			const off = roster.subscribe(() => {
				if (!roster.getSnapshot().ready) return;
				off();
				homeToMainBot();
			});
		}
	};
	const actions: any = {
		...teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, panelFolded }),
		learningAnswer: (id: string, approve: boolean) => after(call("learning-answer", { id, approve })),
		// The full-pane overlays sit above the conversation, so opening one must dismiss them
		// or the click appears to do nothing.
		isAgentSession: (id: string) => isAgentSessionId(id),
		openSession: (id: string) => {
			// A DSH Agent Session id lands on the plain surface, not the Bot skin.
			if (isAgentSessionId(id)) return actions.openAgentSession(id);
			ui.set((state: any) =>
				state.newChat || state.exchange || state.menu || state.palette
					? { ...state, newChat: null, exchange: null, menu: null, palette: null }
					: state,
			);
			setPlain(false);
			show(partFor(id));
		},
		// The conversation replacements withdraw for a plain Session; set the surface before
		// the navigation so the Bot skin never flashes.
		openAgentSession: (sessionId: string) => {
			ui.set((state: any) => ({
				...state,
				newChat: null,
				exchange: null,
				menu: null,
				palette: null,
				details: null,
				view: "details",
				renaming: false,
				tab: null,
			}));
			setPlain(true);
			show(sessionId);
		},
		addAgent: async () => {
			const agent = await after(call("add-agent"));
			if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0]);
			return agent;
		},
		openAgent: (agentId: string) => {
			const agent = roster.getSnapshot().agentsById[agentId];
			if (agent === undefined) return;
			const list = ctx.sessions.list.getSnapshot();
			const recent = agentSessions(agentId).sort(
				(a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0),
			);
			if (recent.length === 0) return actions.newAgentSession(agentId);
			actions.openAgentSession(recent[0]);
		},
		newAgentSession: async (agentId: string) => {
			const agent = roster.getSnapshot().agentsById[agentId];
			if (agent === undefined) return;
			const list = ctx.sessions.list.getSnapshot();
			const recent = agentSessions(agentId).sort(
				(a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0),
			);
			// An untouched Session is already the new conversation the user wants.
			if (recent.length > 0 && list.byId[recent[0]]?.blank === true) {
				actions.openAgentSession(recent[0]);
				return recent[0];
			}
			const { sessionId } = await after(call("agent-session", { agentId, workspaceId: workspaceOf(recent[0]) }));
			actions.openAgentSession(sessionId);
			return sessionId;
		},
		archiveAgentSession: async (agentId: string, sessionId: string) => {
			await after(call("agent-archive", { agentId, sessionId }));
			const list = ctx.sessions.list.getSnapshot();
			const main = (Object.values(list.byId ?? {}) as any[]).find(
				(session: any) => (session?.retainedBy?.mainView ?? 0) > 0,
			)?.id;
			if (main !== sessionId) return;
			const rest = roster.getSnapshot().agentsById[agentId]?.sessions ?? [];
			if (rest.length > 0) actions.openAgent(agentId);
			else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId);
		},
		renameAgentSession: (agentId: string, sessionId: string, title: string) =>
			after(call("agent-rename", { agentId, sessionId, title })),
		beginAgentRename: (sessionId: string) => ui.set((state: any) => ({ ...state, renameAgent: sessionId })),
		endAgentRename: () => ui.set((state: any) => (state.renameAgent ? { ...state, renameAgent: null } : state)),
		// Removing the Agent archives every Session it owns; one of them may fill the main
		// view, and it must not stay there wearing the Bot surface afterwards.
		removeAgent: async (agentId: string) => {
			const owned = agentSessions(agentId);
			const result = await after(call("remove-agent", { agentId }));
			const list = ctx.sessions.list.getSnapshot();
			const main = (Object.values(list.byId ?? {}) as any[]).find(
				(session: any) => (session?.retainedBy?.mainView ?? 0) > 0,
			)?.id;
			if (main !== undefined && owned.includes(main) && roster.getSnapshot().mainBotId) {
				actions.openSession(roster.getSnapshot().mainBotId);
			}
			return result;
		},
		// `last` is the Bot conversation the view held before it cleared: when that part was
		// archived for a fresh one, the view goes on in the fresh one.
		landOn: async (id: string, last: any) => {
			if (last) await pull().catch(() => {});
			const bot = last ? roster.getSnapshot().byId[last.botId] : undefined;
			setPlain(false);
			const target = bot && currentPart(bot) !== last.sessionId ? currentPart(bot) : partFor(id);
			show(target);
		},
		selectPanel: (id: string) => {
			ctx.layout.selectPanel(id);
		},
		toggleSidebar: () => {
			ctx.layout.toggleSidebar();
		},
		// The left column's own preference: 'open', 'rail' or 'hidden'. The switch remembers
		// the shown one it hid; a drag sets the open column's width.
		setSidebarPref: (pref: string) => {
			const next = pref === "rail" || pref === "hidden" ? pref : "open";
			sidebarSaved = { ...sidebarSaved, pref: next as any, ...(next === "hidden" ? {} : { shown: next }) } as any;
			writeSidebar(sidebarSaved);
			sidebarPref.set(next as any);
		},
		toggleLeftHidden: () => {
			ui.set((state: any) =>
				state.leftDrawer || state.panelYield ? { ...state, leftDrawer: false, panelYield: false } : state,
			);
			actions.setSidebarPref(toggledPref(sidebarPref.getSnapshot(), (sidebarSaved as any).shown));
		},
		setSidebarWidth: (width: number) => {
			sidebarSaved = { ...sidebarSaved, width };
			writeSidebar(sidebarSaved);
			frame.set((state: any) => (state.sidebarWidth === width ? state : { ...state, sidebarWidth: width }));
		},
		setLeftDrawer: (on: boolean) =>
			ui.set((state: any) => (state.leftDrawer === on ? state : { ...state, leftDrawer: on })),
		setPanelYield: (on: boolean) =>
			ui.set((state: any) => (state.panelYield === on ? state : { ...state, panelYield: on })),
		// Agent mode hands the surface back to the shell; everything open on the Bot surface
		// closes first so nothing stale reopens on the way back.
		setSurface: (mode: string) => {
			if (mode !== "bot" && mode !== "agent") return;
			// Already there: still worth the landing check - a cold start never calls
			// setSurface, so this is also how a stuck Bot surface recovers itself.
			if (surface.getSnapshot().mode === mode) {
				if (mode === "bot") ensureBotHome();
				return;
			}
			if (mode === "agent") {
				ui.set((state: any) => ({
					...state,
					details: null,
					view: "details",
					settings: null,
					palette: null,
					newChat: null,
					menu: null,
					voice: null,
					exchange: null,
					memory: null,
					toast: null,
				}));
			}
			writeMode(mode as any);
			surface.set((state: any) => ({ ...state, mode }));
			// The Bot view kept the shell's sidebar collapsed under its own column; the shell's
			// own view gets it back (below DSH_NARROW the shell decides itself).
			if (mode === "agent" && window.innerWidth >= DSH_NARROW && frame.getSnapshot().collapsed) {
				ctx.layout.toggleSidebar();
			}
			if (mode !== "bot") return;
			ensureBotHome();
		},
		markUnread: (id: string) => writeUnread(id, true),
		beginVisit: (id: string) => {
			// A conversation a Bot started, never opened here, is unread from its start.
			const made: any = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id];
			const seen =
				seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null);
			ui.set((state: any) => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }));
		},
		endVisit: (id: string) => {
			leaveVisits([id]);
			ui.set((state: any) => {
				if (!(id in (state.visits ?? {}))) return state;
				const visits = { ...state.visits };
				delete visits[id];
				return { ...state, visits };
			});
		},
		toggleReaction: (key: string, index: number, emoji: string) => {
			const reactions = reactionStore.update(
				(saved: any) => toggleReaction(saved, key, index, emoji),
				ui.getSnapshot().reactions,
			);
			ui.set((state: any) => ({ ...state, reactions }));
		},
		clearUnread: (id: string) => writeUnread(id, false),
	};
	// Whether AccountLauncher holds the shell's settings seat; FooterAccount steps aside if so.
	actions.signInEntry = () => ctx.slots.entries?.("settings.models.sign-in")?.[0] ?? null;
	actions.canSignIn = () => Boolean(actions.signInEntry());
	actions.signIn = () => ui.set((state: any) => ({ ...state, signIn: (state.signIn ?? 0) + 1 }));
	actions.closeSignIn = () => ui.set((state: any) => ({ ...state, signIn: null }));
	actions.accountT = () => ctx.get("locale").bind("settings.account");
	// DSH's own settings: models, providers, keys and its plugins.
	actions.openHarnessSettings = openHarnessSettings;
	actions.openHarnessOnboarding = openHarnessOnboarding;
	// DSH's Models page, through Ocean Crew's own onboarding step while it is registered.
	actions.openHarnessModels = () => {
		const step = (ctx.slots.entries?.("settings.onboarding") ?? []).some(
			(entry: any) => entry.options?.id === MODELS_STEP,
		);
		if (step) openHarnessOnboarding(MODELS_STEP);
		else openHarnessSettings();
	};
	actions.seatAccount = (on: boolean) =>
		ui.set((state: any) => (state.accountSeated === on ? state : { ...state, accountSeated: on }));
	// The install runs on the host; the check loop follows it every two seconds.
	actions.installUpdate = async () => {
		const value = await call("update-install");
		update.set((previous: any) => ({ ...previous, ...value }));
		wakeUpdate();
	};
	// The DSH the newest released Ocean Crew verified installs the same way.
	actions.installDshUpdate = async () => {
		const dsh = await call("dsh-update-install");
		update.set((previous: any) => ({ ...previous, dsh }));
		wakeUpdate();
	};
	// The app's panel installs whatever its updater found by now, so it opens only while that
	// is still the verified version.
	actions.openAppUpdates = async (verified: unknown) => {
		const app = await appUpdates?.status?.();
		if (app) update.set((previous: any) => ({ ...previous, app }));
		if (sameVersion(app?.version, verified)) await appUpdates.open();
	};
	actions.checkUpdate = async () => {
		const value = await call("update-check", { fresh: true });
		update.set((previous: any) => ({ ...value, app: previous.app, ownApp: previous.ownApp }));
		wakeUpdate();
	};
	// The app's own updater answers through its bridge; the state it pushes back re-renders
	// the About row.
	actions.checkOwnApp = async () => {
		await ownAppUpdates?.check?.();
	};
	actions.installOwnApp = async () => {
		await ownAppUpdates?.install?.();
	};
	actions.openOwnApp = async () => {
		await ownAppUpdates?.open?.();
	};
	const face = () => ({
		actions,
		hooks: {
			roster,
			ui,
			activity,
			work,
			memoryNews,
			registry,
			turnClock,
			live,
			cards,
			heldCards,
			surface,
			update,
			frame,
			sidebarPref,
		},
	});
	// The queue dock's per-session verbs, supplied the way the shell's own dock injects them
	// (the session facade and the conversation service).
	const queueFace = (sessionId: string) => ({
		...face(),
		updateQueue: async (itemId: string, action: unknown) =>
			(await ctx.sessions.binding(sessionId)?.session?.updateQueue(itemId, action)) ?? { ok: false },
		loadImage: (attachment: unknown) => ctx.uiConversation.imageUrl(sessionId, attachment),
	});
	ctx.effect(
		() =>
			noticeApprovals({
				work,
				roster,
				shownSession: () =>
					(Object.values(ctx.sessions.list.getSnapshot().byId ?? {}) as any[]).find(
						(session: any) => (session?.retainedBy?.mainView ?? 0) > 0,
					)?.id,
				openSession: (id: string) => actions.openSession(id),
			}),
		"ocean-crew: approval notifications",
	);
	const assistantFace = (sessionId: string) => {
		const binding = ctx.sessions.binding(sessionId);
		if (binding === undefined) throw new Error(`ocean-crew: unknown session "${sessionId}"`);
		const chat = ctx.uiConversation.binding(binding).target("chat");
		return {
			...face(),
			keyedHooks: {
				turnSteps: (turn: number) => {
					const snapshot = chat.getSnapshot();
					if (snapshot === undefined) throw new Error("ocean-crew: Chat target is unavailable");
					return snapshot.nodes.turnDataSource(Number(turn), "assistant-step");
				},
				turnContext: (turn: number) => {
					const snapshot = chat.getSnapshot();
					if (snapshot === undefined) throw new Error("ocean-crew: Chat target is unavailable");
					return snapshot.nodes.turnDataSource(Number(turn), "context");
				},
			},
		};
	};

	// The dock lives outside the chat snapshot, so it subscribes for the turn that owns a
	// card. Until that turn closes, the card stays by the composer.
	actions.turnFacts = (sessionId: string) => {
		try {
			const binding = ctx.sessions.binding(sessionId);
			if (binding === undefined) return { turns: undefined, openTurn: undefined };
			const conversation = ctx.uiConversation.binding(binding);
			const chat = conversation.target("chat").getSnapshot();
			return { turns: chat?.timeline?.turns, openTurn: conversation.openTurn.getSnapshot() };
		} catch {
			return { turns: undefined, openTurn: undefined };
		}
	};
	actions.watchTurns = (sessionId: string, listener: () => void) => {
		try {
			const binding = ctx.sessions.binding(sessionId);
			if (binding === undefined) return () => {};
			const conversation = ctx.uiConversation.binding(binding);
			const offChat = conversation.target("chat").subscribe(listener);
			const offOpen = conversation.openTurn.subscribe(listener);
			return () => {
				offChat();
				offOpen();
			};
		} catch {
			return () => {};
		}
	};
	// Enter on an empty composer while the Bot works sends the user's queued messages into
	// the running turn (the "+" owns the key; #839).
	actions.steerQueued = async (sessionId: string) => {
		const session = ctx.sessions.binding(sessionId)?.session;
		if (session === undefined) return;
		if ((await steerQueued(session)) === "failed") {
			actions.reportError(new Error(t("Couldn’t steer the queued messages. Try again.")), "steer-queue");
		}
	};
	// A terminal tab in DSH's right column, only where the terminal plugin registered its
	// type and the column face is there.
	actions.canOpenTerminal = () =>
		ctx.get("sidebarRight") !== undefined && ctx.get("sidebarRightTabs")?.get("terminal") !== undefined;
	actions.newTerminal = () => {
		// The column takes the drawer's space: hand it over first.
		actions.closePanel();
		try {
			ctx.get("sidebarRight")?.openTab("terminal");
		} catch (error) {
			actions.reportError(error, "right-sidebar");
		}
	};
	// The same hand-off for DSH's files tab, where that plugin registered it.
	actions.canOpenFiles = () =>
		ctx.get("sidebarRight") !== undefined && ctx.get("sidebarRightTabs")?.get("files") !== undefined;
	actions.openFiles = () => {
		actions.closePanel();
		try {
			ctx.get("sidebarRight")?.openTab("files");
		} catch (error) {
			actions.reportError(error, "right-sidebar");
		}
	};

	// The drawer and DSH's right column never share the window: whichever the user asked for
	// last wins. The column's state is read off the frame's attributes through a
	// MutationObserver. `mounted` moves before the DOM of a Session switch does, so a switch
	// opens a timed window (createSwitchWindow): an attribute batch inside it is the switch
	// revealing that Session's own column - the drawer wins and folds it back - while one
	// outside it is the user's own opening and takes the space.
	ctx.effect(() => {
		const sidebar = ctx.get("sidebarRight");
		if (!sidebar) return undefined;
		let open = rightColumnOpen(document);
		// Long enough for a fullscreen panel's slide, which reports only once it ends.
		const switchWindow = createSwitchWindow((done) => setTimeout(done, 400));
		const collapseColumn = () => {
			try {
				if (sidebar.isExpanded()) sidebar.toggleExpanded();
			} catch (error) {
				actions.reportError(error, "right-sidebar");
			}
		};
		const observer = new MutationObserver(() => {
			const next = rightColumnOpen(document);
			const opening = next && !open;
			open = next;
			const verdict = opening ? columnOpened(ui.getSnapshot().details !== null, switchWindow.pending) : null;
			if (verdict === "close-drawer") actions.closePanel();
			else if (verdict === "collapse-column") collapseColumn();
		});
		observer.observe(document.documentElement, {
			subtree: true,
			attributes: true,
			attributeFilter: [...RIGHTBAR_ATTRIBUTES],
		});
		const offMounted = sidebar.mounted.subscribe(() => switchWindow.moved());
		let drawer = ui.getSnapshot().details !== null;
		const offUi = ui.subscribe(() => {
			const next = ui.getSnapshot().details !== null;
			if (next && !drawer && drawerOpened(rightColumnOpen(document)) === "collapse-column") collapseColumn();
			drawer = next;
		});
		return () => {
			observer.disconnect();
			offMounted();
			offUi();
		};
	}, "ocean-crew: one right panel");

	// A Bot surface owns the cells it shadows. It starts far below the -10 that plugins
	// commonly use and goes below whatever already holds the cell, so a plugin that shadows
	// the same cell neither breaks the install nor shows through.
	const BOT_PRIORITY = -100;
	const shadow = (name: string, options: any, component: unknown) =>
		ctx.slots.inject(name, () =>
			ctx.slots.register(
				{
					name,
					...options,
					...(options.priority === undefined ? {} : { priority: freePriority(ctx.slots.entries(name), options) }),
				},
				component,
			),
		);
	const installHeader = () =>
		ctx.slots.inject("conversation.session.header", () =>
			installHeaderNavigation(ctx.slots, face, HeaderPill, BOT_PRIORITY),
		);

	// The "@" menu's Bot group and the chats "+" references. The composer's controller for a
	// Session is the shell's own, so the chats open at its caret.
	let atMenu: any = null;
	const installAtMenu = () => {
		const fiber = ctx.inject(["inputTriggers"], (scope: any) => {
			scope.effect(() => {
				const triggers = scope.inputTriggers;
				const controllerOf = (sessionId: string) => {
					const binding = ctx.sessions.binding(sessionId);
					return binding === undefined ? undefined : triggers.sessionOf(binding.ctx);
				};
				const launched = (sessionId: string) => controllerOf(sessionId)?.launcher.getSnapshot() === CHATS_SOURCE;
				const offs = [
					...atSources({ roster, sessions: ctx.sessions, launched, iconFor: menuIcons(roster) }).map(
						(source: any) => triggers.registerSource(source),
					),
					triggers.registerSource(sideSource({ roster, actions })),
				];
				atMenu = { controllerOf };
				return () => {
					atMenu = null;
					for (const off of offs) off();
				};
			}, "ocean-crew: @ menu");
		});
		return () => fiber.dispose();
	};
	actions.canReferenceChat = () => atMenu !== null;
	actions.referenceChat = (sessionId: string, span: unknown) => {
		const controller = atMenu?.controllerOf(sessionId);
		if (controller === undefined || span === undefined) return;
		controller.toggleSource(CHATS_SOURCE, { trigger: "@", query: "", quoted: false, position: "inline", span });
	};

	// The panel's yield flag and the drawer's flag follow the frame: opening (or re-aiming) a
	// panel that does not fit yields the column to the rail; a panel that fits again, or is
	// closed, and a drawer that no longer applies drop their flags.
	const installFrameSync = () => {
		let lastDetails = ui.getSnapshot().details;
		const sync = () => {
			const s = ui.getSnapshot();
			const f = frame.getSnapshot();
			// Only a fresh open counts: a folded panel that just follows the chat to another
			// subject is not the user asking to see it - the openers in team-actions carry the
			// yield themselves.
			const opened = s.details !== null && lastDetails === null;
			lastDetails = s.details;
			const layout = frameLayout({
				viewport: f.viewport,
				sidebarWidth: f.sidebarWidth,
				pref: sidebarPref.getSnapshot(),
				drawer: s.leftDrawer === true,
				panel: s.details === null ? null : { view: s.view, yielded: false },
			});
			if (s.details === null) {
				if (s.panelYield) actions.setPanelYield(false);
			} else if (!s.panelYield && opened && layout.panel === "folded") actions.setPanelYield(true);
			else if (s.panelYield && layout.panel === "shown") actions.setPanelYield(false);
			if (s.leftDrawer === true && layout.left !== "drawer") actions.setLeftDrawer(false);
		};
		const offs = [ui.subscribe(sync), frame.subscribe(sync), sidebarPref.subscribe(sync)];
		return () => {
			for (const off of offs) off();
		};
	};

	// The shell group paints the team surface around the session; the conversation group
	// re-skins the session itself. Each step returns a disposer from slots.inject, so a
	// surface change withdraws the whole group and the outlets re-render.
	const installShell = () => [
		() => installCompiledStyles(SHELL_CSS, "shell"),
		() => installCompiledStyles(SIDEBAR_CSS, "sidebar"),
		() => installCompiledStyles(SECRET_CSS + CONNECTOR_CSS + CONNECTORS_PAGE_CSS, "secrets"),
		() => installCompiledStyles(LEARNING_CSS, "learning"),
		() =>
			installCompiledStyles(
				MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + AGENT_CARDS_CSS + GROUP_SETTINGS_CSS + AVATAR_LIBRARY_CSS,
				"models",
			),
		() => installCompiledStyles(SCHEDULE_CSS, "schedules"),
		() => installCompiledStyles(FEEDBACK_CSS, "feedback"),
		() => installCompiledStyles(ABOUT_CSS, "about"),
		() => installCompiledStyles(MEMBER_CSS, "members"),
		() => installCompiledStyles(IM_CSS, "im"),
		() => installCompiledStyles(GOAL_CSS, "goal"),
		() => installCompiledStyles(USER_MESSAGE_CSS, "user-messages"),
		() => installCompiledStyles(WIDGET_CSS, "widgets"),
		() => installCompiledStyles(SIDE_CSS, "side"),
		// Strip and panel styles also serve the side-chat tabs, which need no bridge.
		() => installCompiledStyles(PANEL_CSS, "panel"),
		() => installFrameWatch(frame),
		() => installFrameSync(),
		() => installTheme(),
		() => shadow("sidebar.workspaces", { priority: BOT_PRIORITY, inject: face }, TeamSidebar),
		() => shadow("sidebar.brand.mark", { priority: BOT_PRIORITY }, BrandMark),
		() => shadow("sidebar.brand.name", { priority: BOT_PRIORITY }, BrandName),
		() => shadow("sidebar.footer.action", { id: "bot-account", order: -200, inject: face }, FooterAccount),
		() => shadow("settings.trigger", { priority: BOT_PRIORITY }, YouAvatar),
		// The whale wins the seat over a shell account plugin's own launcher (the Desktop's
		// "··· More"), which comes back in Agent mode.
		() => shadow("settings.launcher", { priority: BOT_PRIORITY, inject: face }, AccountLauncher),
		() => shadow("settings.onboarding", { id: MODELS_STEP, order: MODELS_STEP_ORDER }, OpenModelsStep),
		() => shadow("shell.overlay", { id: "bot", order: 50, inject: face }, Overlays),
		() => shadow("shell.overlay", { id: "bot-signin", order: 55, inject: face }, DeepSeekSignIn),
		() => shadow("shell.overlay", { id: "bot-toast", order: 60, inject: face }, ErrorToast),
	];
	const installConversation = () => [
		() => installCompiledStyles(CONVERSATION_CSS, "conversation"),
		() => installCompiledStyles(TURN_ERROR_CSS, "turn-errors"),
		() => installCompiledStyles(QUEUE_CSS, "queue"),
		() => installMentions(),
		() => installAtMenu(),
		installHeader,
		() =>
			shadow(
				"conversation.chat.node",
				{ key: "assistant-step", priority: BOT_PRIORITY, locale: "chat", inject: assistantFace },
				AssistantCell,
			),
		() =>
			shadow(
				"conversation.chat.node",
				{ key: "turn-trigger", priority: BOT_PRIORITY, locale: "chat", inject: face },
				TriggerCell,
			),
		() =>
			shadow(
				"conversation.chat.node",
				{ key: "tool-call", priority: BOT_PRIORITY, locale: "chat", inject: face },
				ToolCell,
			),
		() =>
			shadow(
				"conversation.chat.node",
				{ key: "turn-process", priority: BOT_PRIORITY, locale: "chat", inject: face },
				TurnProcessCell,
			),
		// A failed turn shows what the user can do about it instead of the provider's raw text.
		() =>
			shadow(
				"conversation.chat.node",
				{ key: "turn-error", priority: BOT_PRIORITY, locale: "chat", inject: face },
				FailureCell,
			),
		// DSH's own turn tail stays, so what other plugins add there shows, such as the cards
		// of the files a turn delivered; its copy and branch row is hidden.
		() =>
			shadow("conversation.chat.turnTail", { id: "bot-turn-separators", order: 1000, inject: face }, TurnTailCell),
		// A side question is not a transcript row. After its snapshot turn closes it sits on
		// that turn's tail, ahead of the time separator.
		() =>
			shadow(
				"conversation.chat.turnTail",
				{ id: "bot-btw", order: 800, priority: BOT_PRIORITY, inject: face },
				BtwTurnTail,
			),
		() =>
			shadow(
				"conversation.chat.turnTail",
				{ id: "bot-learning", order: 850, priority: BOT_PRIORITY, inject: face },
				LearningTurnTail,
			),
		// The third-party dsh-cost-meter draws a per-turn "本轮费用" line into the turn tail.
		// A Bot chat keeps usage on its usage page instead of after every turn, so that entry
		// is replaced with nothing: the same id and a shadowing priority below it win the cell,
		// and the plugin itself stays installed (Agent mode still shows its line).
		() => shadow("conversation.chat.turnTail", { id: "cost-meter-turn", order: 10, priority: BOT_PRIORITY }, Nothing),
		// A Bot condenses its conversation without telling anyone; the chat keeps showing every
		// message.
		() =>
			shadow(
				"conversation.chat.node",
				{ key: "question-reply", priority: BOT_PRIORITY, locale: "chat" },
				AnsweredReply,
			),
		() => shadow("conversation.chat.node", { key: "compaction", priority: BOT_PRIORITY, locale: "chat" }, CellEmpty),
		// A Bot chat leaves DSH's context lines (tool updates, injected context) out; a Bot
		// message spliced in mid-turn gets an event line from the step that reads it instead.
		() => shadow("conversation.chat.node", { key: "context", priority: BOT_PRIORITY, locale: "chat" }, CellEmpty),
		...(canDrawUserMessages()
			? ["user", "steering"].map(
					(key) => () =>
						shadow(
							"conversation.chat.node",
							{ key, priority: BOT_PRIORITY, locale: "chat", inject: face },
							UserMessageCell,
						),
				)
			: []),
		() => shadow("conversation.input.permission", { priority: BOT_PRIORITY }, Nothing),
		() => shadow("conversation.input.plan", { priority: BOT_PRIORITY }, Nothing),
		// The composer carries no model picker or run statistics; a Bot's model lives in its
		// details panel.
		() => shadow("conversation.input.model", { priority: BOT_PRIORITY }, Nothing),
		() => shadow("conversation.composer.dock", { id: "activity", order: 0, priority: BOT_PRIORITY }, Nothing),
		() => shadow("conversation.composer.dock", { id: "usage", order: 1, priority: BOT_PRIORITY }, Nothing),
		() =>
			shadow("conversation.composer.dock", { id: "btw", order: 2, priority: BOT_PRIORITY, inject: face }, BtwDock),
		() => shadow("conversation.input.left", { id: "bot-plus", order: -100, inject: face }, ComposerPlus),
		() =>
			shadow(
				"conversation.composer",
				{
					priority: BOT_PRIORITY,
					select: (owner: any) =>
						owner.pendingInteraction?.kind === "question" ? owner.pendingInteraction : null,
				},
				QuestionCard,
			),
		() => shadow("conversation.input.dock", { id: "bot-members", order: -120, inject: face }, MemberDock),
		() => shadow("conversation.input.dock", { id: "bot-model", order: -110, inject: face }, ModelChoiceDock),
		() => shadow("conversation.input.dock", { id: "bot-question", order: -100, inject: face }, QuestionDock),
		() => shadow("conversation.input.dock", { id: "bot-view", order: -95, inject: face }, WidgetDock),
		() => shadow("conversation.input.dock", { id: "bot-secret", order: -90, inject: face }, SecretDock),
		() => shadow("conversation.input.dock", { id: "bot-connector", order: -89, inject: face }, ConnectorDock),
		() => shadow("conversation.input.dock", { id: "bot-mail", order: -88, inject: face }, MailDock),
		() =>
			shadow(
				"conversation.input.dock",
				{ id: "bot-learning", order: 850, priority: BOT_PRIORITY, inject: face },
				LearningDock,
			),
		// The shell's own queue dock lists every queued inbox row as the user's drafts -
		// including the team's relayed mail. Reusing its id puts ours in its cell; it lists
		// only the sends the user authored (#663).
		() =>
			shadow(
				"conversation.input.dock",
				{ id: "queue", order: 20, priority: BOT_PRIORITY, inject: queueFace },
				QueueDock,
			),
	];
	// The return button belongs to neither group: it renders only in Agent mode.
	ctx.effect(() => installCompiledStyles(RETURN_CSS, "return"), "ocean-crew: return styles");
	shadow("sidebar.footer.action", { id: "bot-return", order: -300, inject: face }, BotReturn);

	// The main view decides `plain`: a DSH Agent Session keeps the Bot shell but withdraws
	// the conversation replacements, so the native dsh page shows. A jump this plugin did
	// not start - the hero's workspace picker or a fork - opens an unowned Session; coming
	// from a DSH Agent Session it is adopted into that Agent.
	ctx.effect(() => {
		let previous: string | undefined;
		const sync = () => {
			const list = ctx.sessions.list.getSnapshot();
			const main = (Object.values(list.byId ?? {}) as any[]).find(
				(session: any) => (session?.retainedBy?.mainView ?? 0) > 0,
			)?.id as string | undefined;
			const plain = isAgentSessionId(main as string);
			setPlain(plain);
			if (plain) dropPanels();
			if (main === previous) return;
			const before = previous;
			previous = main;
			const ours = expected !== null && main === expected;
			expected = null;
			if (ours || main === undefined) return;
			// Adoption is a Bot-mode affair: in Agent mode the native sidebar owns navigation,
			// and opening an existing Session there must not pull it in.
			if (surface.getSnapshot().mode !== "bot") return;
			const agentId = before !== undefined ? agentOfSession(before) : undefined;
			if (agentId === undefined) return;
			const snapshot = roster.getSnapshot();
			if (
				snapshot.byId[main] !== undefined ||
				snapshot.roomsById[main] !== undefined ||
				agentOfSession(main) !== undefined
			)
				return;
			// Only a Session this jump created joins the Agent: a blank one from the workspace
			// picker, or a fork of a Session the same Agent owns. An existing Session the user
			// opened from the sidebar keeps its team tools and stays out.
			const row = list.byId[main];
			// A subagent child reports the Agent Session as its parent, but adopting it would
			// steal it from subagent routing - the Host refuses anyway, so skip.
			if (row?.origin === "subagent") return;
			// The client list maps the fork's parent to `parentId`; the raw field is the
			// fallback for shapes that skip the mapping.
			const parent = row?.parentId ?? row?.parentSessionId;
			const forkedFromAgent = parent !== undefined && agentOfSession(parent) === agentId;
			if (row?.blank !== true && !forkedFromAgent) return;
			pendingAdopt.set(main, agentId);
			setPlain(true);
			void call("agent-adopt", { agentId, sessionId: main })
				.then(() => pull())
				.catch((error: any) => {
					pendingAdopt.delete(main);
					console.warn("[ocean-crew] agent-adopt", error);
					// The Session never joined the Agent: the sync puts the team surface back (a
					// Map delete fires no subscription), and the user hears why.
					sync();
					actions.reportError(error, "agent-adopt");
				});
			// The hero's workspace picker leaves the blank Session it switched away from
			// behind; in another workspace it stays empty forever, so it is archived.
			const next = workspaceOf(main);
			if (
				list.byId[before as string]?.blank === true &&
				next !== undefined &&
				workspaceOf(before as string) !== next
			) {
				void call("agent-archive", { agentId, sessionId: before })
					.then(() => pull())
					.catch(() => {});
			}
		};
		const offList = ctx.sessions.list.subscribe(sync);
		const offRoster = roster.subscribe(sync);
		sync();
		return () => {
			offList();
			offRoster();
		};
	}, "ocean-crew: agent surface");

	ctx.effect(() => {
		const groups = surfaceGroups(
			{ shell: installShell, conversation: installConversation },
			{
				onError: (_group: string, error: any) =>
					actions.reportError(
						new Error(
							t("Bot mode could not be set up here: {error}", { error: error?.message ?? String(error) }),
						),
						"surface",
					),
			},
		);
		// A shadow step can mount "successfully" with nothing registered: when a slot's inject
		// callback throws inside the host, the host cancels the declaration's subscription but
		// the step's disposer still counts the group as mounted. After the shell goes on, check
		// that its sidebar entry really landed; remount a few times when it did not (cold start
		// race).
		let verifyTimer: any = 0;
		let verifyAttempts = 0;
		const verifySidebar = () => {
			if (!groupsFor(surface.getSnapshot()).shell) return;
			let landed = false;
			let declared = true;
			try {
				landed = ctx.slots.entries("sidebar.workspaces").some((entry: any) => entry.component === TeamSidebar);
				declared = ctx.slots.spec?.("sidebar.workspaces") !== undefined;
			} catch {
				declared = false;
			}
			if (landed) return;
			if (!declared) {
				// The slot itself is not declared yet; keep watching for a while.
				if (verifyAttempts < 20) {
					verifyAttempts += 1;
					verifyTimer = setTimeout(verifySidebar, 250);
				}
				return;
			}
			if (verifyAttempts >= 3) return;
			verifyAttempts += 1;
			console.warn("[ocean-crew] sidebar entry missing after shell mount; remounting");
			groups.remount("shell");
			verifyTimer = setTimeout(verifySidebar, 250);
		};
		const reconcile = () => {
			groups.reconcile(groupsFor(surface.getSnapshot()));
			clearTimeout(verifyTimer);
			verifyAttempts = 0;
			verifyTimer = setTimeout(verifySidebar, 250);
		};
		reconcile();
		if (surface.getSnapshot().mode === "bot") ensureBotHome();
		const unsub = surface.subscribe(reconcile);
		return () => {
			unsub();
			clearTimeout(verifyTimer);
			groups.dispose();
		};
	}, "ocean-crew: surface");
}
