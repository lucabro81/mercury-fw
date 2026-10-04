---
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
---

Several people talking at once.

- `@mercury-fw/core`: turns of one conversation run one after the other, on every channel. Before, two HTTP `/turn` on the same conversation id ran together and mixed up its history.
- `@mercury-fw/core`: a turn waiting behind another one on the same conversation is dropped as soon as its client goes away.
- `@mercury-fw/core`: the idle capture waits for a running turn before it closes a conversation, and a sweep never starts while the previous one is still running.
- `@mercury-fw/core`: the capture a history compression triggers no longer leaves the capture marker wrong, which could make a later capture take the same messages twice or skip new ones.
- `@mercury-fw/core`: the tool log is kept per person, so a busy person no longer pushes everyone else's calls out of it.
- `@mercury-fw/core`: consolidation, `index.md` updates and confirmed promotions compare against the current file in the same queue as the write, so a concurrent update is never lost.
- `@mercury-fw/core`: vault files are written through a temporary file and a rename, so a reader never sees one half written.
- `@mercury-fw/core`: a vault file that exists but can't be read fails a write that depends on it, instead of counting as missing.
- `@mercury-fw/core`: the nightly review rewrites or deletes only the version of a document it read, and rereads it when it changed meanwhile.
- `@mercury-fw/core`: each pass of the nightly review gets up to 100 steps, up from 15.
- `@mercury-fw/cli`: an e2e case on HTTP can send its turns in `lanes` that run at the same time, each as its own user, on a conversation of its own or one they share.
