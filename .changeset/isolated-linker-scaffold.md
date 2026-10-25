---
"@mercury-fw/cli": minor
---

Scaffolded apps now install with Bun's isolated linker (the default when workspaces are present). The Dockerfile's PATH step follows symlinks (`find -L`) so the CLI plugins' binaries are linked as before. The `bunfig.toml` that forced the hoisted layout is gone from new apps; existing apps keep theirs.
