## Working protocol

The plan for every unit of work lives in its GitHub issue (see Development workflow): the source of truth for scope and decisions, and it outlives the PR. This file covers only stack and conventions, it doesn't duplicate planning. If the scope or a past decision isn't clear from the issues, ask instead of guessing.

## Development workflow

Every unit of work — a decision, a feature, or a bugfix — starts as a GitHub
issue and ships through its own branch and PR. Nothing goes straight to `main`.
This workflow is the single source of truth; the plan for a unit of work lives
in its issue and never restates it.

1. **Issue first.** Open a GitHub issue before writing code. The decided plan
   lives as a comment inside that issue — it's the source of truth and outlives
   the PR.
2. **Branch from the issue.** Create the working branch from the ticket with
   GitHub's own "create a branch" feature — `gh issue develop <n> --base main
   --name feat/<n>-<slug>` — so branch and issue stay linked. Never commit to
   `main` directly.
3. **TDD on the branch**, atomic commits, one changeset per issue; open a PR
   with `Closes #N`.
4. **Cold-review gate.** Before merge, run the `cold-reviewer` subagent
   (`.claude/agents/cold-reviewer.md`) over the change — it sees only the issue
   text and `git diff main...HEAD`, no conversation context. Report its findings
   and resolve them in-branch.
5. **Merge on approval:** squash-merge (the issue auto-closes), sync `main`,
   delete the branch.
6. **Close the loop.** At the end of each unit of work, update project memory
   with anything worth carrying to a future session, and bring `README.md` in
   line with the change whenever it affects what the README documents.

Bugfixes still follow the TDD rule below: discuss the root cause first, then a
regression test that fails before the fix and passes after.

## What it is

Mercury is a framework for building your own agent, published on npm as `@mercury-fw/*`: an app declares its plugins, channels, auth provider and persona in `mercury.config.ts`, and `@mercury-fw/core` runs the rest. Apps are scaffolded with `bun create mercury-agent` (`mfw create`) and live in repositories of their own, the production instance included. This repo holds the framework, the first-party plugins and channels, the CLI, and a test bed (`apps/testbed`) where a change is tried live before it's published.

## Stack

- Runtime: Bun + TypeScript
- Tool calling: Vercel AI SDK — no agent framework on top (no LangChain, LlamaIndex, Mastra, etc.)
- LLM: Ollama-compatible endpoint, always via `OLLAMA_HOST`, never hardcoded
- Vector store: Qdrant
- External integrations: plugins; the first-party ones wrap a pinned CLI binary per service (separate repo) through `@mercury-fw/cli-engine`
- Container: Docker, single container, Debian base (`oven/bun:1`) — not Alpine, see Operational notes below

## Non-negotiable principles

1. **Capabilities come from plugins.** Whatever the agent can do, a plugin contributes it; the core knows no service. A plugin built on a CLI uses `@mercury-fw/cli-engine`, and that engine's rules apply to it (see What NOT to do).
2. **No agent framework.** Custom orchestration on top of Vercel AI SDK only.
3. **Memory, as it stands today, has three layers** (in-context history, the wiki, the episodic store on Qdrant). History is required; the rest is enrichment that must fail soft when empty or unreachable. How memory becomes composable is open in #30.
4. **Stateless container.** Anything that must survive a restart lives on an explicit external volume, never only in-process.
5. **Irreversible actions require explicit confirmation.** An explicit one-time token the user has to send back — never a "probably fine" inferred by the model, and never a keyword the model has to relay or the user has to remember. Mercury is a registered Chat app on Google Chat, so confirming there is a button click on the card Mercury sends; on the terminal it's pasting the bare token back. Same underlying token/store mechanism either way.

## What NOT to do

- Don't add heavy dependencies (frameworks, alternative vector stores, message brokers) without flagging it first
- Don't let `@mercury-fw/cli-engine` run a real shell (`sh -c`, pipes, redirects, chaining) — for a CLI-based plugin the model writes a command as free text, but the engine tokenizes it into an argv array itself (`packages/libs/cli-engine/command-parser.ts`) before spawning, and only binaries with a maintainer-authored, schema-valid config file (each plugin ships its own `<binary>.json`, validated by `@mercury-fw/cli-engine` when the plugin loads) whose argv matches an allowed prefix ever execute — a prefix marked `confirm: true` in that file is staged instead of run directly, and only executes once the exact token Mercury hands back comes in on its own — a card-button click on Google Chat, a bare pasted token on the terminal, no keyword required
- Don't assume where the LLM endpoint runs — always via `OLLAMA_HOST`

## Repo structure

Monorepo (Bun workspaces + Turborepo). The framework runtime is `@mercury-fw/core`
(`packages/libs/core`); the plugins and channels are siblings under `packages/`.
There's no instance in the repo: apps are scaffolded into their own
repositories. A change is tried live in the test bed (`apps/testbed`, a private
workspace): `bun run create <name>` there makes an app with this repo's
`mfw create` under `apps/testbed/apps/<name>` (ignored by git, outside the
workspace globs), installing this repo's packages packed as they'd go to npm
(`mfw local-packages`), so it runs the unreleased code in the scaffolded
Dockerfile with real credentials, and `mfw e2e` checks what its model does.
The procedure is in `apps/testbed/README.md`.

`apps/cli` is the Mercury CLI (`@mercury-fw/cli`, bin `mfw`): `mfw create
<folder>` writes a new app from its `template/` plus a hand-written catalog of
the first-party channels and tool plugins, with the framework at the CLI's own
version and each chosen plugin at its latest on the registry, then runs
`bun install` and commits the app to a new git repository (`finish.ts`;
`--no-install`, `--no-git`, `--git-remote`, nothing pushed). Every other command operates an app from
inside its folder (`app/`: `start`/`stop`/`restart`, `logs`, `repl`, `shell`,
`vault`, `memory`, `reset`, `credentials set|reset`, `google-chat set-key`, `local-packages`, `e2e`), as `docker compose` calls (or env-file writes, or a REPL session driven through `/dump` for `e2e`); `mfw` is installed
globally (`bun add -g @mercury-fw/cli`, `mfw upgrade`); an app also gets the CLI as a
devDependency at the framework's version, and inside an app a global `mfw` at another
version hands the command over to it (`MFW_DEFERRED`), so the app's commands match its framework. No "plumbing" commands mirroring
compose: whoever wants that uses compose directly. The command line is declared
with commander (`program.ts`): arguments are validated and help is generated at
every level, so a new command is a `program.command(...)` plus its function in
`app/commands.ts`. `apps/create-mercury-agent` is the same command
under the `bun create mercury-agent` name.

```
mercury/                       # repo root
├── CLAUDE.md                  # these conventions — apply to every workspace
├── README.md
├── turbo.json
├── .changeset/                # repo-level release state
├── scripts/                   # release tooling: release.ts (versions + tags), publish.ts (types + pack check + bun pm pack + npm publish), build-types.ts, check-pack.ts, workspaces.ts
├── packages/                  # grouped into per-role buckets; every workspace is @mercury-fw/*
│   ├── types/
│   │   ├── plugin-types/          # the shared Plugin contract (tools) — types + apiVersion + skill/status helpers, imported by core and plugins
│   │   └── channel-types/         # the shared ChannelPlugin contract (channels) — Provider/TurnSink + confirm helpers, imported by core and channels
│   ├── channels/
│   │   ├── channel-google-chat/   # Google Chat channel plugin: the registered-app transport (Pub/Sub + REST), loaded by the channel loader
│   │   └── channel-http/          # HTTP channel plugin: the opt-in conversational HTTP surface (SSE /turn, /confirm, read routes, OpenAPI) for a custom UI; needs an auth provider
│   ├── auth/
│   │   ├── auth-oidc/             # auth provider: verifies an OpenID Connect bearer token (issuer's JWKS via jose) into a Principal
│   │   └── auth-static/           # auth provider: a fixed token→principal map from AUTH_STATIC_TOKENS, for the test bed and e2e
│   ├── tools/
│   │   ├── plugin-jira/           # Jira plugin: allowlist, SKILL.md, issue-list extractor + the typed kinds of list it emits (JiraDisplays), pinned CLI binary
│   │   ├── plugin-bitbucket/      # Bitbucket plugin: allowlist + pinned CLI binary (the minimal plugin shape)
│   │   └── plugin-atlassian-admin/ # atlassian-admin plugin: allowlist + pinned CLI binary (read-only)
│   ├── formatters/
│   │   └── formatter/             # @mercury-fw/formatter — applies an instance's per-kind rules to the lists a data plugin emits (formatterPlugin + formatter); holds no format of its own
│   ├── libs/
│   │   ├── core/                 # @mercury-fw/core — the framework runtime: composeMercury + loaders + engines wiring + turn pipeline. See its own tree below
│   │   ├── kit/                  # @mercury-fw/kit — the plugin-authoring facade: re-exports plugin-types + channel-types (the future SDK #27 lands here). Apps consume core; authors consume kit
│   │   ├── cli-engine/            # the CLI-execution mechanism (parser/executor/allowlist) every CLI plugin builds its tool with
│   │   ├── confirm-engine/       # the core-owned confirm mechanism (store + stage + resolve), consumed by the core, injected into channels
│   │   └── utils/                 # shared dependency-free helpers: CLI-binary provisioning, the CLI login folder a plugin declares (`mercury.cliCredentials`)
│   └── config/
│       └── typescript-config/     # the shared Bun tsconfig every workspace extends
└── apps/
    ├── create-mercury-agent/     # what `bun create mercury-agent` runs: `mfw create`, nothing of its own
    ├── cli/                   # @mercury-fw/cli — program.ts (the command line, commander), `mfw create <folder>`: catalog.ts (channels/auth providers/plugins it offers), render.ts (template + selection → files), write.ts, wizard.ts (@clack/prompts), finish.ts (install + first commit), template/*.tpl (static files, imported as text); app/ (find-app.ts, commands.ts: the commands that operate an app; credentials.ts: packing a CLI's config folder into its env variable; local-packages.ts); e2e/ (the e2e test format, runner, and the REPL and HTTP sessions behind `mfw e2e`, `@mercury-fw/cli/e2e`)
    └── testbed/               # private: create.ts/pack.ts make apps under apps/ (ignored) on this repo's packed packages; tests/example.e2e.ts, a template; README.md, the procedure
```

Naming: every workspace is `@mercury-fw/*`. The role is read from the bucket
folder plus the name prefix (`plugin-*`, `channel-*`, `*-types`), not encoded
again in the name. Workspace names must be unique repo-wide — the folder doesn't
namespace them.

The framework runtime an app's entrypoints call into lives in `@mercury-fw/core`
(`packages/libs/core/src`), config-agnostic — `composeMercury(config)` takes the
instance's config as a parameter, it never imports a `mercury.config.ts`:

```
packages/libs/core/
├── index.ts                 # public barrel — composeMercury, defineMercuryConfig, the loaders, createTerminalProvider
└── src/
    ├── compose.ts            # builds the instance from the config it's given (model/tools/memory/turn pipeline); returns handleTurn + deferred start closures
    ├── model/                # Ollama provider, real context-window lookup
    ├── session/               # Layer 1 history + summarizer + agent-turn loop
    ├── config/               # defineMercuryConfig + the MercuryConfig contract (plugins, channels, persona)
    ├── tools/                 # CLI executor + command parser/allowlist (cli-tool.ts) + config schema/loader/version-check
    ├── plugins/               # generic fail-soft tool-plugin loader (plugin-loader.ts) + the formatter decorator
    ├── router/
    │   ├── turn-runner.ts      # shared per-turn driver every provider funnels through, one turn at a time per session
    │   ├── session-lock.ts     # the per-session queue the turn runner and the idle sweep share
    │   ├── channel-loader.ts   # generic fail-soft channel-plugin loader — turns the hand-listed channel set into started providers
    │   ├── auth-loader.ts      # builds the declared auth provider into the `authenticate` channels get; fail-soft and closed (no provider ⇒ HTTP doesn't start)
    │   ├── terminal.ts         # the REPL loop (stdin/stdout), driven by the app's repl.ts — a dev console, not a channel
    │   └── tool-log.ts         # terminal-only debug visibility helpers
    ├── identity/              # who sees what, decided in one place: the user key (`<provider>:<id>`), a person's vault area (`users/<key>/`, `personal/` to the model) and its access checks, the per-person channel reads, the startup migration of pre-key data
    ├── credentials/           # unpacks each plugin-declared CLI login from the env file onto the volume (~/.config) at startup, linking one declared elsewhere in the home
    ├── memory/                # Layer 3 — episodic store (Qdrant)
    ├── wiki/                  # Layer 2 — vault init/read/write (common `curated/` + per-person `users/<key>/`) + vault-cli.ts (maintenance CLI, see Operational notes)
    └── cron/                  # idle-session scanner
```

## Versioning & changelog

SemVer via [Changesets](https://github.com/changesets/changesets); every package's `CHANGELOG.md` is public, same audience as the READMEs.

- **The framework moves in lockstep**: the Changesets `fixed` group (`.changeset/config.json`) holds core, the contracts, kit, cli-engine, confirm-engine, utils, formatter, the CLI and `create-mercury-agent`, so they always share one version, tagged `vX.Y.Z`. **Plugins, channels and auth providers are versioned on their own** (tagged `<name>@<version>`): their `@mercury-fw/*` dependencies are `peerDependencies` over the whole `0.x` line (`workspace:*` as devDependencies for local development), because the real compatibility gate is `apiVersion`, checked at load time. The reference app `mercury` is private and outside the group.
- Everything follows the latest minor of its current major: caret ranges for npm dependencies (refreshed with `bun update`, never `--latest`), `bun-version: "1.x"` and `node-version: "24"` in CI, actions on their major tag, images on their major tag (`oven/bun:1`, `qdrant/qdrant:v1`). `devEngines` asks for Bun `^1.4.2` because Turbo refuses a `devEngines.packageManager` without a version. A major upgrade is never part of that: each one gets its own issue, its changelog read and its own verification. An exact pin only once an update breaks something, with the reason next to it.
- No exact pins on external dependencies: caret ranges, and `bun.lock` is what makes the repo reproducible. A published package with a pinned dependency can't share it with the rest of the app (that's how two `@ai-sdk/provider` copies broke a scaffolded app's typecheck).
- Every relevant change gets a changeset: `bun run changeset`, naming the packages it actually touches. Changeset descriptions are public text: no `D-XX`/`S-XX`/milestone references, no internal-only context.
- No batching: consume each changeset right after the change it documents, with `bun run release` from the repo root (`changeset version`, lockfile refresh, commit, tags; see `scripts/release.ts`), then push with tags.
- Publishing happens in CI (`.github/workflows/publish.yml`, #63, #67): every push to `main` touching a `package.json` runs typecheck and tests, then `scripts/publish.ts`, which builds the type declarations, runs `check-pack --types`, packs each public workspace whose version isn't on the registry yet with `bun pm pack` (it rewrites `workspace:*`) and publishes the tarball with `npm publish` (so only a pushed release publishes anything). No token anywhere: npm's trusted publishing lets `publish.yml` publish through OIDC, and it needs `npm publish`, which `bun publish` isn't. Every published package already has its trusted publisher. A brand-new package (a new plugin) can't be trusted before it exists, so its first version is published by hand, then a maintainer runs `npm trust github <package> --file publish.yml --repo lucabro81/mercury-fw --allow-publish --yes` after `npm login` (2FA, npm 11.15.0 or later), from outside the repo: inside it npm reads the root `devEngines` (Bun) and refuses to run. Only `main` publishes; a dispatch defaults to a dry run, which packs everything and runs `npm publish --dry-run`, no credentials needed. Binding the publisher to a main-only environment is #71. Not triggered by tags: GitHub drops tag events when more than three are pushed at once. Locally, `bun run publish-packages` is for rehearsals only. Never `changeset publish` or `npm publish` on a workspace folder: both leave `workspace:*` in the published manifests. Rehearse against a throwaway Verdaccio with `--registry`; Bun caches packages by `name@version`, so clear it (`bun pm cache rm`) before reinstalling a version republished there.
- Packages ship their TypeScript source (Bun runs it) plus declarations in `dist/`, built only at publish time and never committed. Inside the repo a `@mercury-fw/*` import resolves to the source through the `mercury-fw-source` condition (shared tsconfig); an app's `tsc` reads `dist/*.d.ts` through `types`.

## Operational notes

- **An app runs via Docker, not on the host**: `mfw start` (`docker compose up -d --build`) is the normal workflow, not just deployment. The running service is headless (channels + crons, shuts down on SIGTERM); for an interactive session use the dev REPL: `mfw repl`. To run this repo's unreleased code, use a test bed app (`apps/testbed/README.md`): inside one, `bunx mfw` runs the app's own CLI, which is this repo's
- Full install/run/deploy commands live in [README.md](README.md) and the CLI's README, not duplicated here — this file covers stack and conventions only
- `OLLAMA_HOST` in dev points to `http://host.docker.internal:11434` (Ollama runs on the host, never inside the container)
- Bun executes `.ts` natively (transpiles at runtime, zero build step) — `tsconfig.json` has `noEmit: true` on purpose. `bun run typecheck` (`tsc --noEmit`) is the separate gate for type validation, which Bun doesn't do at runtime. `bun run test` from the repo root runs every workspace's suite through Turborepo; each package's tests live next to its code (a plugin's tests in its own package), so `bun test` inside one package runs just that package's
- **Base image is Debian (`oven/bun:1`), not Alpine — reopens D-13.** The CLI binaries are dynamically linked glibc binaries, not static. Verified twice (x86_64 and arm64 builds): Alpine's `gcompat` shim doesn't implement the full glibc resolver (`__res_init` missing) — the CLIs fail to run on Alpine even with `gcompat` installed, regardless of matching architecture. Confirmed the CLIs run natively on Debian with zero compatibility layer. Image size difference is small (~330MB base vs ~290MB Alpine) since the Bun runtime itself dominates the size, not the OS base — not worth the fragility of chasing partial glibc shims
- `apt-get upgrade` after `apt-get update` in the Dockerfile applies security patches already available in the Debian repos but not yet baked into the base image; some CVEs in `oven/bun:1` currently have no fix published yet (e.g. in `libsqlite3`, `ncurses`, `perl-base`) — checked with `trivy image` (offline scanner via `brew install trivy`, no login required unlike `docker scout`), not exploitable through anything Mercury actually uses
- **Don't `RUN chown -R` on a directory across a separate layer from where its files were created** — it duplicates all that data in the new layer (observed: +65MB for a chown that touched already-copied `node_modules`). Use `COPY --chown=user:group` on each copy, and append `&& chown -R user:group <dir>` to the same `RUN` that creates the files (e.g. `bun install`), not a separate step
- `env_file: - path: .env / required: false` in compose prevents `docker compose config` from failing when `.env` doesn't exist yet (only `.env.example` is versioned)
- **Wiki vault and memory maintenance**: `mfw vault <command>` and `mfw memory <list|read>`. The vault and Qdrant's data are Docker named volumes, not host paths, so both run in a one-off `docker compose run --rm -T mercury` container, executing the core's own CLIs by path (`bun node_modules/@mercury-fw/core/src/wiki/vault-cli.ts`, `…/src/memory/memory-cli.ts`), not as package bins: the image runs `bun install` before copying the sources, and Bun doesn't link a bin whose file isn't there yet. Vault commands: `list`, `read <path>`, `grep <pattern>` (case-insensitive; paths are always vault-relative, including the leading `curated/` — matches what `list` prints), `write-curated <curated/...path.md> [--author NAME]`, `write-raw <raw/...path.md>` (body read from stdin). Thin routing only, reusing `wiki-note.ts`/`vault-init.ts` as-is. Deliberately does not expose `writeInferredNote`: that writer is reserved for the deterministic D-22 consolidation engine (see its own docstring), a manual CLI writing "agent-sourced" notes by hand would defeat that guarantee. `mfw memory` is read-only.

## Hard-won conventions

- **An unhandled rejection in an un-awaited async loop kills the whole process**, not just the feature it belongs to — every channel/poller's loop body must be wrapped in try/catch and log on failure, never let one bad tick take down the rest of Mercury (observed live: a Google Chat discovery failure took the terminal REPL down with it, since both run in the same process)
- **A long-running spawned process must surface its own exit code and stderr** — a process that dies on its own, silently, is indistinguishable from a clean exit unless you check; whatever the caller awaits has to fail when the exit wasn't caused by the caller's own abort signal, or the feature that spawned it just disappears with no error anywhere (observed live). Nothing spawns a long-running process today — `runCli` is one-shot — but this applies again the moment something does
- **Exit 0 with non-JSON stdout is success, not a parse failure** (`runCli`) — `--help` output is exactly this shape; treating it as an error sent a model into a confused retry spiral on every session that started with `--help` discovery
- **`readline`'s `output` option (needed for arrow-key/history support) must be gated on `stdin.isTTY` alone, not on whether `io.input` was injected** — passing it against a non-TTY-but-real stdin (e.g. a piped exec session) breaks normal input; passing it against a fully detached/closed stdin (a backgrounded container) crashes the process outright
- **A Pub/Sub topic shared across multiple subscriptions delivers every message to every subscriber** — there's no built-in "this subscription only gets its own events" behavior; a per-space pull-subscription *name* is bookkeeping, not isolation. Application code must filter by the event's actual target, or rely on a subscription-level message filter set at creation time (not yet exposed by the CLI as of M1 — see M2's tech-debt list)
- **A Google Chat Cards v2 section's `collapsible` state is client-side only and resets to collapsed on every `spaces.messages.patch`** — confirmed live. Harmless for a card patched exactly twice (loading, then done); broken for one patched repeatedly while streaming, since expanding it mid-stream just snaps shut on the next patch. Don't try to preserve the user's own expand/collapse choice across an in-flight PATCH sequence: patch once, at the end, instead. A section with zero widgets also renders as a near-empty grey sliver, not a visible title — every section needs at least one widget
- **Google Chat's `CARD_CLICKED` event returns the clicked button's declared `onClick.action.function` back as `action.actionMethodName`, not `action.function`** — confirmed live. `function` is never actually populated on the way in, even though it's the field name used on the way out. Relevant only if a future feature adds real interactive buttons again; none are in use as of this pass
- **Ollama's `/api/generate`/`/api/chat` streaming endpoints expose no intermediate loading/prefill event** — checked against the API docs. `load_duration`/`prompt_eval_duration`/`eval_duration` only appear in the final, non-streamed response object, so there's nothing to hook into for a more granular status during that gap, only a single opaque wait for the first real token
- **A post-hoc modification that can REPLACE (not just append to) already-streamed text breaks any code assuming the final result only ever extends what was streamed** — confirmed live: `terminal.ts`'s `result.slice(streamedText.length)` optimization was safe as long as only `spliceFormattedLists` ever appended to the model's text; it produced garbled output once issue-list correction (`turn-runner.ts`) could replace the text outright instead. Check `result.startsWith(streamedText)` before assuming a slice is safe — fall back to printing the full result, clearly marked, when it isn't
- **`sink.onToolStart`/`onToolFinish` (`TurnSink`) accept any caller with its own correlation id, not just real tool execution** — already true before this was ever exercised beyond `buildTools` (Layer-3 capture pings reuse them too), confirmed as a real, reusable pattern when issue-list correction's status indicator reused the exact same mechanism with zero changes to either provider. A new "is this thing in flight" status doesn't need a new `TurnSink` field by default — check whether this pair already covers it first

## **IMPORTANT**

Never add Co-Authored-By lines to commits