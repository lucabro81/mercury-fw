# @mercury-fw/cli

`mfw`, the command-line tool of [Mercury](https://github.com/lucabro81/mercury-fw): it creates an app, then runs it. Every command except `create` works from inside an app, meaning its folder or any folder under it (the one holding `mercury.config.ts`), and wraps the `docker compose` calls that app needs, so you don't have to remember them; each section below says which calls those are. New commands get documented here as they're added.

## Table of contents

- [Getting it](#getting-it)
- [Usage](#usage)
  - [`mfw create <folder>`](#mfw-create-folder)
  - [`mfw start [--no-cache]`](#mfw-start---no-cache)
  - [`mfw stop`](#mfw-stop)
  - [`mfw restart [--no-cache]`](#mfw-restart---no-cache)
  - [`mfw logs [service]`](#mfw-logs-service)
  - [`mfw repl`](#mfw-repl)
  - [`mfw shell`](#mfw-shell)
  - [`mfw vault <command>`](#mfw-vault-command)
  - [`mfw memory list`](#mfw-memory-list)
  - [`mfw memory read <collection> [--limit N]`](#mfw-memory-read-collection---limit-n)
  - [`mfw reset <memory|wiki>`](#mfw-reset-memorywiki)
  - [`mfw credentials set <plugin> [--from <dir>] [--print]`](#mfw-credentials-set-plugin---from-dir---print)
  - [`mfw credentials reset <plugin>`](#mfw-credentials-reset-plugin)
  - [`mfw google-chat set-key <key-file> [--subscription <name>]`](#mfw-google-chat-set-key-key-file---subscription-name)
  - [`mfw local-packages <folder>` / `mfw local-packages --off`](#mfw-local-packages-folder--mfw-local-packages---off)
  - [`mfw e2e [tests...] [--repeat N]`](#mfw-e2e-tests---repeat-n)
  - [`mfw upgrade`](#mfw-upgrade)
- [Help](#help)

## Getting it

Install it once, globally, and `mfw` works from anywhere (Bun puts it in `~/.bun/bin`, which its installer adds to the `PATH`):

```bash
bun add -g @mercury-fw/cli
mfw create my-agent
```

`mfw upgrade` keeps it current. Every app also lists `@mercury-fw/cli` among its devDependencies, at the framework's version, and inside an app the global `mfw` hands its commands over to that one when the two differ (it says so in one line; `mfw --version` and `mfw --help` stay the global one's), so an app's commands always match the framework it runs, whatever version is installed globally. An app not installed yet (no `bun install`) runs on the global one.

Without a global install: `bun create mercury-agent my-agent` creates an app, and `bunx mfw <command>` runs the app's own CLI from inside it.

## Usage

### `mfw create <folder>`

Writes a new Mercury app into `<folder>`, which has to be missing or empty; the folder's own name is turned into kebab case (`My Agent` becomes `my-agent`, the path above it stays as typed). Without flags it asks:

- the app name (the `name` in `package.json`, defaulting to the folder's);
- the assistant's name and role, which become `persona/identity.md` ("You are Hermes, the platform team's release assistant.") next to a `persona/tone.md` to edit;
- which channels and which tool plugins to include (none is fine: the REPL always works);
- the git remote for `origin`, which you can leave empty (most of the time it doesn't exist yet when you scaffold).

It writes the `mercury.config.ts` for that selection, the persona, the service and REPL entrypoints, a Dockerfile, a compose file with Qdrant, and an env example listing every variable the chosen pieces read. A plugin that hands over lists comes wrapped in the formatter with a starting rule, yours to change.

Then it runs `bun install` in the app and creates a git repository on `main` with a first commit (`bun.lock` included), adding `origin` when you gave one; nothing is pushed. Each step is best effort and never undoes the ones before it: an install that fails still leaves the app committed, without the lockfile, and the closing message says what to run. The repository is skipped when the folder is already inside one (an app created in a monorepo belongs to it). Whether git can commit is git's call: when it refuses (no identity, a hook) or isn't installed, the message reports why and lists the commands to finish by hand. `bun install` prints its own output as it runs.

| Flag | |
|---|---|
| `--name <name>` | The app name. |
| `--assistant-name <name>` | The assistant's name (default `Mercury`). |
| `--role <text>` | Completes "You are <name>, …" (default `an internal assistant`). |
| `--channels <ids>` | Comma-separated: `google-chat`, `http`. |
| `--plugins <ids>` | Comma-separated: `jira`, `bitbucket`, `atlassian-admin`. |
| `--auth <id>` | The HTTP channel's auth provider, `oidc` or `static`: required with `http`, refused without it, since the channel doesn't start without one. The wizard asks for it once `http` is chosen. |
| `--local-packages <folder>` | Installs the packages packed in `<folder>` (`bun pm pack`) instead of the registry's, as [`mfw local-packages`](#mfw-local-packages-folder--mfw-local-packages---off) does on an existing app: their versions come from the tarballs, so a package that isn't published yet works too, and no newer `mfw` is looked up on the registry. For trying unreleased packages in a new app; the test bed makes its apps this way. |
| `--git-remote <url>` | The repository's `origin`, taken as typed. |
| `--no-install` | Don't run `bun install`. |
| `--no-git` | Don't create the repository. |
| `-y`, `--yes` | No questions: the flags, and the defaults for the rest. |

```bash
mfw create my-agent
mfw create my-agent --assistant-name Hermes --channels http --auth oidc --plugins jira --yes
```

The framework packages get the CLI's own version (they're released together); each chosen plugin, channel or auth provider gets its latest version on the registry, `https://registry.npmjs.org` unless `MFW_REGISTRY` names another.

Before anything else it asks the registry for the latest `@mercury-fw/cli`: a newer one than itself means it's a stale copy (Bun keeps the `create-mercury-agent` that `bun create` ran last in its cache, a release behind), so it says so and runs the same command through the newer version (`bunx @mercury-fw/cli@<newer> create …`), which writes the app instead. A registry that doesn't answer within a few seconds, or a newer version that can't be installed yet, is only a warning, and the CLI carries on with itself. Only CLIs from 0.28.4 on do this: a copy older than that, still in Bun's cache, needs one last `bun pm cache rm`, run from any folder with a `package.json` (Bun refuses it elsewhere).

### `mfw start [--no-cache]`

Builds the app's image and starts the app and Qdrant in the background (`docker compose up -d --build`). Docker's cache means only what changed gets rebuilt, and a running container is recreated only if its image or configuration changed, so it's also the command to run after changing a dependency, the Dockerfile or `.env`. `--no-cache` rebuilds everything from scratch (`docker compose build --no-cache`, then `up -d`), which is what refetches a tool plugin's CLI binary when a new release is out: a normal build keeps the cached one.

```bash
mfw start
mfw start --no-cache
```

### `mfw stop`

Stops the app and Qdrant and removes their containers (`docker compose down`). The volumes stay, so memory, the wiki and the CLI credentials are all there on the next start.

```bash
mfw stop
```

### `mfw restart [--no-cache]`

Like `start`, but recreates the containers even when nothing changed (`--force-recreate`): a clean restart, for a process that got stuck. A changed `.env` doesn't need it, `start` already recreates what the change touches. `--no-cache` as in `start`.

```bash
mfw restart
mfw restart --no-cache
```

### `mfw logs [service]`

Follows the logs of every service, interleaved, or only of the one you name, `mercury` or `qdrant` (`docker compose logs -f`). One service at most. `Ctrl+C` stops following, the app keeps running.

```bash
mfw logs
mfw logs mercury
```

### `mfw repl`

Opens the dev REPL, a conversation with the assistant in the terminal, in a one-off container (`docker compose run --rm mercury bun run repl`). The REPL has no user identity by design, so what you try there never lands in anyone's memory; ending it (`Ctrl+D`) removes the one-off container and leaves a running app alone.

```bash
mfw repl
```

### `mfw shell`

Opens a shell in the app's container: the running one if the app is up (`docker compose exec mercury bash`), a one-off one otherwise (`docker compose run --rm mercury bash`). The tool plugins' CLIs are on `PATH` there with their credentials, so it's where you check that a command works before blaming the model.

```bash
mfw shell
```

### `mfw vault <command>`

Maintains the wiki vault, which lives on a Docker volume and not in the app's folder, so every command runs in a one-off container on that volume (`docker compose run --rm -T mercury bun …`). Paths are vault-relative, the way `list` prints them, `curated/` or `raw/` included.

| Command | |
|---|---|
| `list` | Every note. |
| `read <path>` | One note (a path that isn't one says so, exit 1). |
| `grep <pattern>` | Every line matching `<pattern>`, a regular expression (case ignored), as `path:line:text`. A pattern starting with `-` goes after `--` (`mfw vault grep -- -h`). |
| `write-curated <path> [--author NAME]` | Writes a curated note, the body read from stdin. |
| `write-raw <path>` | Writes raw material for the nightly review to triage, the body read from stdin. |

```bash
mfw vault list
mfw vault read curated/standards/jira-fields.md
mfw vault grep "story points"
cat note.md | mfw vault write-curated curated/standards/new-note.md --author luca
```

There's no command writing inferred notes on purpose: those are the agent's own, written only by its consolidation.

### `mfw memory list`

Lists the collections of the memory on Qdrant with how many points each holds, in a one-off container that reaches Qdrant the way the app does. Read-only.

```bash
mfw memory list
```

```
episodic_memory  25 points
semantic_facts  20 points
tool_corrections  37 points
verbatim_archive  0 points
```

### `mfw memory read <collection> [--limit N]`

Prints a collection's points, each as its id followed by one line per payload field. Newest first where the collection has a timestamp index (episodic memory and the verbatim archive do); in Qdrant's own order otherwise, and it says so. `--limit` defaults to 20. Read-only.

```bash
mfw memory read episodic_memory
mfw memory read semantic_facts --limit 5
```

### `mfw reset <memory|wiki>`

Deletes for good what the assistant remembers: `memory` is every collection on Qdrant, `wiki` the whole vault. It reads the volume's real name from the compose file, tells you which one is about to go, and asks you to type the app's name (the `name` in `package.json`); anything else, an empty answer, a `y` or closing the input included, deletes nothing and exits 1. Once confirmed it stops the service using the volume, removes its container and the volume, and starts the service again on an empty one (`docker compose stop`, `rm -f`, `docker volume rm`, `up -d`). After `memory`, a running app is restarted too (`docker compose restart mercury`), since it sets up its collections only when it starts.

If a step fails once the service is stopped (the volume still in use by a one-off container, say), it stops there and says the service is down: `mfw start` brings it back.

```bash
mfw reset memory
mfw reset wiki
```

Useful for clearing out test data; the other layer isn't touched.

### `mfw credentials set <plugin> [--from <dir>] [--print]`

Hands a plugin's CLI its login, for a plugin whose CLI keeps it in a folder under the home and reads it from there at runtime. The plugin declares that folder in its `package.json` (`mercury.cliCredentials`: `{ "folder": "jira-cli" }` for `~/.config/jira-cli`, the usual place, or `{ "path": ".aws" }` for anywhere else under the home), and `<plugin>` names it by the plugin's package or by what it declares; a name the app doesn't have is an error listing the ones it has. Log in with the CLI on your machine first, then this packs the folder (where the plugin declares it, or `--from` when it lives elsewhere on your machine) into a base64 tar.gz and writes it into the app's `.env` as a variable named after the declaration (`jira-cli` goes in `JIRA_CLI_CONFIG_TAR_B64`, `.aws` in `AWS_CONFIG_TAR_B64`), replacing an older value and leaving the other lines alone. The value is never printed; `--print` prints the whole line instead and leaves `.env` alone, for pasting it into another host's.

When the app starts, it unpacks the variable onto the credentials volume, but only if that CLI's folder isn't there yet: what the CLI writes back while running, like a refreshed token, stays on the volume across redeploys, and an older value in `.env` never overwrites it. The volume is mounted on `~/.config`; a folder declared elsewhere in the home lives on it under `~/.config/mercury-home`, and the app makes its usual place a link to it at every start. A CLI that authenticates any other way isn't covered by this, and neither is one that deletes its own folder and makes it again, since that replaces the link.

```bash
mfw credentials set jira-cli
mfw credentials set @mercury-fw/plugin-bitbucket --from ~/work/bitbucket-login
mfw credentials set jira-cli --print
```

### `mfw credentials reset <plugin>`

Deletes the plugin's CLI folder from the credentials volume, so the variable in `.env` is unpacked again at the next start: what to run after correcting a variable whose folder is already on the volume, since the app never touches an existing folder. It asks you to type the folder's name first, because a token the CLI refreshed on the volume goes too (and with a CLI that rotates its refresh token, the one in `.env` may no longer work). Once confirmed it stops the app, removes the folder in a one-off container of the app's own image, and starts the app again (`docker compose stop mercury`, `run --rm --no-deps -T mercury rm -rf …`, `up -d mercury`).

```bash
mfw credentials reset jira-cli
```

### `mfw google-chat set-key <key-file> [--subscription <name>]`

Writes the Google Chat channel's credentials into the app's `.env`, from the service account's JSON key (the file `gcloud iam service-accounts keys create` writes): `GOOGLE_CHAT_APP_CLIENT_EMAIL`, and `GOOGLE_CHAT_APP_PRIVATE_KEY` on one line with literal `\n`, the way the channel reads it. With `--subscription` (`projects/<project>/subscriptions/<name>`) it sets `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` too; without it, that line stays as it is, which is what you want when only the key changes. Older values and the empty lines `mfw create` leaves are replaced, the other lines stay alone, and the key is never printed.

It checks everything before writing: the app has to depend on `@mercury-fw/channel-google-chat`, the file has to be a service account key and the subscription has to have that shape, otherwise it exits 1 saying why and `.env` stays as it was. Delete the key file afterwards; `mfw start` applies the change to a running app. The whole setup of the Chat app is in the [channel's README](https://github.com/lucabro81/mercury-fw/tree/main/packages/channels/channel-google-chat#setting-up-the-chat-app).

```bash
mfw google-chat set-key key.json --subscription projects/my-project/subscriptions/mercury-chat-sub
mfw google-chat set-key new-key.json
```

### `mfw local-packages <folder>` / `mfw local-packages --off`

Makes the app install `@mercury-fw/*` packages from local tarballs instead of the registry: the way to try a framework or plugin change in a real app before it's published. `<folder>` holds the `.tgz` files `bun pm pack` writes, one per package; the command copies them into the app's `.packs/`, points each package at its tarball with `overrides` in `package.json`, and runs `bun install`.

Overrides, and not the dependencies themselves, because a packed package names the packages it depends on by version, and the registry has those versions too: only an override sends them to the tarballs as well (a packed `@mercury-fw/core` depends on `@mercury-fw/plugin-types`, for example). The Dockerfile `mfw create` writes copies `.packs/` before installing, so the image gets the same packages (an app created before 0.31.0 needs `COPY --chown=mercury:mercury .pack[s] ./.packs/` added after the line copying `package.json`); `.gitignore` leaves it out of the repository.

Run it again after packing anew: it replaces the tarballs and the overrides of the previous run, and leaves alone the overrides you wrote yourself. In `.packs/` each tarball is named after its content (`mercury-fw-core-0.38.0-1a2b3c4d.tgz`): Bun doesn't look again at a tarball whose override didn't change, it keeps what its lockfile and its cache hold, so a repack at the same version needs a new name to be installed. `--off` takes the app back to the registry: the overrides it wrote and `.packs/` go, then `bun install`. After either, `mfw start` rebuilds the image with the packages now installed.

```bash
mfw local-packages ../mercury-fw/apps/testbed/.packs
mfw local-packages --off
```

### `mfw e2e [tests...] [--repeat N]`

Runs end-to-end tests against the app's real model: each test case sends its turns to the app's REPL in the container, as `mfw repl` would, or to its HTTP surface as one of the test's users, and checks what each turn did, the tool calls with their inputs and results, and the answer. It's how you find out whether the model actually uses a plugin the way its skill says, at the first try, with the app's own model, configuration, wiki and credentials. That's also why it doesn't belong in CI: the results depend on the model, on what's in the vault and in Qdrant, and on accounts a CI runner shouldn't have.

Without arguments it runs every `e2e/*.e2e.ts` in the app; with files, those (they can live anywhere). It prints every check of every run, keeps everything (each turn's calls and answer, each check) in `e2e/results/<time>/`, which `.gitignore` leaves out, and exits 1 when a case didn't pass. The app must be built and its `.env` filled in, as for `mfw repl`. `--repeat N` runs each case N times, overriding its own `repeat`.

#### Writing a test

A test is a TypeScript file whose default export is `e2e({ … })`, from `@mercury-fw/cli/e2e` (every app has the CLI among its devDependencies, so the types are there):

```ts
import { e2e } from "@mercury-fw/cli/e2e";

export default e2e({
  // What the app must have, by catalog id: checked before anything runs.
  plugins: ["jira"],
  channels: [],
  cases: [
    {
      name: "project key, at the first try",
      turns: ["On Jira, what is the project key of Customer Support?"],
      repeat: 3, // the model isn't deterministic
      minPasses: 3, // how many runs must pass; default every one
      check: (run, expect) => {
        expect.everyCall("jiraCommand", (c) => String((c.input as { command: string }).command).includes("--select "));
        expect.noFailedCalls();
        expect.callCount({ max: 3 });
        expect.answer(/\bCS\b/);
      },
    },
  ],
});
```

Each run of a case gets a fresh REPL session. `check` receives the run, `run.turns` in order and `run.last`, each turn with:

- `calls`: the tool calls, each with `tool`, `input`, `output`, `ok` (false for a failed call, or one that never got a result) and `pending` (an irreversible command staged for confirmation: it worked, and its output holds the token);
- `answer`: the turn's final text (what the model wrote; a list `present` adds afterwards isn't part of it);
- `seconds`: how long it took, for the report.

The `expect` helpers record a named check each and never stop the others, so a failed run shows every check that failed:

| Helper | Passes when |
|---|---|
| `call(tool, match?)` | at least one call to `tool` (matching `match`, when given) |
| `everyCall(tool, match)` | there are calls to `tool`, and every one matches |
| `noFailedCalls()` | no call failed |
| `callCount({ min?, max? }, tool?)` | the number of calls, to any tool or to `tool`, is within the bounds |
| `answer(text \| regex)` | the last answer contains the text, or matches |
| `answerNot(text \| regex)` | it doesn't |
| `that(label, condition)` | `condition` is true |

The call helpers look at every turn of the run, the answer helpers at the last one; each takes an optional label as its last argument. A case that records no check fails: it proves nothing.

A turn can be a function of the one before, for a follow-up or a confirmation: `(previous) => …` returns the next message from `previous.calls` and `previous.answer` (an irreversible command comes back as a call whose output holds the pending confirmation's token, and sending the token as the next turn confirms it). Each turn is one line, as the REPL reads them.

#### On the HTTP surface

A case with `channel: "http"` sends its turns to the app's HTTP surface instead, as one of the test's `users`: each is a name and a token the app's auth provider accepts (with `static`, one of `AUTH_STATIC_TOKENS`). The app's service has to be running (`mfw start`); the surface's URL is the port compose publishes. A turn can name its own user, so one case can stage an action as Alice and try to confirm it as Bob in the same conversation id:

```ts
export default e2e({
  users: { alice: "alice-test-token", bob: "bob-test-token", stranger: "not-a-token" },
  cases: [
    {
      name: "no token, no turn",
      channel: "http",
      as: "stranger",
      turns: ["hi"],
      check: (run, expect) => expect.that("refused with 401", run.last.status === 401),
    },
    {
      name: "Bob can't confirm what Alice staged",
      channel: "http",
      as: "alice",
      turns: [
        "Delete the issue SUP-1 on Jira",
        { text: (previous) => (previous.calls.find((c) => c.pending)?.output as { token: string }).token, as: "bob" },
      ],
      check: (run, expect) => expect.answerNot("Confermato"),
    },
  ],
});
```

Each run of an HTTP case is a conversation of its own. A turn also has the response's `status` (200, or 401 for a refused token). The event stream carries no tool results, so on HTTP a call's `input` is the line the surface shows for it (the command, for a CLI tool) and its `output` is there only for a call staged for confirmation, with the token, as on the REPL. A turn may span several lines.

To see what happens when people talk at the same time, an HTTP case can have `lanes` instead of `turns`: every lane sends its own turns in order, as its own user (`as`, or the case's), while the other lanes send theirs. Each lane gets a conversation of its own, unless lanes name the same `conversation`, which sends their turns at once on one conversation id, like two tabs on one chat. In the check, `run.lanes` holds each lane's run, and `run.turns` every turn, lane by lane:

```ts
{
  name: "Alice and Bob at once",
  channel: "http",
  lanes: [
    { as: "alice", turns: ["Remember: tamarind. Reply OK.", "What word did I give you?"] },
    { as: "bob", turns: ["Remember: persimmon. Reply OK.", "What word did I give you?"] },
  ],
  check: (run, expect) => {
    expect.that("Alice gets hers", run.lanes![0]!.last.answer.includes("tamarind"));
    expect.that("Bob gets his", run.lanes![1]!.last.answer.includes("persimmon"));
  },
}
```

`before`, `after` and `check` also get `cli(command)`, which runs `sh -c command` in the app's container, outside the model, and resolves to its exit code and output: to prepare data (an issue to work on, a note in the wiki with the vault CLI), to check what a turn changed (`jira issue get KEY --select fields.assignee.displayName` after an assignment), to clean up. `after` runs even when the run or the check failed. A test that changes an external system has to clean up after itself, so start from read-only ones.

#### What it can and can't test

It can test how the model uses a plugin through its skill (the commands and flags it picks, rejected or failed calls, how many calls it takes), what the answer says or must not say, what a turn changed in an external system, the confirmation of an irreversible command, conversations over several turns, several plugins working together, and what the wiki and memory make of a conversation.

It can't test how Google Chat shows a turn (its cards), the background jobs (the nightly wiki review, idle-session capture), or the exact wording of an answer: checks look for properties, and `repeat` with `minPasses` says how steady the behaviour is. Durations are in the report and in `e2e/results/`, never a check.

```bash
mfw e2e
mfw e2e e2e/jira.e2e.ts --repeat 3
```

### `mfw upgrade`

Installs the registry's latest `mfw` globally (`bun add -g @mercury-fw/cli@<latest>`) when it's newer than the one running, and says it's already the latest otherwise; a registry that doesn't answer exits 1. It's about the global `mfw` only: an app's framework, its own CLI included, moves with `bun update` in the app. `mfw create` run by a stale global `mfw` creates the app with the latest one anyway, and says to run this.

```bash
mfw upgrade
```

## Help

`mfw --help` lists every command, and `--help` after any of them describes it, down to the subcommands (`mfw vault write-curated --help`). A mistyped command gets a suggestion (`mfw strat` → "Did you mean start?"). Every argument is checked before anything runs: a wrong one exits 1 saying why, with no container started.

MIT
