# @mercury-fw/titles

The titles of a [Mercury](https://github.com/lucabro81/mercury-fw) agent's conversations: after the first turn the person writes in a conversation, the model names it from that message and its answer, so a chat interface lists their conversations by name. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-archive-and-the-titles).

```ts
import { titles } from "@mercury-fw/titles";
import { qdrantConversations } from "@mercury-fw/store-qdrant";

export default defineMercuryConfig({
  plugins: [titles()],
  conversationStore: qdrantConversations(),
  // …
});
```

It needs the conversation store (`needs: ["conversationStore"]`), where the titles are kept next to the conversations: an app declaring it without one doesn't start, and says why. It takes no options and gives the model nothing: no tool, no text.

After each turn the person wrote (`afterTurn`; not one the agent opened, nor the operator's in the terminal), a conversation with no title yet gets one: the background model (the app's `background` model, or its turn model) writes a few words in the person's language, as work nobody waits on (`ctx.job`, `titles:title` in the traces). The title is cut to 100 characters on one line. A title the person chose (a channel's rename, `PATCH /conversation` over HTTP) is never replaced, not even one chosen while the model was writing. A model that can't be reached leaves the conversation without a title, with a line in the log, and the next turn tries again.
