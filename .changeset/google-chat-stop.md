---
"@mercury-fw/channel-google-chat": minor
---

Stop an answer from Google Chat.

- Every card still in progress (the receiving card, a reasoning card, a tool's card) has a Stop button, in a section of its own so it's visible without expanding the card; the card's final state has none.
- `/stop` does the same: the registered slash command, or a message reading exactly `/stop`. With nothing running, the reply says there's nothing to stop.
- A stop aborts the person's running turn and discards the messages they queued behind it. No partial answer is sent; the card in progress says "Stopped." (or a short message does, when no card was in progress). A command a tool already ran stays done.
- Only the person who started the answer can stop it: in a shared space, someone else's stop doesn't touch it.
- New texts: `google-chat.status.stopped`, `google-chat.stop.button`, `google-chat.stop.nothing`.

Needs the framework at 0.58 or later; an older core stops the model too, but sends the half answer it had. To have Chat suggest `/stop`, and to let it reach the app in a space without a mention, add it in the Chat app's configuration (Cloud Console, Google Chat API → Configuration → Commands): type Slash command, name `/stop`, any free command id.
