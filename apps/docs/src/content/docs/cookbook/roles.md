---
title: Who may use which plugin
description: Roles from the directory, and a plugin offered only to the people holding one.
sidebar:
  order: 5
---

The task: everyone can talk to the agent, but only HR may use the payroll plugin. People get roles from the
**directory**, and `access.plugins` says which roles a plugin is offered to; [People and roles](../../concepts/people/)
has the whole chain, from who is talking to what they may do.

## The roles

With the static directory, the roles are in `DIRECTORY_STATIC_PEOPLE` (a real instance takes them from its login
service, ZITADEL for one):

```json
[
  { "id": "ada", "displayName": "Ada", "roles": ["hr"], "identities": ["static:ada"] },
  { "id": "bob", "displayName": "Bob", "roles": [], "identities": ["static:bob"] }
]
```

## The restriction

In `mercury.config.ts`, next to the plugins:

```ts title="mercury.config.ts"
  // Only people holding the hr role are offered the payroll plugin; the terminal always is.
  access: { plugins: { payroll: { roles: ["hr"] } } },
```

`payroll` is the plugin's `name`. A plugin that isn't offered to someone isn't there for them at all: its tools,
its description, its fragment and its skills are left out of what the model reads in their turns, so the model can't
call it and doesn't mention it. Hooks and context layers follow the same rule.

## Trying it

The same question, as each of them:

```text
Ada > Can you list the payroll items? If you have no tool for it, say so in one sentence.
      (calls payroll_list)

Bob > Can you list the payroll items? If you have no tool for it, say so in one sentence.
      I don't have a tool for listing payroll items — I can only work with the team wiki and our conversation history.
```

## Related

- `actsAs` says whose identity a plugin's tools use at the service. A plugin acting as the instance itself
  (`"mercury"`) is offered only to people holding `mercury.act-as-self` or `mercury.act-as-self.<plugin>`, on top of
  any `access.plugins`.
- `access.unknown` decides what happens to someone the directory doesn't know: refused (the default), or let in with
  no roles.
