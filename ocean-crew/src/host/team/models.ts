// Models. Every Bot runs on one model of its own, fixed when it is created and changed
// only in its settings or by a Main Bot. The team's first Main Bot has none until the
// user picks one in its chat. The Session keeps the selection durably.
// The
// provider settings surface, local agents, usage and the settings-window catalog
// nothing here invents a second model mechanism.

import type { Bot } from "../../shared/state.ts";
import type { Runtime } from "../core/runtime.ts";
import { normalize, splitRef } from "../core/text.ts";

const CATALOG_TTL_MS = 10_000;
const ROUTE_WAIT_MS = 30_000;
// The DeepSeek account's sign-in grant (dsh-deepseek-account-platform).
const ACCOUNT_RECORD = "deepseek-account-platform/default";

// One model DSH serves, as the pickers read it.
export interface ModelEntry {
	ref: string;
	provider: string;
	providerName: string;
	id: string;
	name: string;
	input?: string[];
	needsKey?: boolean;
	reasoning?: ModelReasoning;
}

// A model's thinking level; `description` is shown beside the name when the provider has one.
export interface ModelEffort {
	id: string;
	name: string;
	description?: string;
}

export interface ModelReasoning {
	efforts: ModelEffort[];
	defaultEffort?: string;
}

// A Session selection: the provider and model, with the thinking level when the Bot chose one.
export interface ModelRoute {
	provider: string;
	model: string;
	reasoningEffort?: string;
}

export interface ModelSelection {
	provider: string;
	model: string;
	reasoningEffort?: string;
}

// DSH's services, as this module reads them. They are DSH's own, so only the members
// used here are shaped; the rest of each service is none of this module's business.
interface LlmProvider {
	id: string;
	name?: string;
}

interface LlmModel {
	id: string;
	name?: string;
	inputModalities?: readonly string[];
}

interface ModelInfo {
	reasoning?: {
		efforts?: Array<{ id: string; name?: string; description?: string }>;
		defaultEffort?: string;
	};
}

interface LlmService {
	listProviders(): LlmProvider[];
	listModels(provider: string): Promise<LlmModel[]>;
	resolveModelInfo?(provider: string, model: string): Promise<ModelInfo | undefined>;
}

interface AgentDefaultModelService {
	currentSelection?(): ModelSelection | undefined;
	saveSelection(selection: ModelSelection): Promise<unknown>;
}

interface SessionControllerService {
	selectModel(request: {
		sessionId: string;
		provider: string;
		model: string;
		reasoningEffort?: string;
	}): Promise<{ selected?: ModelSelection } | undefined>;
}

interface CredentialsService {
	describe(ref: string): Promise<{ configured?: boolean } | undefined>;
	describeRecord(key: string): Promise<{ configured?: boolean } | undefined>;
}

export function install(rt: Runtime): void {
	const { ctx } = rt;
	const state = rt.state;
	const llm = (): LlmService => ctx.llm as unknown as LlmService;
	const defaults = (): AgentDefaultModelService | undefined =>
		ctx.get?.("agentDefaultModel") as AgentDefaultModelService | undefined;
	const controller = (): SessionControllerService => ctx.sessionController as unknown as SessionControllerService;

	let modelsSynced: Promise<void> | undefined;
	let catalogCache: { at: number; value: ModelEntry[] } = { at: 0, value: [] };
	// Routes DSH serves that cannot answer a request at all — a hosted loop engine
	// publishes one so its Sessions can be prompted. Once one refuses with
	// HOSTED_ENGINE_ROUTE it is remembered with the models its provider served then,
	// and nothing chooses it again until that provider serves different models.
	const refused = new Map<string, string | undefined>();
	const answerable = (entries: ModelEntry[]): ModelEntry[] =>
		refused.size === 0 ? entries : entries.filter((entry) => !refused.has(entry.ref));
	// The models a ref's provider serves, as a string to compare; undefined when it
	// cannot be listed, e.g. the provider is not registered.
	async function servedModels(ref: string): Promise<string | undefined> {
		const route = splitRef(ref);
		if (route === undefined) return undefined;
		try {
			return JSON.stringify(await llm().listModels(route.provider));
		} catch {
			return undefined;
		}
	}
	// An adapter update may have replaced a refused placeholder with a real route, which
	// serves other models; the same models again are the same route, still refused.
	async function forgetChangedRefusals(): Promise<void> {
		for (const [ref, served] of refused) {
			const now = await servedModels(ref);
			if (now !== undefined && now !== served) refused.delete(ref);
		}
	}
	// A model's thinking levels, resolved once and kept for a short while: they change
	// only with the provider, which also drops the catalog cache.
	const reasoningCache = new Map<string, { at: number; value: ModelReasoning | undefined }>();
	const dropCatalog = (): void => {
		catalogCache = { at: 0, value: [] };
	};
	// A key set or a sign-in may be the user's fix for a Bot's failed turn (turns.ts); a
	// key removed or a sign-out is not. A provider that registers or changes fixes
	// nothing by itself: providers register late at every start.
	ctx.on?.("llm/adapters-updated", () => {
		dropCatalog();
		reasoningCache.clear();
		return forgetChangedRefusals();
	});
	ctx.on?.("credentials/reference-updated", async (ref: string) => {
		dropCatalog();
		if (await inPlace((credentials) => credentials.describe(ref))) rt.unblockBots?.({ ref });
	});
	// A sign-in writes the account's record. A sign-out removes it, and so does a token
	// the provider refused, while the turn that failed on it still runs. Other plugins'
	// records (an OAuth token refresh) say nothing about the account.
	ctx.on?.("credentials/record-updated", async (key: string) => {
		dropCatalog();
		if (String(key) !== ACCOUNT_RECORD) return;
		if (await inPlace((credentials) => credentials.describeRecord(key))) rt.unblockBots?.({ signedIn: true });
	});
	ctx.on?.("settings/document-updated", dropCatalog);

	// Whether a credential is there after a change. One that cannot be read counts as
	// there, so a fix is not missed.
	async function inPlace(
		describe: (credentials: CredentialsService) => Promise<{ configured?: boolean } | undefined>,
	): Promise<boolean> {
		const credentials = ctx.get?.("credentials") as CredentialsService | undefined;
		if (credentials === undefined) return true;
		try {
			return (await describe(credentials))?.configured !== false;
		} catch {
			return true;
		}
	}

	// The thinking levels a model serves: `{efforts: [{id, name, description?}],
	// defaultEffort?}`, or undefined when it has none or the provider cannot say.
	async function reasoningOf(ref: string): Promise<ModelReasoning | undefined> {
		const cached = reasoningCache.get(ref);
		if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
		const route = splitRef(ref);
		const pending = route === undefined ? undefined : llm().resolveModelInfo?.(route.provider, route.model);
		const info = pending === undefined ? undefined : await pending.catch(() => undefined);
		const value: ModelReasoning | undefined =
			info?.reasoning === undefined
				? undefined
				: {
						efforts: (info.reasoning.efforts ?? []).map((effort) => ({
							id: effort.id,
							name: effort.name ?? effort.id,
							...(effort.description ? { description: effort.description } : {}),
						})),
						...(info.reasoning.defaultEffort === undefined
							? {}
							: { defaultEffort: info.reasoning.defaultEffort }),
					};
		reasoningCache.set(ref, { at: Date.now(), value });
		return value;
	}

	// A provider's model list can change in DSH settings without any event, so a picker
	// that is about to be used asks for a `fresh` one. Entries for models a Bot uses
	// also carry their `reasoning`, so the picker can offer thinking levels.
	async function catalog({ fresh = false }: { fresh?: boolean } = {}): Promise<ModelEntry[]> {
		if (!fresh && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.value.length > 0)
			return answerable(catalogCache.value);
		const entries: ModelEntry[] = [];
		for (const provider of llm().listProviders()) {
			let models: LlmModel[] = [];
			try {
				models = await llm().listModels(provider.id);
			} catch {
				continue;
			}
			for (const model of models) {
				entries.push({
					ref: `${provider.id}/${model.id}`,
					provider: provider.id,
					providerName: provider.name ?? provider.id,
					id: model.id,
					name: model.name ?? model.id,
					...(model.inputModalities ? { input: [...model.inputModalities] } : {}),
				});
			}
		}
		// DSH serves a provider's models whether or not its key is set; without one, every
		// turn on them fails.
		const missing = (await rt.missingKeys?.([...new Set(entries.map((entry) => entry.provider))])) as
			| Set<string>
			| undefined;
		const missingKeys = missing ?? new Set<string>();
		for (const entry of entries) if (missingKeys.has(entry.provider)) entry.needsKey = true;
		// A key can arrive without an event (an environment variable at the next start), so
		// a provider listed with its key again lifts what its missing key blocked.
		rt.unblockBots?.({ keyed: new Set(entries.filter((entry) => !entry.needsKey).map((entry) => entry.provider)) });
		const used = new Set<string>();
		for (const bot of Object.values(state.bots)) {
			for (const ref of [bot.model, bot.appliedModel]) if (typeof ref === "string") used.add(ref);
		}
		await Promise.all(
			entries
				.filter((entry) => used.has(entry.ref))
				.map(async (entry) => {
					const reasoning = await reasoningOf(entry.ref);
					if (reasoning !== undefined) entry.reasoning = reasoning;
				}),
		);
		catalogCache = { at: Date.now(), value: entries };
		return answerable(entries);
	}

	// The profile default model of DSH as set, served or not, and able to answer.
	const defaultRef = (): string | undefined => {
		const selection = defaults()?.currentSelection?.();
		if (!selection?.provider || !selection.model) return undefined;
		const ref = `${selection.provider}/${selection.model}`;
		return refused.has(ref) ? undefined : ref;
	};
	// A model whose provider has no key fails every turn, so no Bot is given one unasked.
	const keyed = (entries: ModelEntry[]): ModelEntry[] => entries.filter((entry) => entry.needsKey !== true);
	const usableOf = (entries: ModelEntry[]): ModelEntry[] => keyed(entries);
	// By the catalog as last listed, without waiting for a fresh one.
	const isUsable = (ref: string | undefined): boolean => keyed(catalogCache.value).some((entry) => entry.ref === ref);
	// The profile default model of DSH, when it is served and usable; else the first
	// usable model; else none.
	function pickDefault(entries: ModelEntry[]): string | undefined {
		const usable = usableOf(entries);
		const ref = defaultRef();
		// Neither a refused route nor one that fails for a missing key is picked.
		const list = answerable(usable);
		return list.find((entry) => entry.ref === ref)?.ref ?? list[0]?.ref;
	}
	const defaultModel = async (): Promise<string | undefined> => pickDefault(await catalog());

	// The model a create that names none starts on: the team's pick while the catalog
	// still serves it, else the DSH default. A create fixes the ref then, so a later
	// change of either default leaves the Bot alone.
	const defaultBotModel = async (): Promise<string | undefined> => {
		const entries = await catalog();
		const preferred = state.prefs.defaultBotModel;
		return entries.some((entry) => entry.ref === preferred) ? preferred : pickDefault(entries);
	};

	// A full `provider/model` ref, or a model id or name that only one provider serves.
	async function resolveModel(text: unknown): Promise<string> {
		const wanted = String(text ?? "").trim();
		const entries = await catalog({ fresh: true });
		const exact = entries.find((entry) => entry.ref === wanted);
		if (exact) return exact.ref;
		const key = normalize(wanted);
		const named = entries.filter((entry) => normalize(entry.id) === key || normalize(entry.name) === key);
		if (named.length === 1) return named[0].ref;
		const known = entries.map((entry) => entry.ref).join(", ") || "none";
		throw new Error(
			named.length > 1
				? `Model ${wanted} is served by more than one provider; use one of ${named.map((entry) => entry.ref).join(", ")}`
				: `Model ${wanted} is not available. Available models: ${known}`,
		);
	}

	// A Bot with no model yet waits for the user to pick one and changes nothing. A
	// model that is no longer served falls back to the last one it ran on, then the
	// default; a fallback is never one that needs a key, nor a local agent. A local
	// agent that is gone stays the Bot's: its turn fails with the repair card.
	async function desiredModel(bot: Bot): Promise<string | undefined> {
		if (!bot.model) return undefined;
		const entries = await catalog();
		if (entries.some((entry) => entry.ref === bot.model)) return bot.model;
		return usableOf(entries).some((entry) => entry.ref === bot.appliedModel)
			? bot.appliedModel
			: pickDefault(entries);
	}

	// The thinking level a Bot asked for, when the model it runs on serves it; else the
	// model's own default applies. A level the model does not have is ignored, never
	// sent: an explicit effort a provider does not know is a hard refusal there.
	async function desiredEffort(bot: Bot, ref: string | undefined): Promise<string | undefined> {
		if (bot.effort === undefined || ref === undefined) return undefined;
		const reasoning = await reasoningOf(ref);
		return reasoning?.efforts?.some((effort) => effort.id === bot.effort) ? bot.effort : undefined;
	}

	// A thinking level id, or a name only one level of the model has, like resolveModel.
	async function resolveEffort(ref: string, text: unknown): Promise<string | undefined> {
		const wanted = String(text ?? "").trim();
		if (wanted === "") return undefined;
		const reasoning = await reasoningOf(ref);
		const efforts = reasoning?.efforts ?? [];
		if (efforts.length === 0) throw new Error(`Model ${ref} has no thinking levels`);
		const key = normalize(wanted);
		const named = efforts.filter((effort) => normalize(effort.id) === key || normalize(effort.name) === key);
		if (named.length === 1) return named[0].id;
		throw new Error(
			`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map((effort) => effort.name).join(", ")}`,
		);
	}

	// The profile default model's thinking level, when the model a Bot starts on
	// serves it. A level the model does not know is ignored, like an inherited
	// `bot.effort` — the model's own default applies instead.
	async function defaultEffort(ref: string | undefined): Promise<string | undefined> {
		const wanted = defaults()?.currentSelection?.()?.reasoningEffort;
		if (ref === undefined || wanted === undefined) return undefined;
		return resolveEffort(ref, wanted).catch(() => undefined);
	}

	// DSH's selectModel also saves the selection as the profile default model, in the
	// background. A Bot's model is its own, so the user's default is written back after
	// it. Selections run one at a time and wait for the write-back: profile writes land in
	// submission order, so the next one reads the user's default, not a Bot's.
	let selecting: Promise<unknown> = Promise.resolve();
	// Recheck group Sessions after every restart: Bot-level applied fields cannot
	// prove that an older group Session received the member's thinking level.
	const sessionSelections = new Map<string, ModelSelection>();
	function selectSessionModel(
		sessionId: string,
		route: ModelRoute,
	): Promise<{ selected?: ModelSelection } | undefined> {
		const run = selecting.then(async () => {
			const service = defaults();
			const before = service?.currentSelection?.();
			const result = await controller().selectModel({
				sessionId,
				provider: route.provider,
				model: route.model,
				...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
			});
			const saved: ModelSelection = result?.selected ?? {
				provider: route.provider,
				model: route.model,
				...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
			};
			if (service !== undefined && before?.provider && before.model && !sameSelection(before, saved)) {
				await service
					.saveSelection(before)
					.catch((error) => rt.warn("ocean-crew: the default model was not restored: %s", error));
			}
			// The requested route, not what DSH reports back: the resolved default is not an
			// explicit Bot choice to reapply.
			sessionSelections.set(sessionId, {
				provider: route.provider,
				model: route.model,
				...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
			});
			return result;
		});
		selecting = run.catch(() => undefined);
		return run;
	}

	const sameSelection = (a: ModelSelection, b: ModelSelection): boolean =>
		a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;

	// `force` re-selects even when the record says it is applied: the composer's own
	// model picker can move the Session without telling this plugin.
	async function applyModel(bot: Bot, { force = false }: { force?: boolean } = {}): Promise<string | undefined> {
		const ref = await desiredModel(bot);
		if (ref === undefined) return ref;
		const effort = await desiredEffort(bot, ref);
		const ownChanged = force || bot.appliedModel !== ref || (bot.appliedEffort ?? undefined) !== effort;
		const parsed = splitRef(ref);
		if (parsed === undefined) throw new Error(`Model ${ref} is not a provider/model reference`);
		const route: ModelRoute = {
			provider: parsed.provider,
			model: parsed.model,
			...(effort === undefined ? {} : { reasoningEffort: effort }),
		};
		if (ownChanged) await selectSessionModel(rt.chatOf(bot.id), route);
		for (const sessionId of rt.groupSessionsOf(bot.id)) {
			const applied = sessionSelections.get(sessionId);
			if (!force && applied !== undefined && sameSelection(applied, route)) continue;
			await selectSessionModel(sessionId, route).catch((error) =>
				rt.warn("ocean-crew: model for %s in a group not applied: %s", bot.name, error),
			);
		}
		if (!ownChanged) return ref;
		bot.appliedModel = ref;
		if (effort === undefined) delete bot.appliedEffort;
		else bot.appliedEffort = effort;
		await rt.save();
		return ref;
	}

	// A provider may register after the plugin starts; a greeting waits for its Bot's
	// model instead of failing with "no adapter registered".
	async function waitForModel(bot: Bot, ms = ROUTE_WAIT_MS): Promise<string | undefined> {
		const deadline = Date.now() + ms;
		for (;;) {
			if (!bot.model) return undefined;
			catalogCache = { at: 0, value: [] };
			const served = new Set((await catalog()).map((entry) => entry.ref));
			if (served.has(bot.model) || Date.now() >= deadline) return desiredModel(bot);
			await new Promise<void>((resolve) => {
				let settled = false;
				const done = (): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					off();
					resolve();
				};
				const timer = setTimeout(done, Math.min(2000, deadline - Date.now()));
				const off = ctx.on?.("llm/adapters-updated", done);
			});
		}
	}

	// Sequential, and again whenever the answerable models change (a refused route is
	// not one of them): a provider that registers late still gets its Bots' models selected.
	let syncedKey: string | undefined;
	const syncModels = (): Promise<void> => {
		const key = answerable(catalogCache.value)
			.map((entry) => entry.ref)
			.join(",");
		if (key !== syncedKey) {
			syncedKey = key;
			modelsSynced = modelsSynced === undefined ? syncAll() : modelsSynced.then(syncAll, syncAll);
		}
		return modelsSynced ?? Promise.resolve();
	};
	async function syncAll(): Promise<void> {
		for (const bot of Object.values(state.bots)) {
			await applyModel(bot).catch((error) => rt.warn("ocean-crew: model for %s not applied: %s", bot.name, error));
		}
	}

	// A route that refused a request for not being a model endpoint: it stays out of
	// the catalog from now on, the Bots pinned to it move to what they would be given
	// today, and each of them re-selects even when its record looks applied (`force`):
	// its Session may still be on the route, or on another Bot's route in a group.
	async function routeRefused(ref: string, bot?: Bot): Promise<void> {
		const served = await servedModels(ref);
		if (!refused.has(ref)) {
			refused.set(ref, served);
			rt.warn("ocean-crew: %s is not a model endpoint, so it is not chosen again", ref);
			const entries = await catalog();
			const pinned = Object.values(state.bots).filter((other) => other.model === ref || other.appliedModel === ref);
			for (const other of pinned) {
				if (other.model === ref) other.model = pickDefault(entries);
				if (other.appliedModel === ref) delete other.appliedModel;
			}
			await rt.save();
			for (const other of pinned) {
				if (other !== bot)
					await applyModel(other, { force: true }).catch((error) =>
						rt.warn("ocean-crew: model for %s not applied: %s", other.name, error),
					);
			}
		}
		if (bot !== undefined) await applyModel(bot, { force: true });
	}

	Object.assign(rt, {
		catalog,
		cachedCatalog: () => answerable(catalogCache.value),
		cachedDefault: () => pickDefault(catalogCache.value),
		defaultRef,
		defaultModel,
		defaultBotModel,
		defaultEffort,
		isUsable,
		resolveModel,
		desiredModel,
		reasoningOf,
		resolveEffort,
		desiredEffort,
		selectSessionModel,
		applyModel,
		waitForModel,
		syncModels,
		routeRefused,
		dropCatalog,
	});
}
