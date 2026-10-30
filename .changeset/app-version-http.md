---
"@mercury-fw/channel-http": minor
---

- `GET /version` also answers the app's own version when its config declares one: `{ ok: true, version, app: { version } }`. Still no token; without one the body is the same as before.
- Needs the framework at 0.65 or later (peer range raised).
