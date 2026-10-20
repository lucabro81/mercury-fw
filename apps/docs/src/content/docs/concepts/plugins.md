---
title: Plugins and skills
description: How an agent gets its tools, how the model learns to use them, and what keeps a tool from doing more than it should.
sidebar:
  order: 3
---

A **plugin** gives the agent something it can do. The core knows no service: it doesn't know what Jira is, or the
web, so every capability comes from a plugin the app declares. An agent with no plugins can talk, and nothing else.

A plugin can come from npm (the [first-party ones](../../plugins/) are `@mercury-fw/plugin-*`) or be a file in your
app, as in [Your first plugin](../../getting-started/local-plugin/). Either way it's a plain object, and it may
contribute:

- **tools**, the functions the model can call, each with a description and the shape of its input;
- **a prompt fragment**, a few lines the model reads before every conversation, saying what the plugin offers and
  when to use it;
- **skills**, longer instructions the model loads only when it needs them (below);
- **lists for the person**, such as a list of Jira issues, which the app formats and the model never has to
  copy out by hand (below).

## Skills

The instructions a model reads before answering cost time on every message, so they have to stay short. A tool
with many options needs pages of explanation, though: which flags exist, which combinations work, common mistakes.

A **skill** solves this. It's a document with a name, a one-line description, and a body. The name and the
description stay in the model's instructions, so it knows the skill exists; the body loads only when a request
needs it. The Jira plugin, for instance, ships a skill on its commands (searches, changes, finding people), and the
model reads it only when a request is about Jira.

A skill is a Markdown file with a short header, the format [Anthropic's Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
use:

```markdown title="SKILL.md"
---
name: jira
description: Query and act on Jira issues via the jiraCommand tool. Load this before running any jira command.
---

How to write a search, which fields to select…
```

## Plugins built on a command-line tool

Several first-party plugins (Jira, Bitbucket, ZITADEL) work through a command-line program: the model writes a
command, the plugin runs it, the output goes back to the model. Letting a model run commands is exactly what you
don't want to do carelessly, so these plugins share a library, `@mercury-fw/cli-engine`, that makes it safe:

- **No shell.** The command never goes to a shell, so pipes, redirects and `;` mean nothing. The library splits
  it into arguments itself and runs the program directly.
- **An allowlist.** Each plugin ships a file listing the commands it allows, by prefix (`pr list`, `issue
  search`), and anything else is refused before it runs.
- **Confirmation.** A command marked `confirm: true` in that file, like deleting an issue, never runs on the
  model's word: it waits for the person's confirmation. See [Confirmations](../confirmations/).

The program itself is pinned to an exact version and downloaded when the plugin is installed, so every app runs the
one the plugin was tested with.

Building on a command-line tool is a practical choice, never a requirement: a plugin can call an API directly, as
the web search plugin and the guest Wi-Fi example do.

## Lists for the person

When the model searches Jira and gets thirty issues back, copying them into its answer is slow and error-prone (a
small model drops some, or invents a field). So a plugin can hand the person a **list** directly: the model gets the
data to reason on and shows the list with a reference, and Mercury writes the list out.

How each item reads is the app's choice, through `@mercury-fw/formatter`:

```ts title="mercury.config.ts"
formatterPlugin(
  jiraPlugin,
  formatter<JiraDisplays>({
    "issue-list": { item: (issue) => `${issue.key} ${issue.summary}\n${issue.url}`, empty: "No matching issues." },
  }),
),
```

A kind of list with no rule isn't shown at all, and the log says which rule is missing. `mfw create` writes a
starting rule for every plugin that has lists.

## Whose identity a tool uses

A tool that reaches a service does it as someone: as the person asking (they log in to the service through
Mercury), as the agent's own service account, or as no one, for a public service with no login. A plugin says which
with `actsAs`, and [People and roles](../people/) explains what each means for who may use it.

## Texts the person reads

What a plugin shows the person in its own words (the line saying a tool is running, the label of a choice) is
written once, in English, in the plugin's `messages`, every key under the plugin's name (`web-search.choice.once`).
The plugin asks for a text by its key, through the `t` it's handed while a turn runs, and gets it in the language of
the person the turn is for: the app translates the keys in its [language files](../languages/). A plugin whose keys
aren't all under its own name isn't loaded, so it can't take over another plugin's texts or Mercury's, and `core`
and `app` can't be plugin names: their keys are Mercury's and the app's.

## Compatibility

Every plugin declares the version of the plugin contract it was written for (`apiVersion`). When the core loads a
plugin written for another version, it skips that plugin and says why in the log, so an old plugin never runs half
broken. A plugin can also require another one (`dependsOn`): if that one is missing or failed, this one is skipped
too.
