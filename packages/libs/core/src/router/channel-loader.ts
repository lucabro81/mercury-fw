/**
 * Loads the hand-listed channel plugins into the providers the composition root
 * starts — the channel-side mirror of `plugins/plugin-loader.ts`. It knows
 * nothing about any specific channel: the composition root names them, this
 * loop builds them identically.
 *
 * A channel is active when it's declared in `mercury.config.ts`'s `channels`
 * (there is no separate env gate): declared = active. Each channel self-gates on
 * its real config via `build()` returning `undefined` (Google Chat with no
 * subscription; HTTP always builds).
 *
 * Fail-soft, same guarantees as the tool-plugin loader:
 *  - an `apiVersion` mismatch, or texts outside the channel's name (see
 *    `catalogErrors`), are refused before `build()` runs;
 *  - a `build()` that throws degrades as a single unit (logged, skipped) while
 *    every other channel and the process carry on;
 *  - a `build()` that returns `undefined` means "present but inert" (the
 *    instance isn't configured for it) — not started, not an error.
 */
import { CHANNEL_API_VERSION, type ChannelPlugin, type ChannelRuntimeContext, type Provider } from "@mercury-fw/channel-types";
import { catalogErrors, type Messages } from "../i18n/i18n.ts";

/** Whether the loader would build `channel`: its contract is this core's and its texts are its own. */
function loadable(channel: ChannelPlugin): boolean {
  return channel.apiVersion === CHANNEL_API_VERSION && catalogErrors(channel.name, channel.messages ?? {}).length === 0;
}

/** The English texts of the channels in `channels` the loader would load, merged: the instance's languages translate those. */
export function channelMessages(channels: ChannelPlugin[]): Messages {
  return Object.assign({}, ...channels.filter(loadable).map((c) => c.messages ?? {})) as Messages;
}

/** Everything the loader needs from the composition root: the runtime context every `build()` gets. */
export type LoadChannelsContext = {
  runtime: ChannelRuntimeContext;
};

/** One built channel, kept with its plugin name so the composition root can start it and look it up (e.g. the cron `Notifier`). */
export type LoadedChannel = { name: string; provider: Provider };

/** Builds every declared channel in `channels`, returning the providers that actually constructed (skipping incompatible, inert, or failed ones). */
export function loadChannels(channels: ChannelPlugin[], ctx: LoadChannelsContext): LoadedChannel[] {
  const loaded: LoadedChannel[] = [];

  for (const channel of channels) {
    if (channel.apiVersion !== CHANNEL_API_VERSION) {
      ctx.runtime.log(
        `channel "${channel.name}" not activated: apiVersion ${channel.apiVersion} ` +
          `incompatible with this core (supports ${CHANNEL_API_VERSION})`,
      );
      continue;
    }
    // A channel's texts are its own, as a plugin's are (see `catalogErrors`).
    const textErrors = catalogErrors(channel.name, channel.messages ?? {});
    if (textErrors.length > 0) {
      ctx.runtime.log(`channel "${channel.name}" not activated: ${textErrors.join("; ")}`);
      continue;
    }
    try {
      const provider = channel.build(ctx.runtime);
      // undefined = present but inert (this instance isn't configured for it).
      if (provider === undefined) {
        continue;
      }
      loaded.push({ name: channel.name, provider });
    } catch (err) {
      ctx.runtime.log(
        `channel "${channel.name}" failed to load, skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return loaded;
}
