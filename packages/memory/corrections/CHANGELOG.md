# @mercury-fw/corrections

## 0.76.0

### Patch Changes

- Updated dependencies [6534831]
  - @mercury-fw/plugin-types@0.76.0
  - @mercury-fw/wiki@0.76.0

## 0.75.0

### Minor Changes

- bcabfa1: - new `@mercury-fw/memory`: `memory({ wiki?, captureEvery? })`, episodic summaries every few messages and on a session's close, facts promoted to the person's `inferred/` notes through the wiki, every turn's messages indexed for `recall_verbatim`, a `session` layer with the last conversation's recap, `summariesOf` for `conversationWindow({ earlier })`; `needs: ["vectorIndex", "embedding"]`; in the framework's fixed group
  - new `@mercury-fw/corrections`: `corrections({ wiki })`, a failed command and a later one that worked in the same turn, kept in `tool_corrections` and promoted to `curated/standards/<tool>-<topic>.md`; `needs: ["vectorIndex", "embedding"]`; in the framework's fixed group
  - `wiki()` returns `notes`: `promoteFact`, `promoteCorrection`, `facts`, the deterministic consolidation into the vault
  - background jobs named `memory:capture`, `memory:archive-index`, `corrections:correction`
  - `SESSION_CAPTURE_MESSAGE_THRESHOLD` is read by `memory()`
  - **Breaking:** the core keeps no long-term memory: no episodic summaries, no facts, no corrections, no `recall_verbatim`, no recap of the last session: declare `memory()` and `corrections()`
  - **Breaking:** no `memory.capture`, `memory.consolidate`, `memory.correction` events in the traces, and no "Noting down something important" status while a conversation is captured; `core.status.remembering`, `core.status.capture-detail`, `core.status.correction-detail` are gone
  - `mfw create` declares `memory({ wiki: teamWiki })` (in `plugins` and in the `default` profile's `layers`), `corrections({ wiki: teamWiki })`, and `conversationWindow({ earlier: longTermMemory })`
  - **Migration:** `bun add @mercury-fw/memory @mercury-fw/corrections`, then in `mercury.config.ts` add `import { memory } from "@mercury-fw/memory";`, `import { corrections } from "@mercury-fw/corrections";`, `const longTermMemory = memory({ wiki: teamWiki });` (declared before the conversation), `conversationWindow({ earlier: longTermMemory })`, `longTermMemory` and `corrections({ wiki: teamWiki })` in `plugins`, and `longTermMemory` in the `layers` of each context profile that should start with the last conversation's recap
  - **Migration:** an app's language files translating `core.status.remembering`, `core.status.capture-detail`, `core.status.correction-detail` can drop them

### Patch Changes

- Updated dependencies [21716af]
- Updated dependencies [4d0c1ed]
- Updated dependencies [bcabfa1]
- Updated dependencies [bf7b7f3]
- Updated dependencies [2df58af]
  - @mercury-fw/plugin-types@0.75.0
  - @mercury-fw/wiki@0.75.0
