---
"@mercury-fw/wiki": minor
"@mercury-fw/cli": minor
---

- notes take `status`, `verified_at`, `evidence` and `validated_at` in their frontmatter
- the nightly review signs the curated documents it writes `author: mercury-review`
- `raw/` entries over 64 KiB are left out of the triage, logged; `mfw vault write-raw` refuses them
- locked notes: `locked: true` in a note's frontmatter, or `wiki({ locked: ["curated/…"] })` for whole folders; the nightly review doesn't change or delete them
- `write_file` takes `locked`, set only when the person asks; left out, a note keeps its lock
- the nightly review opens an entry in `review/` on a locked note it would have changed (`flag_for_review`)
- `mfw vault review list|show|accept|reject <id>` decides the entries in `review/`
- `mfw vault lock|unlock <path>` locks a curated document
