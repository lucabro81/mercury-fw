/**
 * Builds a Mercury instance from its composition config: the model, the tools
 * this instance has enabled, the memory layers, and the turn pipeline. This is
 * the one place that decides which tools and channels exist on this instance —
 * every other module takes them as inputs.
 *
 * It *builds*, it does not *start*: `composeMercury()` returns `handleTurn`, the
 * channel runtime context, and deferred `startCrons`/`startAdmin` closures, so
 * each entrypoint decides what to run. The long-running service (`index.ts`)
 * starts the network channels + crons + admin; the dev REPL (`repl.ts`) starts
 * only the terminal against the same `handleTurn`.
 *
 * Note: this factory (and `repl.ts`) are written to be lifted into the future
 * Mercury CLI (a separate monorepo app that scaffolds an instance) — that CLI
 * would reuse `composeMercury` to boot the app it built. Not built yet.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import { getOllamaProvider } from "./model/client.ts";
import { runCli } from "@mercury-fw/cli-engine";
import { createConfirmationStore, createStageConfirmation, type ConfirmationStore } from "@mercury-fw/confirm-engine";
import { createDisplayStore } from "./tools/display-store.ts";
import { createPresentTool } from "./tools/present-tool.ts";
import { loadPlugins } from "./plugins/plugin-loader.ts";
import { materializeCliCredentials } from "./credentials/materialize.ts";
import type { MercuryConfig } from "./config/define-config.ts";
import { createSessionHistory, type SessionHistory, type Message } from "./session/history.ts";
import { createSummarizer } from "./session/summarizer.ts";
import { createEpisodicSummarizer } from "./session/episodic-summarizer.ts";
import { createSemanticFactExtractor } from "./session/semantic-fact-extractor.ts";
import { buildContextPrimer } from "./session/context-primer.ts";
import { buildSystemPrompts } from "./session/system-prompt.ts";
import { createTurnRunner } from "./router/turn-runner.ts";
import { loadAuth } from "./router/auth-loader.ts";
import type { TurnSink } from "./router/provider.ts";
import type { HandleTurn, ChannelRuntimeContext, ChannelPlugin } from "@mercury-fw/channel-types";
import {
  truncateForDisplay,
  describeToolOutcome,
} from "./router/tool-log.ts";
import type { StepInfo } from "./session/step-info.ts";
import { withToolStartHook } from "./session/tool-start-hook.ts";
import {
  writeInferredNote,
  writeToolCorrectionNote,
  writeConfirmationNote,
} from "./wiki/wiki-note.ts";
import { createWikiTools } from "./wiki/wiki-tools.ts";
import { createToolLogRecallTool } from "./session/tool-log-recall-tool.ts";
import { createReadSkillTool } from "./session/read-skill-tool.ts";
import { createIdleSessionScanner } from "./cron/idle-session-scanner.ts";
import { startIdleSessionCron, captureSessionToMemory, type CaptureDeps } from "./cron/idle-session-cron.ts";
import {
  ensureEpisodicCollection,
  storeEpisodicSummary,
  getLastSessionEpisodicSummaries,
} from "./memory/episodic-store.ts";
import { ensureVerbatimCollection } from "./memory/verbatim-archive-store.ts";
import { createVerbatimArchiveProvider } from "./memory/memory-provider.ts";
import { ensureSemanticFactsCollection, storeSemanticFact, searchSemanticFactsByTopic } from "./memory/semantic-facts-store.ts";
import { ensureToolCorrectionsCollection, storeToolCorrection, searchToolCorrectionsByTopic } from "./memory/tool-corrections-store.ts";
import { setUpWhenReachable } from "./memory/collection-setup.ts";
import { consolidateSemanticFact, consolidateToolCorrection, type ToolCorrectionConsolidationDeps } from "./cron/semantic-consolidation.ts";
import { createToolCorrectionExtractor } from "./session/tool-correction-extractor.ts";
import { createEmbedder } from "./memory/embedder.ts";
import { initVault } from "./wiki/vault-init.ts";
import { findOrphanCuratedDocs } from "./wiki/orphan-detector.ts";
import { listWikiFilesInRoots, readWikiFileInRoots, readIndexFile } from "./wiki/wiki-read.ts";
import { readInferredNote } from "./identity/vault-access.ts";
import { createHostReads } from "./identity/host-reads.ts";
import { bindConfirm } from "./identity/confirm-binding.ts";
import { migrateMemoryToUserKeys, migrateVaultToUserAreas } from "./identity/migrate-layout.ts";
import { runRawTriagePass, runIndexAndOrphanPass, runContradictionCheckPass } from "./wiki/self-review-runner.ts";
import { startSelfReviewCron } from "./cron/self-review-cron.ts";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { Tool } from "ai";
import { startAdminServer } from "./admin/server.ts";
// The HTTP surface's read routes (4b) reuse the admin panel's per-domain
// functions — the admin is a POC to be retired later; these reads outlive it.
import { getSelfHealth } from "./admin/model-routes.ts";
import { buildPluginManifest } from "./plugins/manifest.ts";

/** A stoppable subsystem (cron, server). */
type Stoppable = { stop: () => void };

/** The confirm capability's binding to this instance's store/vault/note-writer, shared by the terminal and the channel runtime. */
export type ConfirmDeps = {
  store: ConfirmationStore;
  vaultPath: string;
  writeConfirmationNoteFn: typeof writeConfirmationNote;
};

/**
 * The built Mercury instance. `build`, not `start`: the channels, crons and
 * admin are not running until an entrypoint starts them.
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
  ollamaHost: string;
  ollamaModel: string;
  /** Starts the Layer-3 idle-capture and self-review crons; returns a single stopper for shutdown. */
  startCrons: () => Stoppable;
  /** Starts the POC admin panel if `ADMIN_PANEL_ENABLED`; returns it (to stop on shutdown), or undefined. */
  startAdmin: () => Stoppable | undefined;
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
  // The model is constructed up front, before the plugins load and the system
  // prompt is built: a plugin's post-turn guard can be model-backed (Jira's
  // issue-list corrector is), and the system prompt is assembled from the
  // fragments the plugin loader returns — both need the model in hand first.
  const provider = getOllamaProvider();
  const ollamaHost = requireEnv("OLLAMA_HOST"); // already validated by getOllamaProvider(); read again here for the terminal provider's getLoadedContextLength call
  const ollamaModel = requireEnv("OLLAMA_MODEL");
  // think: true enables Ollama's native extended-thinking tokens — see
  // agent-turn.ts's reasoning-delta handling. OLLAMA_THINK lets the deployer
  // turn it off for a model that doesn't support it (Ollama rejects the request
  // outright otherwise, 400 "does not support thinking"), same reasoning as
  // never guessing OLLAMA_HOST. Model-construction-time setting only, set once
  // here for the one shared model instance used by every channel.
  const ollamaThink = process.env.OLLAMA_THINK !== "false";
  const model = provider(ollamaModel, { think: ollamaThink });
  const summarize = createSummarizer(model);

  // Plugins are declared in the instance's config (its `mercury.config.ts`) and
  // handed in — this file no longer names them. The loader processes an opaque
  // list (see plugins/plugin-loader.ts): each supplies its allowlist as data, a
  // system-prompt fragment, and a `build()` that turns the runtime context into
  // post-processors and post-turn guards. Every declared plugin loads; one
  // that fails (an invalid allowlist, missing configuration) degrades only itself.
  const plugins = config.plugins;

  // A plugin's CLI that keeps its login in a folder finds it in place before
  // the plugin loads: unpacked from the env file on a fresh credentials volume.
  await materializeCliCredentials({
    appDir: process.cwd(),
    homeDir: homedir(),
    env: process.env,
    log: (msg) => console.error(msg),
  });

  const loadedPlugins = await loadPlugins(plugins, {
    model,
    env: process.env,
    log: (msg) => console.error(msg),
  });

  // Status labels for the tool-start hook, keyed by tool name: each plugin's
  // describer for its own tool (jiraCommand, …).
  const toolStatusDescribers: Record<string, (input: unknown) => string> = { ...loadedPlugins.toolStatusDescribers };

  // Two system prompts (1:1 and shared-space), both built from the fragments of
  // whatever plugins actually loaded and from the instance's persona.
  const { system, chatSystem } = buildSystemPrompts({
    pluginFragments: loadedPlugins.promptFragments,
    skills: loadedPlugins.skills,
    persona: config.persona,
  });

  const histories = new Map<string, SessionHistory>();
  /**
   * `trackForCapture` wires `onBeforeCompress` so a Layer 1 compression also
   * mirrors the compressed batch to Qdrant (see `captureIncrement`) — only
   * meaningful for sessions tracked in `sessionUsers`/`sessionCaptureMarkers`
   * (a real per-user identity, i.e. Google Chat); an identity-less channel
   * omits it.
   */
  function getOrCreateHistory(key: string, trackForCapture = false, primer?: string): SessionHistory {
    let history = histories.get(key);
    if (!history) {
      history = createSessionHistory(
        summarize,
        trackForCapture
          ? (messages) => {
              void captureIncrement(key, messages).finally(() => {
                // The new getMessages() view after compression starts fresh
                // (just the new synthetic summary message) — the old marker's
                // index has no meaning against it regardless of whether the
                // capture above succeeded.
                sessionCaptureMarkers.set(key, 0);
              });
            }
          : undefined,
        primer,
      );
      histories.set(key, history);
    }
    return history;
  }

  // Session persistence, Layer 3: a tracked session idle past
  // SESSION_IDLE_TIMEOUT_MS is summarized and written to Qdrant as a dated
  // episodic record, then discarded. Identity-less sessions (the terminal) are
  // never tracked here — per-user isolation needs a real sender identity.
  const sessionUsers = new Map<string, string>(); // session key -> sender (userId)
  // How many of a session's current getMessages() entries have already been
  // mirrored to Qdrant by captureIncrement — advanced only after a successful
  // capture, so a failure retries the same (or a larger) slice next time.
  // Reset to 0 whenever Layer 1 compresses the session. Discarded on
  // idle-timeout close, same as sessionUsers.
  const sessionCaptureMarkers = new Map<string, number>();
  // The current turn's tool-status callbacks, refreshed each turn — looked up
  // lazily by captureIncrement/onBeforeCompress rather than captured once.
  const sessionOnCaptureCallbacks = new Map<
    string,
    { onToolStart: TurnSink["onToolStart"]; onToolFinish: TurnSink["onToolFinish"] }
  >();
  const idleScanner = createIdleSessionScanner();
  const episodicSummarize = createEpisodicSummarizer(model);
  const embeddingModel = provider.textEmbeddingModel(process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text");
  const embed = createEmbedder(embeddingModel);
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://qdrant:6333" });
  const episodicCollection = process.env.QDRANT_EPISODIC_COLLECTION ?? "episodic_memory";
  const episodicVectorSize = Number(process.env.QDRANT_EPISODIC_VECTOR_SIZE ?? "768");

  // Verbatim conversation archive (#4): a distinct collection holding the raw
  // user<->model exchange, lossless and durable — separate from the lossy
  // Layer-1 window and the derived episodic summaries above.
  const verbatimCollection = process.env.QDRANT_VERBATIM_COLLECTION ?? "verbatim_archive";
  const verbatimVectorSize = Number(process.env.QDRANT_VERBATIM_VECTOR_SIZE ?? "768");
  const verbatimProvider = createVerbatimArchiveProvider({ client: qdrant, collectionName: verbatimCollection, embed });

  // Semantic consolidation (D-22/D-34): a separate Qdrant collection from
  // episodic memory above — one point per extracted {topic, value} candidate,
  // vector embedded on the topic alone (see semantic-facts-store.ts for why).
  const semanticFactsCollection = process.env.QDRANT_SEMANTIC_FACTS_COLLECTION ?? "semantic_facts";
  const semanticFactsVectorSize = Number(process.env.QDRANT_SEMANTIC_FACTS_VECTOR_SIZE ?? "768");
  const extractFacts = createSemanticFactExtractor(model);

  // Idempotent self-heal: the vault lives on a named Docker volume, empty on
  // first boot and not pre-populatable at build time — re-running this every
  // startup is cheap and means a wiped/fresh volume never needs a separate
  // manual provisioning step.
  const wikiVaultPath = requireEnv("WIKI_VAULT_PATH");
  await initVault(wikiVaultPath);
  // A vault from before per-person areas gets its notes moved into them.
  await migrateVaultToUserAreas(wikiVaultPath, (msg) => console.error(`[wiki-vault] ${msg}`)).catch((err: unknown) =>
    console.error(`[wiki-vault] layout migration failed, Mercury starts anyway: ${String(err)}`),
  );

  // Shared by the idle sweep (final capture + close) and by captureIncrement
  // (the two mid-conversation triggers, neither of which closes the session) —
  // one definition of "how to capture", reused everywhere.
  const captureDeps: CaptureDeps = {
    summarize: episodicSummarize,
    store: (entry) => storeEpisodicSummary(qdrant, episodicCollection, embed, entry),
    extractFacts,
    storeFact: (entry) => storeSemanticFact(qdrant, semanticFactsCollection, embed, entry),
    consolidateFact: (userId, topic) =>
      consolidateSemanticFact(userId, topic, {
        vaultPath: wikiVaultPath,
        clusterFn: (u, t, limit) => searchSemanticFactsByTopic(qdrant, semanticFactsCollection, embed, { userId: u, topic: t, limit }),
        readInferredNoteFn: readInferredNote,
        writeInferredNoteFn: writeInferredNote,
      }),
    log: (msg) => console.error(`[cron] ${msg}`),
  };

  // How many new messages (since the last capture) a live tracked session needs
  // before captureIncrement mirrors them to Qdrant, instead of only ever
  // capturing on idle-timeout.
  const MESSAGE_COUNT_CAPTURE_THRESHOLD = Number(process.env.SESSION_CAPTURE_MESSAGE_THRESHOLD ?? "6");

  // How much of the pending messages' actual text shows up in a capture status
  // card's detail — enough to recognize which exchange is being saved.
  const MESSAGE_PREVIEW_CHARS = 200;

  /** Joins `messages`' content and head-truncates to `maxChars`, "…"-suffixed when cut. */
  function previewMessages(messages: Message[], maxChars: number): string {
    const joined = messages.map((m) => m.content).join(" ");
    return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}…`;
  }

  /**
   * Captures whatever's new in `messages` since the last capture for
   * `sessionKey` — a no-op if nothing new. Shared by both mid-conversation
   * triggers (message-count threshold, Layer 1 compression); the idle-timeout
   * trigger uses `captureSessionToMemory` directly since it also closes the
   * session. Drives the turn's tool-status callbacks like a real tool call so a
   * live conversation shows this happening.
   */
  async function captureIncrement(sessionKey: string, messages: Message[]): Promise<void> {
    const userId = sessionUsers.get(sessionKey);
    if (!userId) return;

    const alreadyCaptured = sessionCaptureMarkers.get(sessionKey) ?? 0;
    const pending = messages.slice(alreadyCaptured);
    if (pending.length === 0) return;

    const callbacks = sessionOnCaptureCallbacks.get(sessionKey);
    const captureId = crypto.randomUUID();
    callbacks?.onToolStart(
      "Mi sto segnando un'informazione importante…",
      `Conversazione recente (${pending.length} messaggi: "${previewMessages(pending, MESSAGE_PREVIEW_CHARS)}"), collection "${episodicCollection}"`,
      captureId,
    );
    try {
      await captureSessionToMemory(userId, sessionKey, pending, Date.now(), captureDeps);
      sessionCaptureMarkers.set(sessionKey, messages.length);
      callbacks?.onToolFinish?.(captureId, "success");
    } catch (err) {
      console.error(`[capture] failed for ${sessionKey}, will retry next trigger: ${String(err)}`);
      callbacks?.onToolFinish?.(captureId, "failed");
    }
  }

  // Procedural corrections (punto 2/Fase D): per-turn, not per-idle-session —
  // the tool-call trace only exists in memory for the duration of its turn.
  const toolCorrectionsCollection = process.env.QDRANT_TOOL_CORRECTIONS_COLLECTION ?? "tool_corrections";
  const toolCorrectionsVectorSize = Number(process.env.QDRANT_TOOL_CORRECTIONS_VECTOR_SIZE ?? "768");
  // Every Layer-3 collection, set up in the background: Mercury starts even
  // while Qdrant isn't answering yet, and memory switches on once it does.
  const memoryReady = setUpWhenReachable(
    async () => {
      await ensureEpisodicCollection(qdrant, episodicCollection, episodicVectorSize);
      await ensureVerbatimCollection(qdrant, verbatimCollection, verbatimVectorSize);
      await ensureSemanticFactsCollection(qdrant, semanticFactsCollection, semanticFactsVectorSize);
      await ensureToolCorrectionsCollection(qdrant, toolCorrectionsCollection, toolCorrectionsVectorSize);
    },
    { log: (msg) => console.error(`[memory] ${msg}`) },
  );
  // Memory written before the user key gets it, once Qdrant answers.
  void memoryReady.done.then(() =>
    migrateMemoryToUserKeys(qdrant, [episodicCollection, semanticFactsCollection, verbatimCollection], (msg) =>
      console.error(`[memory] ${msg}`),
    ),
  );
  const extractToolCorrections = createToolCorrectionExtractor(model, undefined, {
    log: (msg) => console.error(`[cron] ${msg}`),
  });
  const toolCorrectionConsolidationDeps: ToolCorrectionConsolidationDeps = {
    vaultPath: wikiVaultPath,
    clusterFn: (tool, topic, limit) =>
      searchToolCorrectionsByTopic(qdrant, toolCorrectionsCollection, embed, { tool, topic, limit }),
    readNoteFn: (vp, relativePath) => readWikiFileInRoots(vp, [resolvePath(vp, "curated")], relativePath),
    writeNoteFn: writeToolCorrectionNote,
    // A single confirmed correction is already a strong signal — unlike
    // identity/preference facts (DEFAULT_CONSOLIDATION_K = 3). k: 1 fires
    // defaultConfidenceForCount's dominantCount >= k branch on the first
    // candidate ("high" confidence immediately).
    k: 1,
  };

  /**
   * Extracts and consolidates any procedural corrections found in one turn's
   * `steps` — a no-op if none are found. Drives `onToolStart`/`onToolFinish`
   * once per correction like a real tool call.
   */
  async function processToolCorrections(
    steps: StepInfo[],
    onToolStart?: TurnSink["onToolStart"],
    onToolFinish?: TurnSink["onToolFinish"],
  ): Promise<void> {
    const corrections = await extractToolCorrections(steps);
    for (const correction of corrections) {
      const correctionId = crypto.randomUUID();
      onToolStart?.(
        "Mi sto segnando un'informazione importante…",
        `Correzione per lo strumento "${correction.tool}" (argomento: "${correction.topic}", collection: "${toolCorrectionsCollection}")`,
        correctionId,
      );
      try {
        const timestamp = new Date().toISOString();
        await storeToolCorrection(qdrant, toolCorrectionsCollection, embed, { ...correction, timestamp });
        await consolidateToolCorrection(correction.tool, correction.topic, toolCorrectionConsolidationDeps);
        onToolFinish?.(correctionId, "success");
      } catch (err) {
        console.error(`[capture] procedural correction failed for ${correction.tool}/${correction.topic}: ${String(err)}`);
        onToolFinish?.(correctionId, "failed");
      }
    }
  }

  // `key` (the user key) is separate from `sessionKey`: a person's wiki area,
  // memory and confirmations are theirs across spaces and conversations, so
  // it must not include the space. The turn runner derives it from the
  // turn's principal.
  function buildTools(
    sessionKey: string,
    key: string,
    onToolStart?: TurnSink["onToolStart"],
    onToolFinish?: TurnSink["onToolFinish"],
  ): Record<string, Tool> {
    const sessionTools: Record<string, Tool> = {};

    // The session-scoped capabilities every CLI tool needs, bound to this turn:
    // staging a confirm-required action (token + pending note) and stashing a
    // display artifact the model can `present`.
    const sessionToolContext = {
      sessionKey,
      stageConfirmation: createStageConfirmation({
        store: confirmationStore,
        sessionKey,
        owner: key,
        vaultPath: wikiVaultPath,
        writeConfirmationNoteFn: writeConfirmationNote,
      }),
      stashDisplay: (artifact: string) => displayStore.stash(sessionKey, artifact),
    };

    // Each CLI-based plugin owns its tool (jiraCommand, …), built from its own
    // allowlist and post-processor. The core just invokes what they contributed.
    for (const bundle of loadedPlugins.sessionToolBundles) {
      Object.assign(sessionTools, bundle.build(sessionToolContext, bundle.postProcess));
    }

    // `present` only makes sense alongside CLI tools: they are what produce the
    // display artifacts it surfaces. An instance with no CLI tool never sees it.
    const hasCliTool = loadedPlugins.sessionToolBundles.length > 0;
    if (hasCliTool) {
      Object.assign(sessionTools, createPresentTool({ sessionKey, store: displayStore }));
    }

    Object.assign(
      sessionTools,
      createWikiTools({ vaultPath: wikiVaultPath, key, stageConfirmation: sessionToolContext.stageConfirmation }),
    );
    Object.assign(sessionTools, createToolLogRecallTool({ sessionKey }));
    // Verbatim archive recall, scoped to this person — lets the model resurface
    // what was actually said in earlier conversations, beyond the live window.
    Object.assign(sessionTools, verbatimProvider.sessionTools!({ sessionKey, userId: key }));
    // read_skill only exists when a plugin contributed at least one skill.
    if (loadedPlugins.skills.length > 0) {
      Object.assign(sessionTools, createReadSkillTool(loadedPlugins.skills));
    }
    return onToolStart ? withToolStartHook(sessionTools, onToolStart, toolStatusDescribers, onToolFinish) : sessionTools;
  }

  const confirmationStore = createConfirmationStore();
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
  const handleTurn = createTurnRunner({
    model,
    systemPrompts: { singleUser: system, multiUser: chatSystem },
    buildTools,
    // Post-turn guards contributed by whatever plugins loaded — the core runs
    // them without knowing what any does (see PostTurnGuard).
    postTurnGuards: loadedPlugins.postTurnGuards,
    getOrCreateHistory: async (key, trackForCapture, userId) => {
      if (trackForCapture && userId && !histories.has(key)) {
        const primer = await buildContextPrimer(userId, {
          vaultPath: wikiVaultPath,
          getLastSessionEntries: (uid) => getLastSessionEpisodicSummaries(qdrant, episodicCollection, { userId: uid }),
          listWikiFilesInRootsFn: listWikiFilesInRoots,
          readWikiFileInRootsFn: readWikiFileInRoots,
          readIndexFileFn: readIndexFile,
          log: (msg) => console.error(`[memory] ${msg}`),
        });
        return getOrCreateHistory(key, trackForCapture, primer);
      }
      return getOrCreateHistory(key, trackForCapture);
    },
    trackSession: (key, userId, at) => {
      sessionUsers.set(key, userId);
      idleScanner.touch(key, at);
    },
    registerCaptureCallback: (key, onToolStart, onToolFinish) => sessionOnCaptureCallbacks.set(key, { onToolStart, onToolFinish }),
    maybeCapture: async (key, history) => {
      const messages = history.getMessages();
      const alreadyCaptured = sessionCaptureMarkers.get(key) ?? 0;
      if (messages.length - alreadyCaptured >= MESSAGE_COUNT_CAPTURE_THRESHOLD) {
        await captureIncrement(key, messages);
      }
    },
    captureVerbatim: verbatimProvider.captureExchange,
    processToolCorrections,
    logStep,
    // Appends what the model surfaced via `present` this turn — nothing if it
    // presented nothing.
    takeSurfacedDisplays: (sessionKey) => displayStore.takeSurfaced(sessionKey),
  });

  // The confirm capability, bound to this instance's store/vault/note-writer.
  const confirmDeps: ConfirmDeps = { store: confirmationStore, vaultPath: wikiVaultPath, writeConfirmationNoteFn: writeConfirmationNote };

  // The runtime context each channel's build() gets. The floor (confirm) plus
  // HTTP's optional in-process capabilities (resolveConfirmation, reads and the
  // declared auth provider), which can't come from env; a channel that doesn't
  // need them ignores them.
  const channelRuntime: ChannelRuntimeContext = {
    env: process.env,
    log: (msg) => console.error(msg),
    ...bindConfirm(confirmDeps),
    authenticate: loadAuth(config.auth, { env: process.env, log: (msg) => console.error(msg) }),
    // Every read but the manifest and health is scoped to the caller (see
    // identity/host-reads.ts).
    reads: createHostReads({
      vaultPath: wikiVaultPath,
      qdrant,
      collections: { verbatim: verbatimCollection, episodic: episodicCollection, semanticFacts: semanticFactsCollection },
      confirmationStore,
      manifest: () => buildPluginManifest(plugins, loadedPlugins.activated, [], loadedPlugins.skills),
      health: () => getSelfHealth({ qdrant, ollamaHost }),
    }),
  };

  /** Starts the Layer-3 idle-capture and self-review crons; returns one stopper. */
  function startCrons(): Stoppable {
    const idleCron = startIdleSessionCron(
      idleScanner,
      {
        getSession: (key) => {
          const history = histories.get(key);
          const userId = sessionUsers.get(key);
          if (!history || !userId) {
            return undefined;
          }
          return { key, userId, messages: history.getMessages() };
        },
        closeSession: (key) => {
          histories.delete(key);
          sessionUsers.delete(key);
          sessionCaptureMarkers.delete(key);
          sessionOnCaptureCallbacks.delete(key);
        },
        ...captureDeps,
      },
      {
        idleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? String(30 * 60_000)),
        checkIntervalMs: Number(process.env.SESSION_IDLE_CHECK_INTERVAL_MS ?? String(60_000)),
      },
    );
    const selfReviewCron = startSelfReviewCron({
      listRawEntries: () => listWikiFilesInRoots(wikiVaultPath, [resolvePath(wikiVaultPath, "raw")]),
      findOrphans: () => findOrphanCuratedDocs(wikiVaultPath),
      runRawTriage: (rawEntries) => runRawTriagePass({ vaultPath: wikiVaultPath, model, rawEntries }),
      runIndexAndOrphan: (orphans) => runIndexAndOrphanPass({ vaultPath: wikiVaultPath, model, orphans }),
      runContradictionCheck: () => runContradictionCheckPass({ vaultPath: wikiVaultPath, model }),
      log: (msg) => console.error(`[cron] ${msg}`),
    });
    return {
      stop: () => {
        idleCron.stop();
        selfReviewCron.stop();
      },
    };
  }

  /**
   * Starts the POC admin panel if `ADMIN_PANEL_ENABLED` — opt-in, dev-only,
   * unauthenticated. Reuses the already-constructed qdrant client, model and
   * vault path. Returns it (to stop on shutdown), or undefined when disabled.
   */
  function startAdmin(): Stoppable | undefined {
    if (process.env.ADMIN_PANEL_ENABLED !== "true") return undefined;
    const adminPort = Number(process.env.ADMIN_PANEL_PORT ?? "4000");
    const adminServer = startAdminServer({
      port: adminPort,
      vaultPath: wikiVaultPath,
      model,
      qdrant,
      qdrantCollections: { episodic: episodicCollection, semanticFacts: semanticFactsCollection },
      // Every CLI is a plugin now (no file-based bucket), so there are no
      // centrally-configured CLIs for the POC admin's CLI status to cover.
      activeCliConfigs: {},
      runCliFn: runCli,
      ollamaHost,
      ollamaModel,
      systemPrompts: { terminal: system, googleChat: chatSystem },
      envFilePath: ".env",
    });
    console.error(`[admin] panel listening on http://localhost:${adminPort}`);
    return adminServer;
  }

  return {
    handleTurn,
    channels: config.channels ?? [],
    channelRuntime,
    confirmDeps,
    ollamaHost,
    ollamaModel,
    startCrons,
    startAdmin,
  };
}
