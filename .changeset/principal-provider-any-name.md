---
"@mercury-fw/channel-types": minor
"@mercury-fw/core": patch
---

- `Principal.provider` (`PrincipalProvider`) takes any name: an auth provider or a channel of your own gives its people its own
- a `directory` named like one of the instance's auth providers or channels doesn't load, and the instance lets in nobody but the terminal
