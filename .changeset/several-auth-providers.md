---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/auth-oidc": minor
"@mercury-fw/plugin-zitadel": patch
"@mercury-fw/channel-http": patch
---

- `auth` in `mercury.config.ts` takes a list of providers as well as one: they're tried in order and the first that recognizes the caller decides who they are. One that fails to load, or fails on a request, is logged and the others still serve; a name taken twice is refused.
- `createOidcAuth({ name })` is an OIDC provider of its own (`oidc-<name>`), configured by `OIDC_<NAME>_ISSUER` and `OIDC_<NAME>_AUDIENCE`, so an instance can accept several issuers. `oidcAuth` is unchanged.
- A principal's provider can be `oidc-<name>`; each provider's people keep their own keys.
- `zitadelDirectory` takes `ZITADEL_AUTH_PROVIDER`, the auth provider whose subjects are its users (default `oidc`).
