---
title: Writing a plugin
description: How to start a plugin of every kind, what its package holds, the rules every plugin follows, and how to check it works.
sidebar:
  order: 3.7
---

A plugin is how an agent gets to do something, and also how an app gets the pieces it's made of: a channel people
talk through, the service that says who is calling, the store that keeps conversations. Every one of them is a
package, written against `@mercury-fw/kit` (the plugin contract), that the app declares in `mercury.config.ts`.

This page is the how-to. What a plugin is and what it can contribute is in [Plugins and skills](../plugins/), what
it can reach of the agent in [What a plugin can use](../primitives/), and every field of the contracts in the
[reference](../../reference/api/).

## Start from the scaffold

Nobody writes a plugin from an empty folder. From the app's folder:

```bash
bunx mfw plugin create tool guest-wifi
```

`mfw plugin create <kind> <name>` writes a package that already works under `plugins/<name>`, with its tests and a
README saying what each file does. It adds the package to the app's `package.json` (as `workspace:*`: the app
installs it from its own folder), declares it in `mercury.config.ts` when the place is clear, and runs
`bun install`. When the place isn't clear (the config was rewritten by hand, an `auth` is already set) it leaves the
config alone and prints the two lines to add. From there, change the example into the plugin's own, keeping its
shape: the tests tell you when you broke something.

`<name>` is lowercase words joined by hyphens: it's the plugin's `name`, the start of every key of its texts, its
folder. [Your first plugin](../../getting-started/local-plugin/) walks through one from start to end.

## The kinds

| Kind | What it is | Declared in the config as |
|---|---|---|
| `tool` | typed tools the model calls, each with its input schema | an element of `plugins` |
| `cli` | a tool running a pinned command-line program through an allowlist | an element of `plugins` |
| `memory` | what the agent keeps from each turn and session, and a context layer reading it back | an element of `plugins`, and of a profile's `layers` |
| `context-strategy` | a context profile's conversation: what the model reads of it | a profile's `conversation`, in place of the one there |
| `channel` | a way people talk to the agent | an element of `channels` |
| `auth` | who is calling a channel that takes credentials | `auth` |
| `directory` | who people are and their roles | `directory` |
| `trace-sink` | where the traces of what the agent does go | `traces.sink` |
| `vector-index` | the vector index memory searches by meaning | `vectorIndex` |
| `conversation-store` | where conversations are kept word for word | `conversationStore` |

The scaffold of each kind is a small working example of its contract. A `tool` plugin lists the items of a service
and deletes one after the person confirms. A `cli` plugin runs a program whose allowlist allows a read and a confirmed
delete. A `memory` plugin keeps what each person asked about. A `context-strategy` keeps the latest exchanges within
a size. The two stores keep their data in memory, ready to have a database put behind the same methods.

## What every plugin has

- **`apiVersion`**, the version of the contract the plugin is written for, as a number written out: `apiVersion: 7`.
  Never the `PLUGIN_API_VERSION` constant, which reports the contract that's installed, not the one the code was
  written for, so Mercury could never refuse a plugin written for another one.
- **`name`**, unique on the agent; `core` and `app` are taken.
- **`build(ctx)`**, run once at startup with what the plugin can use (`ctx.env` for its settings, `ctx.log` for what
  it skips). A tool, CLI or memory plugin missing a setting logs why and returns `{}`: the agent starts anyway,
  without it. A channel, auth provider, directory, trace sink or store throws instead, and Mercury leaves it out: an
  auth provider or a directory left out closes the agent, never opens it.

A tool, CLI, memory plugin or context strategy also has a **`description`**, one sentence on what it lets the agent
do, which the model reads; and **`actsAs`**, whose identity its tools use at the service they reach (`"anyone"`,
`"person"` or `"mercury"`, explained in [People and roles](../people/)).

## The rules

- **An irreversible action waits for the person.** A tool that deletes, sends or changes something calls
  `stageConfirmation({ describe, run })` and returns `{ ok: false, pendingConfirmation: true, token, summary, error }`:
  the person confirms on their channel, and only then does Mercury run `run`. A `cli` plugin marks such commands
  `confirm: true` in its allowlist instead. See [Confirmations](../confirmations/).
- **A tool never throws.** It answers `{ ok: true, … }`, or `{ ok: false, error }` with an error the model can read
  and tell the person about.
- **What the model reads is in English**: descriptions, the prompt fragment, skills. The assistant's name is
  `{{assistant}}`, which Mercury replaces with the app's.
- **What the person reads goes in `messages`**, in English, every key under the plugin's name; the app's
  [language files](../languages/) translate them. A status line while a tool runs is one of them, through
  `toolStatusDescribers`.
- **Settings and secrets come from the environment**, read in `build` from `ctx.env` and listed in the app's
  `.env.example`.
- **A memory is enrichment.** When its store is empty or unreachable it logs and goes on: a turn never fails because
  of it. Work that calls a model goes through `ctx.job`, which runs it when nobody is waiting on the model.

## A skill

A plugin whose tools need explaining ships a skill: `skills/<name>/SKILL.md`, a short frontmatter (`name`,
`description`) and the instructions, loaded with `parseSkill` and listed in the plugin's `skills`. The description
stays in the model's instructions; the body loads only when the model asks for it, so it can be as long as it needs
to be. A good one says which tool to call first, never to guess an id, what to do on `ok: false`, and gives a couple
of examples. The `tool` scaffold has one.

## The `mercury` block of `package.json`

A plugin running a command-line program says two things about it in its `package.json`, under `mercury`:

```json
{
  "mercury": {
    "cliBinary": { "repo": "acme/acme-cli", "crate": "acme", "version": "1.2.3" },
    "cliCredentials": { "folder": "acme-cli", "setup": ["acme", "init"], "check": ["acme", "doctor"] }
  },
  "scripts": { "postinstall": "bun run scripts/install-acme-cli.ts" }
}
```

- **`cliBinary`** pins the program: the GitHub repository releasing it, its name there, the release. The package's
  postinstall downloads it into `bin/` with `downloadPinnedBinary` from `@mercury-fw/utils`, and the app's image puts
  it on the PATH. Bun runs no install script it isn't told to trust, so the app lists the plugin in
  `trustedDependencies` (`mfw plugin create` does it).
- **`cliCredentials`** says where the program keeps its login (`folder` under `~/.config`, or `path` anywhere in the
  home) and the commands that set it up (`setup`, required), set up the app people log in through (`userSetup`),
  check it (`check`) and log an identity out (`logout`). `mfw credentials setup <plugin>` runs them in the app's
  container, so the login lands on a volume that outlives a rebuild.

The `cli` scaffold writes both, from `--cli-binary`, `--cli-repo` and `--cli-version`.

## Checking it

1. `bun run test` in the app runs every plugin's tests, `bun run typecheck` checks the types.
2. `bunx mfw restart`, then `bunx mfw logs`: the plugin loads, or the log says why not (a missing setting, an
   `apiVersion` the core doesn't run).
3. `bunx mfw repl`, to try it by hand.
4. An end-to-end test in the app's `e2e/`, run with `bunx mfw e2e`: what the real model does with the plugin, which
   tools it calls with what, over several runs. See [`mfw e2e`](../../reference/cli/#mfw-e2e-tests---repeat-n).

## With a coding assistant

Every app `mfw create` makes has an `AGENTS.md`, what a coding assistant reads first (what the app is, where things
are, the `mfw` command, what to do and not to do), and the `mercury-plugin` skill, in `.claude/skills/` and
`.agents/skills/`, which tells it how to write a plugin by these rules, starting from `mfw plugin create`. Ask your
assistant for a plugin and it finds both. An app made before them gets them with `bunx mfw agent-files`, which keeps
any file already there.

## A plugin for everyone

A plugin in your app is your app's. One that would serve every Mercury user can become one of Mercury's own
packages: see [Proposing a plugin](../../getting-started/public-plugin/).
