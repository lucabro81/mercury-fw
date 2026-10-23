/**
 * Shared contract between the core and every channel plugin: the turn shape
 * (`Provider`/`InboundTurn`/`TurnSink`/`HandleTurn`/`Notifier`), the pure
 * confirmation pieces a channel uses to build its own UI
 * (`detectPendingConfirmation`, `NO_REPLY`), the login a tool asks a person
 * for (`detectLoginRequired`, `loginLinkText`), and
 * the channel-plugin system (`ChannelPlugin`/`ChannelRuntimeContext`/
 * `CHANNEL_API_VERSION`), and the providers a config declares beside the
 * channels: who is calling (`AuthPlugin`) and who that is to Mercury
 * (`DirectoryPlugin`). The stateful half of confirmation (`ConfirmationStore`,
 * `resolveConfirmation`) stays in the core and reaches a channel via
 * `ctx.confirm`.
 */
import type { Messages, StepInfo, Translate } from "@mercury-fw/plugin-types";

export type { Messages, Translate };

/** Settled outcome of a tool call (or guard/capture-ping) reported via `onToolFinish`. `pending` = action deferred behind a token, not run. */
export type ToolOutcome = "success" | "failed" | "pending";

/** One way the person can answer a staging: the token to send back and the words on its button (empty when the tool gave none: the channel words it). */
export type ConfirmChoice = { token: string; label: string };

/**
 * A confirm-required staging found in a step: the token to send back, a
 * summary of what will run, and the choices offered. A staging with a single
 * token is one choice with an empty label, which the channel words itself (a
 * "Confirm" button, in the person's language); `token` is always the first
 * choice's, so a channel that knows nothing of choices still shows that one.
 */
export type PendingConfirmation = { token: string; summary: string; choices: ConfirmChoice[] };

/** The `choices` a tool result carries, keeping only well-formed ones. */
function choicesOf(raw: unknown): ConfirmChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is ConfirmChoice =>
      typeof c === "object" && c !== null && typeof (c as ConfirmChoice).token === "string" && typeof (c as ConfirmChoice).label === "string",
  ).map((c) => ({ token: c.token, label: c.label }));
}

/**
 * Returns the first confirm-required staging in `step` (in tool-call order), or
 * `null`. Keys on the `pendingConfirmation` flag a tool sets on its result, not
 * on a tool name. Used by the core to stop the loop and by channels to build
 * their confirm UI.
 */
export function detectPendingConfirmation(step: StepInfo): PendingConfirmation | null {
  for (const call of step.toolCalls) {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
    const output = result?.output as { pendingConfirmation?: unknown; token?: unknown; summary?: unknown; choices?: unknown } | undefined;
    if (!output || output.pendingConfirmation !== true || typeof output.token !== "string") continue;

    const choices = choicesOf(output.choices);
    return {
      token: output.token,
      summary: typeof output.summary === "string" ? output.summary : "",
      choices: choices.length > 0 ? choices : [{ token: output.token, label: "" }],
    };
  }
  return null;
}

/** A login a tool asked the person for: the service it's for and the link to open. */
export type LoginRequest = { service: string; url: string };

/**
 * Returns the first login a tool asked for in `step` (its result carries
 * `loginRequired` and the link), or `null`. A channel shows the link to the
 * person itself: the model is never handed it, so it can't mangle or leak it.
 * Only to that person, never where someone else can see it: whoever opens the
 * link logs their own account in as the person who asked.
 */
export function detectLoginRequired(step: StepInfo): LoginRequest | null {
  for (const call of step.toolCalls) {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
    const output = result?.output as { loginRequired?: unknown; authorizeUrl?: unknown; service?: unknown } | undefined;
    if (!output || output.loginRequired !== true || typeof output.authorizeUrl !== "string") continue;
    return { service: typeof output.service === "string" ? output.service : "", url: output.authorizeUrl };
  }
  return null;
}

/** The words a channel puts on a login link (a button, a link text), in the person's language (`t`, the core's `core.login.link*`), so every channel says it the same way. */
export function loginLinkText(login: LoginRequest, t: Translate): string {
  return login.service === "" ? t("core.login.link-any") : t("core.login.link", { service: login.service });
}

/** Sentinel the model returns for "not addressed to me" in a multi-person space (see `buildSystemPrompt`'s multiUser block). A multi-user channel suppresses it in `finalize`. */
export const NO_REPLY = "NO_REPLY";

/**
 * Who vouched for a principal's identity: the chat platform itself, an auth
 * provider (`oidc`, a named OIDC provider `oidc-<name>`, `static`), or `none` =
 * nobody did (the terminal): nothing identity-dependent treats it as a real
 * person. Each provider has its own, so two providers' people never share a key.
 */
export type PrincipalProvider = "google-chat" | "oidc" | `oidc-${string}` | "static" | "none";

/** Who is talking, as the channel knows them. The channel builds it; the core
 * turns it into the person (see `Directory`) every per-person id derives from. */
export type Principal = {
  /** Stable id for this person within `provider` (Google Chat: `users/<id>`). */
  id: string;
  provider: PrincipalProvider;
  displayName?: string;
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
  /** Set when the turn resumes after a confirmation whose result goes back to
   * the model (`ConfirmReply.resume`): the core runs the model on what it kept
   * for the session, and `text` is ignored. With nothing kept, the turn ends
   * with no answer. */
  resumeAfterConfirm?: true;
  /**
   * When set, aborting it cancels the turn: one still waiting never starts,
   * and one running stops its model call. A cancelled turn isn't an answer:
   * `finalize` is never called (an open reasoning block still gets
   * `onReasoningEnd(id, true)`), the sink is still released with `dispose`,
   * and the turn resolves instead of throwing. The history keeps the person's
   * message with a marker in place of the half answer. HTTP aborts it when
   * the client disconnects, Google Chat when the person presses Stop or sends
   * `/stop`.
   */
  abortSignal?: AbortSignal;
  /**
   * Set when `sessionKey` names a conversation its client reopens whenever it
   * wants (one of many a person keeps, as on HTTP), rather than a single
   * running thread (as a Google Chat space): once the core has let go of its
   * history, the next turn rebuilds it from the archive. `maxChars` is the
   * channel's own budget for what comes back; absent, the core's
   * (`SESSION_RESUME_MAX_CHARS`), and 0 turns resuming off.
   */
  resume?: { maxChars?: number };
  /**
   * Set, with an empty `text`, when the person hasn't written anything and the
   * channel asks the assistant to speak first (the HTTP surface, right after
   * someone signs in). The core speaks only to someone it doesn't know the
   * name of, introducing itself and asking how to call them; otherwise the
   * turn finalizes with an empty text and nothing is kept.
   */
  opening?: true;
  /**
   * The language the caller's client asks for, as an `Accept-Language` value
   * (`it-IT,it;q=0.9,en;q=0.8`), when the channel has one. The core uses it for
   * the turn's texts when the person saved no language of their own; it never
   * overrides the one they saved.
   */
  languageHint?: string;
  /**
   * The time zone the caller's client is in, as its IANA name (`Europe/Rome`),
   * when the channel has one. The core stamps the turn with the time there
   * when the person saved no time zone of their own; it never overrides the
   * one they saved, and a name that isn't a zone is ignored.
   */
  timeZoneHint?: string;
};

/** What the core says about a turn's final text, beside it. */
export type FinalizeInfo = {
  /**
   * Set when the text begins with the core's stand-in for an answer the model
   * didn't write, because the turn staged an action (in the person's
   * language): the exact sentence, followed by anything the turn appended
   * (`\n\n` and a list it surfaced). A channel that shows its own
   * confirmation UI drops it from what it shows; the archive keeps it.
   */
  pendingNote?: string;
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
  /** Deliver the model's complete final text, with what the core says about it (see `FinalizeInfo`). */
  finalize: (finalText: string, info?: FinalizeInfo) => Promise<void>;
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
 * An auth provider, declared in `auth` in `mercury.config.ts` (one, or several
 * tried in order): it tells a channel whose callers carry their own
 * credentials (HTTP) who is calling. `build` reads its own config from `env`
 * and throws when it's missing, so a misconfigured provider is left out
 * (closed), never open. `name` is unique on an instance, and the principals a
 * provider returns carry it as their `provider`.
 */
export type AuthPlugin = {
  apiVersion: number;
  name: string;
  build: (ctx: { env: Record<string, string | undefined>; log: (msg: string) => void }) => Authenticate;
};

/** A person as a directory knows them: `id` is stable within the directory
 * (the core keys the person on `<directory name>:<id>`), `roles` decide what
 * they may make Mercury do. */
export type DirectoryPerson = { id: string; displayName?: string; email?: string; roles: string[] };

/** Turns whoever a channel says is talking into the person they are, or
 * `null` when the directory doesn't know them. Throws when it can't tell
 * (unreachable, misconfigured): the core then refuses, it never guesses. */
export type Directory = { resolve: (principal: Principal) => Promise<DirectoryPerson | null> };

/** Directory-plugin contract version: the core refuses a directory with a different `apiVersion`, and then identifies nobody. */
export const DIRECTORY_API_VERSION = 1;

/**
 * A user directory, declared as `directory` in `mercury.config.ts`: the source
 * of truth about who people are and their roles. `build` reads its own config
 * from `env` and throws when it's missing, so a misconfigured directory leaves
 * the instance closed to everyone but the terminal, never open. `name` prefixes
 * the people's keys, so it can't be a principal provider's.
 */
export type DirectoryPlugin = {
  apiVersion: number;
  name: string;
  build: (ctx: { env: Record<string, string | undefined>; log: (msg: string) => void }) => Directory;
};

/** Whether the core talks to `principal`: `unknown` when the directory doesn't
 * know them and the instance is closed, `unavailable` when it couldn't tell.
 * `message` is what to tell them. */
export type Admission = { ok: true } | { ok: false; reason: "unknown" | "unavailable"; message: string };

/** Channel-plugin contract version: the loader refuses a channel with a different `apiVersion` fail-soft, like the tool-plugin loader with `PLUGIN_API_VERSION`. Bumped only on a breaking change to this file's shapes. */
export const CHANNEL_API_VERSION = 6;

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
  | { status: "failed"; error: string }
  | { status: "resume" };

/**
 * What the person is told about a confirmation they sent, in their language:
 * `text`, and `resume` when the confirmed action's result goes back to the
 * model, so the channel resumes the session's turn
 * (`InboundTurn.resumeAfterConfirm`) instead of showing `text`.
 */
export type ConfirmReply = { text: string; resume?: true };

/** A resolved confirmation (see `ConfirmOutcome`) with what to tell the person, `null` only for input that wasn't a token. */
export type ResolvedConfirmation = ConfirmOutcome & { text: string | null };

/** A channel's texts for a request: the language they're in and the texts by key (see `ChannelI18n`). */
export type RequestTexts = { locale: string; t: Translate };

/**
 * The texts a channel shows a person itself (a card's title, a button, a
 * login page), in their language: the person's own when `principal` is
 * someone the core knows and they saved one, else the channel's `hint` (an
 * `Accept-Language` value), else the instance's default. `null` for a request
 * with no principal (a login page): the hint, then the default.
 */
export type ChannelI18n = { forRequest: (principal: Principal | null, hint?: string) => Promise<RequestTexts> };

/**
 * Read-only introspection getters the core injects for a channel that exposes an
 * API/UI (the HTTP surface today). Every getter reads state that already exists
 * in-process — nothing computes anything new — so these can't come from `env`.
 * Returns are `unknown`/primitive by design, to keep this contract free of any
 * domain types. Tokens are never exposed.
 *
 * Every getter but `health` takes the caller's `Principal` and returns only
 * what belongs to that person (the common wiki area included) and what they're
 * offered (the manifest); the channel authenticates, the core decides what the
 * person can see. For someone the core doesn't admit, a getter answers `null`.
 */
export type ChannelHostReads = {
  manifest: (principal: Principal) => Promise<unknown>;
  pendingConfirmations: (principal: Principal) => Promise<unknown>;
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
  toolLog: (principal: Principal) => Promise<unknown>;
  health: () => Promise<unknown>;
  /** Who the caller is to the core: `{ name, language, timeZone }`, how they asked to be called, the language and the time zone they saved, `null` for what they never said (`timeZone` absent on an older core). Absent on an older core. */
  me?: (principal: Principal) => Promise<unknown>;
};

/** How finishing a login came out: the service the person is now logged in to, or why not. */
export type LoginOutcome = { ok: true; service: string } | { ok: false; error: string };

/**
 * Logins of people to the services Mercury's plugins act on, for a channel
 * that can receive the provider's redirect (the HTTP surface, when it has a
 * public URL). `accept` offers the URL the provider sends the person back to;
 * without one, a plugin asking for a login says no channel can take it.
 * `complete` finishes the login the `state` was issued for, with the `code`
 * the provider sent: `state` is single-use and tied to the person who
 * started, so the request carrying it needs no other credential.
 */
export type ChannelLogins = {
  accept: (callbackUrl: string) => void;
  complete: (state: string, code: string) => Promise<LoginOutcome>;
};

/** A code the person sends from another account to link it to this one, or why there's none. */
export type LinkStart = { ok: true; code: string; expiresAt: string } | { ok: false; error: string };

/**
 * Linking another account to a person, for a channel that can show them a
 * code without the model in between (the HTTP surface): `start` hands the
 * person `principal` is a one-time code. They send it from the other account,
 * on any channel, where `confirm` takes it like a token.
 */
export type ChannelLinking = { start: (principal: Principal) => Promise<LinkStart> };

/** A setting as the core saved it, or why it didn't. */
export type SettingOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The person's own settings, for a channel that can show them a settings
 * area (the HTTP surface): what the model would otherwise save when the
 * person tells it. `setTimeZone` saves the time zone `principal` is in, by
 * its IANA name, as the IANA list writes it; it refuses what isn't a zone's
 * name, and anyone the core doesn't admit.
 */
export type ChannelSettings = {
  setTimeZone: (principal: Principal, timeZone: string) => Promise<SettingOutcome<string>>;
};

/**
 * The minimal capabilities every channel gets from the core — the intersection
 * across terminal, HTTP and Google Chat, nothing channel-specific. Anything
 * specific (Google Chat's credentials, HTTP's port) the channel reads from `env`
 * in its own `build()`. This is the dependency-inversion seam: the core injects
 * these, the channel imports none of them.
 *
 * `env`, `log`, `confirm` and `admit` are the floor every channel relies on.
 * `resolveConfirmation`, `reads`, `authenticate`, `logins`, `linking` and `settings` are optional in-process capabilities that
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
   * Returns what to tell the person, in their language (`hint` as in
   * `ChannelI18n`), or `null` when the input wasn't token-shaped (see
   * `resolveConfirmation`). A link code (`xxxx-xxxx-xxxx`, see
   * `ChannelLinking`) is taken here too, from whoever sends it.
   */
  confirm: (token: string, sessionKey: string, principal: Principal, hint?: string) => Promise<ConfirmReply | null>;
  /**
   * Whether the core talks to `principal` at all (see `Admission`). A channel
   * that authenticates its own callers checks it before anything else and
   * answers with `message` when it's refused; the core checks again on every
   * turn, confirmation and read, so a channel that doesn't still can't let
   * anyone in. `message` is in the language `hint` asks for (see `ChannelI18n`).
   */
  admit: (principal: Principal, hint?: string) => Promise<Admission>;
  /** The structured sibling of `confirm` (see `ResolvedConfirmation`), for a channel that branches on whether the token was accepted. */
  resolveConfirmation?: (token: string, sessionKey: string, principal: Principal, hint?: string) => Promise<ResolvedConfirmation>;
  /** The texts the channel shows a person itself, in their language (see `ChannelI18n`). */
  i18n: ChannelI18n;
  /** In-process introspection getters for a channel that exposes an API/UI. */
  reads?: ChannelHostReads;
  /** The configured auth provider, built; absent when the app declares none or it failed to build. */
  authenticate?: Authenticate;
  /** People's logins to the plugins' services (see `ChannelLogins`). */
  logins?: ChannelLogins;
  /** Linking another account to a person (see `ChannelLinking`). */
  linking?: ChannelLinking;
  /** The person's own settings (see `ChannelSettings`); absent on an older core. */
  settings?: ChannelSettings;
  /** The assistant's name (the app's `persona.name`), for what the channel tells people itself (a login page, a card). The core always sets it; absent on an older core. */
  assistantName?: string;
  /** The framework's version (`major.minor.patch`), for a channel that tells people which Mercury they're talking to (HTTP's `/version`). The core always sets it; absent on an older core. */
  frameworkVersion?: string;
};

/**
 * A channel plugin: the value the core's channel loader consumes, mirroring
 * `@mercury-fw/plugin-types`' `Plugin`. A channel package exports one and does not
 * import the app.
 *
 * - `apiVersion`: contract version (see `CHANNEL_API_VERSION`); the loader refuses a mismatch.
 * - `name`: the channel's id, and the key the loader registers the provider under (the cron layer looks up `"google-chat"` for its `Notifier`).
 * - `build`: builds the `Provider` from the context, or `undefined` when the instance isn't configured for this channel (e.g. no `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION`) → the loader treats it as "present but inert" and never starts it.
 * - `messages`: the channel's texts a person sees, in English, every key under `<name>.`; the loader refuses a channel with a key outside it (and one named `core` or `app`). The instance's language files translate them, and the channel gets them through `ctx.i18n`.
 */
export type ChannelPlugin = {
  apiVersion: number;
  name: string;
  build: (ctx: ChannelRuntimeContext) => Provider | undefined;
  messages?: Messages;
};
