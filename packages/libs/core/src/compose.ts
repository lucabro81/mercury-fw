/**
 * Builds a Mercury instance from its composition config: the model, the tools
 * this instance has enabled, the memory layers, and the turn pipeline. This is
 * the one place that decides which tools and channels exist on this instance —
 * every other module takes them as inputs.
 *
 * It *builds*, it does not *start*: `composeMercury()` returns `handleTurn`, the
 * channel runtime context, and a deferred `startCrons` closure, so each
 * entrypoint decides what to run. The long-running service (`index.ts`)
 * starts the network channels + crons; the dev REPL (`repl.ts`) starts
 * only the terminal against the same `handleTurn`.
 *
 * Note: this factory (and `repl.ts`) are written to be lifted into the future
 * Mercury CLI (a separate monorepo app that scaffolds an instance) — that CLI
 * would reuse `composeMercury` to boot the app it built. Not built yet.
 */
import { getOllamaProvider } from "./model/client.ts";
import { resolveModels } from "./model/models.ts";
import { createScheduler, type BackgroundJobName, type Urgency } from "./model/scheduler.ts";
import { createConfirmationStore, createStageChoices, createStageConfirmation, type ConfirmationStore, type ResumedAction, type WriteConfirmationNote } from "@mercury-fw/confirm-engine";
import { createDisplayStore } from "./tools/display-store.ts";
import { createPresentTool } from "./tools/present-tool.ts";
import { loadPlugins } from "./plugins/plugin-loader.ts";
import { createPluginHooks, type TurnRecordInfo } from "./plugins/plugin-hooks.ts";
import { createContextAssembler, profileFor, resolveContext } from "./context/context.ts";
import { createChannelContextAdmin } from "./context/context-admin.ts";
import { createContextSettings } from "./context/context-settings.ts";
import { materializeCliCredentials } from "./credentials/materialize.ts";
import type { MercuryConfig } from "./config/define-config.ts";
import { createResumeSlots } from "./session/resume-slots.ts";
import type { Message } from "./session/history.ts";
import { createConversations } from "./session/conversations.ts";
import { createEpisodicSummarizer } from "./session/episodic-summarizer.ts";
import { createSemanticFactExtractor } from "./session/semantic-fact-extractor.ts";
import { buildContextPrimer, primerOptions } from "./session/context-primer.ts";
import { buildSystemPrompts } from "./session/system-prompt.ts";
import { assistantNameOf, skillsWithAssistantName, toolsWithAssistantName } from "./session/assistant-name.ts";
import { createSessionLock } from "./router/session-lock.ts";
import { createSessionCapture } from "./session/session-capture.ts";
import { createTurnRunner, parseStallTimeoutMs } from "./router/turn-runner.ts";
import { loadAuth } from "./router/auth-loader.ts";
import { loadDirectory } from "./router/directory-loader.ts";
import type { TurnSink } from "./router/provider.ts";
import type { HandleTurn, ChannelRuntimeContext, ChannelPlugin, VectorIndex } from "@mercury-fw/channel-types";
import type { MercuryModelHandle, PluginNeed } from "@mercury-fw/plugin-types";
import {
  truncateForDisplay,
  describeToolOutcome,
} from "./router/tool-log.ts";
import type { StepInfo } from "./session/step-info.ts";
import { withToolStartHook } from "./session/tool-start-hook.ts";
import { confirmationNotesRoot, copyVaultConfirmations, pendingConfirmationTokens, writeConfirmationNote } from "./data/confirmation-notes.ts";
import { createResolveReferenceTool } from "./tools/resolve-reference-tool.ts";
import { createReadSkillTool } from "./session/read-skill-tool.ts";
import { createIdleSessionScanner } from "./cron/idle-session-scanner.ts";
import { startIdleSessionCron, captureSessionToMemory, type CaptureDeps } from "./cron/idle-session-cron.ts";
import {
  EPISODIC_SPACE,
  storeEpisodicSummary,
  getLastSessionEpisodicSummaries,
} from "./memory/episodic-store.ts";
import { listVerbatimBySession } from "./memory/verbatim-archive-store.ts";
import { setTitle, titlesOf } from "./memory/conversation-titles-store.ts";
import { createVerbatimRecall } from "./memory/memory-provider.ts";
import { storeSemanticFact } from "./memory/semantic-facts-store.ts";
import { TOOL_CORRECTIONS_SPACE, storeToolCorrection } from "./memory/tool-corrections-store.ts";
import { MIGRATED_SPACES, setUpMemory, setUpWhenReachable } from "./memory/collection-setup.ts";
import { loadVectorIndex } from "./data/vector-index-loader.ts";
import { loadConversationStore, unusedStoreWarning } from "./data/conversation-store-loader.ts";
import { createToolCorrectionExtractor } from "./session/tool-correction-extractor.ts";
import { createEmbedder } from "./memory/embedder.ts";
import { createHostReads } from "./identity/host-reads.ts";
import { createChannelSettings } from "./identity/channel-settings.ts";
import { createChannelConversations } from "./identity/channel-conversations.ts";
import { resolveTimeZone, stripTurnStamp, timeZoneName } from "./session/turn-stamp.ts";
import { bindConfirm } from "./identity/confirm-binding.ts";
import { createPersonLogins } from "./identity/person-logins.ts";
import { createProfileStore, profilesPath } from "./identity/profiles.ts";
import { createTexts, instanceI18n, requestTexts, type Texts, type Translate } from "./i18n/i18n.ts";
import { channelMessages } from "./router/channel-loader.ts";
import { createPeople, type TurnWho } from "./identity/people.ts";
import { createLinkStore, linksPath } from "./identity/links.ts";
import { createLinking } from "./identity/linking.ts";
import { offeringFor, type Offering } from "./plugins/offering.ts";
import { AS_SELF_SUFFIX } from "./plugins/act-as-self.ts";
import { buildOfferedTools } from "./plugins/offered-tools.ts";
import { migrateMemoryToUserKeys } from "./identity/migrate-layout.ts";
import { createDaily } from "./cron/daily.ts";
import { pluginToolLog } from "./session/tool-log-buffer.ts";
import { pluginProfiles } from "./identity/plugin-profiles.ts";
import { loadTracer } from "./traces/trace-loader.ts";
import { migrateLegacyState, pluginDataRoot, requireDataPath } from "./data/data-dir.ts";
import type { Tracer } from "./traces/tracer.ts";
import { compressionEvent } from "./traces/compression-events.ts";
import { homedir } from "node:os";
import type { LanguageModel, Tool } from "ai";
import { getSelfHealth } from "./health.ts";
import { frameworkVersion } from "./version.ts";
import { buildPluginManifest } from "./plugins/manifest.ts";

/** A stoppable subsystem (cron, server). */
type Stoppable = { stop: () => void };

/** The confirm capability's binding to this instance's store and note writer, shared by the terminal and the channel runtime. */
export type ConfirmDeps = {
  store: ConfirmationStore;
  writeConfirmationNoteFn: WriteConfirmationNote;
  /** Keeps a confirmed action's result for the session's resumed turn. */
  onResume: (sessionKey: string, action: ResumedAction) => void;
};

/**
 * The built Mercury instance. `build`, not `start`: the channels and crons
 * are not running until an entrypoint starts them.
 */
export type ComposedApp = {
  /** The turn driver every channel funnels through (see `turn-runner.ts`). */
  handleTurn: HandleTurn;
  /** The declared channel plugins (from `mercury.config.ts`). */
  channels: ChannelPlugin[];
  /** The runtime context each channel's `build()` gets — confirm + in-process reads injected by the core. */
  channelRuntime: ChannelRuntimeContext;
  /** The confirm binding, for a caller (the terminal) that intercepts tokens directly. */
  confirmDeps: ConfirmDeps;
  /** The texts a person sees, in their language: for the terminal's own lines. */
  texts: Texts;
  ollamaHost: string;
  /** The turn model's name, for the terminal's context-size line. */
  ollamaModel: string;
  /** Starts the Layer-3 idle-capture cron and the plugins' daily work; returns a single stopper for shutdown. */
  startCrons: () => Stoppable;
  /** Where this instance's trace events go (#23): for the entrypoint's channel report (`loadChannels`) and to flush on shutdown. Records nothing without `traces` in the config. */
  tracer: Tracer;
};

/** Reads a required env var, failing fast instead of silently defaulting. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * Builds a Mercury instance from the composition `config` it is given + env. The
 * config is a parameter, never imported here: that's what makes the core
 * app-agnostic — an entrypoint (the service, the dev REPL, a future scaffolded
 * app) reads its own `mercury.config.ts` and passes it in. See {@link ComposedApp}.
 */
export async function composeMercury(config: MercuryConfig): Promise<ComposedApp> {
  // What every text calls the assistant: checked first, so a persona name that
  // can't stand in a prompt stops the app before anything starts.
  const assistantName = assistantNameOf(config.persona);
  // Shown as the app declares it; an empty one is none.
  const appVersion = config.version?.trim() || undefined;

  // Mercury's own state lives in its data folder (see data/data-dir.ts): a
  // missing MERCURY_DATA_PATH stops the start, and what an older instance kept
  // in the vault's `.mercury/` is copied over on the first start.
  const dataPath = requireDataPath(process.env);
  // Where an older instance kept its state, read only to copy it over once.
  const legacyVault = process.env.WIKI_VAULT_PATH || undefined;
  const migratedState = await migrateLegacyState({
    dataPath,
    ...(legacyVault === undefined ? {} : { vaultPath: legacyVault }),
    log: (msg) => console.error(`[data] ${msg}`),
  });
  // The confirmation notes live in the data folder too; an older instance kept
  // them in the vault, copied over once (see data/confirmation-notes.ts).
  const notesRoot = confirmationNotesRoot(dataPath);
  await copyVaultConfirmations({
    ...(legacyVault === undefined ? {} : { vaultPath: legacyVault }),
    notesRoot,
    log: (msg) => console.error(`[data] ${msg}`),
  });
  const writeNote: WriteConfirmationNote = (owner, token, fields) => writeConfirmationNote(notesRoot, owner, token, fields);

  // The models are built up front, before the plugins load and the system
  // prompt is built: a plugin's post-turn guard can be model-backed, and the
  // system prompt is assembled from the fragments the plugin loader returns —
  // both need the models in hand first. Each declared handle becomes one model
  // on the instance's Ollama, with its settings for every call on it.
  const provider = getOllamaProvider();
  const ollamaHost = requireEnv("OLLAMA_HOST"); // already validated by getOllamaProvider(); read again here for the terminal provider's getLoadedContextLength call
  // Without tsc (Bun doesn't typecheck), a config still on the old `model` gets here with no models.
  if (config.models?.turn === undefined) {
    throw new Error("models.turn is required: declare the model the turns run on with ollamaModel(...)");
  }
  // Memory found by meaning is embedded: an index without an embedding model is
  // a config that can't work, not something to start without.
  if (config.vectorIndex !== undefined && config.models.embedding === undefined) {
    throw new Error("vectorIndex is declared but models.embedding isn't: declare the model the memory is embedded with (ollamaEmbedding(...))");
  }
  const models = resolveModels(config.models, {
    language: (name, settings) => provider(name, settings),
    embedding: (name) => provider.textEmbeddingModel(name),
  });
  for (const line of models.describe()) console.error(line);
  const ollamaModel = config.models.turn.name;
  // The core's queue of model work (#383), one queue per declared model:
  // turns hold the turn model from their arrival to their answer, and the
  // work nobody waits on runs a model call at a time in the slots they leave
  // free. Every model but the turn's own (the turn runner counts its turns)
  // goes through it; a wrong capacity stops the start here.
  const scheduler = createScheduler({ emit: (event) => tracer.emit(event), log: (line) => console.error(line) });
  /** Runs `fn` as one background job on the queue. */
  const backgroundJob = <T,>(job: BackgroundJobName, urgency: Urgency, fn: () => Promise<T>): Promise<T> =>
    scheduler.job({ job, urgency }, fn);
  // The turn model's queue, made now: its capacity is checked at the start.
  scheduler.declare(config.models.turn);
  const model = models.turn;
  const backgroundModel = scheduler.languageModel(config.models.background ?? config.models.turn, models.background);
  const embeddingModel =
    config.models.embedding === undefined || models.embedding === undefined
      ? undefined
      : scheduler.embeddingModel(config.models.embedding, models.embedding);
  // The turn model as plugins get it, queued: a call during a turn is turn
  // work on it, never held back; one inside a plugin's job waits its turn.
  const pluginModel = scheduler.languageModel(config.models.turn, model);
  // A plugin's own model, queued the same way.
  const queuedOwn = new Map<MercuryModelHandle, LanguageModel>();
  const modelFor = (handle: MercuryModelHandle): LanguageModel => {
    if (handle === config.models.turn) return pluginModel;
    let queued = queuedOwn.get(handle);
    if (queued === undefined) {
      queued = scheduler.languageModel(handle, models.modelFor(handle));
      queuedOwn.set(handle, queued);
    }
    return queued;
  };

  // Plugins are declared in the instance's config (its `mercury.config.ts`) and
  // handed in — this file no longer names them. The loader processes an opaque
  // list (see plugins/plugin-loader.ts): each supplies its allowlist as data, a
  // system-prompt fragment, and a `build()` that turns the runtime context into
  // post-processors and post-turn guards. Every declared plugin loads; one
  // that fails (an invalid allowlist, missing configuration) degrades only itself.
  const plugins = config.plugins;

  // A plugin's CLI that keeps its login in a folder finds it in place before
  // the plugin loads: on the credentials volume, linked when it's kept elsewhere.
  // What it reported, also for the startup event: a login not set up yet, a link it couldn't make.
  const credentialsReport: string[] = [];
  await materializeCliCredentials({
    appDir: process.cwd(),
    homeDir: homedir(),
    log: (msg) => {
      console.error(msg);
      credentialsReport.push(msg);
    },
  });

  // Without a vector index nothing is embedded, and none is declared.
  const embed =
    embeddingModel === undefined
      ? async (): Promise<number[]> => {
          throw new Error("no embedding model declared (models.embedding)");
        }
      : createEmbedder(embeddingModel);
  // Where what was said is kept (the archive and the titles): the declared
  // conversation store. Without one nothing is archived: no conversations to
  // reopen or list, no titles, no recall.
  const conversationStore = loadConversationStore(config.conversationStore, {
    env: process.env,
    log: (msg) => console.error(`[archive] ${msg}`),
  });
  // Where what's found by meaning lives (the episodes, the facts, the
  // corrections, the archive's search): the declared vector index. Without
  // one Mercury keeps no memory and offers no recall.
  const vectorIndex = loadVectorIndex(config.vectorIndex, { env: process.env, log: (msg) => console.error(`[memory] ${msg}`) });

  // How each person wants to be called and the language they want, kept next to the links.
  const profiles = createProfileStore({ path: profilesPath(dataPath) });
  // The work plugins run every day at a set time (see cron/daily.ts), in the
  // instance's time zone unless they ask for another: registered while they
  // build, started with the crons.
  const dailyWork = createDaily({
    defaultTimeZone: (config.i18n?.timeZone === undefined ? undefined : timeZoneName(config.i18n.timeZone)) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    log: (msg) => console.error(msg),
  });
  // What the config declares of what a plugin may need (see `Plugin.needs`).
  const declaredNeeds: PluginNeed[] = [
    ...(config.vectorIndex === undefined ? [] : (["vectorIndex"] as const)),
    ...(config.conversationStore === undefined ? [] : (["conversationStore"] as const)),
    ...(config.models.embedding === undefined ? [] : (["embedding"] as const)),
  ];
  // The instance's languages, known once the plugins' texts are (see `i18n` below).
  let shippedLanguages: string[] = ["en"];

  const loadedPlugins = await loadPlugins(plugins, {
    model: pluginModel,
    modelFor,
    assistantName,
    env: process.env,
    log: (msg) => console.error(msg),
    pluginDataRoot: pluginDataRoot(dataPath),
    job: (name, urgency, fn) => backgroundJob(name as BackgroundJobName, urgency, fn),
    backgroundModel,
    declared: declaredNeeds,
    provided: {
      ...(vectorIndex === undefined ? {} : { vectorIndex }),
      ...(conversationStore === undefined ? {} : { conversations: conversationStore }),
      ...(embeddingModel === undefined ? {} : { embed }),
    },
    daily: dailyWork.daily,
    toolLog: pluginToolLog,
    profiles: pluginProfiles(profiles, () => shippedLanguages),
  });

  // A store nobody writes stays empty: said at startup (#393).
  const unusedStore = unusedStoreWarning(
    conversationStore === undefined ? undefined : config.conversationStore?.name,
    loadedPlugins.plugins.map((p) => ({ name: p.name, ...(p.source.needs === undefined ? {} : { needs: p.source.needs }) })),
  );
  if (unusedStore !== undefined) console.error(`[archive] ${unusedStore}`);

  // Status labels for the tool-start hook, keyed by tool name: each plugin's
  // describer for its own tool (jiraCommand, …), the same for its variant
  // acting as Mercury.
  const toolStatusDescribers: Record<string, (input: unknown, t: Translate) => string> = { ...loadedPlugins.toolStatusDescribers };
  for (const [name, describe] of Object.entries(loadedPlugins.toolStatusDescribers)) {
    toolStatusDescribers[`${name}${AS_SELF_SUFFIX}`] = describe;
  }

  // Who a principal is to Mercury: an account linked to another is its
  // owner, then the declared directory decides, closed to anyone it doesn't
  // know unless the config opens it. The links live in the data folder,
  // where no model tool or HTTP read reaches.
  const accountLinks = createLinkStore({ path: linksPath(dataPath) });

  // The texts a person sees, in their language (see i18n/i18n.ts): the
  // core's and the loaded plugins' English, the instance's language files over it. A default
  // language the instance doesn't ship stops the start; a file's gaps are
  // logged, and show as their keys.
  // The declared channels' texts too, those of the channels the loader will load.
  const i18n = instanceI18n({ ...loadedPlugins.messages, ...channelMessages(config.channels ?? []) }, config.i18n);
  shippedLanguages = i18n.supported;
  const i18nReport = i18n.report();
  for (const line of i18nReport) console.error(line);
  const texts = createTexts(i18n, (key) => profiles.languageOf(key));

  const loadedDirectory = loadDirectory(config.directory, { env: process.env, log: (msg) => console.error(msg) });
  const people = createPeople({
    links: accountLinks,
    directory: loadedDirectory,
    ...(config.access?.unknown === undefined ? {} : { unknown: config.access.unknown }),
    texts,
    log: (msg) => console.error(msg),
    emit: (event) => tracer.emit(event),
  });

  // Linking a second account to a person, by a code (see identity/linking.ts).
  const linking = createLinking({ people, links: accountLinks, assistantName, texts });

  // What a person is offered of the loaded plugins (see plugins/offering.ts).
  const offeringOf = (who: TurnWho): Offering =>
    offeringFor(loadedPlugins.plugins, { roles: who.person.roles, operator: who.operator }, config.access?.plugins);

  // What the model reads besides the conversation (see context/context.ts):
  // checked now, so a contradiction in the config stops the start.
  const resolvedContext = resolveContext(config.context, {
    declared: config.plugins,
    loaded: loadedPlugins.plugins,
    ...(config.access?.plugins === undefined ? {} : { access: config.access.plugins }),
    log: (msg) => console.error(msg),
  });
  const contextAssembler =
    resolvedContext === undefined
      ? undefined
      : createContextAssembler({ resolved: resolvedContext, offered: (who) => offeringOf(who).entries, log: (msg) => console.error(msg) });
  // What an admin changed in the profiles while the instance ran (see
  // context/context-settings.ts): kept in the data folder, applied now.
  const contextSettings =
    resolvedContext === undefined
      ? undefined
      : createContextSettings({ resolved: resolvedContext, dataPath, log: (msg) => console.error(msg), emit: (event) => tracer.emit(event) });

  // The plugins' hooks (see plugins/plugin-hooks.ts): a plugin hears about
  // the turns, and the closes, of the sessions it was offered in.
  const pluginHooks = createPluginHooks({
    offered: (who) => offeringOf(who).entries,
    log: (msg) => console.error(msg),
    emit: (event) => tracer.emit(event),
  });

  // The two system prompts (1:1 and shared-space) for an offering, built from
  // the descriptions, fragments and skills of the plugins it holds and the instance's
  // persona, once per distinct offering.
  const promptsByOffering = new Map<string, { singleUser: string; multiUser: string }>();
  function systemPromptsFor(who: TurnWho): { singleUser: string; multiUser: string } {
    const offering = offeringOf(who);
    let prompts = promptsByOffering.get(offering.signature);
    if (!prompts) {
      const built = buildSystemPrompts({
        pluginFragments: offering.promptFragments,
        plugins: offering.plugins,
        skills: offering.skills,
        persona: config.persona,
        // recall_verbatim searches the archive: it needs both.
        recallVerbatim: vectorIndex !== undefined && conversationStore !== undefined,
      });
      prompts = { singleUser: built.system, multiUser: built.chatSystem };
      promptsByOffering.set(offering.signature, prompts);
    }
    return prompts;
  }

  // People's pending logins to the plugins' services, finished by the channel
  // that receives the provider's redirect.
  const personLogins = createPersonLogins({ log: (msg) => console.error(msg), emit: (event) => tracer.emit(event), assistantName, texts });

  /** What the person's earlier conversations left for a new one (see session/context-primer.ts); none for one its client reopens at will (#233). */
  const primerFor = (userId: string, resume: { maxChars?: number } | undefined) =>
    buildContextPrimer(userId, {
      getLastSessionEntries: async (uid) =>
        vectorIndex === undefined ? [] : getLastSessionEpisodicSummaries(vectorIndex, { userId: uid }),
      pendingTokens: (key) => pendingConfirmationTokens(notesRoot, key),
      log: (msg) => console.error(`[memory] ${msg}`),
    }, primerOptions(resume));

  // The open conversations, one per session (see session/conversations.ts):
  // kept by the plugin the first person's profile names, else none.
  const conversations = createConversations({
    ownerFor: (who) => (resolvedContext === undefined ? undefined : profileFor(resolvedContext, who).conversation?.conversation),
    primerFor,
    // What the conversation's compression did, an event of the session's (#393).
    onCompressed: (sessionKey, report) => tracer.emit({ ...compressionEvent(report), session: sessionKey }),
  });

  // Session persistence, Layer 3: a tracked session idle past
  // SESSION_IDLE_TIMEOUT_MS is summarized and written to Qdrant as a dated
  // episodic record, then discarded. Identity-less sessions (the terminal) are
  // never tracked here — per-user isolation needs a real sender identity.
  const idleScanner = createIdleSessionScanner();
  const episodicSummarize = createEpisodicSummarizer(backgroundModel);

  // The search of what was said (#4): every message a turn leaves, indexed
  // from the turn's record (the store is the archive plugin's), for
  // recall_verbatim, which reads what the archive keeps: it needs both.
  const verbatimRecall =
    conversationStore === undefined || vectorIndex === undefined
      ? undefined
      : createVerbatimRecall({
          index: vectorIndex,
          embed,
          // Embedding a message for the search is background work.
          indexInBackground: (work) =>
            void backgroundJob("archive-index", "soon", work).catch((err: unknown) =>
              console.error(`[verbatim-archive] indexing failed: ${String(err instanceof Error ? err.message : err)}`),
            ),
        });

  /** What a turn or a resolved confirmation left: to the plugins' `onTurnRecord`, and to the search of what was said. */
  const turnRecord = (who: TurnWho, record: TurnRecordInfo): void => {
    pluginHooks.turnRecord(who, record);
    if (verbatimRecall === undefined) return;
    void verbatimRecall
      .indexRecord({ ...record, person: { key: who.person.key }, operator: who.operator, as: "anyone" })
      .catch((err: unknown) => console.error(`[verbatim-archive] indexing failed: ${String(err instanceof Error ? err.message : err)}`));
  };

  // Semantic consolidation (D-22/D-34): a separate space from the episodic
  // memory above — one point per extracted {topic, value} candidate, vector
  // embedded on the topic alone (see semantic-facts-store.ts for why).
  const extractFacts = createSemanticFactExtractor(backgroundModel);

  // Where the events of what this instance does go (#23): nowhere unless the config declares a sink.
  const tracer = await loadTracer(config.traces, {
    env: process.env,
    log: (msg) => console.error(msg),
    dataPath,
    now: () => Date.now(),
  });
  if (migratedState.length > 0) tracer.emit({ kind: "system.migrated", area: "data-folder", entries: migratedState });

  /** The index, for what runs only when there's one (capture, corrections). */
  const requireIndex = () => {
    if (vectorIndex === undefined) throw new Error("no vector index");
    return vectorIndex;
  };

  // Shared by the idle sweep (final capture + close) and by sessionCapture
  // (the mid-conversation threshold, which doesn't close the session) —
  // one definition of "how to capture", reused everywhere.
  const captureDeps: CaptureDeps = {
    summarize: episodicSummarize,
    store: (entry) => storeEpisodicSummary(requireIndex(), embed, entry),
    extractFacts,
    storeFact: (entry) => storeSemanticFact(requireIndex(), embed, entry),
    // The facts are kept; turning them into notes is the memory plugin's (#393).
    consolidateFact: async () => {},
    log: (msg) => console.error(`[cron] ${msg}`),
    emit: (event) => tracer.emit(event),
  };

  // How many new messages (since the last capture) a live tracked session needs
  // before it's mirrored to Qdrant, instead of only ever capturing on
  // idle-timeout.
  const MESSAGE_COUNT_CAPTURE_THRESHOLD = Number(process.env.SESSION_CAPTURE_MESSAGE_THRESHOLD ?? "6");

  // How much of the pending messages' actual text shows up in a capture status
  // card's detail — enough to recognize which exchange is being saved.
  const MESSAGE_PREVIEW_CHARS = 200;

  /** Joins `messages`' content, without the turns' stamps, and head-truncates to `maxChars`, "…"-suffixed when cut. */
  function previewMessages(messages: Message[], maxChars: number): string {
    const joined = messages.map((m) => stripTurnStamp(m.content)).join(" ");
    return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}…`;
  }

  // Who each tracked session belongs to and how much of it is already in
  // memory; mirrors the rest every few messages.
  const sessionCapture = createSessionCapture({
    capture: (userId, sessionKey, messages, trigger) => captureSessionToMemory(userId, sessionKey, messages, Date.now(), captureDeps, trigger),
    job: (fn) => backgroundJob("capture", "idle", fn),
    threshold: MESSAGE_COUNT_CAPTURE_THRESHOLD,
    texts,
    describe: (pending, t) =>
      t("core.status.capture-detail", {
        count: pending.length,
        preview: previewMessages(pending, MESSAGE_PREVIEW_CHARS),
        collection: EPISODIC_SPACE,
      }),
  });

  // Procedural corrections (punto 2/Fase D): per-turn, not per-idle-session —
  // the tool-call trace only exists in memory for the duration of its turn.
  // Every Layer-3 space and collection, set up in the background: Mercury
  // starts even while the index or the embedding model isn't answering yet,
  // and memory switches on once they do (see memory/collection-setup.ts).
  const memoryReady = setUpWhenReachable(
    () =>
      setUpMemory({
        ...(vectorIndex === undefined ? {} : { index: vectorIndex }),
        ...(conversationStore === undefined ? {} : { store: conversationStore }),
        embed,
      }),
    { log: (msg) => console.error(`[memory] ${msg}`), emit: (event) => tracer.emit(event) },
  );
  // Memory written before the user key gets it, once the index answers.
  if (vectorIndex !== undefined) {
    const index = vectorIndex;
    void memoryReady.done.then(() =>
      migrateMemoryToUserKeys(index, MIGRATED_SPACES, (msg) => console.error(`[memory] ${msg}`)),
    );
  }
  const extractToolCorrections = createToolCorrectionExtractor(backgroundModel, undefined, {
    log: (msg) => console.error(`[cron] ${msg}`),
  });

  /**
   * Extracts and keeps any procedural corrections found in one turn's
   * `steps` — a no-op if none are found. Drives `onToolStart`/`onToolFinish`
   * once per correction like a real tool call.
   */
  async function processToolCorrections(
    steps: StepInfo[],
    onToolStart: TurnSink["onToolStart"] | undefined,
    onToolFinish: TurnSink["onToolFinish"] | undefined,
    key: string,
  ): Promise<void> {
    // Without an index there's nowhere to keep a correction: nothing to extract.
    const index = vectorIndex;
    if (index === undefined) return;
    await backgroundJob("correction", "soon", () => correctToolUse(index, steps, onToolStart, onToolFinish, key));
  }

  /** `processToolCorrections`' work, as one background job. */
  async function correctToolUse(
    vectorIndex: VectorIndex,
    steps: StepInfo[],
    onToolStart: TurnSink["onToolStart"] | undefined,
    onToolFinish: TurnSink["onToolFinish"] | undefined,
    key: string,
  ): Promise<void> {
    const corrections = await extractToolCorrections(steps);
    const { t } = texts.forPerson(key);
    for (const correction of corrections) {
      const correctionId = crypto.randomUUID();
      onToolStart?.(
        t("core.status.remembering"),
        t("core.status.correction-detail", {
          tool: correction.tool,
          topic: correction.topic,
          collection: TOOL_CORRECTIONS_SPACE,
        }),
        correctionId,
      );
      try {
        const timestamp = new Date().toISOString();
        await storeToolCorrection(vectorIndex, embed, { ...correction, timestamp });
        onToolFinish?.(correctionId, "success");
        tracer.emit({ kind: "memory.correction", person: key, binary: correction.tool, topic: correction.topic, outcome: "done" });
      } catch (err) {
        console.error(`[capture] procedural correction failed for ${correction.tool}/${correction.topic}: ${String(err)}`);
        onToolFinish?.(correctionId, "failed");
        tracer.emit({
          kind: "memory.correction",
          person: key,
          binary: correction.tool,
          topic: correction.topic,
          outcome: "failed",
          args: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  // `key` (the person's key) is separate from `sessionKey`: a person's wiki
  // area, memory and confirmations are theirs across spaces and
  // conversations, so it must not include the space. The turn runner
  // identifies the person from the turn's principal.
  // `who` decides which plugins are offered and as whom their tools act:
  // the person, or Mercury itself (see plugins/offering.ts).
  function buildTools(
    sessionKey: string,
    key: string,
    who: TurnWho,
    onToolStart?: TurnSink["onToolStart"],
    onToolFinish?: TurnSink["onToolFinish"],
    languageHint?: string,
  ): Record<string, Tool> {
    const offering = offeringOf(who);
    // The texts of the person the turn is for, on the channel's hint.
    const { t } = texts.forPerson(key, languageHint);
    const sessionTools: Record<string, Tool> = {};

    // The session-scoped capabilities every CLI tool needs, bound to this turn:
    // staging a confirm-required action (token + pending note), alone or as
    // several choices, and stashing a display artifact the model can `present`.
    const stagingDeps = {
      store: confirmationStore,
      sessionKey,
      owner: key,
      writeConfirmationNoteFn: writeNote,
    };
    const sessionToolContext = {
      sessionKey,
      t,
      stageConfirmation: createStageConfirmation(stagingDeps),
      stageChoices: createStageChoices(stagingDeps),
      stashDisplay: (artifact: string, label?: string) => displayStore.stash(sessionKey, artifact, label),
    };

    // Each CLI-based plugin owns its tool (jiraCommand, …), built from its own
    // allowlist and post-processor. The core just invokes what they contributed,
    // as the person or as Mercury per the offering (see plugins/offered-tools.ts).
    const { tools: pluginTools, hasPluginTools } = buildOfferedTools(offering, who, {
      context: sessionToolContext,
      requireLogin: (service, login, personKey) => personLogins.require(service, login, personKey),
      log: (msg) => console.error(msg),
      stashDisplay: (artifact, label, opts) => displayStore.stash(sessionKey, artifact, label, opts),
    });
    Object.assign(sessionTools, pluginTools);

    // `present` only makes sense alongside plugin tools: they are what produce
    // the display artifacts it surfaces. A turn with none never sees it.
    if (hasPluginTools) {
      Object.assign(sessionTools, createPresentTool({ sessionKey, store: displayStore }));
    }

    Object.assign(sessionTools, createResolveReferenceTool({ notesRoot, key }));
    // Verbatim archive recall, scoped to this person — lets the model resurface
    // what was actually said in earlier conversations, beyond the live window.
    if (verbatimRecall !== undefined) Object.assign(sessionTools, verbatimRecall.sessionTools({ sessionKey, userId: key }));
    // read_skill only exists when a plugin offered contributed at least one skill.
    if (offering.skills.length > 0) {
      Object.assign(sessionTools, createReadSkillTool(skillsWithAssistantName(offering.skills, assistantName)));
    }
    // Every description, the plugins' included, names the assistant as the app does.
    const named = toolsWithAssistantName(sessionTools, assistantName);
    return onToolStart
      ? withToolStartHook(named, onToolStart, toolStatusDescribers, onToolFinish, t)
      : named;
  }

  const confirmationStore = createConfirmationStore();
  // A confirmed action whose result goes back to the model, kept per session
  // until the channel resumes that session's turn (see `InboundTurn.resumeAfterConfirm`).
  const resumes = createResumeSlots();
  // Shared across turns (like confirmationStore): a display artifact stashed
  // while answering can be surfaced by `present` in a later turn, so it's
  // session-scoped, not rebuilt per turn.
  const displayStore = createDisplayStore();

  // Raw tool output can be tens of KB — too long to print in full and stay
  // readable. MAX_INLINE_CHARS bounds what's shown per call/result.
  const MAX_INLINE_CHARS = 600;

  /**
   * Server-side-only tool-call/result visibility for debugging a turn —
   * written to this process's own stderr, never sent back to whoever asked.
   * `prefix` distinguishes which conversation a line belongs to.
   */
  function logStep(prefix: string, step: StepInfo): void {
    for (const call of step.toolCalls) {
      console.error(
        `${prefix}[tool] ${call.toolName}(${truncateForDisplay(call.input, MAX_INLINE_CHARS)})`,
      );
      console.error(`${prefix}${describeToolOutcome(step, call.toolCallId, MAX_INLINE_CHARS)}`);
    }
  }

  // Shared turn-taking pipeline (see src/router/turn-runner.ts). Parameterized
  // entirely by Provider/InboundTurn/TurnSink — it doesn't know which provider
  // a given turn came from. getOrCreateHistory seeds a context primer only for
  // a genuinely new, tracked (real per-user identity) session; an identity-less
  // turn (userId undefined) never triggers it.
  // One turn at a time per session, and the idle sweep waits its turn on the
  // same lock before it captures and closes a session.
  const sessionLock = createSessionLock();
  // A streaming turn whose model goes silent is stopped (#240); checked here so a bad value stops the app at startup.
  const stallTimeoutMs = parseStallTimeoutMs(process.env.TURN_STALL_TIMEOUT_MS);
  const handleTurn = createTurnRunner({
    tracer,
    takeResumed: (sessionKey) => resumes.take(sessionKey),
    sessionLock,
    holdTurn: () => scheduler.holdTurn(config.models.turn),
    model,
    systemPrompts: systemPromptsFor({ person: { key: "", roles: [] }, operator: false }),
    systemPromptsFor,
    preferredName: (key) => profiles.nameOf(key),
    preferredLanguage: (key) => texts.savedLanguage(key),
    timeZoneFor: (key, hint) => resolveTimeZone(profiles.timeZoneOf(key), hint, i18n.timeZone),
    translatorFor: (key, hint) => texts.forPerson(key, hint).t,
    stallTimeoutMs,
    shownLists: (sessionKey) => displayStore.shown(sessionKey),
    identify: people.identify,
    buildTools,
    // Post-turn guards contributed by whatever plugins loaded — the core runs
    // them without knowing what any does (see PostTurnGuard).
    postTurnGuards: loadedPlugins.postTurnGuards,
    afterTurn: pluginHooks.afterTurn,
    ...(contextAssembler === undefined ? {} : { contextFor: contextAssembler.forTurn }),
    getOrCreateHistory: (key, tracked, userId, resume, timeZone, who) =>
      conversations.open(who, {
        sessionKey: key,
        tracked,
        ...(userId === undefined ? {} : { userId }),
        ...(resume === undefined ? {} : { resume }),
        ...(timeZone === undefined ? {} : { timeZone }),
      }),
    trackSession: (key, userId, at) => {
      sessionCapture.track(key, userId);
      idleScanner.touch(key, at);
    },
    registerCaptureCallback: (key, onToolStart, onToolFinish) => sessionCapture.registerCallbacks(key, { onToolStart, onToolFinish }),
    // What a resumed conversation brought back is already in memory.
    // Without an index there's no memory to mirror the conversation to.
    maybeCapture: async (key, history) => {
      if (vectorIndex !== undefined) await sessionCapture.maybeCapture(key, history.getCapturable());
    },
    turnRecord,
    processToolCorrections,
    logStep,
    // Appends what the model surfaced via `present` this turn — nothing if it
    // presented nothing.
    takeSurfacedDisplays: (sessionKey) => displayStore.takeSurfaced(sessionKey),
    discardSurfacedDisplays: (sessionKey) => displayStore.discardSurfaced(sessionKey),
  });

  // The confirm capability, bound to this instance's store and note writer.
  const confirmDeps: ConfirmDeps = {
    store: confirmationStore,
    writeConfirmationNoteFn: writeNote,
    onResume: (sessionKey, action) => resumes.keep(sessionKey, action),
  };

  // The runtime context each channel's build() gets. The floor (confirm) plus
  // HTTP's optional in-process capabilities (resolveConfirmation, reads, the
  // declared auth provider and people's logins), which can't come from env; a channel that doesn't
  // need them ignores them.
  const authenticate = loadAuth(config.auth, { env: process.env, log: (msg) => console.error(msg) });
  const channelRuntime: ChannelRuntimeContext = {
    env: process.env,
    log: (msg) => console.error(msg),
    // How a confirmation was resolved goes to the plugins keeping the conversation (#370, #393).
    ...bindConfirm(confirmDeps, people.identify, linking.redeem, texts, turnRecord, (event) => tracer.emit(event)),
    admit: people.admit,
    // The channel's own texts: the person's language when the core knows who
    // it is, else the hint's, else the default.
    i18n: requestTexts(texts, people.identify),
    authenticate,
    // Every read but health is scoped to the caller (see identity/host-reads.ts).
    reads: createHostReads({
      identify: people.identify,
      ...(conversationStore === undefined ? {} : { store: conversationStore }),
      ...(vectorIndex === undefined ? {} : { index: vectorIndex }),
      confirmationStore,
      // What the caller is offered, nothing more.
      manifest: (who) => {
        const offering = offeringOf(who);
        const offered = new Set(offering.entries.map((e) => e.plugin.name));
        return buildPluginManifest(
          plugins.filter((p) => offered.has(p.name)),
          loadedPlugins.activated,
          [],
          offering.skills,
        );
      },
      health: () =>
        getSelfHealth({
          ...(conversationStore === undefined ? {} : { store: conversationStore }),
          ...(vectorIndex === undefined ? {} : { index: vectorIndex }),
          ollamaHost,
        }),
      preferredName: (key) => profiles.nameOf(key),
      preferredLanguage: (key) => texts.savedLanguage(key),
      preferredTimeZone: (key) => profiles.timeZoneOf(key),
      ...(conversationStore === undefined
        ? {}
        : { titlesOf: (key: string, sessionKeys: string[]) => titlesOf(conversationStore, { userId: key, sessionKeys }) }),
    }),
    settings: createChannelSettings({ identify: people.identify, setTimeZone: (key, timeZone) => profiles.setTimeZone(key, timeZone) }),
    // A conversation's title the person chose (#214), for one of their own in the archive.
    ...(conversationStore === undefined
      ? {}
      : {
          conversations: createChannelConversations({
            identify: people.identify,
            owns: async (key, sessionKey) =>
              (await listVerbatimBySession(conversationStore, { userId: key, sessionKey, limit: 1 })).messages.length > 0,
            setTitle: (key, sessionKey, title) => setTitle(conversationStore, { userId: key, sessionKey, title, source: "person" }),
          }),
        }),
    // The instance's context, for the admins of a channel's admin area (#387).
    ...(contextSettings === undefined ? {} : { contextAdmin: createChannelContextAdmin({ identify: people.identify, settings: contextSettings }) }),
    logins: { accept: personLogins.accept, complete: personLogins.complete },
    linking: { start: linking.start },
    assistantName,
    frameworkVersion: frameworkVersion(),
    ...(appVersion === undefined ? {} : { appVersion }),
  };

  /** Starts the Layer-3 idle-capture cron and the plugins' daily work; returns one stopper. */
  function startCrons(): Stoppable {
    const idleCron = startIdleSessionCron(
      idleScanner,
      {
        getSession: (key) => {
          const history = conversations.get(key);
          const userId = sessionCapture.userOf(key);
          if (!history || !userId) {
            return undefined;
          }
          return { key, userId, messages: history.getCapturable() };
        },
        closeSession: (key) => {
          conversations.close(key);
          contextAssembler?.forget(key);
          sessionCapture.close(key);
          displayStore.forget(key);
        },
        withSession: async (key, fn) => {
          await sessionLock.run(key, fn);
        },
        job: (fn) => backgroundJob("capture", "idle", fn),
        ...captureDeps,
        capture: vectorIndex !== undefined,
        onClosed: pluginHooks.sessionClosed,
      },
      {
        idleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? String(30 * 60_000)),
        checkIntervalMs: Number(process.env.SESSION_IDLE_CHECK_INTERVAL_MS ?? String(60_000)),
      },
    );
    const daily = dailyWork.start();
    return {
      stop: () => {
        idleCron.stop();
        daily.stop();
        // Model work still waiting is dropped; what's running finishes.
        scheduler.stop();
      },
    };
  }

  // How this instance started, as one event: the same facts the startup log
  // prints, structured, with why anything was left out.
  const declaredAuth = config.auth === undefined ? [] : Array.isArray(config.auth) ? config.auth : [config.auth];
  tracer.emit({
    kind: "system.start",
    framework: frameworkVersion(),
    ...(appVersion === undefined ? {} : { app: appVersion }),
    models: models.report,
    plugins: { activated: loadedPlugins.activated, left: loadedPlugins.left },
    auth: { declared: declaredAuth.map((a) => a.name), active: authenticate !== undefined },
    directory: typeof loadedDirectory === "string" ? loadedDirectory : loadedDirectory.name,
    vectorIndex: { declared: config.vectorIndex?.name ?? null, active: vectorIndex !== undefined },
    conversationStore: { declared: config.conversationStore?.name ?? null, active: conversationStore !== undefined },
    i18n: i18nReport,
    credentials: credentialsReport,
    traceLevel: config.traces?.level ?? "meta",
  });

  return {
    tracer,
    handleTurn,
    channels: config.channels ?? [],
    channelRuntime,
    confirmDeps,
    texts,
    ollamaHost,
    ollamaModel,
    startCrons,
  };
}
