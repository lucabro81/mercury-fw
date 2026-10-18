---
title: People and roles
description: How Mercury knows who is writing, keeps each person's things apart, and decides what they may use.
sidebar:
  order: 5
---

An agent many people use has to know who is writing: to keep each person's memory and notes their own, and to let
someone use a tool someone else may not. Mercury works this out in three steps.

## 1. The channel says who is writing

Every message arrives with an identity the channel vouches for, written `<provider>:<id>`:

- Google Chat knows the sender's account: `google-chat:users/123456789`.
- The HTTP channel asks an **auth provider** to check the token the caller sends. With
  [`auth-oidc`](../../plugins/auth-oidc/) the token comes from a login service such as ZITADEL, Google or Keycloak
  (an *OpenID Connect* issuer), and the identity is `oidc:<the user's id there>`. With
  [`auth-static`](../../plugins/auth-static/) it comes from a fixed list of test tokens.

The identity the channel gives is called the **principal**. Two providers issuing the same id are still two people,
because the provider is part of the name.

## 2. The directory says who that is

A **directory** turns a principal into a **person**, with their **roles**: labels such as `mercury.act-as-self` or
`support` that decide what they may use. It's optional:

- **Without a directory**, the person is whoever the channel says, with no roles.
- **With one**, the agent talks only to the people the directory knows (unless the configuration sets
  `access.unknown` to `"allow"`), and refuses everyone while the directory can't be reached.

A directory can list several identities for the same person, so someone reaching the agent from Google Chat and
from a web chat is one person, with one memory. Mercury has two: [`directory-static`](../../plugins/directory-static/),
a list kept by hand, and the one in [`plugin-zitadel`](../../plugins/plugin-zitadel/), which reads people and
their project roles from ZITADEL.

People can also link two of their accounts themselves, with a one-time code they get on one and send from the
other, and whoever runs the agent can link them with `mfw identity`.

## 3. Each person's things are theirs

Memory, conversations, pending confirmations and personal notes belong to one person, and nobody sees anyone
else's. The wiki has a common area everyone reads, and a note goes there only when its owner confirms it.

## Whose identity a tool uses

When a tool reaches a service, it does so as someone. Each plugin declares which (`actsAs`):

- **`"person"`**: as the person asking. They log in to the service once, through a link the agent sends, and the
  tool then sees what they see there and nothing more.
- **`"mercury"`**: as the agent's own service account. That account may see more than any one person, so only
  people holding the role `mercury.act-as-self` (every plugin) or `mercury.act-as-self.<plugin>` (that plugin) may
  use it, plus the terminal. A plugin that declares nothing counts as `"mercury"`.
- **`"anyone"`**: as no one, for a public service with no login, such as web search. Everyone may use it.

People allowed to make the agent act as itself also get every `"person"` tool a second time, run with the agent's
account.

## Restricting a plugin

The configuration can restrict a plugin to some roles, on top of everything above:

```ts title="mercury.config.ts"
access: {
  plugins: { jira: { roles: ["support"] } },
},
```

With this, only people holding `support` get the Jira tools. The terminal is exempt.
