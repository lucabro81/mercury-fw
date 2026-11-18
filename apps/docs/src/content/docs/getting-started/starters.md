---
title: Starters
description: Agents set up for a task by mfw create, a knowledge base, a Jira assistant, a web researcher, and how to check each does its job.
sidebar:
  order: 1.5
---

A **starter** is an agent `mfw create` sets up for a task: the plugins the task needs, a role for the assistant, an
end-to-end test that checks the agent does the task with your model, and a section of the app's README saying what
it does and how to set it up. It's a starting point, not a cage: everything it writes is the app's to change, like
any app `mfw create` makes.

## Picking one

`mfw create` asks what the agent is for, right after the app's name: pick a starter, or "Something else" to start
empty. The starter's plugins come pre-selected and its role pre-filled, and you can change both before the app is
written. From the command line:

```bash
bun create mercury-agent my-agent --starter web-researcher
```

`--starter` takes the starter's id; `--plugins` and `--role` still win over it, as long as the starter's own plugins
stay among the plugins (its test calls them). `mfw create --help` lists the starters.

## The starters

| Starter | What the agent does | Plugins | Its settings |
|---|---|---|---|
| `knowledge-base` | answers from the team's Confluence and wiki, naming the pages it used | [Confluence](../../plugins/plugin-confluence/) | the Confluence login |
| `jira-assistant` | finds, reads and updates the team's Jira issues | [Jira](../../plugins/plugin-jira/) | `JIRA_SITE_URL`, the Jira login |
| `web-researcher` | searches the web and answers citing its sources | [Web search](../../plugins/plugin-web-search/) | `SEARXNG_SECRET` |

Every app also keeps the team's wiki and a long-term memory, whatever the starter: they come with every app
`mfw create` makes.

The Confluence and Jira logins are set up once, inside the app's container, with
`bunx mfw credentials setup @mercury-fw/plugin-confluence` (or `-jira`): each plugin's page says what the login asks
for. The web researcher needs none: its search runs in SearXNG, next to the app.

## Checking it does the task

Each starter writes a test in the app's `e2e/`, named after it. Once the app runs (`bunx mfw start`) and its settings
are in `.env`:

```bash
bunx mfw e2e e2e/web-researcher.e2e.ts
```

The test sends the agent a question its task should answer and checks what it did, over three runs: the knowledge
base loads the Confluence skill and searches the pages, the Jira assistant searches the issues the way the Jira
skill says, the web researcher searches the web and links its source. The tests name nothing of your own (no project,
no page), so they pass as they are; add cases with what your Confluence or Jira actually holds.

## From here

- [Your first plugin](../local-plugin/) gives the agent a tool of its own.
- [The mfw CLI](../../reference/cli/#mfw-e2e-tests---repeat-n) has the rest of `mfw e2e`.
