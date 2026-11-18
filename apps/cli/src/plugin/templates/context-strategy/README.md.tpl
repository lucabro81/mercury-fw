# __PACKAGE__

The __TITLE__ context strategy: the conversation a context profile keeps, and so everything the model reads of it. `mfw plugin create` wrote it as a starting point: it keeps the latest exchanges within a size, in memory.

## Contents

- [Declaring it](#declaring-it)
- [What a strategy decides](#what-a-strategy-decides)
- [Testing](#testing)

## Declaring it

A strategy is a context profile's `conversation`, in place of the one there (`conversationWindow` in a new app). In `mercury.config.ts`:

```ts
import { __EXPORT__ } from "__PACKAGE__";

const conversation = __EXPORT__({ maxChars: 40_000 });
```

The profile names `conversation` already, and `plugins` lists it: the strategy takes its place in both.

## What a strategy decides

- The messages the model reads (`getMessages`) and what happens as a turn adds to them (`addUserMessage`, `addAssistantMessage`): here, the oldest exchanges go past `maxChars` (`window.ts`), and the core records the report in the traces.
- `toolOutput`: what the model reads of a tool's output inside the turn.
- `pastCall`: what it reads of a past call on later turns.
- `turnIndex`: what goes in front of the person's message at each turn.
- `placeLayers`: the session layers' blocks in the system prompt.

The last four are written to change nothing. A reopened conversation starts empty: `@mercury-fw/conversation-window` exports what it uses to bring back what the conversation store kept (`resumeConversation`, `readTail`), and `@mercury-fw/context-files` is a strategy built on them.

## Testing

`bun test` in this folder, or `bun run test` in the app's. To compare it with another strategy on the same conversations, run the app's e2e tests (`mfw e2e`) under each.
