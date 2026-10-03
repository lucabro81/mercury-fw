# @mercury-fw/channel-types

The contract a [Mercury](https://github.com/lucabro81/mercury-fw) channel implements: `ChannelPlugin`, `CHANNEL_API_VERSION`, the provider and sink a channel drives a turn through, the `Principal` it builds for whoever sent the message (only the core reads it, tools never see it), and the confirmation helpers the core injects. Channel authors get it through [`@mercury-fw/kit`](https://www.npmjs.com/package/@mercury-fw/kit).

MIT
