---
"@mercury-fw/channel-http": minor
---

- `GET /version` answers the framework's version (`{ ok: true, version: "0.58.0" }`) with no token, for a UI to show which Mercury it's talking to. It needs the framework at 0.58 or later; on an older core the route isn't there.
