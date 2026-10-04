# @mercury-fw/auth-static

Tells a [Mercury](https://github.com/lucabro81/mercury-fw) agent who is calling through a fixed map from bearer token to user. It's meant for the test bed and e2e tests (two tokens, two users, and you can check that one doesn't see the other's things); for real users there's [`@mercury-fw/auth-oidc`](../auth-oidc).

```bash
bun add @mercury-fw/auth-static
```

```ts
import { staticAuth } from "@mercury-fw/auth-static";

auth: staticAuth,
```

| Variable | |
|---|---|
| `AUTH_STATIC_TOKENS` | Required. JSON from token to user: `{"<token>": {"id": "alice", "displayName": "Alice", "roles": ["admin"]}}`, where `displayName` and `roles` are optional. |

A caller sends `Authorization: Bearer <token>`; a known token becomes the principal `{ id, provider: "static", displayName?, roles? }`, anything else is refused. A missing or malformed `AUTH_STATIC_TOKENS` stops the provider from loading, and the channels that need it (HTTP) don't start: a broken config closes the surface, it never opens it.

Tokens are secrets even here, so they live in `.env`, never in `mercury.config.ts`, and never show up in a log or an error message.
