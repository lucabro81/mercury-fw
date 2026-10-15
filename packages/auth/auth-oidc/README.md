# @mercury-fw/auth-oidc

Tells a [Mercury](https://github.com/lucabro81/mercury-fw) agent who is calling by verifying the bearer token an OpenID Connect issuer gave them. Zitadel, Google, Keycloak and the rest work the same way: which one is only configuration.

```bash
bun add @mercury-fw/auth-oidc
```

```ts
import { oidcAuth } from "@mercury-fw/auth-oidc";

auth: oidcAuth,
```

| Variable | |
|---|---|
| `OIDC_ISSUER` | Required. The issuer's URL, exactly as tokens carry it in `iss` (`https://<instance>.zitadel.cloud`, `https://accounts.google.com`). |
| `OIDC_AUDIENCE` | Required. The client id the UI calling Mercury is registered with on the issuer, which tokens carry in `aud`. A token the same issuer minted for another application is refused. |

A caller sends `Authorization: Bearer <token>`. The provider finds the issuer's keys through its discovery document (`<issuer>/.well-known/openid-configuration`, fetched on the first request and kept), then checks the signature, `iss`, `aud` and expiry (a token without `exp` is refused). A valid token becomes the principal:

```ts
{ id: sub, provider: "oidc", displayName: name ?? preferred_username ?? email, claims }
```

Anything else is refused. Roles aren't read: which claim carries them depends on the issuer.

When the issuer can't be reached, or its discovery doesn't answer within 5 s, requests are refused and the reason is logged; discovery is tried again on the next request. A missing `OIDC_ISSUER` or `OIDC_AUDIENCE` stops the provider from loading, and the channels that need it (HTTP) don't start.

## Several issuers

One provider serves one issuer. To accept people from more than one (Google and a company IdP, say), give every issuer after the first a provider of its own, with a name, and list them all in `auth`:

```ts
import { createOidcAuth, oidcAuth } from "@mercury-fw/auth-oidc";

auth: [oidcAuth, createOidcAuth({ name: "company" })],
```

A named provider reads `OIDC_<NAME>_ISSUER` and `OIDC_<NAME>_AUDIENCE` (the name upper-cased, `-` as `_`: `OIDC_COMPANY_ISSUER` here), and its principals have `provider: "oidc-<name>"`. A name is lowercase letters, digits and single hyphens. The providers are tried in the order listed, and the first that accepts the token decides who the caller is; one that fails to load is left out, and the others still work.

Each provider's people are its own: someone signing in through both issuers is two people to Mercury, with two private areas. `mfw create` sets up one provider; a second one is the line above plus its two variables.
