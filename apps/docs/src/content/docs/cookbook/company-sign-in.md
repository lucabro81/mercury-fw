---
title: Your company's sign-in
description: The people your company's login service knows, calling the agent with its tokens, next to another auth provider.
sidebar:
  order: 6
---

The task: the people who use the agent through your company's tools are already signed in to its login service
(Keycloak, Microsoft Entra ID, Google, ZITADEL: an *OpenID Connect* issuer). The agent should take their tokens and
know who they are. [`auth-oidc`](../../plugins/auth-oidc/) checks those tokens; a directory says who each one is.

## The config

```bash
bun add @mercury-fw/auth-oidc
```

```ts title="mercury.config.ts"
import { createOidcAuth } from "@mercury-fw/auth-oidc";

// in defineMercuryConfig:
  // The test tokens, then the company's sign-in: the first provider that knows the token decides who is calling.
  auth: [staticAuth, createOidcAuth({ name: "company" })],
```

`createOidcAuth({ name: "company" })` reads two settings:

```bash title=".env"
OIDC_COMPANY_ISSUER=https://login.example.com/realms/staff
OIDC_COMPANY_AUDIENCE=mercury-ui
```

the issuer exactly as tokens carry it in `iss`, and the client id the calling application is registered with, which
tokens carry in `aud`. A token the same issuer minted for another application is refused. With a single issuer,
`oidcAuth` (reading `OIDC_ISSUER` and `OIDC_AUDIENCE`) is enough; `createOidcAuth` names a second one.

## Who that is

The provider says who signed in: `oidc-company:<the user's id there>` (the token's `sub`). The directory turns that
into a person with roles, listing it among their identities:

```json
{ "id": "ada", "displayName": "Ada", "roles": ["hr"], "identities": ["static:ada", "oidc-company:ada-sso"] }
```

so Ada is the same person whether she comes with a test token or with her company login: one memory, the same roles.

## Trying it

Checked against a stand-in issuer serving its discovery and its keys, with a token it signed for `ada-sso`:

- `GET /me` with that token answered `200`, and the turns that followed ran as `people:ada`;
- the same token with one character changed answered `401`.

When the issuer can't be reached, requests carrying its tokens are refused and the log says why; the other providers
keep working.
