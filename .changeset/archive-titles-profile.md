---
"@mercury-fw/archive": minor
"@mercury-fw/titles": minor
"@mercury-fw/profile": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/core": minor
"@mercury-fw/kit": patch
"@mercury-fw/cli": minor
"@mercury-fw/channel-http": patch
---

- new `@mercury-fw/archive`: `archive()`, every conversation word for word in the conversation store, from each turn's and resolved confirmation's record, never the operator's; `needs: ["conversationStore"]`; in the framework's fixed group
- new `@mercury-fw/titles`: `titles()`, each conversation's generated title after the first turn the person wrote, as the `titles:title` job on the background model, never replacing the person's; `needs: ["conversationStore"]`; in the framework's fixed group
- new `@mercury-fw/profile`: `profile()`, the tools `set_preferred_name`, `set_time_zone`, `set_preferred_language` and the system prompt's lines on the name, on `ctx.profiles`; in the framework's fixed group
- plugin contract: `onTurnRecord(record)`, every turn the model ran (`outcome` `"done"`, `"cancelled"`, `"failed"`) and every resolved confirmation, as a `TurnRecord` (`TurnRecordOfTurn`, `TurnRecordOfConfirmation`)
- plugin contract: `archivedMessages(record)`, the messages an archive keeps of a record, in the `StoredMessage` shape
- `plugin.hook` events for `onTurnRecord`
- a conversation store declared with no plugin needing it is a line in the log at startup
- an opening turn tells the model to save the person's name only when it has `set_preferred_name`
- the person's archived message is timestamped when its turn started running, the answer when the turn ended
- **Breaking:** the core no longer writes the archive, titles conversations or offers `set_preferred_name`, `set_time_zone`, `set_preferred_language`: declare `archive()`, `titles()`, `profile()`
- **Breaking:** no `title` event in the traces: a title is the `titles:title` `background.job`; an archive write that fails is a failed `plugin.hook`, no `system.error` with area `archive`
- `mfw create` declares `archive()`, `titles()`, `profile()` in `plugins`
- **Migration:** `bun add @mercury-fw/archive @mercury-fw/titles @mercury-fw/profile`, then in `mercury.config.ts` add `import { archive } from "@mercury-fw/archive";`, `import { titles } from "@mercury-fw/titles";`, `import { profile } from "@mercury-fw/profile";` and `archive(), titles(), profile()` to `plugins`
