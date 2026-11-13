# @mercury-fw/corrections

What a [Mercury](https://github.com/lucabro81/mercury-fw) agent learns about using a tool: when a command fails and a later one for the same tool works in the same turn, the rule behind the fix, written down in the wiki for everyone. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-long-term-memory).

```ts
import { corrections } from "@mercury-fw/corrections";
import { wiki } from "@mercury-fw/wiki";

const teamWiki = wiki();

export default defineMercuryConfig({
  plugins: [teamWiki, corrections({ wiki: teamWiki })],
  vectorIndex: qdrantIndex(),
  models: { turn: main, embedding: ollamaEmbedding("nomic-embed-text") },
  // …
});
```

It needs the vector index and the embedding model (`needs: ["vectorIndex", "embedding"]`): an app declaring it without them doesn't start, and says why. `wiki` is the wiki the rules are written to (`wiki()`, declared in `plugins` too).

After each turn (`afterTurn`), it looks at the turn's tool calls: a call carrying a `command` that failed, followed by one for the same binary (the command's first word) that worked. With none, nothing happens and no model is called. With one, as work nobody waits on (`corrections:correction` in the traces), the background model describes the correction as a topic (the flag or subcommand it's about, without the tool's name) and a one-sentence rule, or nothing when the second command wasn't a fix of the first. Each correction is kept in the vector index's `tool_corrections` space, and the wiki promotes the rule with most support among the last occurrences of that topic to `curated/standards/<tool>-<topic>.md`. The log says what the wiki decided; a correction the wiki couldn't take stays in the index.
