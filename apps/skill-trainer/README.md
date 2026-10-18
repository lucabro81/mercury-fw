# Skill trainer

Scores a plugin's skill on the model Mercury actually runs, and, once the SkillOpt bridge lands (#246), trains it. Each training task runs as a real Mercury turn: the core composed with only the plugin under training, the model from this folder's env file, the plugin's CLI replaced by fixtures that answer for it, so nothing reaches a real service and the same task gets the same data every time.

It's private: it lives in this repo, works on the plugins in this repo, and never goes to npm.

## Table of contents

- [Before you start](#before-you-start)
- [Running a plugin's tasks](#running-a-plugins-tasks)
- [What a plugin provides](#what-a-plugin-provides)
- [Fixtures](#fixtures)
- [Tasks and scores](#tasks-and-scores)

## Before you start

- An Ollama-compatible endpoint with the model you want to score pulled.
- `bun install` done at the repo's root.
- `.env.example` copied to `.env` in this folder and filled in: `OLLAMA_HOST` and `OLLAMA_MODEL` for the model, `OLLAMA_THINK=false` for a model without Ollama's extended thinking. `QDRANT_URL` points somewhere that refuses at once (memory beyond the conversation isn't used), and the variables a plugin needs to build (`JIRA_SITE_URL` for Jira) can be any value, since its CLI never runs.

Every command below runs from `apps/skill-trainer`: Bun reads `.env` from the folder the command runs in.

## Running a plugin's tasks

```bash
bun src/bin.ts run jira
bun src/bin.ts run jira --split val
bun src/bin.ts run jira --task open-issues-count --skill /tmp/candidate.md
bun src/bin.ts run jira --json /tmp/results.json
```

`run` sends every task of the plugin (or those of `--split`, or those named by `--task`, in that order) once, prints each task's checks and the commands no fixture answered, then the scores. `--skill` swaps in a candidate: its body alone, or a whole `SKILL.md` whose name and description are the skill's own (the description isn't trained, since it decides whether the model loads the skill at all, so a candidate with another one is refused). `--json` also writes the results to a file, turns and calls included; it's a file and not stdout because the core logs there too.

The process runs with a throwaway home folder, so composing Mercury never links anything into yours, and each task gets a fresh conversation on a throwaway vault, removed when the task ends.

## What a plugin provides

Its training data sits next to its code, in `packages/tools/plugin-<name>/skill-training/index.ts` (`run jira` reads `packages/tools/plugin-jira/`). The folder stays out of the plugin's npm package: `files` in its `package.json` doesn't name it, and `scripts/check-pack.ts` knows it's repo-only.

The default export is a `SkillTraining` (`src/contract.ts`):

- `skill`, the name of the skill to train, one of the plugin's `skills`;
- `plugin(runCliFn)`, the plugin built on the CLI runner it's handed (`createJiraPlugin({ runCliFn })`);
- `fixtures`, what that runner answers;
- `tasks`.

## Fixtures

A fixture answers one command, matched on the parsed argv and not on the line, because the model writes the same command many ways (flag order, quoting, `--flag=value`):

```ts
{
  command: ["issue", "search"],
  flags: { "--select": /issues\.key/, "--page-token": false },
  result: { ok: true, data: { issues: [{ key: "KAN-1" }], issueCount: 1 } },
}
```

`command` is the leading tokens, `args` conditions on the positionals after it, `flags` conditions on flags (`true` present, `false` absent, a string the exact value, a pattern the value matching), and `result` what the CLI answers, a failure included (`{ ok: false, error, exitCode: 3 }` is a CLI that isn't logged in). The first fixture that matches wins: a task's own `fixtures` come before the plugin's, so a task can make the same command answer differently.

A command no fixture answers fails the way a CLI fails an unknown command (exit code 2), and the report lists it. A run with unmatched commands says more about the fixtures than about the skill, so fill those holes before reading the scores.

## Tasks and scores

A task is an e2e case run on fixtures: `turns` sent in one conversation (a turn can be a function of the one before it), and a `check(run, expect)` with the same `expect` as [`mfw e2e`](../cli/README.md). It also has an `id` (it names files, so letters, digits, `.`, `_` and `-`), a `split` (`train`, `val` or `test`) and a `taskType`, which SkillOpt samples by.

`hard` is 1 when every check passed and 0 otherwise, `soft` is the fraction that passed. A task that checks nothing scores 0, and so does one whose turn fails (the error is in the result). Checks on the answer's exact wording make a noisy score, so check calls, their arguments and the facts the answer has to contain.
