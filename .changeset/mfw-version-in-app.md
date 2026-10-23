---
"@mercury-fw/cli": patch
---

Inside an app, `mfw --version` and `mfw --help` (and a bare `mfw`) come from the app's own CLI too when the global one is another version, like every app command: before, they stayed the global one's, so `mfw --version` there showed the global version and a mismatch with the app's went unnoticed. The line saying it hands over names both versions (`mfw 0.53.2: running the app's 0.58.0`). `create` and `upgrade` stay the global CLI's. It's the global `mfw` that hands over, so this takes effect once it's updated: `mfw upgrade`.
