# Mercury

Mercury is a framework for building your own agent on Bun and the Vercel AI SDK: you declare what the agent is made of in one config file, and the framework runs everything around it, from the conversation loop to the channels it talks through.

The documentation, from a first agent to the reference, is at [lucabro81.github.io/mercury-fw](https://lucabro81.github.io/mercury-fw/).

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Composing an app](#composing-an-app)
- [Packages](#packages)
- [Versions and compatibility](#versions-and-compatibility)
- [Developing in this repo](#developing-in-this-repo)

## How it works

An agent built on Mercury can do what its plugins let it do and nothing else: each plugin contributes tools to the model, a prompt fragment, skills it loads on demand, and the core composes whatever the app declares. Some plugins work through a command-line tool, and those build on a dedicated library (`@mercury-fw/cli-engine`) that runs the command without a shell and only when it matches what the plugin allows. Channels are plugins as well (Google Chat, HTTP), so the core doesn't know where a message comes from either.

The orchestration sits directly on the AI SDK, with no agent framework in between, and the model is whatever an Ollama-compatible endpoint serves (`OLLAMA_HOST`, `OLLAMA_MODEL`). An action a plugin marks as irreversible never runs on the model's word: Mercury stages it and hands back a one-time token, and it runs only when that token comes back (a button click on Google Chat, the pasted token in the terminal).

Memory, as it stands today, has three layers: the conversation history, a wiki the agent reads and writes, and an episodic store on Qdrant. The history is what the agent needs to work at all, the other two enrich it and fail soft when they're unreachable. How memory becomes composable like the rest is still open ([#30](https://github.com/lucabro81/mercury-fw/issues/30)). Every person gets their own: the wiki has a common area the whole team reads and an area per person, and memory, conversations and pending confirmations are theirs alone (the [core README](packages/libs/core/README.md) has the details).

## Quick start

You need Bun, Docker and an Ollama-compatible endpoint the containers can reach.

```bash
bun add -g @mercury-fw/cli
mfw create my-agent
cd my-agent
cp .env.example .env
mfw start
```

`mfw` is Mercury's command-line tool, installed once (`mfw upgrade` keeps it current). Without a global install, `bun create mercury-agent my-agent` does the same scaffolding and `bunx mfw <command>` runs the rest. `mfw create` asks for the app's name, the assistant's name and role, which channels and which tool plugins to include, then writes an app with exactly that: the config, the persona, a `locales/` folder with an `en.json` for the texts people see (empty, or the starting formatter rules' own texts: `app.jira.no-issues` with Jira), the two entrypoints, a Dockerfile, a compose file with Qdrant, and an env example listing every variable the chosen pieces read. It installs the app and commits it to a new git repository (adding `origin` if you give one, never pushing). Fill in `.env` (at least `OLLAMA_HOST` and `OLLAMA_MODEL`) before starting it.

The service is headless (channels and background jobs); to talk to the agent from a terminal, open the dev REPL:

```bash
mfw repl
```

Inside an app, `mfw` runs the app's own CLI (a devDependency, at the framework's version) whenever the global one is another version: besides starting and stopping the app it follows the logs, opens a shell in the container, reads and writes the wiki, reads the memory on Qdrant and resets either. The [`@mercury-fw/cli` README](apps/cli/README.md) documents every command, and every flag for scaffolding without the questions.

## Composing an app

An app is its `mercury.config.ts`, plus the environment it runs in:

```ts
import { defineMercuryConfig } from "@mercury-fw/core";
import { formatterPlugin, formatter } from "@mercury-fw/formatter";
import { jiraPlugin, type JiraDisplays } from "@mercury-fw/plugin-jira";
import { httpChannel } from "@mercury-fw/channel-http";

const name = "Hermes";

const jiraIssueLine = (issue: JiraDisplays["issue-list"]) =>
  `${issue.key} ${issue.status ? `[${issue.status}] ` : ""}${issue.summary}\n${issue.url}`;

export default defineMercuryConfig({
  persona: {
    name,
    identity: `You are ${name}, the platform team's release assistant.`,
    tone: [
      "DO:",
      "- Answer directly, in plain text only.",
      // …
    ].join("\n"),
  },
  plugins: [
    formatterPlugin(
      jiraPlugin,
      formatter<JiraDisplays>({
        "issue-list": { item: jiraIssueLine, empty: (t) => t("app.jira.no-issues") },
      }),
    ),
  ],
  channels: [httpChannel],
});
```

`plugins` are the tool plugins and `channels` the channels, each active as soon as it's declared: a plugin missing a setting it requires (Jira's `JIRA_SITE_URL`) refuses to load and says why at startup, and a channel left unconfigured stays inert.

A plugin can hand the user a list (Jira does, for `issue search`), and how that list reads is the app's call: `formatterPlugin` wraps the plugin and `formatter` takes one rule per kind of list, the line for each item plus an optional text for an empty list. The kinds come typed from the plugin (`JiraDisplays`), so a kind it doesn't emit fails the typecheck, and a kind left without a rule isn't shown at all (the model still gets the data, and the log says which rule is missing).

`directory` says who the people are and what they may do. Every channel brings an identity of its own (a Google Chat user, the subject of an OIDC token), and the directory turns it into one person with their roles, so someone reaching Mercury from two channels keeps one private area. A person can also link their accounts themselves, with a one-time code they get on one and send from the other, and the operator can with `mfw identity`. Without a directory the person is whoever the channel says, with no roles; with one, the instance talks only to the people it knows (unless `access.unknown` is `"allow"`) and refuses everyone while the directory can't be reached. Plugins act as the person by default, or as no one when they reach a public service with no login: the role `mercury.act-as-self` (or `mercury.act-as-self.<plugin>`) lets someone make Mercury act with its own identity, and `access.plugins` restricts a plugin to some roles.

`persona` sets who the assistant is: `name` is what it's called (Mercury when left out), `identity` opens the system prompt ("You are Hermes, …") and `tone` closes it with the rules on how to answer. Identity and tone are plain strings written in the config, and a field left out falls back to the default; a scaffolded app writes the name once, as a `const` both refer to, and the tone in full, one string per line. Everything between them, the rules tied to the tools, stays with the core. No text the model reads writes a name in: they say `{{assistant}}`, the core puts the persona's name there, and where the one acting is the system around the model they say so, so the model never takes the framework's name for its own.

## Packages

The framework, released together under one version:

| Package | What it is |
|---|---|
| [`@mercury-fw/core`](packages/libs/core) | The runtime: `composeMercury(config)`, the loaders, the turn loop, memory. What an app depends on. |
| [`@mercury-fw/cli`](apps/cli) | The `mfw` command: `mfw create` scaffolds an app, the other commands run it. |
| [`create-mercury-agent`](apps/create-mercury-agent) | What `bun create mercury-agent` runs. |
| [`@mercury-fw/formatter`](packages/formatters/formatter) | Applies an app's rules to the lists a plugin hands over. |
| [`@mercury-fw/kit`](packages/libs/kit) | For plugin authors: the plugin and channel contracts in one import. |
| [`@mercury-fw/plugin-types`](packages/types/plugin-types), [`@mercury-fw/channel-types`](packages/types/channel-types) | The contracts a tool plugin and a channel implement. |
| [`@mercury-fw/cli-engine`](packages/libs/cli-engine) | For plugins that work through a CLI: parsing, allowlist, execution, confirmation staging. |
| [`@mercury-fw/confirm-engine`](packages/libs/confirm-engine), [`@mercury-fw/utils`](packages/libs/utils) | Internals the packages above build on. |

The first-party plugins, channels and auth providers, each with its own version:

| Package | What it does |
|---|---|
| [`@mercury-fw/plugin-jira`](packages/tools/plugin-jira) | Jira through the `jira` CLI: searches, issue changes, typed issue lists, and deletion only after confirmation. |
| [`@mercury-fw/plugin-confluence`](packages/tools/plugin-confluence) | Confluence through the `confluence` CLI, read-only, as the person: searches, pages as Markdown, a page's children and comments, typed page lists. |
| [`@mercury-fw/plugin-bitbucket`](packages/tools/plugin-bitbucket) | Bitbucket pull requests through the `bitbucket` CLI, read-only. |
| [`@mercury-fw/plugin-atlassian-admin`](packages/tools/plugin-atlassian-admin) | User lookup in an Atlassian organization through the `atlassian-admin` CLI, read-only. |
| [`@mercury-fw/plugin-web-search`](packages/tools/plugin-web-search) | Web search through a backend of the app's choice, and the pages it finds, read only on hosts the instance or the person allowed. |
| [`@mercury-fw/web-search-searxng`](packages/tools/web-search-searxng) | A SearXNG instance as the web search plugin's backend; `mfw create` runs one next to the app. |
| [`@mercury-fw/plugin-zitadel`](packages/tools/plugin-zitadel) | ZITADEL users, their project roles and identity provider links, organizations and projects through the `zitadel` CLI, read-only, as the person; and ZITADEL as the user directory. |
| [`@mercury-fw/channel-google-chat`](packages/channels/channel-google-chat) | Google Chat, as a registered Chat app. |
| [`@mercury-fw/channel-http`](packages/channels/channel-http) | An HTTP surface for a custom UI: streamed turns and read-only routes for authenticated callers, plus the open `/version` and OpenAPI document. |
| [`@mercury-fw/auth-oidc`](packages/auth/auth-oidc) | Who is calling the HTTP surface, from a token an OpenID Connect issuer (Zitadel, Google, Keycloak) signed. |
| [`@mercury-fw/auth-static`](packages/auth/auth-static) | Who is calling the HTTP surface, from a fixed map of test tokens: for the test bed and e2e tests. |
| [`@mercury-fw/directory-static`](packages/directories/directory-static) | Who the people are, their identities on each channel and their roles, from a list kept by hand. |

## Versions and compatibility

The framework packages share one version and are released together, so an app picks a single framework version. Plugins and channels are versioned on their own: each declares the framework range it works with as `peerDependencies`, and at load time the core checks the contract version a plugin was written against (`apiVersion`), skipping one it can't run and logging why. While everything is `0.x`, minor releases may break things.

## Developing in this repo

A Bun workspace managed with Turborepo: the framework and the first-party plugins under `packages/` (grouped by role), the CLI and `create-mercury-agent` under `apps/`, and the [test bed](apps/testbed), where a change gets tried end to end before it's published: an app made with `mfw create` that installs this repo's packages packed as they'd go to npm, and `mfw e2e` checking what its real model does with them. The [skill trainer](apps/skill-trainer) scores a plugin's skill on the real model and trains it with SkillOpt, its tasks run as Mercury turns with the plugin's CLI answered by fixtures. The [documentation site](apps/docs) is an Astro + Starlight workspace published after each release (see below): `bun run dev` inside it serves it locally, and `bun run build` then `bun run test:a11y` check every kind of page against WCAG 2.2 AA in both themes, with no broken link.

```bash
bun install
bun run test         # every package's tests
bun run typecheck    # every package
bun run check-pack   # what each package would publish
```

To try the CLI from source, link it once (`cd apps/cli && bun link`) and `mfw create` works from any folder.

Every pull request goes through [CI](.github/workflows/ci.yml): the typecheck, every test, the pack check publishing runs, and the skill trainer's SkillOpt adapter tests. Every change that matters to users gets a changeset (`bun run changeset`), naming the packages it touches. `bun run release` turns the pending changesets into versions, changelogs and tags, and pushing that to `main` publishes it: the [publish workflow](.github/workflows/publish.yml) builds the type declarations, checks every pack and publishes to npm whatever version isn't there yet, through npm's trusted publishing, so there's no token to keep anywhere. Once published, each release's tag gets its GitHub Release ([`scripts/github-releases.ts`](scripts/github-releases.ts)): one per framework version, merging the framework packages' changelogs, and one per plugin or channel release. Then the same workflow publishes the [documentation site](https://lucabro81.github.io/mercury-fw/) on GitHub Pages, built from that release. A new package is the one exception: npm can trust a workflow only on a package that exists, so its first version is published by hand, then `npm trust github <package> --file publish.yml --repo lucabro81/mercury-fw --allow-publish --yes` hands it to the workflow (after `npm login`, npm 11.15.0 or later, run from outside the repo, where the root `devEngines` doesn't make npm refuse). `bun run publish-packages --registry <url>` does the same from your machine, for a rehearsal against a throwaway registry.

## License

MIT
