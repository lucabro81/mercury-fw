/**
 * The HTTP channel's `Provider` — a thin wrapper that makes the HTTP surface a
 * first-class channel the composition root starts and stops. The conversational
 * mechanics (the `/turn` endpoint, SSE, the confirm interception) live in
 * `http-server.ts`; this file only satisfies the `Provider` contract around it.
 *
 * `start` launches the Bun.serve and resolves immediately — the server runs in
 * the background, so the composition root proceeds. `notify` is a no-op: HTTP is
 * request/response, with no persistent connection to push a proactive message to
 * (that stays with Google Chat). `stop` closes the socket on shutdown. Confirm is
 * injected (`confirm`/`resolveConfirmation`), so this package never imports the app.
 */
import { startHttpServer, type AdmitFn, type CompleteLoginFn, type ConfirmFn, type ResolveConfirmationFn } from "./http-server.ts";
import type { Authenticate, Provider, HandleTurn, ChannelHostReads, ChannelLinking } from "@mercury-fw/channel-types";

export type HttpProviderDeps = {
  port: number;
  /** Bare-token interception before the model. */
  confirm: ConfirmFn;
  /** Structured resolver for the `/confirm` endpoint's `resolved` flag. */
  resolveConfirmation: ResolveConfirmationFn;
  reads?: ChannelHostReads;
  /** Who is calling, from the app's auth provider. */
  authenticate: Authenticate;
  /** Whether the core talks to them, from the core. */
  admit?: AdmitFn;
  /** Allowed CORS origin echoed to a browser UI; defaults to `*` in the server. */
  corsOrigin?: string;
  /** People's logins, when the surface has a public URL to be sent back to:
   * the callback is offered (`accept`) once the server listens. */
  logins?: { callbackUrl: string; accept: (callbackUrl: string) => void; complete: CompleteLoginFn };
  /** Linking another account to the caller (`POST /link`). */
  linking?: ChannelLinking;
};

export function createHttpProvider(deps: HttpProviderDeps): Provider & { stop(): Promise<void> } {
  let server: ReturnType<typeof startHttpServer> | undefined;
  return {
    async start(handleTurn: HandleTurn): Promise<void> {
      server = startHttpServer({
        port: deps.port,
        handleTurn,
        confirm: deps.confirm,
        resolveConfirmation: deps.resolveConfirmation,
        reads: deps.reads,
        authenticate: deps.authenticate,
        ...(deps.admit === undefined ? {} : { admit: deps.admit }),
        corsOrigin: deps.corsOrigin,
        completeLogin: deps.logins?.complete,
        ...(deps.linking === undefined ? {} : { linking: deps.linking }),
      });
      deps.logins?.accept(deps.logins.callbackUrl);
    },
    async notify(): Promise<{ sessionKey: string }> {
      // No proactive push channel over HTTP (request/response only).
      return { sessionKey: "" };
    },
    async stop(): Promise<void> {
      server?.stop();
    },
  };
}
