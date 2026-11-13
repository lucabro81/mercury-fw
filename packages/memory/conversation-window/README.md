# @mercury-fw/conversation-window

Keeps each conversation of a [Mercury](https://github.com/lucabro81/mercury-fw) agent for the model: the recent messages it reads on every answer, a summary of the older ones once they grow too long, and a conversation the person reopens brought back from the archive. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-conversation).

```ts
import { conversationWindow } from "@mercury-fw/conversation-window";

const conversation = conversationWindow();

export default defineMercuryConfig({
  plugins: [conversation],
  context: { profiles: { default: { conversation, layers: [], budget: { maxChars: 8000 } } } },
  // …
});
```

A context profile names it as its `conversation`, the same object as in `plugins`. A profile that names none keeps no conversation, and the model reads each message alone.

| Option | |
|---|---|
| `maxChars` | How many characters of messages a window holds before it shortens what came before the person's last message, 60000 when left out. A whole number above 0; anything else stops the app at startup. |
| `overflow` | How it shortens: `"summarize"` (the default) has the turn's model write a summary of the older messages, which the person waits for; `"truncate"` drops the oldest ones until the window fits, at no cost. |
| `reopen` | `{ maxChars }`: how many characters of a reopened conversation come back when the channel sets no budget of its own, half of `maxChars` when left out, `0` for nothing. `false` never reads the archive, and then the plugin doesn't need the app's conversation store. |
| `earlier` | What reads the summaries of a reopened conversation's older part (`{ summariesOf({ person, sessionKey }) }`, oldest first): the long-term memory, `memory()` from `@mercury-fw/memory`, which writes them. Without it, a reopened conversation gets back its newest messages only. |

A conversation comes back only on a channel that reopens it (the HTTP surface), only for a person someone vouched for, and only from the conversation store (`needs: ["conversationStore"]`, unless `reopen` is `false`): its newest messages word for word, within the budget, the person's ones stamped with when they were written in the turn's time zone, as the model read them live. None of it is captured again by the memory. An archive that can't be read leaves the conversation to start empty, with a line in the log. An app that declares no conversation store doesn't start with the default options (use `reopen: false`), and a store that couldn't start at all leaves the plugin out: the model then reads each message alone.

Each time the window shortens, it tells Mercury how (`CompressionReport`), and the traces record it as `history.compressed`. A summary that fails leaves the window as it was and the turn goes on; the next message tries again.

It also gives the model `recall_tool_calls`: the calls it made earlier in this conversation and what they returned, newest first, from the core's log of the recent tool calls (`ctx.toolLog`, the person's and this conversation's only). The window keeps of each call only what it ran and how it went, so this is how the model quotes a result instead of guessing it. The tool's status line is under the `conversation-window.status.recall` key.
