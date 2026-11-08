// Ocean Crew host entry: DSH mounts this plugin, calls `apply(ctx, config)`, and the
// runtime installs every host module in a fixed order.
import { join } from "node:path";
import { install as installBrowser } from "./host/browser/browser.ts";
import { install as installBrowserPlugins } from "./host/browser/browser-plugins.ts";
import { install as installBtw } from "./host/chat/btw.ts";
import { install as installChannel } from "./host/chat/channel.ts";
import { install as installChatIndex } from "./host/chat/chat-index.ts";
import { install as installDelivery } from "./host/chat/delivery.ts";
import { install as installFeed } from "./host/chat/feed.ts";
import { install as installHandoffs } from "./host/chat/handoffs.ts";
import { install as installParts } from "./host/chat/parts.ts";
import { install as installRequests } from "./host/chat/requests.ts";
import { install as installResume } from "./host/chat/resume.ts";
import { install as installSide } from "./host/chat/side.ts";
import { install as installSteer } from "./host/chat/steer.ts";
import { install as installTurns } from "./host/chat/turns.ts";
import { install as installConnectors } from "./host/connectors/index.ts";
import { createWarn, install as installDiagnostics } from "./host/core/diagnostics.ts";
import { install as installDshUpdate } from "./host/core/dsh-update.ts";
import { dshHomeOf, install as installFolders } from "./host/core/folders.ts";
import { install as installLinks } from "./host/core/links.ts";
import type { DshContext, HostModule, Runtime } from "./host/core/runtime.ts";
import { install as installStore } from "./host/core/store.ts";
import { install as installThinking } from "./host/core/thinking.ts";
import { install as installTimeContext } from "./host/core/time-context.ts";
import { install as installUpdate } from "./host/core/update.ts";
import { install as installGroups } from "./host/groups/index.ts";
import { install as installIm } from "./host/im/index.ts";
import { install as installAgents } from "./host/team/agents.ts";
import { install as installModels } from "./host/team/models.ts";
import { install as installPermissions } from "./host/team/permissions.ts";
import { install as installPrivacy } from "./host/team/privacy.ts";
import { install as installPrompt } from "./host/team/prompt.ts";
import { install as installProviders } from "./host/team/providers.ts";
import { install as installRoster } from "./host/team/roster.ts";
import { install as installTools } from "./host/team/tools.ts";
import { install as installApprovals } from "./host/work/approvals.ts";
import { install as installAvatar } from "./host/work/avatar.ts";
import { install as installAvatarLibrary } from "./host/work/avatar-library.ts";
import { install as installCapabilities } from "./host/work/capabilities.ts";
import { install as installGoalSkills } from "./host/work/goal-skills.ts";
import { install as installGoals } from "./host/work/goals.ts";
import { install as installImages } from "./host/work/images.ts";
import { install as installLearning } from "./host/work/learning.ts";
import { install as installMemory } from "./host/work/memory.ts";
import { install as installReset } from "./host/work/reset.ts";
import { install as installSchedules } from "./host/work/schedules.ts";
import { install as installSecrets } from "./host/work/secrets.ts";
import { install as installUsage } from "./host/work/usage.ts";
import type { PluginConfig } from "./shared/config.ts";

export const name = "ocean-crew";

export const inject = [
	"llm",
	"tools",
	"systemPrompt",
	"sessionController",
	"sessions",
	"sessionTitle",
	"workspaceRegistry",
	"connection",
] as const;

// Order matters: listeners run and tools list in registration order, and a module
// must never be installed before a module it calls.

const MODULES: HostModule[] = [
	installDiagnostics,
	installStore,
	installModels,
	installProviders,
	installPermissions,
	installTurns,
	installSteer,
	installHandoffs,
	installRequests,
	installDelivery,
	installRoster,
	installFolders,
	installPrivacy,
	installAgents,
	installPrompt,
	installTimeContext,
	installLinks,
	installTools,
	installChatIndex,
	installGroups,
	installGoals,
	installApprovals,
	installResume,
	installMemory,
	installParts,
	installBtw,
	installSide,
	installImages,
	installAvatar,
	installAvatarLibrary,
	installSecrets,
	installConnectors,
	installCapabilities,
	installLearning,
	installReset,
	installSchedules,
	installBrowser,
	installBrowserPlugins,
	installUsage,
	installUpdate,
	installDshUpdate,
	installThinking,
	installFeed,
	installIm,
	installChannel,
	installGoalSkills,
];

export function apply(ctx: DshContext, config: PluginConfig = {}): void {
	createRuntime(ctx, config);
}

export function createRuntime(ctx: DshContext, config: PluginConfig = {}): Runtime {
	const dshHome = dshHomeOf(process.env.DSH_HOME);
	const home = config.home ?? join(dshHome, "bot");
	// The modules install into this object; each one publishes the part of the runtime it
	// owns, so the core object is only complete once MODULES has run.
	const rt = {
		ctx,
		config,
		dshHome,
		home,
		statePath: join(home, "state.json"),
		// The Bot-only tools each module defines; tools.ts registers them in each Bot
		// Session's own scope, never globally.
		teamTools: [],
		defaults: {
			mainName: config.mainName ?? "Chief",
			mainRole: config.mainRole ?? "Chief of Staff",
		},
		warn: createWarn(ctx),
	} as unknown as Runtime;
	for (const install of MODULES) install(rt);
	return rt;
}
