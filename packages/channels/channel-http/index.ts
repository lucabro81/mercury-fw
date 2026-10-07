/**
 * The HTTP channel plugin: an opt-in conversational HTTP surface (SSE `/turn`,
 * `/confirm`, read-only introspection routes, the OpenAPI doc) that a custom UI
 * calls. Exported as a `ChannelPlugin` the core's channel loader consumes; it
 * does not import the app. Enabled by listing it in `mercury.config.ts` — there
 * is no runtime inert condition (unlike Google Chat's subscription): if it's
 * declared, it starts.
 *
 * `build` reads its port and CORS origin from `env` and takes the confirm
 * capabilities, the in-process reads and the app's auth provider from the
 * injected context (dependency inversion). Those are optional on the contract
 * but required here, so a context missing them throws — the loader isolates it
 * fail-soft, and without an auth provider the surface never opens.
 */
import type { ChannelPlugin } from "@mercury-fw/channel-types";
import { createHttpProvider } from "./http-provider.ts";

export { createHttpProvider, type HttpProviderDeps } from "./http-provider.ts";

export const httpChannel: ChannelPlugin = {
  // The contract this channel is written for, as a literal: importing
  // CHANNEL_API_VERSION would report whichever contract is installed.
  apiVersion: 4,
  name: "http",
  build: (ctx) => {
    if (!ctx.resolveConfirmation || !ctx.reads) {
      throw new Error("http channel requires the resolveConfirmation and reads capabilities on the runtime context");
    }
    if (!ctx.authenticate) {
      throw new Error("http channel requires an auth provider (auth in mercury.config.ts)");
    }
    return createHttpProvider({
      port: Number(ctx.env.HTTP_SURFACE_PORT ?? "4100"),
      corsOrigin: ctx.env.HTTP_SURFACE_CORS_ORIGIN ?? "*",
      confirm: ctx.confirm,
      resolveConfirmation: ctx.resolveConfirmation,
      reads: ctx.reads,
      authenticate: ctx.authenticate,
    });
  },
};
