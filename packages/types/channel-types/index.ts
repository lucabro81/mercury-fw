/**
 * Shared contract between the core and every channel plugin: the turn shape
 * (`Provider`/`InboundTurn`/`TurnSink`/`HandleTurn`/`Notifier`), the pure
 * confirmation pieces a channel uses to build its own UI
 * (`detectPendingConfirmation`, `PENDING_CONFIRMATION_NOTE`, `NO_REPLY`), and
 * the channel-plugin system (`ChannelPlugin`/`ChannelRuntimeContext`/
 * `CHANNEL_API_VERSION`). The stateful half of confirmation (`ConfirmationStore`,
 * `tryConfirm`) stays in the core and reaches a channel via `ctx.confirm`.
 */
import type { StepInfo } from "@mercury-fw/plugin-types";

/** Settled outcome of a tool call (or guard/capture-ping) reported via `onToolFinish`. `pending` = action deferred behind a token, not run. */
export type ToolOutcome = "success" | "failed" | "pending";

/** A confirm-required staging found in a step: the token to send back and a summary of what will run. */
export type PendingConfirmation = { token: string; summary: string };

/**
 * Returns the first confirm-required staging in `step` (in tool-call order), or
 * `null`. Keys on the `pendingConfirmation` flag a tool sets on its result, not
 * on a tool name. Used by the core to stop the loop and by channels to build
 * their confirm UI.
 */
export function detectPendingConfirmation(step: StepInfo): PendingConfirmation | null {
  for (const call of step.toolCalls) {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
    const output = result?.output as { pendingConfirmation?: unknown; token?: unknown; summary?: unknown } | undefined;
    if (!output || output.pendingConfirmation !== true || typeof output.token !== "string") continue;

    return { token: output.token, summary: typeof output.summary === "string" ? output.summary : "" };
  }
  return null;
}

/** Text shown when a turn ends with no text because it staged an action: stands in for the answer, not model-generated (no token to leak). Every channel suppresses it and shows its own confirm UI. */
export const PENDING_CONFIRMATION_NOTE = "Azione in sospeso, in attesa di conferma.";

/** Sentinel the model returns for "not addressed to me" in a multi-person space (see `buildSystemPrompt`'s multiUser block). A multi-user channel suppresses it in `finalize`. */
export const NO_REPLY = "NO_REPLY";

/** Who vouched for a principal's identity: the chat platform itself, an auth provider (`oidc`, `static`), or `none` = nobody did (the terminal): nothing identity-dependent treats it as a real person. */
export type PrincipalProvider = "google-chat" | "oidc" | "static" | "none";

/** The person behind a turn. The channel builds it; the core derives every per-person id from it. */
export type Principal = {
  /** Stable id for this person within `provider` (Google Chat: `users/<id>`). */
  id: string;
  provider: PrincipalProvider;
  displayName?: string;
  /** Roles the provider granted, when it has any. */
  roles?: string[];
  /** Raw claims the provider vouched for, when it has any. */
  claims?: Record<string, unknown>;
};

/** One inbound message, already resolved by its provider into the shape the shared layer needs. */
export type InboundTurn = {
  /** Stable provider id for the tool log — a free string, each provider supplies its own. */
  channel: string;
  /** Whether the conversation can carry more than one person — selects the NO_REPLY system-prompt variant. */
  multiUser: boolean;
  /** Text handed to the model, already provider-decorated (e.g. Google Chat's "[Da: X]" marker). */
  text: string;
  /** Opaque session key. Derived by the provider, never parsed above it. */
  sessionKey: string;
  /** Who is talking, as the channel knows them. Read only by the core, never handed to tools. */
  principal: Principal;
  /** stderr log prefix, e.g. `[chat:spaces/x:users/y] ` — empty for the terminal. */
  logPrefix: string;
  /** When set, aborting it cancels the in-flight turn. Only the HTTP surface supplies one today (client disconnect); other channels leave it undefined. */
  abortSignal?: AbortSignal;
};

/**
 * A provider's output for one turn. Each optional member maps 1:1 onto an
 * optional `runTurn` dep: supplying `onTextChunk` *or* `onReasoningChunk` puts
 * `runTurn` on its `streamText` path. Google Chat supplies only
 * `onReasoningChunk` (never `onTextChunk`), so *answer* streaming never starts there.
 */
export type TurnSink = {
  /** `onToolStart` for `buildTools`. `detail`/`toolCallId` present for a real tool call or a capture-ping with its own id; both undefined = a caller with no correlation id. `toolName` only for a real tool call (the model's tool, e.g. `jiraCommand`), never for a capture-ping. */
  onToolStart: (label: string, detail?: string, toolCallId?: string, toolName?: string) => void;
  /** Paired with `onToolStart` via `toolCallId` once the call settles. Optional — only Google Chat implements it (patches its status card). */
  onToolFinish?: (toolCallId: string, outcome: ToolOutcome) => void;
  /** Present ⇒ `runTurn` uses `streamText`. Must stay undefined for Google Chat's own *answer* delivery. */
  onTextChunk?: (chunk: string) => void;
  /** Reasoning-token delta (Ollama extended thinking, behind OLLAMA_THINK). Present ⇒ `streamText`. Never reaches `SessionHistory`. `id` is the reasoning-block id; a turn can reason more than once, each burst with its own id. */
  onReasoningChunk?: (chunk: string, id: string) => void;
  /** Closes a reasoning block that started (even if the turn aborts with it open), so a live display doesn't get stuck. Never for an id `onReasoningChunk` didn't report. `failed` is true only on abort. */
  onReasoningEnd?: (id: string, failed: boolean) => void;
  /** Provider-local per-step bookkeeping (the terminal's `/dump` buffer). */
  onStep?: (step: StepInfo) => void;
  /** Provider-local usage handling (the terminal's prompt indicator, Chat's stderr line). */
  onUsage?: (inputTokens: number | undefined) => void;
  /** Deliver the model's complete final text. */
  finalize: (finalText: string) => Promise<void>;
  /** Release per-turn resources. Idempotent. */
  dispose: () => void;
};

/** What a provider calls once it has a real model turn to run. */
export type HandleTurn = (turn: InboundTurn, sink: TurnSink) => Promise<void>;

/** Proactive, out-of-band delivery — the slice the cron layer depends on. */
export type Notifier = {
  /** DMs `userId` (an opaque id the provider knows how to address). Returns the session key of the conversation the message landed in, so a reply continues that same conversation. */
  notify(userId: string, text: string): Promise<{ sessionKey: string }>;
};

/**
 * What a provider (terminal, Google Chat, HTTP, future ones) must supply to
 * plug into the turn pipeline and proactive notification. Opaque addressing
 * strings: each provider owns its own addressing model, nothing above this
 * layer parses them.
 */
export type Provider = Notifier & {
  /** Runs the provider's inbound driver, calling `handleTurn` once per message that needs the model. Deterministic pre-interception (a confirm token, `/dump`) is the provider's, before this. Resolves when the provider stops. */
  start(handleTurn: HandleTurn): Promise<void>;
  /** Optional lifecycle stop for a channel with a background resource (a Pub/Sub subscription, an HTTP server); the composition root calls it on shutdown. A channel with nothing to release omits it. */
  stop?(): Promise<void>;
};

/** Who sent `req`, or `null` when it carries no credential the provider accepts. */
export type Authenticate = (req: Request) => Promise<Principal | null>;

/** Auth-plugin contract version: the core refuses an auth plugin with a different `apiVersion`, and no channel gets `authenticate`. */
export const AUTH_API_VERSION = 1;

/**
 * An auth provider, declared as `auth` in `mercury.config.ts`: it tells a
 * channel whose callers carry their own credentials (HTTP) who is calling.
 * `build` reads its own config from `env` and throws when it's missing, so a
 * misconfigured provider leaves the channel without `authenticate` (closed),
 * never open.
 */
export type AuthPlugin = {
  apiVersion: number;
  name: string;
  build: (ctx: { env: Record<string, string | undefined>; log: (msg: string) => void }) => Authenticate;
};

/** Channel-plugin contract version: the loader refuses a channel with a different `apiVersion` fail-soft, like the tool-plugin loader with `PLUGIN_API_VERSION`. Bumped only on a breaking change to this file's shapes. */
export const CHANNEL_API_VERSION = 3;

/**
 * Structured outcome of resolving a confirmation token, distinguishing cases the
 * string-returning `confirm` collapses together. `not-a-token` = the input isn't
 * token-shaped (run the normal flow); `not-found` = token-shaped but no matching
 * pending confirmation; `ok`/`failed` = the staged action was consumed and run.
 * Returned by `ctx.resolveConfirmation` — the value the core's `resolveConfirmation`
 * produces. A channel that needs to branch on acceptance (the HTTP `/confirm`
 * endpoint's `resolved` flag) uses it; one that only needs a reply string uses `confirm`.
 */
export type ConfirmOutcome =
  | { status: "not-a-token" }
  | { status: "not-found" }
  | { status: "ok"; data: unknown }
  | { status: "failed"; error: string };

/**
 * Read-only introspection getters the core injects for a channel that exposes an
 * API/UI (the HTTP surface today). Every getter reads state that already exists
 * in-process — nothing computes anything new — so these can't come from `env`.
 * Returns are `unknown`/primitive by design, to keep this contract free of any
 * domain types. Tokens are never exposed.
 *
 * Every getter but `manifest` and `health` takes the caller's `Principal` and
 * returns only what belongs to that person (the common wiki area included);
 * the channel authenticates, the core decides what the person can see.
 */
export type ChannelHostReads = {
  manifest: () => unknown;
  pendingConfirmations: (principal: Principal) => unknown;
  /** A conversation's durable verbatim transcript, chronological, paginated; empty unless `sessionKey` is one of the person's own. */
  conversation: (principal: Principal, sessionKey: string, limit: number, offset?: string) => Promise<unknown>;
  /** The person's conversations, most-recently-active first. */
  conversations: (principal: Principal, limit: number) => Promise<unknown>;
  wikiList: (principal: Principal) => Promise<unknown>;
  /** The file at `path` as the person names it (`curated/...`, `personal/...`), or `null` when it isn't among what they can see. */
  wikiRead: (principal: Principal, path: string) => Promise<unknown>;
  wikiGrep: (principal: Principal, pattern: string) => Promise<unknown>;
  /** A page of the person's points in `collection`, or `null` when it isn't a collection kept per person. */
  memoryScroll: (principal: Principal, collection: string, limit: number, offset?: string) => Promise<unknown>;
  toolLog: (principal: Principal) => unknown;
  health: () => Promise<unknown>;
};

/**
 * The minimal capabilities every channel gets from the core — the intersection
 * across terminal, HTTP and Google Chat, nothing channel-specific. Anything
 * specific (Google Chat's credentials, HTTP's port) the channel reads from `env`
 * in its own `build()`. This is the dependency-inversion seam: the core injects
 * these, the channel imports none of them.
 *
 * `env`, `log` and `confirm` are the floor every channel relies on.
 * `resolveConfirmation`, `reads` and `authenticate` are optional in-process capabilities that
 * can't come from `env`: the core populates them, only a channel that needs them
 * (HTTP) reads them, the others ignore them.
 */
export type ChannelRuntimeContext = {
  /** The process env, so a channel reads its own config (subscription, credentials, port) without the core knowing which keys it needs. */
  env: Record<string, string | undefined>;
  /** stderr logger for the channel's own lifecycle/errors. */
  log: (msg: string) => void;
  /**
   * Resolves a confirmation token against the core's single `ConfirmationStore`,
   * already bound to this instance's store/vault/writer. The channel calls it
   * and holds no state: staging and the store stay the core's. The token
   * resolves only for the `principal` who staged it, in the same session.
   * Returns the reply text to send back, or `null` when the input wasn't
   * token-shaped (see `resolveConfirmation`).
   */
  confirm: (token: string, sessionKey: string, principal: Principal) => Promise<string | null>;
  /** The structured sibling of `confirm` (see `ConfirmOutcome`), for a channel that branches on whether the token was accepted. */
  resolveConfirmation?: (token: string, sessionKey: string, principal: Principal) => Promise<ConfirmOutcome>;
  /** In-process introspection getters for a channel that exposes an API/UI. */
  reads?: ChannelHostReads;
  /** The configured auth provider, built; absent when the app declares none or it failed to build. */
  authenticate?: Authenticate;
};

/**
 * A channel plugin: the value the core's channel loader consumes, mirroring
 * `@mercury-fw/plugin-types`' `Plugin`. A channel package exports one and does not
 * import the app.
 *
 * - `apiVersion`: contract version (see `CHANNEL_API_VERSION`); the loader refuses a mismatch.
 * - `name`: the channel's id, and the key the loader registers the provider under (the cron layer looks up `"google-chat"` for its `Notifier`).
 * - `build`: builds the `Provider` from the context, or `undefined` when the instance isn't configured for this channel (e.g. no `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION`) → the loader treats it as "present but inert" and never starts it.
 */
export type ChannelPlugin = {
  apiVersion: number;
  name: string;
  build: (ctx: ChannelRuntimeContext) => Provider | undefined;
};
