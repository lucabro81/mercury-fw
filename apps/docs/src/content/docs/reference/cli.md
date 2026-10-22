---
title: The mfw command
description: Every command of mfw, Mercury's command-line tool, with what it runs underneath.
sidebar:
  order: 2
---

`mfw` creates an app, then runs it. Every command except `create` and `upgrade` works from inside an app (its
folder or any folder under it) and wraps the `docker compose` calls that app needs, so you don't have to remember
them; each section says which calls those are.

Every app has its own copy of `mfw`, at the app's framework version: run it with `bunx mfw`. You can also install it
globally, once, and type `mfw` anywhere:

```bash
bun add -g @mercury-fw/cli
```

Inside an app, a global `mfw` of another version hands the command over to the app's own, so the commands always
match the app's framework. `mfw --help` lists every command, and `--help` after any of them describes it.

## Create and update

### `mfw create <folder>`

Writes a new app into `<folder>`, which must be missing or empty. Without flags it asks the app's name, the
assistant's name and role, which channels, tool plugins, auth provider and directory to include, and a git remote.
Then it runs `bun install` and makes a git repository with a first commit (nothing is pushed).
`bun create mercury-agent <folder>` runs the same command.

| Flag | |
|---|---|
| `--name <name>` | The app's name. |
| `--assistant-name <name>` | The assistant's name (default `Mercury`). |
| `--role <text>` | Completes "You are <name>, …" (default `an internal assistant`). |
| `--channels <ids>` | Comma-separated: `google-chat`, `http`. |
| `--plugins <ids>` | Comma-separated: `jira`, `bitbucket`, `atlassian-admin`, `zitadel`, `web-search`. |
| `--auth <id>` | The HTTP channel's auth provider, `oidc` or `static`. Required with `http`. |
| `--directory <id>` | The user directory, `static` or `zitadel`. |
| `--local-packages <folder>` | Installs packages packed in `<folder>` instead of the registry's, to try unreleased ones. |
| `--git-remote <url>` | The repository's `origin`. |
| `--no-install` | Skip `bun install`. |
| `--no-git` | Skip the repository. |
| `-y`, `--yes` | No questions: the flags, and the defaults for the rest. |

```bash
mfw create my-agent --assistant-name Hermes --channels http --auth static --plugins web-search --yes
```

The framework packages get the CLI's own version; each plugin, channel or auth provider gets its latest version.

The app's `package.json` declares `plugins/*` as workspaces, the place for the app's own plugins (each a package in
`plugins/<name>`, which the image copies before installing), and a `test` script (`bun test --pass-with-no-tests`: the plugins'
tests included, passing while there are none); `bunfig.toml` keeps Bun's hoisted `node_modules`, which the workspaces would otherwise turn into links.

### `mfw upgrade`

Installs the latest `mfw` globally when it's newer than the one running. It touches only the global `mfw`: an
app's framework, its own `mfw` included, moves with `bun update` inside the app.

## Run the app

### `mfw start [--no-cache]`

Builds the image and starts the app and Qdrant in the background (`docker compose up -d --build`). Only what changed
is rebuilt, and a container is recreated only if its image or settings changed, so it's also the command to run
after changing a dependency, the Dockerfile or `.env`. `--no-cache` rebuilds everything, which is what fetches a new
release of a plugin's command-line tool.

### `mfw stop`

Stops the app and Qdrant and removes their containers (`docker compose down`). The volumes stay: memory, wiki and
logins are there at the next start.

### `mfw restart [--no-cache]`

Like `start`, but recreates the containers even when nothing changed (`--force-recreate`), for a process that got
stuck.

### `mfw logs [service]`

Follows the logs of every service, or of one (`mercury` or `qdrant`) (`docker compose logs -f`). `Ctrl+C` stops
following; the app keeps running.

### `mfw repl`

Opens a conversation with the agent in the terminal, in a one-off container (`docker compose run --rm mercury bun
run repl`). It has no user identity, so nothing you try there lands in anyone's memory. `Ctrl+D` ends it.

### `mfw shell`

Opens a shell in the app's container, the running one if the app is up. The plugins' command-line tools are on the
`PATH` there with their logins, so it's where you check a command works before blaming the model.

## Memory and wiki

### `mfw vault <command>`

Reads and writes the wiki, which lives on a Docker volume, in a one-off container. Paths are relative to the wiki,
`curated/` included.

| Command | |
|---|---|
| `list` | Every note. |
| `read <path>` | One note. |
| `grep <pattern>` | Every line matching a regular expression (case ignored), as `path:line:text`. |
| `write-curated <path> [--author NAME]` | Writes a note in the common area, the body read from stdin. |
| `write-raw <path>` | Writes raw material for the nightly review to sort, the body read from stdin. |

```bash
mfw vault grep "story points"
cat note.md | mfw vault write-curated curated/standards/new-note.md --author luca
```

### `mfw memory list` and `mfw memory read <collection> [--limit N]`

Lists the long-term memory's collections on Qdrant with their size, and prints a collection's entries, newest
first where it can (20 by default). Both only read.

### `mfw reset <memory|wiki>`

Deletes for good the long-term memory (every collection on Qdrant) or the whole wiki. It asks you to type the
app's name first; anything else deletes nothing. Then it removes the volume and starts the service again on an empty
one.

## People and logins

### `mfw identity links`, `link`, `unlink`

Lists, makes and undoes the links that make several accounts one person (one memory, one private area, the same
roles). Identities are written `<provider>:<id>`. The running agent applies a change within five minutes.

```bash
mfw identity link google-chat:users/123 oidc:3123
```

### `mfw credentials setup|check|reset <plugin>`

For a plugin whose command-line tool keeps its login in a folder under the home. `setup` runs the tool's own login
in a one-off container, on your terminal, and keeps what it writes on a volume, so it survives redeploys; it's the
identity the agent itself runs as (people log in on their own, through the agent). `check` runs the tool's check and
exits with its code. `reset` logs out the agent's identity, or one person with `--user <key>`.

```bash
mfw credentials setup @mercury-fw/plugin-jira
```

### `mfw google-chat set-key <key-file> [--subscription <name>]`

Writes the Google Chat channel's credentials into `.env` from a service account's JSON key, without printing the
key. The [Google Chat page](../../plugins/channel-google-chat/) covers the whole setup.

## Develop and test

### `mfw local-packages <folder>` / `--off`

Makes the app install `@mercury-fw/*` packages from local tarballs (the files `bun pm pack` writes) instead of the
registry, to try a change before it's published. `--off` goes back to the registry.

### `mfw e2e [tests...] [--repeat N]`

Runs end-to-end tests against the app's real model: each test sends messages to the agent and checks which tools it
called, with what, and what it answered. The results depend on the model and on the app's data, so these tests
belong on your machine, not in CI.

```ts title="e2e/wifi.e2e.ts"
import { e2e } from "@mercury-fw/cli/e2e";

export default e2e({
  plugins: [],
  channels: [],
  cases: [
    {
      name: "answers with the guest Wi-Fi",
      turns: ["How do I get on the guest Wi-Fi?"],
      repeat: 3,
      check: (run, expect) => {
        expect.callCount({ min: 1, max: 2 });
        expect.answer(/Office-Guest/);
      },
    },
  ],
});
```
