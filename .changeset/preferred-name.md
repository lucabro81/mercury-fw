---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-http": minor
---

- The assistant remembers how each person wants to be called: they say it in conversation and the model saves it with the new `set_preferred_name` tool. It's a setting kept in `.mercury/profiles.json` on the vault's volume, not a wiki note, and every one-to-one turn tells the model the name.
- A turn can be an opening (`opening: true`, with no text): the assistant speaks first, but only to someone whose name it doesn't know, introducing itself and asking how to call them. For anyone else, and in a shared space, it says nothing and keeps nothing.
- `ChannelHostReads.me` says how the caller asked to be called, or `null`.
- HTTP: `POST /turn` takes `{ opening: true, conversationId }`, and `GET /me` answers `{ name }`. A UI asks for an opening right after a sign-in, when the name is `null`. The channel now needs channel-types 0.49.0 or later.
