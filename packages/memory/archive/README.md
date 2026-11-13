# @mercury-fw/archive

The archive of a [Mercury](https://github.com/lucabro81/mercury-fw) agent: every conversation kept word for word in the app's conversation store, so a chat interface shows it again when the person reopens it, and lists their conversations. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-archive-and-the-titles).

```ts
import { archive } from "@mercury-fw/archive";
import { qdrantConversations } from "@mercury-fw/store-qdrant";

export default defineMercuryConfig({
  plugins: [archive()],
  conversationStore: qdrantConversations(),
  // …
});
```

It needs the conversation store (`needs: ["conversationStore"]`): an app declaring it without one doesn't start, and says why. It takes no options and gives the model nothing: no tool, no text.

## What it keeps

Once each turn is over, the core hands every plugin a record of it (`onTurnRecord`), and the archive writes the messages it leaves (`archivedMessages`, in the plugin contract), one by one, each in the store's shape (`StoredMessage`) under an id of its own:

- a turn the person wrote: their message, timestamped when the turn started running, and the answer, timestamped when the turn ended, with the lists they were shown, the tool calls it was written from and what they saw of the turn besides the text (the reasoning, the tools' status lines, the confirmations, the logins);
- a turn the agent opened, or one going on after a confirmation: the answer only;
- a turn the person stopped: their message and the answer marked `interrupted`, only when the conversation kept one; a turn that failed: nothing;
- a resolved confirmation: the reply the person got and how it went.

A message with no words and nothing shown is left out, and nothing of the operator's (the terminal, `mfw repl`) is kept. A store that rejects a write fails the hook: the core logs it, records a failed `plugin.hook` event, and the person's turn is untouched.
