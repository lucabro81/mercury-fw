---
"@mercury-fw/wiki": minor
"@mercury-fw/cli": minor
---

- `wiki({ review: { dreaming: {} } })` adds the dreaming pass at the end of the nightly review: notes used since the last pass, and curated documents the review wrote, checked against the conversations they were used in
- dreaming sets `status` (`unverified`, `verified`, `contested`), `verified_at` and `evidence` on the notes it checks, rewrites a person's note a conversation contradicts, and opens `curated` and `standard` entries in `review/`
- `review.dreaming.k`: how many distinct conversations decide a status, 3 by default
- with dreaming on, the wiki needs the conversation store (`needs: ["conversationStore"]`) and records the notes each turn read (`onTurnRecord`, in its data folder)
- `review.at` is optional, `"03:00"` when left out
- `mfw create`: new apps declare `wiki({ review: { dreaming: {} } })`
- **Migration:** to turn dreaming on in an existing app, write `const teamWiki = wiki({ review: { dreaming: {} } });` in `mercury.config.ts`
