/**
 * The HTTP surface's Bun.serve and its one conversational endpoint (4a).
 * `POST /turn` runs a real model turn and streams the result back as
 * Server-Sent Events, mirroring what `terminal-provider.ts` does with console
 * chunks: reasoning/text deltas as they arrive, a `pending` event carrying the
 * token when a turn stages a confirm-required action, a `final` event with the
 * complete answer. A bare confirmation token in `text` is resolved by the
 * injected `confirm` capability, before the model is ever consulted.
 *
 * `handleTurnRequest` is exported (and takes its collaborators as deps — the
 * injected `confirm` and the ephemeral session key) so the streaming behaviour
 * is unit-tested without standing up a socket. The read-only routes (4b) mount
 * alongside `/turn` here, driven by the injected `reads` getters.
 *
 * `/login/callback` is where a person's browser comes back after logging in to
 * a service a plugin acts on as them; the single-use state is its credential.
 *
 * Every route but the OpenAPI document, the login callback and the CORS
 * preflights asks the injected `authenticate` (the auth provider the app declares) who is calling
 * before anything runs, and answers 401 when nobody is. A conversation belongs
 * to whoever opened it: the session key is `<principal.id>:<conversationId>`.
 * Confirm resolution is injected too (`confirm`/`resolveConfirmation`), so this
 * package never imports the app.
 */
import {
  detectLoginRequired,
  detectPendingConfirmation,
  type HandleTurn,
  type TurnSink,
  type Authenticate,
  type ChannelHostReads,
  type ChannelI18n,
  type ChannelRuntimeContext,
  type LoginOutcome,
  type Principal,
  type Admission,
  type ChannelLinking,
  type ChannelSettings,
} from "@mercury-fw/channel-types";
import { englishHttp } from "./messages.ts";

/**
 * A client's conversation id becomes part of the session key and the log
 * prefix, so only letters, digits, `-` and `_` get in: no path segments, no
 * line breaks, nothing to encode, and no `:`, which separates it from the
 * caller's id in the session key.
 */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `text` with every control character (line breaks included) as `?`, for a log line nobody can forge. */
function forLog(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, "?");
}

/** Resolves a bare confirmation token to what to tell the person, or `null` if the input isn't a token. Injected by the core (`ctx.confirm`). */
export type ConfirmFn = ChannelRuntimeContext["confirm"];
/** The structured sibling of {@link ConfirmFn}, for the `/confirm` `resolved` flag. Injected by the core (`ctx.resolveConfirmation`). */
export type ResolveConfirmationFn = NonNullable<ChannelRuntimeContext["resolveConfirmation"]>;

/** Whether the core talks to an authenticated caller at all, injected by the core (`ctx.admit`); everyone when absent. */
export type AdmitFn = (principal: Principal, hint?: string) => Promise<Admission>;

/** The language the caller's client asks for (`Accept-Language`), when it says. */
function languageHint(req: Request): string | undefined {
  const value = req.headers.get("accept-language")?.trim();
  return value ? value : undefined;
}

/** The time zone the caller's client says it's in (`X-Time-Zone`, an IANA name), when it says; the core ignores a name that isn't a zone. */
function timeZoneHint(req: Request): string | undefined {
  const value = req.headers.get("x-time-zone")?.trim();
  return value ? value : undefined;
}

/** `Content-Language` for a response to `principal` asking for `hint`, when the core says which language its texts are in. */
async function contentLanguage(i18n: ChannelI18n | undefined, principal: Principal | null, hint: string | undefined): Promise<Record<string, string>> {
  return i18n ? { "content-language": (await i18n.forRequest(principal, hint)).locale } : {};
}

export type TurnRequestDeps = {
  handleTurn: HandleTurn;
  /** Who is calling, injected from the app's auth provider; `null` = refused. */
  authenticate: Authenticate;
  admit?: AdmitFn;
  /** Bare-token interception before the model, injected by the core. */
  confirm: ConfirmFn;
  /** The texts in the caller's language, injected by the core (`ctx.i18n`): what `Content-Language` says. */
  i18n?: ChannelI18n;
  /** Allowed CORS origin echoed back to a browser UI; defaults to `*`. */
  corsOrigin?: string;
  /** Test seam for the ephemeral session key when the client sends no conversationId. */
  newSessionKey?: () => string;
  /** How much of a reopened conversation comes back once the core let its history go (`HTTP_SURFACE_RESUME_MAX_CHARS`); absent, the core's own. */
  resumeMaxChars?: number;
};

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/**
 * The CORS headers echoed on every response so a browser UI served from a
 * different origin (the separate custom-UI project) can call this surface.
 * The caller's token travels in an explicit `Authorization` header, never in a
 * cookie the browser would attach on its own, so a wildcard origin is safe: a
 * page on another origin can't borrow anyone's credentials. A specific origin
 * can still be pinned via `HTTP_SURFACE_CORS_ORIGIN`.
 */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, accept-language, x-time-zone",
  };
}

/** 401 for a caller the auth provider refused, with the Bearer challenge and CORS headers (so a browser UI can read it). */
function unauthorized(origin: string): Response {
  return Response.json(
    { ok: false, error: "unauthorized" },
    { status: 401, headers: { ...corsHeaders(origin), "www-authenticate": "Bearer" } },
  );
}

/** The core's refusal of an authenticated caller: 403 for someone it doesn't know, 503 when it couldn't tell, with what to tell them, in the language they asked for. */
function notAdmitted(admission: Exclude<Admission, { ok: true }>, origin: string, language: Record<string, string>): Response {
  return Response.json(
    { ok: false, error: admission.message, reason: admission.reason },
    { status: admission.reason === "unknown" ? 403 : 503, headers: { ...corsHeaders(origin), ...language } },
  );
}

/** The caller of `req`, authenticated and admitted, or the response refusing them. */
async function caller(
  req: Request,
  deps: { authenticate: Authenticate; admit?: AdmitFn; i18n?: ChannelI18n },
  origin: string,
): Promise<Principal | Response> {
  const principal = await deps.authenticate(req);
  if (principal === null) return unauthorized(origin);
  const hint = languageHint(req);
  const admission = deps.admit ? await deps.admit(principal, hint) : { ok: true as const };
  // A refused caller is nobody the core knows: their client's language, else the default.
  return admission.ok ? principal : notAdmitted(admission, origin, await contentLanguage(deps.i18n, null, hint));
}

/** 204 preflight response for an `OPTIONS` request, carrying only CORS headers. */
function preflight(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/**
 * Serves the OpenAPI document that describes this surface — the single source
 * of truth in this package's `openapi.yaml`, also rendered as the GitHub Pages
 * API docs. Served raw as `text/yaml` (no YAML parser needed at runtime); most
 * tooling (Redoc, Swagger UI, Postman) reads YAML directly.
 */
export function openApiResponse(corsOrigin = "*"): Response {
  const file = Bun.file(new URL("./openapi.yaml", import.meta.url));
  return new Response(file, {
    headers: { "content-type": "text/yaml; charset=utf-8", ...corsHeaders(corsOrigin) },
  });
}

/**
 * Runs one `POST /turn` request and returns an SSE stream Response. The caller
 * is authenticated first. The body is `{ text, conversationId? }`;
 * `conversationId` (opaque, client-owned) continues one of the caller's
 * conversations: the session key is `<principal.id>:<conversationId>`, so the
 * same id from someone else is a session of their own. Mercury keys its
 * histories by session, so many conversations run concurrently, each
 * one-on-one (`multiUser: false`). No `conversationId` means a fresh ephemeral
 * session. Never throws: a refused caller is a 401, a bad body a 400, a
 * mid-turn failure an `error` event on the stream.
 *
 * `{ opening: true, conversationId }`, with no `text`, asks the assistant to
 * speak first in that conversation (right after someone signs in): the core
 * decides whether it has anything to say, and a `final` with an empty text
 * means it hasn't. `{ resume: true, conversationId }` runs the turn a
 * `/confirm` answered `resume: true` for; a bare token whose confirmation
 * resumes runs that turn on the same stream.
 */
export async function handleTurnRequest(req: Request, deps: TurnRequestDeps): Promise<Response> {
  const origin = deps.corsOrigin ?? "*";
  const cors = corsHeaders(origin);
  const principal = await caller(req, deps, origin);
  if (principal instanceof Response) return principal;
  let body: { text?: unknown; conversationId?: unknown; opening?: unknown; resume?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "body must be JSON" }, { status: 400, headers: cors });
  }
  const opening = body.opening === true;
  // A conversation the client names is one it reopens; an ephemeral one never comes back.
  const named = typeof body.conversationId === "string" && body.conversationId.trim().length > 0;
  // The turn a `/confirm` answered `resume: true` for.
  const resume = body.resume === true;
  if (opening && !named) {
    return Response.json({ ok: false, error: "an opening needs a conversationId" }, { status: 400, headers: cors });
  }
  if (resume && !named) {
    return Response.json({ ok: false, error: "a resumed turn needs a conversationId" }, { status: 400, headers: cors });
  }
  if (!opening && !resume && (typeof body.text !== "string" || body.text.trim().length === 0)) {
    return Response.json({ ok: false, error: "missing text" }, { status: 400, headers: cors });
  }
  const text = opening || resume ? "" : (body.text as string);
  const conversationId = named ? (body.conversationId as string).trim() : (deps.newSessionKey ?? (() => crypto.randomUUID()))();
  if (!CONVERSATION_ID.test(conversationId)) {
    return Response.json({ ok: false, error: "invalid conversationId" }, { status: 400, headers: cors });
  }
  const sessionKey = `${principal.id}:${conversationId}`;
  const hint = languageHint(req);
  const zone = timeZoneHint(req);
  const language = await contentLanguage(deps.i18n, principal, hint);

  // Aborted when the client disconnects (see the stream's `cancel` below) so
  // the in-flight turn stops instead of running to completion — the "stop"
  // affordance for a diverging generation.
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      // Once the client is gone the controller is closed; enqueuing then throws.
      // Swallow it — there's no consumer left to receive the event anyway.
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* stream already closed/canceled */
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Same deterministic interception as every other channel — a
      // previously-approved mutation must never depend on the model.
      const reply = opening || resume ? null : await deps.confirm(text, sessionKey, principal, hint);
      if (reply !== null && !reply.resume) {
        send("final", { text: reply.text });
        close();
        return;
      }
      // The confirmed action's result goes back to the model: the turn runs again, on this stream.
      const resuming = resume || reply?.resume === true;

      const sink: TurnSink = {
        onToolStart: (label, detail, toolCallId, toolName) => send("tool", { label, detail, toolCallId, name: toolName }),
        onToolFinish: (toolCallId, outcome) => send("tool_finish", { toolCallId, outcome }),
        onTextChunk: (chunk) => send("text", { chunk }),
        onReasoningChunk: (chunk, id) => send("reasoning", { chunk, id }),
        onReasoningEnd: (id, failed) => send("reasoning_end", { id, failed }),
        onStep: (step) => {
          const pending = detectPendingConfirmation(step);
          if (pending) send("pending", { command: pending.summary, token: pending.token, choices: pending.choices });
          const login = detectLoginRequired(step);
          if (login) send("login", { service: login.service, url: login.url });
        },
        onUsage: () => {},
        // The core says when the text is its stand-in for an answer the
        // model didn't write: a UI showing its own confirmation hides it.
        finalize: async (finalText, info) =>
          send("final", info?.pendingNote === undefined ? { text: finalText } : { text: finalText, pendingNote: info.pendingNote }),
        dispose: () => {},
      };

      try {
        await deps.handleTurn(
          {
            channel: "http",
            multiUser: false,
            text: resuming ? "" : text,
            sessionKey,
            principal,
            // The caller's id comes from the auth provider, unchecked here.
            logPrefix: `[http:${forLog(sessionKey)}] `,
            abortSignal: abort.signal,
            ...(named ? { resume: deps.resumeMaxChars === undefined ? {} : { maxChars: deps.resumeMaxChars } } : {}),
            ...(opening ? { opening: true as const } : {}),
            ...(resuming ? { resumeAfterConfirm: true as const } : {}),
            ...(hint === undefined ? {} : { languageHint: hint }),
            ...(zone === undefined ? {} : { timeZoneHint: zone }),
          },
          sink,
        );
      } catch (err) {
        // A client-initiated cancellation is a clean stop, not a failure —
        // don't surface it as an `error` event (and there's no client left).
        if (!abort.signal.aborted) {
          send("error", { message: err instanceof Error ? err.message : String(err) });
        }
      }
      close();
    },
    // Fires when the client disconnects (closes the EventSource / aborts the
    // fetch): abort the in-flight turn so generation stops promptly.
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, ...cors, ...language } });
}

export type ConfirmRequestDeps = {
  authenticate: Authenticate;
  admit?: AdmitFn;
  resolveConfirmation: ResolveConfirmationFn;
  corsOrigin?: string;
  /** The texts in the caller's language, injected by the core: what `Content-Language` says. */
  i18n?: ChannelI18n;
};

/**
 * `POST /confirm { token, conversationId }` — the explicit confirmation
 * endpoint. A nicer contract for a UI than re-POSTing the bare token as `text`
 * to `/turn`, but the exact same mechanism underneath: it authenticates the
 * caller and resolves the token through the injected `resolveConfirmation`,
 * keyed on the caller's own session (`<principal.id>:<conversationId>`), so a
 * token staged in someone else's conversation is never found. `resolved: true` means the token matched a
 * pending confirmation and its staged action was consumed and run; the `text`
 * (the core's, in the caller's language) then reports whether that execution
 * succeeded. `resolved: false` means the
 * token was not a pending confirmation (unknown, expired, already used, or not
 * even token-shaped). `resume: true` (with no `text`) means the action handed
 * its result back to the model: the client hears its answer by opening
 * `/turn { resume: true, conversationId }`. Never touches the model.
 */
export async function handleConfirmRequest(req: Request, deps: ConfirmRequestDeps): Promise<Response> {
  const origin = deps.corsOrigin ?? "*";
  const cors = corsHeaders(origin);
  const principal = await caller(req, deps, origin);
  if (principal instanceof Response) return principal;
  let body: { token?: unknown; conversationId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "body must be JSON" }, { status: 400, headers: cors });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  if (token.length === 0 || conversationId.length === 0) {
    return Response.json({ ok: false, error: "missing token or conversationId" }, { status: 400, headers: cors });
  }
  if (!CONVERSATION_ID.test(conversationId)) {
    return Response.json({ ok: false, error: "invalid conversationId" }, { status: 400, headers: cors });
  }
  const hint = languageHint(req);
  const headers = { ...cors, ...(await contentLanguage(deps.i18n, principal, hint)) };
  const outcome = await deps.resolveConfirmation(token, `${principal.id}:${conversationId}`, principal, hint);
  switch (outcome.status) {
    case "not-a-token":
    case "not-found":
      return Response.json({ ok: true, resolved: false }, { headers });
    case "ok":
    case "failed":
      return Response.json({ ok: true, resolved: true, text: outcome.text }, { headers });
    case "resume":
      // The result went back to the model: the client opens `/turn { resume: true }` to hear its answer.
      return Response.json({ ok: true, resolved: true, resume: true }, { headers });
  }
}

export type LinkRequestDeps = {
  authenticate: Authenticate;
  admit?: AdmitFn;
  /** Hands the caller a link code, injected by the core (`ctx.linking.start`). */
  start: ChannelLinking["start"];
  corsOrigin?: string;
};

/**
 * `POST /link` — a one-time code for linking another account to the caller
 * (the custom UI shows it). The person then sends it from the other account,
 * on any channel. Nobody but the caller ever sees it, the model included, and
 * it isn't cached. `400` with the core's reason when there's no code for them.
 */
export async function handleLinkRequest(req: Request, deps: LinkRequestDeps): Promise<Response> {
  const origin = deps.corsOrigin ?? "*";
  const principal = await caller(req, deps, origin);
  if (principal instanceof Response) return principal;
  const started = await deps.start(principal);
  return Response.json(started, { status: started.ok ? 200 : 400, headers: { ...corsHeaders(origin), "cache-control": "no-store" } });
}

/** `POST /link` and its preflight, mounted when the core offers linking. */
function linkRoutes(deps: LinkRequestDeps): Record<string, { POST: (req: Request) => Promise<Response>; OPTIONS: () => Response }> {
  return { "/link": { POST: (req) => handleLinkRequest(req, deps), OPTIONS: () => preflight(deps.corsOrigin ?? "*") } };
}

/** Finishes a person's login, injected by the core (`ChannelLogins.complete`). */
export type CompleteLoginFn = (state: string, code: string) => Promise<LoginOutcome>;

/** A plain-text page for the person's browser, at the end of their login. */
function loginPage(text: string, status: number, language: Record<string, string> = {}): Response {
  // The URL carried the code and the state: neither kept nor passed on.
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", ...language },
  });
}

/**
 * `GET /login/callback`: where the provider sends a person back after they log
 * in, with `code` and `state` (or `error`, when they refused). Public: the
 * person's browser carries no token here, and the single-use `state` the core
 * issued for them is what ties the request to their login. Answers with a
 * plain page telling them how it went, naming the assistant as the app does
 * (`Mercury` from an older core that doesn't say).
 */
export async function handleLoginCallback(
  req: Request,
  deps: { complete: CompleteLoginFn; assistantName?: string; i18n?: ChannelI18n },
): Promise<Response> {
  const assistant = deps.assistantName ?? "Mercury";
  // Nobody is known on this page: the browser's language, then the default.
  const texts = deps.i18n ? await deps.i18n.forRequest(null, languageHint(req)) : undefined;
  const t = texts?.t ?? englishHttp;
  const language: Record<string, string> = texts ? { "content-language": texts.locale } : {};
  const params = new URL(req.url).searchParams;
  const error = params.get("error");
  if (error !== null) {
    const reason = error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
    return loginPage(t("http.login.denied", { reason, assistant }), 400, language);
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return loginPage(t("http.login.incomplete", { assistant }), 400, language);
  const outcome = await deps.complete(state, code);
  // A failed login's text is the core's, in the language of whoever started it: no header claims otherwise.
  return outcome.ok ? loginPage(t("http.login.done", { service: outcome.service }), 200, language) : loginPage(outcome.error, 400);
}

/** The login callback route, mounted when the server can complete logins. */
function loginRoutes(
  complete: CompleteLoginFn,
  assistantName: string | undefined,
  i18n: ChannelI18n | undefined,
): Record<string, { GET: (req: Request) => Promise<Response> }> {
  return {
    "/login/callback": {
      GET: (req) =>
        handleLoginCallback(req, {
          complete,
          ...(assistantName === undefined ? {} : { assistantName }),
          ...(i18n === undefined ? {} : { i18n }),
        }),
    },
  };
}

/** A single read route: its `GET` handler plus the shared `OPTIONS` preflight, and on `/me` the `PATCH` saving a setting. */
type ReadRoute = {
  GET: (req: Request) => Response | Promise<Response>;
  /** Only on `/me`, when the core offers the person's settings (`PATCH /me`). */
  PATCH?: (req: Request) => Promise<Response>;
  OPTIONS: () => Response;
};

/**
 * Builds the read-only routes, each carrying CORS headers on its `GET` and a
 * shared `OPTIONS` preflight so a browser UI on `corsOrigin` (default `*`) can
 * reach them. Every `GET` asks `authenticate` first and answers 401 without
 * calling its getter when nobody is calling; the preflight doesn't ask. The
 * caller's principal goes to every per-person getter, so the core answers with
 * their data only; a conversation is named by its conversationId, as on
 * `/turn`, and its session key is built from the caller.
 * `json` JSON-encodes with the CORS headers merged in; `badRequest` does the
 * same for a 400. With `settings`, `/me` also takes a `PATCH` saving the
 * caller's time zone (a UI's settings area), asking `authenticate` first too.
 */
export function readRoutes(
  reads: ChannelHostReads,
  authenticate: Authenticate,
  corsOrigin = "*",
  admit?: AdmitFn,
  settings?: ChannelSettings,
): Record<string, ReadRoute> {
  const cors = corsHeaders(corsOrigin);
  const json = (payload: object, status = 200): Response =>
    Response.json(payload, { status, headers: cors });
  const badRequest = (message: string): Response => json({ ok: false, error: message }, 400);
  const requireParam = (req: Request, name: string): string | null => new URL(req.url).searchParams.get(name);
  const options = () => preflight(corsOrigin);
  const route = (GET: (req: Request, principal: Principal) => Response | Promise<Response>): ReadRoute => ({
    GET: async (req) => {
      const principal = await caller(req, { authenticate, ...(admit === undefined ? {} : { admit }) }, corsOrigin);
      return principal instanceof Response ? principal : GET(req, principal);
    },
    OPTIONS: options,
  });
  return {
    "/manifest": route(async (_req, principal) => json({ ok: true, manifest: await reads.manifest(principal) })),
    "/confirmations": route(async (_req, principal) => json({ ok: true, pending: await reads.pendingConfirmations(principal) })),
    "/conversation": route(async (req, principal) => {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (!id) return badRequest("missing ?id");
      if (!CONVERSATION_ID.test(id)) return badRequest("invalid conversationId");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const offset = url.searchParams.get("offset") ?? undefined;
      return json({ ok: true, ...(await reads.conversation(principal, `${principal.id}:${id}`, limit, offset) as object) });
    }),
    "/conversations": route(async (req, principal) => {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
      const { conversations } = (await reads.conversations(principal, limit)) as {
        conversations: Array<{ sessionKey: string; lastTimestamp: string; preview: string }>;
      };
      const prefix = `${principal.id}:`;
      return json({
        ok: true,
        conversations: conversations
          .filter((c) => c.sessionKey.startsWith(prefix))
          .map((c) => ({ conversationId: c.sessionKey.slice(prefix.length), lastTimestamp: c.lastTimestamp, preview: c.preview })),
      });
    }),
    "/tool-log": route(async (_req, principal) => json({ ok: true, entries: await reads.toolLog(principal) })),
    // Who the caller is to the core, on a core that can say.
    ...(reads.me === undefined
      ? {}
      : {
          "/me": {
            ...route(async (_req, principal) => {
              // Null when the core no longer admits the caller: still a name, null.
              const me = (await reads.me!(principal)) as { name: string | null; language?: string | null; timeZone?: string | null } | null;
              // An older core says no language or time zone: the reply then has none either.
              return json({
                ok: true,
                name: me?.name ?? null,
                ...(me?.language === undefined ? {} : { language: me.language }),
                ...(me?.timeZone === undefined ? {} : { timeZone: me.timeZone }),
              });
            }),
            ...(settings === undefined
              ? {}
              : {
                  PATCH: async (req: Request) => {
                    const principal = await caller(req, { authenticate, ...(admit === undefined ? {} : { admit }) }, corsOrigin);
                    if (principal instanceof Response) return principal;
                    const body = (await req.json().catch(() => null)) as { timeZone?: unknown } | null;
                    if (typeof body?.timeZone !== "string") return badRequest('the body must be {"timeZone": "<IANA name>"}');
                    const saved = await settings.setTimeZone(principal, body.timeZone);
                    return saved.ok ? json({ ok: true, timeZone: saved.value }) : badRequest(saved.error);
                  },
                }),
          },
        }),
    "/health": route(async () => json({ ok: true, ...(await reads.health() as object) })),
    "/wiki/list": route(async (_req, principal) => json({ ok: true, files: await reads.wikiList(principal) })),
    "/wiki/read": route(async (req, principal) => {
      const path = requireParam(req, "path");
      if (!path) return badRequest("missing ?path");
      const content = await reads.wikiRead(principal, path);
      return content === null ? json({ ok: false, error: "not found" }, 404) : json({ ok: true, content });
    }),
    "/wiki/grep": route(async (req, principal) => {
      const pattern = requireParam(req, "pattern");
      if (!pattern) return badRequest("missing ?pattern");
      return json({ ok: true, matches: await reads.wikiGrep(principal, pattern) });
    }),
    "/memory/scroll": route(async (req, principal) => {
      const url = new URL(req.url);
      const collection = url.searchParams.get("collection");
      if (!collection) return badRequest("missing ?collection");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = url.searchParams.get("offset") ?? undefined;
      const page = await reads.memoryScroll(principal, collection, limit, offset);
      return page === null ? badRequest(`unknown collection: ${collection}`) : json({ ok: true, ...(page as object) });
    }),
  };
}

export type HttpServerDeps = TurnRequestDeps & {
  port: number;
  reads?: ChannelHostReads;
  /** The `/confirm` endpoint's structured resolver, injected by the core. */
  resolveConfirmation: ResolveConfirmationFn;
  /** Finishes people's logins; `/login/callback` is mounted only with it. */
  completeLogin?: CompleteLoginFn;
  /** Linking another account to the caller; `/link` is mounted only with it. */
  linking?: ChannelLinking;
  /** The person's own settings; `PATCH /me` is mounted only with it. */
  settings?: ChannelSettings;
  /** What the pages people read call the assistant. */
  assistantName?: string;
};

/** Starts the HTTP surface: `POST /turn` (4a) plus the read-only routes (4b)
 * when `reads` is supplied. */
export function startHttpServer(deps: HttpServerDeps): ReturnType<typeof Bun.serve> {
  const origin = deps.corsOrigin ?? "*";
  return Bun.serve({
    port: deps.port,
    // Bind all interfaces inside the container so a published port can reach it
    // (Bun defaults to loopback-only, unreachable through Docker's port proxy).
    // This is not "externally reachable": the container network still isolates
    // it — production simply does not publish the port (see docker-compose).
    hostname: "0.0.0.0",
    // Disable the idle timeout (Bun defaults to 10s): an SSE turn can go quiet
    // for longer than that between events — the model loading, a slow CLI
    // subprocess — and a timeout there would reset the stream mid-turn.
    idleTimeout: 0,
    routes: {
      "/turn": { POST: (req) => handleTurnRequest(req, deps), OPTIONS: () => preflight(origin) },
      "/confirm": {
        POST: (req) =>
          handleConfirmRequest(req, {
            authenticate: deps.authenticate,
            ...(deps.admit === undefined ? {} : { admit: deps.admit }),
            resolveConfirmation: deps.resolveConfirmation,
            corsOrigin: origin,
            ...(deps.i18n === undefined ? {} : { i18n: deps.i18n }),
          }),
        OPTIONS: () => preflight(origin),
      },
      "/openapi.yaml": { GET: () => openApiResponse(origin), OPTIONS: () => preflight(origin) },
      ...(deps.reads ? readRoutes(deps.reads, deps.authenticate, origin, deps.admit, deps.settings) : {}),
      ...(deps.completeLogin ? loginRoutes(deps.completeLogin, deps.assistantName, deps.i18n) : {}),
      ...(deps.linking ? linkRoutes({ ...deps, start: deps.linking.start, corsOrigin: origin }) : {}),
    },
    error: (err) =>
      Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers: corsHeaders(origin) },
      ),
  });
}
