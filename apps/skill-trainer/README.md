# Skill trainer

Trains a plugin's skill with [SkillOpt](https://github.com/microsoft/SkillOpt), and scores it on the model Mercury actually runs. Each training task runs as a real Mercury turn: the core composed with only the plugin under training, the model from this folder's env file, the plugin's CLI replaced by fixtures that answer for it, so nothing reaches a real service and the same task gets the same data every time. `run` scores a skill on those tasks, `train` has SkillOpt improve it, `compare` says whether a candidate does better than the skill it started from, by more than the model's own noise.

A skill is worth training only when the model gets its tasks wrong often enough to measure an improvement. Jira's wasn't: its first run passed 127 of its 128 tasks (see [Measuring a gain](#measuring-a-gain)), so it was scored and left as it is.

It's private: it lives in this repo, works on the plugins in this repo, and never goes to npm.

## Table of contents

- [Before you start](#before-you-start)
- [Running a plugin's tasks](#running-a-plugins-tasks)
- [What a run is and isn't](#what-a-run-is-and-isnt)
- [What a plugin provides](#what-a-plugin-provides)
- [Fixtures](#fixtures)
- [Tasks and scores](#tasks-and-scores)
- [Training a skill](#training-a-skill)
- [Comparing two skills](#comparing-two-skills)
- [Adopting a trained skill](#adopting-a-trained-skill)
- [Measuring a gain](#measuring-a-gain)
- [SkillOpt](#skillopt)

## Before you start

- An Ollama-compatible endpoint with the model you want to score pulled.
- `bun install` done at the repo's root.
- For `train`, `update-skillopt` and `bun run test:python`, [uv](https://docs.astral.sh/uv/): it fetches SkillOpt and the Python it runs on by itself, nothing installed globally. `run` and `compare` don't need it.
- `.env.example` copied to `.env` in this folder and filled in: `OLLAMA_HOST` and `OLLAMA_MODEL` for the model, `OLLAMA_THINK=false` for a model without Ollama's extended thinking. `QDRANT_URL` points somewhere that refuses at once (memory beyond the conversation fails soft, and nothing waits on it), and the variables a plugin needs to build (`JIRA_SITE_URL` for Jira) can be any value, since its CLI never runs.

Every command below runs from `apps/skill-trainer`: Bun reads `.env` from the folder the command runs in.

## Running a plugin's tasks

```bash
bun src/bin.ts run jira
bun src/bin.ts run jira --split val
bun src/bin.ts run jira --task count-web-open --skill /tmp/candidate.md
bun src/bin.ts run jira --json results/all.json
bun src/bin.ts run jira --split test --repeat 3 --json results/baseline.json
```

`run` sends every task of the plugin (or those of `--split`, or those named by `--task`, in that order) once, prints each task's checks and the commands no fixture answered, then the scores. `--skill` swaps in a candidate: its body alone, or a whole `SKILL.md` whose name and description are the skill's own (the description isn't trained, since it decides whether the model loads the skill at all, so a candidate with another one is refused). `--repeat <n>` runs every task n times, each result carrying its repeat. `--json` also writes the results to a file, turns and calls included, with the run's conditions: the repo's commit and whether the tree had changes, `OLLAMA_MODEL` and `OLLAMA_HOST`, and a hash of the skill body that ran and of the plugin's training data (its `skill-training/` folder, tests left out) (`compare` refuses two runs whose conditions differ in anything but the skill). It's a file and not stdout because the core logs there too. The file (and its folder, when missing) is made or emptied before anything runs, and rewritten as each task ends, so a run cut short keeps the tasks it finished. `results/` is ignored by git, so a run writing there leaves the tree clean for the next one. `--skillopt-out <dir>` also writes what SkillOpt reads of the run (see [SkillOpt](#skillopt)), and doesn't go with `--repeat`, since SkillOpt runs each task once a step; `train` uses it, a person doesn't need to.

The process runs with a throwaway home folder, so composing Mercury never links anything into yours, and each task gets a fresh conversation on a throwaway vault, removed when the task ends (a run interrupted with Ctrl-C leaves both in the system's temp folder).

It exits 1 when no task ran (a split with no tasks, say) or a task couldn't run at all: a plugin that didn't load (the core skips a plugin whose build fails, so without this check the tasks would run without its tool), a model that stopped sending (the core's stall watchdog, `TURN_STALL_TIMEOUT_MS`), an unreachable endpoint. A task that ran and failed its checks is a score, not an error, and exits 0.

## What a run is and isn't

A turn runs as the operator (the terminal's principal) in a one-to-one conversation, which gets every plugin acting as Mercury under its own tool names. A person on a channel gets the plugin acting as them, and in a shared space the multi-user prompt, so the context the skill is scored in is close to production but not identical.

The rest of the turn is the real one, post-turn work included: the tool corrections still run after a turn with a failed call (a model call of their own, and a write to Qdrant that fails against `QDRANT_URL`), and so does the plugin's post-processing (Jira's issue lists).

Confirmations aren't part of a run. On the terminal a pasted token goes to the confirm store before the model sees it; here every turn goes to the model. A task about an irreversible command ends where the skill's part ends: the command staged (a `pending` call) and the token kept out of the answer.

For the same reason a plugin acting as the person never asks anyone to log in: the operator's turns act as Mercury, so a skill's rule about a person's login link has nothing to be scored on here.

A turn's answer is the model's text, as in `mfw e2e`: a list the model shows with `present` is appended to the reply but isn't part of the answer, so check the `present` call rather than the list in the answer.

## What a plugin provides

Its training data sits next to its code, in `packages/tools/plugin-<name>/skill-training/index.ts` (`run jira` reads `packages/tools/plugin-jira/`). The folder stays out of the plugin's npm package: `files` in its `package.json` doesn't name it, and `scripts/workspaces.ts` lists it among the repo-only folders, which the pack check and the type build both leave out (it imports from outside the package, which a declaration build can't take).

The default export is a `SkillTraining` (`src/contract.ts`):

- `skill`, the name of the skill to train, one of the plugin's `skills`;
- `plugin(runCliFn)`, the plugin built on the CLI runner it's handed, wrapped the way an app's `mercury.config.ts` wraps it (Jira's goes behind the formatter with the rule `mfw create` writes, or its lists have no `displayRef` to `present`);
- `fixtures`, what that runner answers: a list, or a function making a fresh one for each task when the fixtures hold state;
- `tasks`.

The plugin doesn't depend on the trainer or the CLI, so its training data imports both the contract and the check types (`Call`, `Expect`, `Run`) from `apps/skill-trainer/src/contract.ts` by a relative path; the plugin's own typecheck covers the folder. Jira's (`packages/tools/plugin-jira/skill-training/`) is the worked example: a made-up Jira (`world.ts`) with a small JQL evaluator (`jql.ts`), printed the way the real CLI prints (`jira-cli.ts`), the tasks (`tasks-basic.ts`, `tasks-hard.ts`) and what they check (`checks.ts`), gathered in `index.ts`; `facts.test.ts` holds the expected counts, issue sets and created keys of the tasks it lists (most of those with a number, a set of issues to find or a create, and the follow-ups that count) against the made-up Jira, with a reference run of the right search or create for each. Its fixtures answer `--help` only for the commands whose help was recorded from the real CLI (search, get, create, transition, assign, comment add, delete): asking for any other shows up as unmatched.

## Fixtures

A fixture answers one command, matched on the parsed argv and not on the line, because the model writes the same command many ways (flag order, quoting, `--flag=value`):

```ts
{
  command: ["issue", "search"],
  flags: { "--select": /issues\.key/, "--page-token": false },
  result: { ok: true, data: { isLast: true, issues: [{ key: "KAN-1" }] } },
}
```

`command` is the leading tokens, `args` conditions on the positionals after it, `flags` conditions on flags (`true` present, `false` absent, a string the exact value, a pattern the value matching), and `result` what the CLI answers, a failure included (`{ ok: false, error, exitCode: 3 }` is a CLI that isn't logged in). The first fixture that matches wins: a task's own `fixtures` come before the plugin's, so a task can make the same command answer differently.

`result` can also be a function of the call (`{ args, positionals, flags }`), to answer the way the CLI would: apply `--select`, page a search, change what a later command reads. A function returning `undefined` passes the command on to the next fixture, and to the unmatched ones when none answers: that's how a fixture says "I can't answer this" (a JQL clause it doesn't read, say) instead of making an answer up.

A command no fixture answers fails the way a CLI fails an unknown command (exit code 2), and the report lists it. A run with unmatched commands says more about the fixtures than about the skill, so fill those holes before reading the scores.

The matcher knows no CLI's schema, so it reads an argv by shape: a token starting with `--` (or `-` and a letter) is a flag, the token after it is its value unless it's a flag itself, anything else is a positional. A flag that takes no value goes in the fixture's `switches` (`switches: ["--unassign"]`), or `--unassign KAN-4` reads KAN-4 as its value. A repeated flag keeps its last value, and a global flag before the subcommand breaks the `command` match. When a command the model wrote reasonably shows up as unmatched for one of these, fix the fixture instead of reading it as the model's mistake. Each answer is a fresh copy of the fixture's `result`, so nothing a turn does to it reaches the next task.

## Tasks and scores

A task is an e2e case run on fixtures: `turns` sent in one conversation (a turn can be a function of the one before it), and a `check(run, expect)` with the same `expect` as [`mfw e2e`](../cli/README.md). It also has an `id` (it names files, so letters, digits, `.`, `_` and `-`), a `split` (`train`, `val` or `test`) and a `taskType`, the kind of task, shown next to its result in the report. `vault` puts notes in the task's throwaway wiki before its first turn, by vault-relative path (`vault: { "curated/projects.md": "The shop is WEB." }`), for a task about what the wiki already knows; a path outside the vault (absolute, or with `..`) is refused before any task runs.

`hard` is 1 when every check passed and 0 otherwise, `soft` is the fraction that passed. A task that checks nothing scores 0, and so does one whose turn fails (the error is in the result). A task needs at least one turn and its first one written as text (a function turn gets the turn before it), and `--task` refuses an id named twice. Checks on the answer's exact wording make a noisy score, so check calls, their arguments and the facts the answer has to contain.

## Training a skill

```bash
bun src/bin.ts train jira
bun src/bin.ts train jira --config my-training.yaml --out results/jira-try-1
```

`train` has SkillOpt edit the skill's body, a few bounded edits at a time, on the plugin's tasks. Each step runs a batch of train tasks with the current skill, has a model (the optimizer) read the conversations and propose edits, applies them, and keeps the result only if its score on the val split is strictly higher. At the end it runs the test split with the original, the best and the last skill. The description in the frontmatter never changes: it decides whether the model loads the skill at all, and changing it is another experiment.

Every rollout is a `run` of this trainer, so each task in a batch, and every val task at every step, is a real turn on the model: with Jira's 46 train and 31 val tasks, an epoch of batches of 8 is 6 steps of 8 train and 31 val tasks, about 230 turns, two and a half hours at 40 seconds a turn.

The output folder (a new one under `results/` by default; an existing one must be empty, since SkillOpt would resume from what's there) gets:

- `SKILL.md`, the trained skill: SkillOpt's best body, its own marked blocks taken out, the plugin's name and description put back;
- `skillopt/`, SkillOpt's run: `best_skill.md`, every version of the skill, each step's rollouts and edits, `history.json`, the test results;
- what SkillOpt was given: `skill_init.md` (the current body), `splits/` (the tasks), `skillopt-config.yaml`.

The settings are `skillopt-defaults.yaml`, small on purpose (2 epochs, batches of 8, at most 3 edits a step, the gate on `soft`, SkillOpt's extra rollouts off, 2 parallel optimizer calls for one Ollama), then the model, then `--config` on top. Keys and meanings are SkillOpt's own. The `env` section is the trainer's and a `--config` can't change it.

**The optimizer is the model the skill runs on**, unless `--config` says otherwise: SkillOpt's OpenAI-compatible backend on `$OLLAMA_HOST/v1` with `OLLAMA_MODEL`. A stronger model usually writes better edits; any OpenAI-compatible endpoint works, a local one or a hosted one with its key:

```yaml
model:
  optimizer: gpt-5.5
  optimizer_openai_compatible_base_url: https://api.example.com/v1
  optimizer_openai_compatible_model: gpt-5.5
  optimizer_openai_compatible_api_key: sk-...
```

SkillOpt never calls the target model here: the rollouts are this trainer's, on `OLLAMA_MODEL`.

An API key never goes into the output folder: `train` takes every `*openai_compatible_api_key` out of the config it writes and hands it to SkillOpt as the environment variable SkillOpt reads it from (`OPTIMIZER_OPENAI_COMPATIBLE_API_KEY` for `optimizer_openai_compatible_api_key`). Keep a `--config` with a key outside the repo too.

A task that couldn't run during a training (a stalled model, an unreachable endpoint) counts as failed in that rollout, as in `run`: it lowers the score of whichever skill it ran with, and the gate can reject or accept an edit because of it. Its conversation says it couldn't run, so the optimizer doesn't learn from it, but a training on an endpoint that keeps failing is noise: watch `skillopt/` for rollouts full of them.

`train` exits with SkillOpt's exit code, and writes no `SKILL.md` when SkillOpt failed.

## Comparing two skills

```bash
bun src/bin.ts run jira --split test --repeat 3 --json results/baseline.json
bun src/bin.ts run jira --split test --repeat 3 --skill results/jira-try-1/SKILL.md --json results/candidate.json
bun src/bin.ts compare results/baseline.json results/candidate.json
```

`compare` applies the procedure in [Measuring a gain](#measuring-a-gain) to two `run --json` files: each task's score is the fraction of its repeats that passed, the gain is the mean per-task difference, and its one-sided 95% bounds come from a bootstrap over tasks (seeded, so the same two files always give the same answer). It prints the verdict (a gain only when the lower bound is above zero, worse only when the upper one is below it, not distinguishable otherwise), the gain per task type, every task that got worse, and the tasks only one of the runs had, which it leaves out. It warns when tasks were run a different number of times (a run cut short keeps the repeats it finished, and its tasks then weigh unevenly), when the tasks aren't all from the test split, when both runs used the same skill (an A/A comparison, which shows the noise alone), and when results of tasks that couldn't run were counted as failures.

It refuses two runs made under different conditions (another commit, another model or host, other training data), and any run made on a tree with changes, since its commit isn't the code that ran: commit, then run.

## Adopting a trained skill

A trained skill goes into a plugin by hand, like any change:

1. Run the original and the trained skill on the test split, at least 3 times each, and `compare` them. Only a gain is a reason to go on.
2. Try the trained skill on the real service: copy it into the plugin in a test bed app (`apps/testbed/README.md`) and run `mfw e2e` there.
3. Read it. Take out rules that only fit the training data (a project key, a person's name, a count) and anything that contradicts the rest of the skill.
4. Open a PR on the plugin with its changeset, the comparison in the description.

## Measuring a gain

A trained skill counts as better only if it beats the original by more than the model's own noise: the same skill on the same tasks doesn't score the same twice (the baseline's runs show how much it moves). So a gain is measured, not read off one run. `compare` does what this section describes; this is why it does it that way, and how much data it takes.

**Keep everything but the skill fixed.** Same model (name, weights, quantization), same commit of the fixtures, tasks, checks and of the Mercury code a turn goes through, same skill description. If any of these changes, both skills run again: a baseline from before a fixture fix isn't comparable with a candidate after it.

**Compare on the test split only.** SkillOpt edits the skill on train tasks and accepts edits by their val score, so on those two a trained skill looks better than it is.

**Run each skill several times on every test task**, a task's score being the fraction of its runs that passed, then pair the two skills task by task: the gain is the mean of the per-task differences. Its uncertainty comes from resampling the tasks (a bootstrap over tasks, not over runs, since the runs of one task aren't independent of each other), and a gain is claimed only when the one-sided 95% lower bound is above zero. Below that the honest answer is "not distinguishable", whatever the mean says. Report the gain per task type too, and every task that got worse: a skill that fixes counts and breaks transitions isn't a better skill.

**Check the procedure on itself first.** Compare the baseline with a second run of the baseline: it has to come out as no gain. If it doesn't, the tasks or the checks are noisier than the numbers below assume.

How many tasks and runs that takes comes from `bun scripts/power.ts`, a simulation of exactly this comparison. Its numbers hold under its assumptions: every task's pass rate drawn from a Beta with the baseline as mean and a low concentration (2, so tasks differ a lot, some always passing and some rarely), runs independent of each other, a real gain spread over the tasks in proportion to how often they fail, 400 bootstrap resamples. They haven't been checked against a real A/A comparison yet, which is the first thing to run on a plugin's data. The share of comparisons that see a real gain, with 3 runs per skill:

| test tasks | baseline 90%, +5 points | +10 | baseline 70%, +5 | +10 | +15 |
|---|---|---|---|---|---|
| 16 | 25% | 64% | 22% | 39% | 61% |
| 30 | 41% | 95% | 21% | 54% | 86% |
| 50 | 58% | 100% | 31% | 75% | 96% |
| 80 | 77% | 100% | 44% | 89% | 100% |
| 120 | 90% | 100% | 56% | 97% | 100% |

With no real gain the comparison claims one 3 to 9% of the time across the table's settings, around the 5% it's built for (the bootstrap gets a little loose with few tasks). With 5 runs instead of 3, 50 tasks at a 70% baseline see +10 points 92% of the time; with a single run, 37%.

What that means for a plugin's training data:

- **At least 50 test tasks, 3 runs per skill** to tell a 10-point gain from noise. That's the minimum for any claim. Under 30 tasks no number of runs makes it reliable (16 tasks with 5 runs see +10 points about half the time at a 70% baseline).
- **At least 80 test tasks with 5 runs, or 120 with 3,** to claim a gain as small as 5 points, and that only near a 90% baseline: at 70% even those see a 5-point gain only about 60% of the time, and a smaller gain isn't worth measuring.
- **At least 30 val tasks.** SkillOpt accepts an edit when its val score is strictly higher in one run, so with few val tasks it accepts noise as progress.
- **Tasks the baseline fails sometimes.** A task every skill always passes adds nothing but runtime. Aim for a test baseline between 60% and 80%: near 100% there's no room left to measure. Jira's first run (2026-10-18, `qwen3.8:27b`, the training data as it was then) passed 123 of 132 tasks, and 127 of 128 once the checks it showed to be wrong were fixed: the skill didn't need training. The data has changed since (the user search, ORDER BY, EMPTY, tighter checks), so that figure isn't the current data's baseline until it runs again.
- **The time it takes.** A task costs about 40 seconds on the current model (a run of Jira's 132 tasks took 90 minutes; most take 15 to 30, a few over a minute when the model wanders), so 50 test tasks, 3 runs, two skills is about 3 hours and a half, and 80 tasks with 5 runs about 9.

## SkillOpt

SkillOpt is never installed or vendored: `train` runs it with uv at the commit pinned in `skillopt.json` (`uv run --with git+<repository>@<commit>`), on Python 3.12, which uv fetches too.

SkillOpt knows only its own benchmarks, and a new one is an environment adapter registered in its CLIs. The adapter is `python/` (`mercury_skillopt`), installed next to SkillOpt for the run: `python -m mercury_skillopt train` adds it to SkillOpt's registry and hands over to SkillOpt's own `main()`, since SkillOpt has no plugin mechanism. The adapter holds no logic: a rollout runs `skill-trainer run <plugin> --skill <candidate> --task <ids> --skillopt-out <dir>`, and this trainer writes what SkillOpt reads there (`src/skillopt-out.ts`), the conversation its optimizer reflects on (each turn's message, the tool calls with their output cut at 4000 characters, the answer, then the checks) and each task's score.

The adapter relies on parts of SkillOpt that aren't a public API (its CLIs' registries, the base classes' methods), so moving the pin goes through a check:

```bash
bun src/bin.ts update-skillopt                 # latest main
bun src/bin.ts update-skillopt --ref v0.2.0    # a tag, a branch or a full commit
```

It moves the pin only after the adapter's smoke check (`python -m mercury_skillopt smoke`) and the adapter's tests pass on the new commit; otherwise the pin stays where it was.

The adapter's tests run inside the pinned SkillOpt, with a stand-in harness and a stand-in model, a whole training included:

```bash
bun run test:python
```

They need uv, so they're kept out of `bun run test`; CI runs them in a job of their own on every pull request (`.github/workflows/ci.yml`).
