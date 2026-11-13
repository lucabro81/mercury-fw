/**
 * The plugin contract: the shared types both the Mercury core and every plugin
 * package program against. It exists so neither side has to mirror the other's
 * shapes locally (as the Jira plugin did through Fase 2) and so the compiler
 * checks compatibility at a real seam rather than by hand. It's a monorepo
 * type package, not a published SDK — there is no runtime here beyond the one
 * version constant.
 *
 * The interface is deliberately the *sum of what Fase 2 actually had to
 * deliver*, not a guess at what a plugin might one day want. Its real
 * validation is the second plugin (Bitbucket): if extracting it forces this
 * file to grow, the interface was Jira-shaped and gets redrawn. Two slots are
 * reserved ahead of that — `apiVersion` and `surfaces` — not because Jira uses
 * them, but because adding either later would be a retrofit on every plugin
 * already written.
 */
import type { LanguageModel, Tool } from "ai";

/**
 * Contract version. The core and a plugin are versioned and installed
 * separately, so a plugin compiled against a different contract than the core
 * supports is possible by construction; the loader compares this against each
 * plugin's declared `apiVersion` and refuses a mismatch (fail-soft). A single
 * integer, bumped only on a breaking change to the shapes in this file.
 */
export const PLUGIN_API_VERSION = 7;

/**
 * A catalog of texts a person sees: key → text, `{param}` marking where a
 * value goes. A package declares its own in English, its keys under its
 * namespace (`<plugin name>.`); the instance translates them in its language
 * files, and the core picks each person's language.
 */
export type Messages = Record<string, string>;

/** The values filled into a text's `{param}`s. */
export type Params = Record<string, string | number>;

/**
 * A text in the language of the person a turn is for, by key, with its
 * params filled in. A key the language's file lacks comes back as the key
 * itself. The core hands one to whatever builds a text a person sees; the
 * core's own keys (`core.…`) are always there.
 */
export type Translate = (key: string, params?: Params) => string;

/** A tool built with `ai`'s `tool()` and an `execute`: what the core's and the
 * plugins' tool factories return. Spelled out so their declarations name it
 * instead of `ai`'s internal types, which a published package can't reference. */
export type ExecutableTool = Tool & { execute: NonNullable<Tool["execute"]> };

/**
 * The user-facing channel of a tool result: structured output destined for the
 * user and — unlike `data` — never placed into the model's context. `type`
 * names the kind of data (e.g. "issue-list"): the key an instance's formatter
 * rules are looked up by, so a plugin should export the kinds it emits as a
 * type mapping each kind to its item shape. `items` are its entries. Kept
 * deliberately generic so it serves any plugin: a CLI post-processor's result
 * or a typed tool's ok output (`{ ok: true, …, display }`) alike. The core
 * strips it from every plugin tool's output before the model sees it, stashes
 * it once rendered (the formatter turns `items` into one text) and hands the
 * model a `displayRef` instead. `always` is set by the formatter when the
 * instance's rule for the kind says the display is the answer itself: the core
 * then shows it without the model calling `present`, and tells the model so.
 */
export type ToolDisplay = { type: string; items: unknown[]; always?: true };

/**
 * Result of running a CLI command, carrying two explicit channels. On success
 * `data` is the model channel — the parsed JSON (or raw text) stdout the model
 * reasons on — and the optional `display` is the user channel (see
 * `ToolDisplay`), which never enters the model's context. On failure `error` is
 * a human/model-readable string, with the process's `exitCode` when it ran
 * and exited non-zero. Mirrors `runCli`'s return — `@mercury-fw/cli-engine`
 * owns the runner, this owns the shape both sides agree on.
 */
export type CliResult =
  | { ok: true; data: unknown; display?: ToolDisplay }
  | { ok: false; error: string; exitCode?: number };

/**
 * Deterministically transforms a `runCli` result. A plugin contributes at most
 * one, and it runs after every allowed command of the plugin's tool; `prefix`
 * is the allowlist entry that matched (`[]` for `--help`), so the plugin
 * decides for itself which commands it touches and passes the rest through.
 * Can augment `data`, attach a `display`, or turn a technically-ok result into
 * `{ ok: false }` when the data isn't shaped as it needs. `t` gives the
 * texts of the turn's person, for a display it renders.
 */
export type CliPostProcessor = (
  cmd: { binary: string; args: string[]; prefix: string[] },
  result: CliResult,
  t: Translate,
) => CliResult;

/**
 * The outcome of running a deferred, confirm-required action. Deliberately
 * generic (no `display` channel, unlike `CliResult`): the confirmation
 * subsystem reports `data` or `error` and nothing more. A CLI command's
 * execution is one producer of it, a future non-CLI action another.
 */
export type ActionResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * How a confirmed action's result goes back to the model: the core resumes the
 * turn as if the model had called `toolName` with `input` and got the action's
 * result back. The result stays a tool result, never text of the person's.
 */
export type ResumeAs = { toolName: string; input: unknown };

/**
 * Stages an irreversible action behind a confirmation token and returns that
 * token. The action is opaque — a `run` thunk plus a `describe` string for the
 * paper trail — so nothing here (and nothing in the core that runs it later)
 * needs to know what kind of action it is. The core binds an implementation to
 * a session/user and hands it to whatever needs to defer an action; the plugin
 * side calls it without touching the confirmation store or the wiki. See the
 * core's confirmation-staging and confirm-flow for the two halves.
 */
export type StageConfirmation = (action: {
  run: () => Promise<ActionResult>;
  describe: string;
}) => Promise<string>;

/**
 * Stages one action offered as several choices (e.g. "only this time" /
 * "always for this host") and returns a token per choice, in order, each with
 * its `label`. The person takes exactly one: the others die with it, and they
 * all expire together. `describe` is the paper trail of the whole group; a
 * choice with `resume` has its result handed back to the model (see
 * `ResumeAs`) instead of shown to the person as is.
 */
export type StageChoices = (action: {
  describe: string;
  choices: Array<{ label: string; run: () => Promise<ActionResult>; resume?: ResumeAs }>;
}) => Promise<Array<{ label: string; token: string }>>;

/**
 * Minimal shape of a finished generation step — enough to see what tool was
 * called, with what input, and what came back. A subset of the AI SDK's
 * `StepResult`; function parameter types only need to be structurally
 * compatible, not identical. A `toolCalls` entry with no matching
 * `toolResults` entry (linked by `toolCallId`) means the call failed before
 * executing, surfaced as a `tool-error` in `content`.
 */
export type StepInfo = {
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
  content: Array<{ type: string; toolCallId?: string; error?: unknown }>;
};

/**
 * A post-turn guard: something run over the model's finished text before it
 * reaches the user. `shouldRun` gates both the transformation and its status
 * indicator; `run` returns the (possibly unchanged) text plus an `outcome`
 * that drives the status pair and an optional diagnostic `log`. `steps` is
 * offered to both for guards that need the turn's tool trace (a turn resumed
 * after a confirmation starts with the confirmed call); a guard is free to
 * ignore it, and an older core passes none to `shouldRun`. A guard that
 * throws never blocks delivery — the core wraps each one. `t` gives the
 * texts of the turn's person: the status line and anything `run` adds.
 */
export type PostTurnGuard = {
  statusLabel: (t: Translate) => string;
  statusId: string;
  shouldRun: (text: string, steps?: StepInfo[]) => boolean;
  run: (
    text: string,
    steps: StepInfo[],
    t: Translate,
  ) => Promise<{ text: string; outcome: "success" | "failed"; log?: string }>;
};

/**
 * How a language model generates, for every call on it. Every entry is
 * optional: one left out isn't sent, so the model's own value (its Modelfile)
 * applies.
 */
export type ModelSettings = {
  /** Whether the model reasons before answering; on when left out. `false` for a model that doesn't support it, which Ollama otherwise refuses. */
  think?: boolean;
  /** How much room the less likely words get: lower is more predictable. From 0 up. */
  temperature?: number;
  /** Only the most likely words whose probabilities add up to this are kept. Above 0, at most 1. */
  topP?: number;
  /** Only this many of the most likely words are kept. A whole number from 1 up. */
  topK?: number;
};

/**
 * A model the instance declared (`ollamaModel(...)` in its config): which
 * one, how it generates, and how many requests its runtime serves at once.
 * A plugin that needs a model of its own takes one of these in its own
 * configuration and turns it into a model with `ctx.modelFor`, so the
 * instance decides which model it is and the core knows every model in use.
 */
export type MercuryModelHandle = {
  readonly provider: "ollama";
  readonly kind: "language";
  /** The model's name on its runtime (`qwen3.8:27b`). */
  readonly name: string;
  readonly settings: Readonly<ModelSettings>;
  /** How many requests the model's runtime serves at once; 1 for a model served one request at a time. */
  readonly capacity: number;
  /** How many of those the work nobody waits on may take at once: below `capacity` when it's above 1, 1 otherwise. */
  readonly backgroundSlots: number;
};

/** An embedding model the instance declared (`ollamaEmbedding(...)`), the one memory found by meaning is embedded with. */
export type MercuryEmbeddingHandle = {
  readonly provider: "ollama";
  readonly kind: "embedding";
  readonly name: string;
  readonly capacity: number;
};

// ---- The storage primitives: what an instance declares (`vectorIndex`,
// `conversationStore` in its config) and a plugin reaches through `needs`. ----

/** Equality filters on a space's keyword fields: every field must hold exactly that value. */
export type VectorWhere = Record<string, string>;

/** A point of a space: its id (a UUID), its vector and what it carries. */
export type VectorPoint = { id: string; vector: number[]; payload: Record<string, unknown> };

/**
 * What a space needs: the length of its vectors, the payload fields it's
 * filtered on (`keys`) and those it's ordered by (`ordered`, ISO 8601 times).
 */
export type VectorSpaceSpec = { dimensions: number; keys?: string[]; ordered?: string[] };

/**
 * The instance's vector index (`vectorIndex` in its config): named spaces of
 * points, each a vector and a payload, for what is found by meaning. Whoever
 * writes computes the vectors (`PluginRuntimeContext.embed`); the index keeps
 * them, finds the nearest ones (`query`), lists points in an order (`scroll`)
 * and rewrites payload fields (`setPayload`), always within the points `where`
 * selects. A scroll is paged by the opaque `cursor` the previous page gave as
 * `next`. Every method may reject when the index can't be reached: treat that
 * as the index being away for now, never as a reason to fail a turn.
 *
 * A plugin gets it as `ctx.vectorIndex` by declaring `needs: ["vectorIndex"]`.
 * Its spaces are its own: name them after the plugin, and `ensure` them before
 * writing (it is idempotent). The index is shared by the whole instance and
 * knows no person: a space holding people's data filters every read on the
 * person's key, as the core's own spaces do.
 */
export type VectorIndex = {
  /** Creates `space` when it's missing, and the indexes its fields need; idempotent. */
  ensure: (space: string, spec: VectorSpaceSpec) => Promise<void>;
  upsert: (space: string, points: VectorPoint[]) => Promise<void>;
  /** The `limit` points nearest to `vector`, nearest first. */
  query: (
    space: string,
    q: { vector: number[]; where?: VectorWhere; limit: number },
  ) => Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>>;
  scroll: (
    space: string,
    q: { where?: VectorWhere; orderBy?: { key: string; direction: "asc" | "desc" }; limit: number; cursor?: string },
  ) => Promise<{ points: Array<{ id: string; payload: Record<string, unknown> }>; next?: string }>;
  /** Sets `payload`'s fields on every point `where` selects, keeping the rest. */
  setPayload: (space: string, q: { where: VectorWhere; payload: Record<string, unknown> }) => Promise<void>;
  /** Whether the index answers now, and why not when it doesn't. */
  health: () => Promise<{ ok: boolean; detail?: string }>;
};

/** Settled outcome of a tool call (or a guard, or any status line) reported via `onToolFinish`. `pending` = the action was staged behind a confirmation, not run. */
export type ToolOutcome = "success" | "failed" | "pending";

/**
 * What a tool call's result is reduced to when it's kept: how it went, what it
 * ran, how many items it found (`found: false` when it found none), the ref of
 * the list it produced, its error. Never the data.
 */
export type CallResult = {
  ok: boolean;
  ran: string;
  results?: number;
  found?: false;
  displayRef?: string;
  error?: string;
};

/** A tool call as a conversation keeps it: the tool, its input, its reduced result. */
export type CallRecord = { toolName: string; input: unknown; result: CallResult };

/**
 * One thing the person saw during a turn besides its text, in the order it
 * happened: a block of reasoning, a tool's (or a guard's) status line with its
 * outcome, a confirmation staged (named by a hash of its token, never the
 * token), a login asked for (by its service, never the link). For the person
 * only: nothing of it goes back to the model.
 */
export type TraceEntry =
  | { type: "reasoning"; text: string; failed?: true }
  | { type: "tool"; label: string; detail?: string; name?: string; outcome?: ToolOutcome }
  | { type: "confirmation"; id: string; command: string; choices: string[] }
  | { type: "login"; service: string };

/**
 * How a staged action was resolved: `id` is the staging's (the one its trace
 * entry carries), `status` what came of it, `choice` the label of the choice
 * taken when it was one of several.
 */
export type ArchivedConfirmation = {
  id: string;
  status: "ok" | "failed" | "resume";
  choice?: string;
};

/**
 * A message as the conversation store keeps it, and the standard of what is
 * archived: whoever writes the archive writes this shape, whoever reads it
 * (the channels reopening a conversation, a plugin resuming or searching it)
 * reads this shape. A writer may leave out the optional parts; adding a part
 * is a change of this contract.
 *
 * - `id` (a UUID), `userId` (whose it is, the person's key), `sessionKey` (which
 *   conversation), `timestamp` (ISO 8601, the order the store reads them in);
 * - `role` and `content`: who spoke, and the text. For an answer, the model's
 *   own text only;
 * - `displays`: the lists the person was shown after the text;
 * - `calls`: the tool calls the answer was written from;
 * - `interrupted`: the turn was stopped before its answer (`content` is then
 *   the placeholder the conversation kept for it);
 * - `trace`: what the person saw of the turn besides its text;
 * - `pendingNote`: the core's sentence `content` begins with when the turn
 *   only staged an action;
 * - `confirmation`: the message says how a staged action was resolved, outside
 *   any turn;
 * - `turnId`: the id the turn's trace events carry.
 *
 * `displays`, `trace`, `pendingNote` and `confirmation` are for the person,
 * never for the model.
 */
export type StoredMessage = {
  id: string;
  userId: string;
  sessionKey: string;
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  displays?: string[];
  calls?: CallRecord[];
  interrupted?: true;
  trace?: TraceEntry[];
  pendingNote?: string;
  confirmation?: ArchivedConfirmation;
  turnId?: string;
};

/** A conversation's title as the store keeps it: one per person and conversation, the newest replacing the one before. */
export type StoredTitle = { userId: string; sessionKey: string; title: string; source: string; updatedAt: string };

/**
 * The instance's conversation store (`conversationStore` in its config): every
 * message of every conversation (`StoredMessage`), read back by key and in
 * time order, never searched by meaning (that's the vector index's), and each
 * conversation's title. Every read is scoped to one person (`userId`).
 * `messages` pages one conversation by the opaque `cursor` the previous page
 * gave as `next`. Every method may reject when the store can't be reached:
 * treat that as the store being away for now.
 *
 * A plugin gets it as `ctx.conversations` by declaring
 * `needs: ["conversationStore"]`. It is shared data: the channels read it to
 * reopen and list a person's conversations, so what a plugin writes there is
 * what those people will see again.
 */
export type ConversationStore = {
  /** Gets the store ready to be written and read (creating what it needs); idempotent, retried while it rejects. */
  ready: () => Promise<void>;
  append: (message: StoredMessage) => Promise<void>;
  /** One conversation's messages, oldest first (`asc`) or newest first (`desc`). */
  messages: (q: {
    userId: string;
    sessionKey: string;
    order: "asc" | "desc";
    limit: number;
    cursor?: string;
  }) => Promise<{ messages: StoredMessage[]; next?: string }>;
  /** The person's newest `limit` messages across their conversations, newest first. */
  recent: (q: { userId: string; limit: number }) => Promise<StoredMessage[]>;
  setTitle: (title: StoredTitle) => Promise<void>;
  /** The titles of the person's conversations among `sessionKeys`; a conversation with none is missing. */
  titles: (q: { userId: string; sessionKeys: string[] }) => Promise<StoredTitle[]>;
  /** Whether the store answers now, and why not when it doesn't. */
  health: () => Promise<{ ok: boolean; detail?: string }>;
};

// ---- What else a plugin can use while it runs (see `PluginRuntimeContext`). ----

/**
 * What a plugin can ask the instance for in `needs`, beyond what every plugin
 * gets: the vector index (`ctx.vectorIndex`), the conversation store
 * (`ctx.conversations`), the embedding model (`ctx.embed`). Each is declared
 * by the instance in its config; a plugin that needs one the instance didn't
 * declare stops the instance at startup, saying which.
 */
export type PluginNeed = "vectorIndex" | "conversationStore" | "embedding";

/**
 * Turns a text into its vector with the instance's embedding model
 * (`models.embedding`), through the core's queue: like every model call a
 * plugin makes, it waits while people are waiting on the model, so call it
 * inside `ctx.job` when nobody is waiting for it. Rejects when the model can't
 * be reached.
 */
export type Embed = (text: string) => Promise<number[]>;

/**
 * Runs `fn` every day at `at` (`"HH:MM"`, 24 hours) in `timeZone` (an IANA
 * name; the instance's `i18n.timeZone` when left out). `name` says what the
 * work is, for the log (`<plugin>:<name>`).
 *
 * - Only the long-running service runs it, from its start: never the dev REPL.
 * - If the instance isn't running at that minute, that day's run is skipped,
 *   never made up later.
 * - It runs once a day even across a change of the clocks; a day whose clocks
 *   skip `at` has no run.
 * - `fn` isn't held for a model: work that calls one belongs in `ctx.job`
 *   inside it. One that throws or rejects is logged; the next day's run goes on.
 * - An `at` that isn't `"HH:MM"`, or a time zone that doesn't exist, is a
 *   mistake in the instance's config: the instance doesn't start.
 */
export type Daily = (name: string, when: { at: string; timeZone?: string }, fn: () => void | Promise<void>) => void;

/**
 * One tool call as the core's tool log keeps it: when, from which channel and
 * session, for whom (`owner`, the person's key), the tool, its input and its
 * output as text (cut when long; a login's link never kept).
 */
export type ToolLogEntry = {
  timestamp: string;
  channel: string;
  sessionKey: string;
  owner: string;
  toolName: string;
  input: string;
  output: string;
};

/**
 * The tool calls of the recent turns, kept in memory by the core (lost on a
 * restart), the newest ones per person. `read` returns `person`'s, oldest
 * first, only those of `sessionKey` when given.
 */
export type ToolLog = {
  read: (q: { person: string; sessionKey?: string }) => ToolLogEntry[];
};

/**
 * What a person told the agent about themselves, kept by the core (the
 * channels read it too: their name, their language, their time zone). Each
 * `of` is undefined when they never said. Each `set` saves and returns the
 * value as stored, and throws on one that can't be kept: a name that can't
 * stand in a prompt, a language the instance doesn't ship (`languages`), a
 * time zone that doesn't exist.
 */
export type Profiles = {
  nameOf: (person: string) => string | undefined;
  setName: (person: string, name: string) => string;
  languageOf: (person: string) => string | undefined;
  setLanguage: (person: string, language: string) => string;
  timeZoneOf: (person: string) => string | undefined;
  setTimeZone: (person: string, timeZone: string) => string;
  /** The languages the instance ships, its default first. */
  languages: string[];
};

/**
 * A message of a conversation as the model reads it: who spoke, the text,
 * on an answer the tool calls it was written from, on a person's message what
 * the instance's `turn` context layers put in front of it (which the model
 * reads there on later calls too, so its cache holds).
 */
export type ConversationMessage = { role: "user" | "assistant"; content: string; calls?: CallRecord[]; context?: string };

/**
 * What a conversation is opened for: the session; whose it is (`person`,
 * absent when nobody vouched for who writes, as on the terminal: nothing of
 * it is theirs to keep or bring back); `reopen` when the channel keeps many
 * conversations a person reopens at will, with the channel's budget for what
 * comes back (`maxChars`, the owner's own when absent, 0 for nothing);
 * `timeZone`, the turn's, to stamp what comes back.
 */
export type ConversationOpen = {
  sessionKey: string;
  person?: { key: string };
  reopen?: { maxChars?: number };
  timeZone?: string;
};

/**
 * The line the core puts before a person's message for the model
 * (`[Wednesday 2026-10-21 14:32 Europe/Rome]` and a line break): when it was
 * written at `date`, in `timeZone` (an IANA name). A conversation bringing
 * back archived messages stamps the person's with it, so the model reads them
 * as it read them live.
 */
export function formatTurnStamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `[${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${timeZone}]\n`;
}

/**
 * What a conversation tells the core when adding a message made it shorten
 * what came before (see `Conversation`): how many messages it folded, how
 * long they were and what they became (`charsAfter`, absent when it failed),
 * how long it took, and how it went (`error` when it failed). The core
 * records it as the `history.compressed` event of the instance's traces.
 */
export type CompressionReport = {
  messages: number;
  charsBefore: number;
  charsAfter?: number;
  durationMs: number;
  outcome: "done" | "failed";
  error?: string;
};

/**
 * One open conversation, as the turn uses it: what the model reads
 * (`getMessages`), the messages a turn adds (the person's with its context,
 * then the answer with its calls; either may make the owner shorten what
 * came before, and then resolves to a `CompressionReport` saying how), the
 * answer replaced after a post-turn guard rewrote it, and how long it is
 * (`getCharCount`, for a channel showing how full it is). `getCapturable` is
 * what the conversation added since it was opened, without what a reopening
 * brought back: what a memory may still have to learn.
 */
export type Conversation = {
  getMessages: () => ConversationMessage[];
  addUserMessage: (content: string, context?: string) => Promise<CompressionReport | void>;
  addAssistantMessage: (content: string, calls?: CallRecord[]) => Promise<CompressionReport | void>;
  replaceLastAssistantMessage: (content: string) => void;
  getCharCount: () => number;
  getCapturable?: () => ConversationMessage[];
};

/**
 * What a plugin contributes to keep conversations, when an instance's context
 * profile names it as its `conversation`: the core `open`s one at a session's
 * first turn and keeps it until the session closes (`close`, when the plugin
 * keeps anything of its own per session). `open` may reject: the turn then
 * fails, as it would without a model.
 */
export type ConversationOwner = {
  open: (req: ConversationOpen) => Promise<Conversation>;
  close?: (sessionKey: string) => void;
};

/**
 * What a plugin's `build()` receives — everything its runtime contributions may
 * need that isn't static data: the instance's turn model (for a model-backed
 * guard), the model of a handle it was given (`modelFor`), the process env
 * (for its own configuration), and a logger for anything it skips.
 */
export type PluginRuntimeContext = {
  model: LanguageModel;
  /**
   * The model a handle the plugin was given in its configuration stands for,
   * built by the core (the same model for the same handle). Absent with an
   * older core.
   */
  modelFor?: (handle: MercuryModelHandle) => LanguageModel;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  /**
   * The assistant's name (the app's `persona.name`), for a text the plugin
   * builds while running. Static texts (fragment, skill, tool descriptions)
   * write `{{assistant}}` instead, and the core substitutes it. The core always
   * sets it; optional so a plugin also builds against an older one.
   */
  assistantName?: string;
  /**
   * A folder for this plugin alone, in Mercury's data folder (a volume of its
   * own, so it survives a restart) and out of the wiki:
   * `$MERCURY_DATA_PATH/plugins/<name>/`, created
   * by the core before `build()`. What goes inside is the plugin's business;
   * nothing in it reaches the model or the wiki. Two sessions may write at
   * once, so write a temporary file in the folder and rename it over the old
   * one. Absent with an older core, or when the folder couldn't be made (the
   * core logs why): the plugin does without.
   */
  dataDir?: string;
  /**
   * Runs `fn` as work nobody is waiting on, through the core's queue for the
   * models: every model call inside it waits until the people talking to the
   * agent leave the model a free slot, one call at a time. `name` says what
   * the work is (the traces show it as `<plugin>:<name>`); `urgency` puts
   * `"soon"` work before `"idle"` work. Resolves with what `fn` resolves with,
   * rejects with its error, or when the agent stops before it ran. Absent
   * with an older core: call the model directly.
   */
  job?: <T>(name: string, urgency: JobUrgency, fn: () => Promise<T>) => Promise<T>;
  /**
   * The instance's `background` model (its `turn` model when it declares
   * none), through the core's queue: for work nobody waits on, in `ctx.job`.
   * The core always sets it.
   */
  backgroundModel?: LanguageModel;
  /** The instance's vector index (see `VectorIndex`): set when the plugin declares `needs: ["vectorIndex"]`. */
  vectorIndex?: VectorIndex;
  /** The instance's conversation store (see `ConversationStore`): set when the plugin declares `needs: ["conversationStore"]`. */
  conversations?: ConversationStore;
  /** The instance's embedding model (see `Embed`): set when the plugin declares `needs: ["embedding"]`. */
  embed?: Embed;
  /** Runs work every day at a set time (see `Daily`). The core always sets it. */
  daily?: Daily;
  /** The tool calls of the recent turns (see `ToolLog`). The core always sets it. */
  toolLog?: ToolLog;
  /** What people told the agent about themselves (see `Profiles`). The core always sets it. */
  profiles?: Profiles;
};

/** How soon a piece of work nobody waits on should run: `"soon"` (a title, within minutes) goes before `"idle"` (whenever the model is free). */
export type JobUrgency = "soon" | "idle";

/** A tool call of a finished turn, as hooks see it: the tool, what it was called with, whether it worked, and its error when it didn't. Never what it returned. */
export type HookCall = { toolName: string; input: unknown; ok: boolean; error?: string };

/** A message of a session, as `onSessionClose` sees it: the person's text, or the agent's answer with the calls it made. */
export type HookMessage = { role: "user" | "assistant"; content: string; calls?: HookCall[] };

/**
 * A turn that just ended with an answer, as `afterTurn` sees it. `person` is
 * who wrote it (in a shared space, the sender); `operator` is true on the
 * terminal, whose turns today's memory never learns from; `as` is how the
 * plugin was offered in that turn (see `Plugin.actsAs`).
 */
export type FinishedTurn = {
  sessionKey: string;
  person: { key: string };
  operator: boolean;
  as: "person" | "mercury" | "anyone";
  /** What the person wrote, as they wrote it. */
  input: string;
  /** The answer they got, after the post-turn guards. */
  answer: string;
  calls: HookCall[];
  /** Whether the turn came from a space shared by several people. */
  multiUser: boolean;
};

/** A session that was just closed for being quiet, as `onSessionClose` sees it: whose it was and its messages. */
export type ClosedSession = {
  sessionKey: string;
  person: { key: string };
  messages: HookMessage[];
};

/**
 * What a context layer is built for: the session, who wrote (in a shared
 * space, the sender; `operator` on the terminal), how the plugin is offered
 * to them (`as`, the identity its tools would act with), what they wrote
 * (for a `session` layer, their first message in the session; empty when
 * that turn was one the agent opened, or resumed after a confirmation),
 * whether the space is shared, and the value of each knob the layer
 * declares in the person's profile: the one the instance set, or the knob's
 * `default` (empty when it declares none), and whether the conversation was
 * reopened.
 */
export type ContextRequest = {
  sessionKey: string;
  person: { key: string };
  operator: boolean;
  as: "person" | "mercury" | "anyone";
  input: string;
  multiUser: boolean;
  knobs: Record<string, KnobValue>;
  /** Whether the session is a conversation its client reopened (see `ConversationOpen.reopen`), rather than one started now or a single running thread. */
  reopened: boolean;
};

/** A knob's value: what its `KnobSpec` allows. */
export type KnobValue = boolean | number | string;

/**
 * A setting a context layer lets the instance change while it runs, per
 * profile, without a restart (an admin area draws it from this alone):
 * its `type`, its `default`, a one-line `description` for whoever changes
 * it, and the values it allows. `integer` and `number` may bound it with
 * `min` and `max` (included); `enum` lists its `values`, `default` among
 * them. A plugin whose spec contradicts itself (a `default` outside it, an
 * `enum` with no values) isn't loaded.
 */
export type KnobSpec =
  | { type: "boolean"; default: boolean; description: string }
  | { type: "integer" | "number"; default: number; description: string; min?: number; max?: number }
  | { type: "string"; default: string; description: string }
  | { type: "enum"; default: string; description: string; values: string[] };

/**
 * What a plugin adds to what the model reads, when the instance lists it in
 * a context profile's `layers`. `build` returns blocks of text, the most
 * important first: the core keeps whole blocks, in order, as long as the
 * profile's budget allows, and drops the rest. `undefined` or `[]` adds
 * nothing.
 *
 * - `"session"`: built once per session and person, at their first turn in
 *   it, and kept in the system prompt for the rest of the session (stable
 *   text keeps the model's cache of the conversation valid); one that fails
 *   then stays out until the session closes. In a space shared by several
 *   people each one gets their own, never another's.
 * - `"turn"`: built for every turn and put in front of the person's
 *   message, where the model reads it on later turns too (each call starts
 *   with the previous one, so the model's cache of it holds); what the
 *   conversation keeps (its archive, what the person sees) is the message
 *   without it.
 *
 * A `build` that throws is skipped for that turn (or session), and the core
 * logs it.
 */
export type ContextLayer = {
  scope: "session" | "turn";
  build: (req: ContextRequest) => Promise<string[] | undefined>;
  /** The settings the layer reads from `req.knobs`, by name (see `KnobSpec`). */
  knobs?: Record<string, KnobSpec>;
};

/**
 * The per-turn context a `sessionTools` factory receives: the session it's
 * building tools for, and the two core capabilities a tool may need bound to
 * that session: staging a confirm-required action, and stashing a display
 * artifact for the model to `present` by hand. All generic; nothing here is CLI-shaped.
 */
export type SessionToolContext = {
  sessionKey: string;
  /** The texts of the person the turn is for (a choice's label, a line a tool shows them). */
  t: Translate;
  stageConfirmation: StageConfirmation;
  /** Stages an action offered as several choices (see `StageChoices`). The
   * core always sets it; optional so a plugin also builds against an older
   * one, where it has to do without. */
  stageChoices?: StageChoices;
  /** Stashes a rendered list for the model to `present`, with what it is
   * (`label`, free text), and returns its ref. A tool returning a `display`
   * doesn't need it: the core stashes that on its own (see `ToolDisplay`). */
  stashDisplay: (artifact: string, label?: string) => string;
  /** Whom the tools act for, by the person's key, when they act as the
   * person, and whom the turn is for when the plugin acts as no one
   * (`actsAs: "anyone"`, the operator's key on the terminal); `null` when they
   * act as the plugin's own service identity: on the
   * terminal, where whoever types already holds the container, and for a
   * person allowed to make Mercury act as itself. */
  person: { key: string } | null;
  /** For a plugin acting as `person` whose service says that person isn't
   * logged in: starts their login and returns what the tool hands back, a
   * `loginRequired` result whose link the channel shows them, or an error
   * when nothing can take a login. */
  requireLogin: () => Promise<LoginRequired>;
};

/** What a tool returns when its person has to log in first. The channel shows
 * `authorizeUrl` (see the channel contract's `detectLoginRequired`); the model
 * only reads `error`, which never contains the link. */
export type LoginRequired =
  | { ok: false; loginRequired: true; service: string; authorizeUrl: string; error: string }
  | { ok: false; error: string };

/**
 * How a plugin acting as `person` logs one in, for a person who isn't at the
 * service's machine: `start` begins the login for `personKey` (a user key)
 * with the link back to Mercury that the provider redirects to, and returns
 * the link the person opens and the `state` the provider sends back with the
 * code; `complete` finishes it with that code. The core keeps which person a
 * `state` belongs to, so `complete` only ever runs for the person who started.
 */
export type PersonLogin = {
  start: (
    personKey: string,
    callbackUrl: string,
  ) => Promise<{ ok: true; authorizeUrl: string; state: string } | { ok: false; error: string }>;
  complete: (personKey: string, code: string, state: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * The env/model-dependent half of a plugin's contributions, produced by
 * `build()` (which may be async, e.g. to validate its own config before
 * building its tool). Every field optional: a plugin may contribute nothing.
 *
 * - `postProcess`: the result transform for the plugin's own tool (see
 *   `CliPostProcessor`). A formatter decorator may wrap it to render a display;
 *   the composition then hands the final one to `sessionTools` (which is why the
 *   factory takes it as an argument rather than closing over it — the wrapping
 *   happens after `build()` returns).
 * - `sessionTools`: builds the plugin's model-facing tools for one turn, given
 *   the session context and the plugin's (possibly decorated) post-processor.
 *   This is how a tool reaches the model without the core knowing what it is.
 * - `toolStatusDescribers`: one per tool name the plugin contributes, turning a
 *   tool call's input into the one-line status shown while it runs, in the
 *   turn's person's language (`t`) — so the core can label a plugin's tool
 *   without knowing it's a CLI.
 * - `postTurnGuards`: run over the model's finished text (see `PostTurnGuard`).
 * - `login`: how a plugin acting as `person` logs one in (see `PersonLogin`).
 * - `afterTurn`: called once a turn ended with an answer, for every plugin
 *   offered in that turn (see `FinishedTurn`). The core doesn't wait for it:
 *   the person already has the answer, and their next turn doesn't wait
 *   either. A model call belongs in `ctx.job`. Ignored by an older core.
 * - `onSessionClose`: called once a quiet session was closed, for every
 *   plugin offered in its last turn (see `ClosedSession`); not awaited
 *   either. Ignored by an older core.
 *
 * - `context`: what the plugin adds to what the model reads, when the
 *   instance lists it in a context profile (see `ContextLayer`). Ignored by
 *   an older core, and by this one when no profile lists the plugin.
 * - `conversation`: how the plugin keeps conversations, when a context profile
 *   names it as its `conversation` (see `ConversationOwner`).
 *
 * A hook that throws, or rejects, is logged: nothing else is affected.
 */
export type PluginRuntimeContributions = {
  postProcess?: CliPostProcessor;
  login?: PersonLogin;
  sessionTools?: (ctx: SessionToolContext, postProcess?: CliPostProcessor) => Record<string, Tool>;
  toolStatusDescribers?: Record<string, (input: unknown, t: Translate) => string>;
  postTurnGuards?: PostTurnGuard[];
  afterTurn?: (turn: FinishedTurn) => void | Promise<void>;
  onSessionClose?: (session: ClosedSession) => void | Promise<void>;
  context?: ContextLayer;
  conversation?: ConversationOwner;
};

/**
 * A CLI command about to run, as the status describer sees it: the binary, the
 * argv after it, and whether the command mutates state (the core computes this
 * from the allowlist and passes it in, so a custom describer can vary read vs
 * write without re-deriving it).
 */
export type CliCommandInfo = { binary: string; args: string[]; mutating: boolean };

/** Turns a command about to run into the one-line status content shown while it
 * runs. A plugin may supply one to `createCliStatusDescriber` (see
 * `@mercury-fw/cli-engine`) to override the default; the core only transports the
 * result, the channel decides how to render it. `t` gives the turn's texts. */
export type StatusDescriber = (cmd: CliCommandInfo, t: Translate) => string;

/**
 * The default status content for a CLI command, used for every command unless a
 * plugin overrides it. A plain "Running <binary> <subcommand>" (the core's
 * `core.status.command`, `core.status.command-bare` without a subcommand),
 * where the subcommand is the leading non-flag tokens capped at two —
 * deliberately not a read/write classification. A plugin that wants finer
 * wording supplies its own `StatusDescriber`.
 */
export const defaultStatusLabel: StatusDescriber = ({ binary, args }, t) => {
  const sub: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) break;
    sub.push(a);
    if (sub.length === 2) break;
  }
  return sub.length > 0
    ? t("core.status.command", { binary, command: sub.join(" ") })
    : t("core.status.command-bare", { binary });
};

/**
 * A skill in the Anthropic Agent Skills sense: a `name` and a one-line
 * `description` that stay in the system prompt so the model knows the capability
 * exists, plus a `body` (the voluminous "how to" — conventions, flags, examples)
 * loaded on demand only when a request matches. A plugin declares its skills via
 * `Plugin.skills`; `parseSkill` reads them from the standard `SKILL.md` shape.
 */
export type Skill = { name: string; description: string; body: string };

/**
 * Parses the Anthropic Agent Skills `SKILL.md` shape — frontmatter fenced by
 * `---` lines carrying at least `name` and `description`, then the markdown
 * body — into a `Skill`. A deliberately tiny hand-rolled parser (no yaml
 * dependency, so this package stays dependency-free): it reads only `name` and
 * `description` from the frontmatter and takes everything after the closing
 * fence as the body verbatim. Throws when the frontmatter or either required
 * field is missing, so a malformed skill fails loudly at load.
 */
export function parseSkill(markdown: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!match) {
    throw new Error("SKILL.md is missing its frontmatter (--- name/description ---)");
  }
  const [, frontmatter = "", body = ""] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fields[key] = line.slice(idx + 1).trim();
  }
  const name = fields.name;
  const description = fields.description;
  if (!name || !description) {
    throw new Error("SKILL.md frontmatter must set both name and description");
  }
  return { name, description, body: body.trim() };
}

/**
 * Reserved slot. A plugin may declare a persistent surface that lives *outside*
 * a turn — a Figma canvas, a configuration view — as data only: a `type` the
 * hosting UI recognizes, an `address` to reach it, and opaque `params`. Never
 * frontend code, never a component; a UI that doesn't know the `type` simply
 * doesn't show it. Distinct from per-turn output (status, lists, cards), which
 * already flows through the core's sink — a plugin exposes nothing for that.
 * Jira declares none; the shape is a placeholder until a real surface plugin
 * (Figma) nails it down.
 */
export type PluginSurface = {
  type: string;
  address: string;
  params?: Record<string, unknown>;
};

/**
 * The plugin module: the single value the core's loader consumes. A plugin
 * package exports one as a plain object — it must not import the app it plugs
 * into, so compatibility is checked where the core's plugin list is typed
 * against this.
 *
 * - `apiVersion`: the contract version this plugin was built against (see
 *   `PLUGIN_API_VERSION`). Mandatory; the loader refuses a mismatch.
 * - `name`: the plugin's name, what `dependsOn` and the logs refer to it by; for a CLI plugin, the binary it owns.
 * - `description`: what the plugin lets the assistant do, in one English
 *   sentence written for the model (`{{assistant}}` stands for its name). The
 *   system prompt lists the plugins offered to the person with theirs, and the
 *   model answers "what can you do?" from that list. It says what, never how:
 *   usage instructions belong to `skills` and `systemPromptFragment`.
 *   Mandatory and on one line; the loader refuses a plugin without one, or
 *   with a line break inside it.
 * - `dependsOn`: names of plugins this one requires present. The loader loads
 *   dependencies first and skips this plugin fail-soft if any is absent or
 *   failed (see `loadPlugins`). Presence + ordering only — a dependency shares
 *   its capability through the usual registries, not a handle injected here.
 *   Absent/empty ⇒ no dependency.
 * - `needs`: what the plugin uses of the instance beyond what every plugin
 *   gets (see `PluginNeed`), handed to its `build()` in the context. The
 *   instance stops at startup when it declares the plugin without declaring
 *   what it needs.
 * - `systemPromptFragment`: the tool-surface description spliced into the
 *   system prompt when the plugin is active.
 * - `build`: the env/model-dependent contributions (its tool, post-processors,
 *   status describers, guards). A plugin that owns a CLI tool validates its own
 *   allowlist here (schema only — its pinned binary is co-shipped) before
 *   building the tool. It may return a promise, for work the plugin does once
 *   at startup (creating its spaces in the index, moving old data): the
 *   instance waits for it before taking turns, so keep it short, and leave
 *   to the plugin's first use anything that waits on a service that may be
 *   away. One that throws or rejects leaves the plugin out, as below.
 * - `skills`: Agent-Skills the plugin contributes (see `Skill`); their
 *   descriptors go in the system prompt, their bodies load on demand.
 * - `surfaces`: reserved (see `PluginSurface`); absent for a plugin with none.
 * - `messages`: the plugin's texts a person sees, in English (see `Messages`),
 *   every key under `<name>.`; the loader refuses a plugin with a key outside
 *   it. The instance's language files translate them.
 * - `actsAs`: whose identity the plugin's tools act with at the service they
 *   reach. `"person"`: the person the turn is for, who logs in to it through
 *   Mercury (the plugin contributes `login`). `"mercury"`: Mercury's own
 *   service identity, whoever asks. `"anyone"`: no identity at all (a public
 *   service, no login): offered to everyone, and its tools still get the
 *   turn's `person`, to keep what belongs to them; an older core reads it as
 *   `"mercury"`. Undeclared counts as `"mercury"`. A
 *   `"mercury"` plugin is offered to people only when they hold the
 *   permission to make Mercury act as itself (`mercury.act-as-self`, or
 *   `mercury.act-as-self.<plugin>`), and on the terminal.
 *
 * A plugin no longer carries a raw `cliConfig`: the core knows nothing about
 * CLIs. A CLI-based plugin owns its allowlist and, using `@mercury-fw/cli-engine`,
 * builds its own tool in `build()` — the core just collects the contributed
 * tools.
 */
export type Plugin = {
  apiVersion: number;
  name: string;
  description: string;
  dependsOn?: string[];
  needs?: PluginNeed[];
  systemPromptFragment?: string;
  build?: (ctx: PluginRuntimeContext) => PluginRuntimeContributions | Promise<PluginRuntimeContributions>;
  skills?: Skill[];
  surfaces?: PluginSurface[];
  actsAs?: "person" | "mercury" | "anyone";
  messages?: Messages;
};
