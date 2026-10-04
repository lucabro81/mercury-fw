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
 * Every route but the OpenAPI document and the CORS preflights asks the
 * injected `authenticate` (the auth provider the app declares) who is calling
 * before anything runs, and answers 401 when nobody is. A conversation belongs
 * to whoever opened it: the session key is `<principal.id>:<conversationId>`.
 * Confirm resolution is injected too (`confirm`/`resolveConfirmation`), so this
 * package never imports the app.
 */
import {
  detectPendingConfirmation,
  PENDING_CONFIRMATION_NOTE,
  type HandleTurn,
  type TurnSink,
  type Authenticate,
  type ChannelHostReads,
  type ConfirmOutcome,
} from "@mercury-fw/channel-types";

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

/** Resolves a bare confirmation token to a reply string, or `null` if the input isn't a token. Injected by the core (`ctx.confirm`). */
export type ConfirmFn = (token: string, sessionKey: string, userId: string) => Promise<string | null>;
/** The structured sibling of {@link ConfirmFn}, for the `/confirm` `resolved` flag. Injected by the core (`ctx.resolveConfirmation`). */
export type ResolveConfirmationFn = (token: string, sessionKey: string, userId: string) => Promise<ConfirmOutcome>;

export type TurnRequestDeps = {
  handleTurn: HandleTurn;
  /** Who is calling, injected from the app's auth provider; `null` = refused. */
  authenticate: Authenticate;
  /** Bare-token interception before the model, injected by the core. */
  confirm: ConfirmFn;
  /** Allowed CORS origin echoed back to a browser UI; defaults to `*`. */
  corsOrigin?: string;
  /** Test seam for the ephemeral session key when the client sends no conversationId. */
  newSessionKey?: () => string;
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

/** 401 for a caller the auth provider refused, with the Bearer challenge and CORS headers (so a browser UI can read it). */
function unauthorized(origin: string): Response {
  return Response.json(
    { ok: false, error: "unauthorized" },
    { status: 401, headers: { ...corsHeaders(origin), "www-authenticate": "Bearer" } },
  );
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
 */
export async function handleTurnRequest(req: Request, deps: TurnRequestDeps): Promise<Response> {
  const origin = deps.corsOrigin ?? "*";
  const cors = corsHeaders(origin);
  const principal = await deps.authenticate(req);
  if (principal === null) return unauthorized(origin);
  let body: { text?: unknown; conversationId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "body must be JSON" }, { status: 400, headers: cors });
  }
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return Response.json({ ok: false, error: "missing text" }, { status: 400, headers: cors });
  }
  const text = body.text;
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.trim().length > 0
      ? body.conversationId.trim()
      : (deps.newSessionKey ?? (() => crypto.randomUUID()))();
  if (!CONVERSATION_ID.test(conversationId)) {
    return Response.json({ ok: false, error: "invalid conversationId" }, { status: 400, headers: cors });
  }
  const sessionKey = `${principal.id}:${conversationId}`;

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
      const confirmReply = await deps.confirm(text, sessionKey, principal.id);
      if (confirmReply !== null) {
        send("final", { text: confirmReply });
        close();
        return;
      }

      const sink: TurnSink = {
        onToolStart: (label, detail, toolCallId, toolName) => send("tool", { label, detail, toolCallId, name: toolName }),
        onToolFinish: (toolCallId, outcome) => send("tool_finish", { toolCallId, outcome }),
        onTextChunk: (chunk) => {
          if (chunk !== PENDING_CONFIRMATION_NOTE) send("text", { chunk });
        },
        onReasoningChunk: (chunk, id) => send("reasoning", { chunk, id }),
        onReasoningEnd: (id, failed) => send("reasoning_end", { id, failed }),
        onStep: (step) => {
          const pending = detectPendingConfirmation(step);
          if (pending) send("pending", { command: pending.summary, token: pending.token });
        },
        onUsage: () => {},
        finalize: async (finalText) => send("final", { text: finalText }),
        dispose: () => {},
      };

      try {
        await deps.handleTurn(
          {
            channel: "http",
            multiUser: false,
            text,
            sessionKey,
            principal,
            // The caller's id comes from the auth provider, unchecked here.
            logPrefix: `[http:${forLog(sessionKey)}] `,
            abortSignal: abort.signal,
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

  return new Response(stream, { headers: { ...SSE_HEADERS, ...cors } });
}

export type ConfirmRequestDeps = {
  authenticate: Authenticate;
  resolveConfirmation: ResolveConfirmationFn;
  corsOrigin?: string;
};

/**
 * `POST /confirm { token, conversationId }` — the explicit confirmation
 * endpoint. A nicer contract for a UI than re-POSTing the bare token as `text`
 * to `/turn`, but the exact same mechanism underneath: it authenticates the
 * caller and resolves the token through the injected `resolveConfirmation`,
 * keyed on the caller's own session (`<principal.id>:<conversationId>`), so a
 * token staged in someone else's conversation is never found. `resolved: true` means the token matched a
 * pending confirmation and its staged action was consumed and run; the `text`
 * then reports whether that execution succeeded. `resolved: false` means the
 * token was not a pending confirmation (unknown, expired, already used, or not
 * even token-shaped). Never touches the model.
 */
export async function handleConfirmRequest(req: Request, deps: ConfirmRequestDeps): Promise<Response> {
  const origin = deps.corsOrigin ?? "*";
  const cors = corsHeaders(origin);
  const principal = await deps.authenticate(req);
  if (principal === null) return unauthorized(origin);
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
  const outcome = await deps.resolveConfirmation(token, `${principal.id}:${conversationId}`, principal.id);
  switch (outcome.status) {
    case "not-a-token":
    case "not-found":
      return Response.json({ ok: true, resolved: false }, { headers: cors });
    case "ok":
      return Response.json({ ok: true, resolved: true, text: `Confermato ed eseguito: ${JSON.stringify(outcome.data)}` }, { headers: cors });
    case "failed":
      return Response.json({ ok: true, resolved: true, text: `Confermato, ma l'esecuzione è fallita: ${outcome.error}` }, { headers: cors });
  }
}

/** A single read route: its `GET` handler plus the shared `OPTIONS` preflight. */
type ReadRoute = {
  GET: (req: Request) => Response | Promise<Response>;
  OPTIONS: () => Response;
};

/**
 * Builds the read-only routes, each carrying CORS headers on its `GET` and a
 * shared `OPTIONS` preflight so a browser UI on `corsOrigin` (default `*`) can
 * reach them. Every `GET` asks `authenticate` first and answers 401 without
 * calling its getter when nobody is calling; the preflight doesn't ask.
 * `json` JSON-encodes with the CORS headers merged in; `badRequest` does the
 * same for a 400.
 */
export function readRoutes(reads: ChannelHostReads, authenticate: Authenticate, corsOrigin = "*"): Record<string, ReadRoute> {
  const cors = corsHeaders(corsOrigin);
  const json = (payload: object, status = 200): Response =>
    Response.json(payload, { status, headers: cors });
  const badRequest = (message: string): Response => json({ ok: false, error: message }, 400);
  const requireParam = (req: Request, name: string): string | null => new URL(req.url).searchParams.get(name);
  const options = () => preflight(corsOrigin);
  const route = (GET: ReadRoute["GET"]): ReadRoute => ({
    GET: async (req) => ((await authenticate(req)) === null ? unauthorized(corsOrigin) : GET(req)),
    OPTIONS: options,
  });
  return {
    "/manifest": route(() => json({ ok: true, manifest: reads.manifest() })),
    "/confirmations": route(() => json({ ok: true, pending: reads.pendingConfirmations() })),
    "/conversation": route(async (req) => {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (!id) return badRequest("missing ?id");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const offset = url.searchParams.get("offset") ?? undefined;
      return json({ ok: true, ...(await reads.conversation(id, limit, offset) as object) });
    }),
    "/conversations": route(async (req) => {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
      return json({ ok: true, ...(await reads.conversations(limit) as object) });
    }),
    "/tool-log": route(() => json({ ok: true, entries: reads.toolLog() })),
    "/health": route(async () => json({ ok: true, ...(await reads.health() as object) })),
    "/wiki/list": route(async () => json({ ok: true, files: await reads.wikiList() })),
    "/wiki/read": route(async (req) => {
      const path = requireParam(req, "path");
      if (!path) return badRequest("missing ?path");
      return json({ ok: true, content: await reads.wikiRead(path) });
    }),
    "/wiki/grep": route(async (req) => {
      const pattern = requireParam(req, "pattern");
      if (!pattern) return badRequest("missing ?pattern");
      return json({ ok: true, matches: await reads.wikiGrep(pattern) });
    }),
    "/memory/scroll": route(async (req) => {
      const url = new URL(req.url);
      const collection = url.searchParams.get("collection");
      if (!collection) return badRequest("missing ?collection");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = url.searchParams.get("offset") ?? undefined;
      return json({ ok: true, ...(await reads.memoryScroll(collection, limit, offset) as object) });
    }),
  };
}

export type HttpServerDeps = TurnRequestDeps & {
  port: number;
  reads?: ChannelHostReads;
  /** The `/confirm` endpoint's structured resolver, injected by the core. */
  resolveConfirmation: ResolveConfirmationFn;
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
          handleConfirmRequest(req, { authenticate: deps.authenticate, resolveConfirmation: deps.resolveConfirmation, corsOrigin: origin }),
        OPTIONS: () => preflight(origin),
      },
      "/openapi.yaml": { GET: () => openApiResponse(origin), OPTIONS: () => preflight(origin) },
      ...(deps.reads ? readRoutes(deps.reads, deps.authenticate, origin) : {}),
    },
    error: (err) =>
      Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers: corsHeaders(origin) },
      ),
  });
}
