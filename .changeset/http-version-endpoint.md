---
"@mercury-fw/channel-http": minor
---

- `GET /version` answers the framework's version (`{ ok: true, version: "0.59.0" }`) with no token, for a UI to show which Mercury it's talking to.
- The channel now needs the framework at 0.59 or later (peer range `>=0.59.0 <1.0.0`), the first whose core gives channels its version.
