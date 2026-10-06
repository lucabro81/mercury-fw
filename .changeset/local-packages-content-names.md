---
"@mercury-fw/cli": patch
---

- `mfw local-packages` and `mfw create --local-packages` name each tarball in `.packs/` after its content, so a package repacked at the same version is installed anew instead of kept from Bun's cache or refused by the lockfile's integrity check
