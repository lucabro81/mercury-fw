---
title: Plugins and skills
description: How an agent gets its tools, how the model learns to use them, and what keeps a tool from doing more than it should.
sidebar:
  order: 3
---

A **plugin** gives the agent something it can do. The core knows no service: it doesn't know what Jira is, or the
web, so every capability comes from a plugin the app declares. An agent with no plugins can talk, and nothing else.

A plugin can come from npm (the [first-party ones](../../plugins/) are `@mercury-fw/plugin-*`) or live in your app,
as a single file or as a package of its own under `plugins/`, both in [Your first plugin](../../getting-started/local-plugin/). Either way it's a plain object, and it always
has a **description**: one sentence on what it lets the agent do, such as "Lists and reads Bitbucket pull requests."
Before every conversation the model reads the descriptions of the plugins the person may use, and that list is what
it answers from when someone asks what it can do. The description says what, never how: how to use a plugin is up to
its fragment and its skills. Mercury doesn't load a plugin without one, and says why in the log.

A plugin may also contribute:

- **tools**, the functions the model can call, each with a description and the shape of its input;
- **a prompt fragment**, a few lines the model reads before every conversation, saying what the plugin offers and
  when to use it;
- **skills**, longer instructions the model loads only when it needs them (below);
- **lists for the person**, such as a list of Jira issues, which the app formats and the model never has to
  copy out by hand (below);
- **a context layer**, text the model reads besides the conversation, when the app asks for it (see
  [Context](../context/));
- **hooks**, code Mercury runs after a turn and when a conversation closes, for a plugin that learns from what was
  said (below);
- **the way the conversation is kept**, when the app names it in a context profile (see
  [What a plugin can use](../primitives/#keeping-the-conversation)).

What a plugin can reach of the agent while it does any of this (the models, the vector index, the conversation
store, work at a set time) is in [What a plugin can use](../primitives/).

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

The model decides whether the person sees a list: it calls `present` with the reference when they asked to see it,
and answers "how many are open?" in prose without it. For some results that choice makes no sense, though: when the
person asks for the link that opens a search, the link is the answer, and a small model that forgets to show it (or
retypes a long encoded URL by hand, breaking it) has failed the turn. A rule with `always: true` shows that kind
every time, after the answer, and the model is told it's already there.

A tool written in code hands over a list the same way a command-line one does, by returning it next to what the
model reads:

```ts
execute: async ({ query }) => ({ ok: true, query, display: { type: "search-link", items: [{ url, query }] } }),
```

Mercury takes `display` out before the model sees the result, so the model reads `query` and a reference, never the
list itself. The plugin exports the kinds it hands over as a type (as Jira does with `JiraDisplays`), so the app's
rules for them are checked too. [What a turn returns](../turn-output/) follows a display from the tool's result to
what the person sees, next to the checks a plugin can run on the finished answer (guards).

## After a turn, and when a conversation closes

Some plugins don't add a tool: they learn from what was said, to remember it later. A plugin like that gives Mercury
pieces of code to run:

- **after a turn**, once the person has their answer: it gets what they wrote, the answer, and the tools the model
  called (what with, and whether they worked, never what they returned);
- **on what a turn or a confirmation left**, whatever its outcome (a turn the person stopped, or one that failed,
  included): everything an archive keeps of it, which is how `@mercury-fw/archive` keeps the conversations (see
  [What a plugin can use](../primitives/#what-every-turn-leaves));
- **when a conversation closes**, after half an hour with no message (`SESSION_IDLE_TIMEOUT_MS`): it gets the
  conversation's messages.

A plugin hears only about the conversations of the people it's offered to: the same [roles](../people/) that decide
who may use its tools decide whose turns it sees. Mercury doesn't wait for this code: the answer is already out,
and the person's next message doesn't wait either. Code that fails is written in the log and leaves everything else
as it was.

What Mercury remembers works this way: the conversation, the archive, the titles, the long-term memory and the
corrections are plugins of this kind, which an app made with `mfw create` declares (see [Memory](../memory/)), and a
plugin of yours can learn from conversations the same way they do.

When that work needs the model (a summary, say), the plugin hands it to Mercury as a **job**: Mercury runs it only
when nobody is waiting for an answer, the same way it runs its own work (see
[Work nobody waits on](../../reference/config/#work-nobody-waits-on)). The [traces](../traces/) show each job
under the plugin's name.

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
too. And it names what it needs of the app (`needs`, such as the vector index): an app that declares the plugin
without it doesn't start.
