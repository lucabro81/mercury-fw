# @mercury-fw/directory-static

A user directory for [Mercury](https://github.com/lucabro81/mercury-fw) that lists the people by hand: who they are, the identities the channels know them by, and their roles. For a small instance whose admin keeps the list, and for the test bed.

```bash
bun add @mercury-fw/directory-static
```

Declare it in `mercury.config.ts`:

```ts
import { staticDirectory } from "@mercury-fw/directory-static";

directory: staticDirectory,
```

| Variable | |
|---|---|
| `DIRECTORY_STATIC_PEOPLE` | Required. A JSON list of people: `[{"id": "alice", "displayName": "Alice", "email": "alice@example.com", "roles": ["mercury.act-as-self"], "identities": ["static:alice", "google-chat:users/123"]}]`, where `displayName`, `email` and `roles` are optional. |

An identity is `<provider>:<id>`, as the channel or the auth provider vouches for it (`static:<id>` from `auth-static`, `oidc:<sub>` from `auth-oidc`, `google-chat:users/<id>` from Google Chat), and it belongs to one person only. Listing several identities for the same person makes them one person across channels: one private area, one memory, the same roles.

The person's key is `people:<id>`, so `id` is a short lowercase slug (letters, digits, `.`, `_`, `-`). A missing or malformed list stops the directory from loading, and the instance then lets nobody in but the terminal: a broken config closes it, it never opens it.

The roles that mean something to Mercury itself are `mercury.act-as-self`, which lets a person make Mercury act with its own identity on every plugin, and `mercury.act-as-self.<plugin>`, the same for one plugin. Any other role is for the app's own `access.plugins` restrictions.

MIT
