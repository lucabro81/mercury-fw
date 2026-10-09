/**
 * The Google Chat channel plugin: the `ChannelPlugin` the core's channel loader
 * consumes. `build()` reads this channel's own config from `ctx.env` and
 * constructs the provider; it returns `undefined` when no
 * `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` is set (the instance isn't running Google
 * Chat — present but inert). A subscription set with the app credentials
 * missing is a misconfiguration: `build()` throws and the loader skips this
 * channel fail-soft, leaving the rest of Mercury up.
 */
import type { ChannelPlugin, ChannelRuntimeContext } from "@mercury-fw/channel-types";
import { createGoogleChatProvider } from "./google-chat-provider.ts";

/** Reads a required env var, failing loudly (caught by the channel loader) instead of silently degrading. */
function require(env: ChannelRuntimeContext["env"], name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export const googleChatChannel: ChannelPlugin = {
  // The contract this channel is written for, as a literal: importing
  // CHANNEL_API_VERSION would report whichever contract is installed.
  apiVersion: 5,
  name: "google-chat",
  build: (ctx) => {
    // No subscription configured ⇒ this instance simply doesn't run Google Chat.
    const subscription = ctx.env.GOOGLE_CHAT_PUBSUB_SUBSCRIPTION;
    if (!subscription) {
      return undefined;
    }
    return createGoogleChatProvider({
      credentials: {
        clientEmail: require(ctx.env, "GOOGLE_CHAT_APP_CLIENT_EMAIL"),
        // A PEM key is multi-line; stored in a single-line env var with literal
        // "\n" escapes — unescape before Node's crypto, which needs real newlines.
        privateKey: require(ctx.env, "GOOGLE_CHAT_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
      },
      subscription,
      confirm: ctx.confirm,
      log: ctx.log,
    });
  },
};
