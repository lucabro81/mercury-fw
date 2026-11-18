---
name: mercury-plugin
description: How to write a plugin for this Mercury app (a tool, a CLI tool, a memory, a context strategy, a channel, an auth provider, a directory, a trace sink, a store). Load it before creating or changing anything under plugins/.
---

# Writing a Mercury plugin

A plugin is how the agent gets to do something, or how the app gets a piece it's made of: a channel, an auth provider, a store. Each one is a package under `plugins/<name>`, written against `@mercury-fw/kit`, the plugin contract.

## Start from the scaffold

Never write a plugin from an empty folder. From the app's folder:

```bash
bunx mfw plugin create <kind> <name>
```

`<name>` is lowercase words joined by hyphens (`guest-wifi`). The kinds:

- `tool`: typed tools the model calls, each with its input schema;
- `cli`: a tool running a pinned command-line program through an allowlist (`--cli-binary`, `--cli-repo`, `--cli-version`);
- `memory`: what the agent keeps from each turn and session, and a context layer reading it back;
- `context-strategy`: a context profile's conversation, what the model reads of it;
- `channel`, `auth`, `directory`, `trace-sink`, `vector-index`, `conversation-store`: the other pieces an app declares.

It writes a working package with its tests and a README, adds it to `package.json`, declares it in `mercury.config.ts` when the place is clear (otherwise it prints the two lines to add: add them), and runs `bun install`. Then change the example code into the plugin's own, keeping the shape.

## The contract, in short

- `apiVersion` is a number literal, the contract version the plugin is written for. Never import the `*_API_VERSION` constant into it: that reports the installed contract, not the one the code was written for.
- `name` is the plugin's name: its texts' keys start with it, and it can't be `core` or `app`.
- `description` (tool, CLI and memory plugins, context strategies) is one sentence the model reads to know what the agent can do. Required.
- `actsAs` says whose identity a tool uses at its service: `"anyone"` (nobody's, no login), `"person"` (each person logs in to it), `"mercury"` (the instance's own account, offered only to people allowed to make the agent act as itself).
- `build(ctx)` runs once at startup. It reads its settings from `ctx.env`; when one is missing it logs why (`ctx.log`) and returns `{}`: the agent starts anyway, without it. A channel, auth provider, directory, trace sink or store throws instead, and the core leaves it out, closed.
- `sessionTools(sctx)` returns the tools, by name. A tool never throws: it returns `{ ok: true, ... }` or `{ ok: false, error }`, and the model reads the error.

## Rules

- **Irreversible actions wait for the person.** A tool that deletes, sends or changes something calls `sctx.stageConfirmation({ describe, run })` and returns `{ ok: false, pendingConfirmation: true, token, summary, error }`; the core runs `run` only when the person confirms. Never let the model decide on its own that something is fine.
- **What the model reads is English**: tool descriptions, the skill, `systemPromptFragment`. Use `{{assistant}}` for the assistant's name, never a product name.
- **What the person reads goes in `messages`**, in English, every key under the plugin's name (`guest-wifi.status.list`); the app's `locales/` translate them. Status lines come from `toolStatusDescribers` reading those keys.
- **Settings and secrets come from the environment**, never written in the code. Add each variable to the app's `.env.example`.
- **A memory fails soft**: when its store is empty or unreachable it logs and goes on, never failing a turn. Background model work goes through `ctx.job`.
- **A skill** (`skills/<name>/SKILL.md`, loaded with `parseSkill`) tells the model how to use the tools: which to call first, never guessing ids, what to do on `ok: false`. Keep `description` to one line; the body loads only when needed.

## Checking it

- `bun run test` runs every plugin's tests; `bun run typecheck` checks the types. Both must pass.
- `bunx mfw restart`, then `bunx mfw logs`: the plugin loads, or the log says why it doesn't (a missing setting, a wrong `apiVersion`).
- `bunx mfw repl` to try it; an e2e test in `e2e/` and `bunx mfw e2e` to check what the real model does with it, several runs each.

## More

The documentation: https://lucabro81.github.io/mercury-fw/, *Writing a plugin* under Concepts, and the contract reference under Reference.
