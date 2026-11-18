/**
 * The __TITLE__ channel: people talk to the agent with an HTTP request,
 * `POST /message` with `{ "text": "…", "conversation": "…" }` and their
 * credentials (whatever the instance's auth provider takes), and get the
 * answer back as JSON. Written by `mfw plugin create` as a starting point for
 * a channel of its own: a chat platform's webhook goes where `handleMessage`
 * reads the request. What every channel does is all here:
 * - who is talking (`authenticate`), and whether the agent talks to them (`admit`);
 * - a confirmation token runs the staged action, never the model (`confirm`);
 * - the turn itself (`handleTurn`), with a sink collecting what it says;
 * - the person's language for the channel's own texts (`i18n`).
 */
import {
  detectPendingConfirmation,
  type ChannelPlugin,
  type ChannelRuntimeContext,
  type HandleTurn,
  type PendingConfirmation,
  type Provider,
  type TurnSink,
} from "@mercury-fw/kit";
import { __CONSTANT___MESSAGES } from "./messages.ts";

/** What the channel needs of the core, from its runtime context. */
export type __PASCAL__Deps = Pick<ChannelRuntimeContext, "admit" | "confirm" | "i18n"> & {
  authenticate: NonNullable<ChannelRuntimeContext["authenticate"]>;
};

/** A JSON response. */
function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** Answers one request: the turn's answer, or why there's none. */
export async function handleMessage(req: Request, deps: __PASCAL__Deps, handleTurn: HandleTurn): Promise<Response> {
  if (req.method !== "POST" || new URL(req.url).pathname !== "/message") return json(404, { error: "not found" });
  const principal = await deps.authenticate(req).catch(() => null);
  const { t } = await deps.i18n.forRequest(principal);
  if (principal === null) return json(401, { error: t("__NAME__.unauthorized") });
  const admission = await deps.admit(principal);
  if (!admission.ok) return json(403, { error: admission.message });

  const body = (await req.json().catch(() => undefined)) as { text?: unknown; conversation?: unknown } | undefined;
  if (typeof body?.text !== "string" || body.text.trim() === "") return json(400, { error: t("__NAME__.no-text") });
  const conversation = typeof body.conversation === "string" && body.conversation !== "" ? body.conversation : "main";
  const sessionKey = `__NAME__:${principal.id}:${conversation}`;

  // A confirmation token runs its staged action: deterministic, never up to the model.
  const reply = await deps.confirm(body.text, sessionKey, principal);
  if (reply !== null && !reply.resume) return json(200, { text: reply.text });
  // A confirmed action whose result goes back to the model: the turn runs again.
  const resuming = reply?.resume === true;

  let answer = "";
  let pending: PendingConfirmation | null = null;
  const sink: TurnSink = {
    onToolStart: () => {},
    onStep: (step) => {
      pending ??= detectPendingConfirmation(step);
    },
    finalize: async (text) => {
      answer = text;
    },
    dispose: () => {},
  };
  try {
    await handleTurn(
      {
        channel: "__NAME__",
        multiUser: false,
        text: resuming ? "" : body.text,
        sessionKey,
        principal,
        logPrefix: `[__NAME__:${conversation}] `,
        ...(resuming ? { resumeAfterConfirm: true as const } : {}),
      },
      sink,
    );
  } catch {
    return json(500, { error: t("__NAME__.failed") });
  }
  // A staged action: the person sends the token back as their next message to confirm it.
  const staged = pending as PendingConfirmation | null;
  return json(200, { text: answer, ...(staged === null ? {} : { confirm: { summary: staged.summary, token: staged.token } }) });
}

/** The channel's provider, serving on `port`. */
export function createProvider(port: number, deps: __PASCAL__Deps): Provider {
  let server: ReturnType<typeof Bun.serve> | undefined;
  return {
    async start(handleTurn) {
      server = Bun.serve({ port, fetch: (req) => handleMessage(req, deps, handleTurn) });
    },
    // Nothing reaches a person outside a request: a channel that can push
    // (a chat platform) sends `text` to `userId` here, in a session of theirs.
    async notify() {
      return { sessionKey: "" };
    },
    async stop() {
      await server?.stop();
    },
  };
}

/** The channel. Its port is `__CONSTANT___PORT` (4200 unless set). */
export function __EXPORT__(): ChannelPlugin {
  return {
    // The contract this channel is written for, as a literal: importing
    // CHANNEL_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    messages: __CONSTANT___MESSAGES,
    build: (ctx) => {
      // Without an auth provider nobody can say who they are: the channel
      // doesn't start, and the loader logs why.
      if (ctx.authenticate === undefined) throw new Error("__NAME__ needs an auth provider (auth in mercury.config.ts)");
      const port = Number(ctx.env.__CONSTANT___PORT ?? "4200");
      return createProvider(port, { authenticate: ctx.authenticate, admit: ctx.admit, confirm: ctx.confirm, i18n: ctx.i18n });
    },
  };
}
