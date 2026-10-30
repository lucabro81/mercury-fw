---
name: create-changeset
description: Create a changeset file for the current changes. Use when the user asks to create/add/write a changeset, or when a branch reaches the point where its changeset is due (before the review gate). Does NOT run `bun run release`, bump versions or publish — only writes the markdown file in .changeset/.
---

## Goal

Write a changeset markdown file in `.changeset/` that describes the current changes. Its text becomes the public changelog: the package's `CHANGELOG.md`, the GitHub Release and the docs site. Never bump versions and never publish — this skill only creates the file.

---

## Process

### 1. Identify the changed packages

Run `git diff main...HEAD --stat` (plus `git status` for uncommitted work) and map the changed files to packages through each `package.json` `name` field (`@mercury-fw/core`, `@mercury-fw/channel-http`, not `core`). Only public workspaces get an entry: a `"private": true` one (the docs site, the test bed, the skill trainer) gets none.

Name only the packages the diff actually touches. The framework's `fixed` group (`.changeset/config.json`) moves together anyway, so touching `@mercury-fw/cli` alone still releases the whole group; plugins, channels and auth providers are versioned on their own and get an entry only when they change.

If the changes only touch private workspaces or repo tooling, say no changeset is needed.

If the branch bundles unrelated changes, write one file per logical change. Check the unreleased `.changeset/*.md` files already on the branch (not `config.json`, not `README.md`): extend the one that covers a change instead of writing an overlapping one.

### 2. Determine bump type per package

- **major** — never without a dedicated issue deciding it
- **minor** — something new: a config field, a command, an export, a contract field, a behaviour a user turns on
- **patch** — a fix, a docs or text change, an internal change with nothing new to use

If genuinely unclear, ask rather than guess.

### 3. Write the summary

One bullet per change, in English:

```markdown
- <what changed>
- <what changed> (fixes <the problem>, only when that isn't obvious)
```

**Only what the package adds, removes or changes for whoever uses it. Nothing else.** One bullet per change, stated as the behaviour that is now different. No mechanism, no implementation, no rationale, no "because", no what-it-was-before, no numbers from the investigation, no caveats. Those live in the code comments and in the commit bodies.

The test for every bullet: **does it name something an app, a plugin author or a person talking to Mercury can now do, can no longer do, or gets differently?** If it explains *how* or *why*, cut it.

**Telegraphic, written for someone who knows Mercury.** Short lines, no explanations. Name config fields, commands, flags, exports, contract fields and message keys outright — `version`, `mfw create`, `ctx.appVersion`, `core.resume.gone` — rather than paraphrasing what they do.

```
✅ add `version` to `mercury.config.ts`, handed to channels as `ctx.appVersion`
✅ `mfw create`: new apps declare `version: pkg.version`
✅ `GET /version` shows the app's version under `app.version`
✅ a skill read in an earlier turn is read again before its tools are used
✅ `POST /turn { resume: true }` with nothing left to resume: the `final` says the answer is gone (`core.resume.gone`)
❌ Mercury only shows that number: moving it is up to the app (by hand, with Changesets, or with a script before pushing), and a new one shows once the app is rebuilt.
❌ With the generic note of the other calls, the model rarely read a skill again in later turns and guessed the commands it names instead.
❌ The core hands it to the channels as `ctx.appVersion`, trimmed and otherwise as written; left out or empty, channels get none.
❌ …instead of an empty one, which a UI shows like any answer; an empty `final` now always means the model had nothing to add.
```

**Never describe the development history.** A commit that fixes a mistake made earlier on the same branch is not a change: describe the resulting behaviour, not the path taken to it.

**Public text.** No `D-XX`, `S-XX`, milestones, issue-internal context.

What an existing app must or can change to get the new behaviour (template changes reach existing apps only through the changeset) goes in a `**Migration:**` bullet: what to change and how, still without the why.

```
✅ **Migration:** to show the app's version, add `import pkg from "./package.json";` and `version: pkg.version,` to `mercury.config.ts`
```

An incompatible change gets a `**Breaking:**` bullet naming what changed and, after a colon, how to migrate.

```
✅ **Breaking:** channel contract 3, `confirm` and `resolveConfirmation` take a `Principal`: pass the caller's; channels written for contract 2 are refused
```

### 4. Create the file

`.changeset/<descriptive-kebab-slug>.md`:

```markdown
---
"@mercury-fw/core": minor
"@mercury-fw/channel-http": minor
---

- <what changed>
- <what changed>
```

### 5. Confirm

Show the created file's path and content. Do NOT run `bun run release`, `changeset version` or any publish command — this skill stops at file creation.
