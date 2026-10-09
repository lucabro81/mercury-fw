---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/cli": minor
---

One person across accounts: linking them by a code.

- `POST /link` on the HTTP surface hands the caller a one-time code (`xxxx-xxxx-xxxx`, ten minutes, single use). They send it from the other account, on any channel, twice. The first time Mercury says whom the account would be linked to, the second time it links it.
- From then on the account is the person it's linked to: one private area, one memory, the same roles. Its earlier area stays where it was, and undoing the link gives it back.
- A link never touches the terminal, never chains, and is refused for an account the directory already knows as someone else.
- The links live on the vault's volume, out of the vault's git and out of reach of the model and the HTTP reads.
- `mfw identity links | link | unlink` lets the operator manage them, for instances where nobody can be shown a code.
- Channels get the code through the confirmation hook they already call (`ctx.confirm`), and the HTTP surface gets `ctx.linking`.
- Fixed: `ctx.confirm` refused someone the core doesn't admit before checking that their text was a token at all. On Google Chat, every message from an unknown sender came back as the refusal.
