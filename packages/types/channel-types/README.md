# @mercury-fw/channel-types

The contract a [Mercury](https://github.com/lucabro81/mercury-fw) channel implements: `ChannelPlugin`, `CHANNEL_API_VERSION`, the provider and sink a channel drives a turn through, the `Principal` it builds for whoever sent the message (only the core reads it, tools never see it), the confirmation helpers and read getters the core injects (both take the caller's `Principal`, so a token resolves only for whoever staged it and a read returns only the caller's data), and the auth-provider contract (`AuthPlugin`, `AUTH_API_VERSION`, `Authenticate`): an app declares one provider as `auth`, and a channel whose callers bring their own credentials gets it as `ctx.authenticate`. Channel authors get it through [`@mercury-fw/kit`](https://www.npmjs.com/package/@mercury-fw/kit).

MIT
