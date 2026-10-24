---
name: mercury-review
description: Load before merging a PR on Mercury. Runs the two review-gate subagents (cold-reviewer and docs-auditor) with only the issue number and branch name, collects their verdicts, fixes findings in-branch, and re-runs until both APPROVE.
user-invocable: true
---

# Mercury Review — Phase 5: Review Gate

Before merging a PR, two subagents review the branch in parallel, each with
only the issue number and the branch name — no conversation context. Their
verdicts are binding: no merge until both return APPROVE.

## Prerequisites

- You are on branch `feat/<N>-<slug>`
- All tests pass, typecheck clean
- The changeset is created and committed (created in `mercury-tdd`)
- The branch is pushed to origin: `git push -u origin <branch>`
- The PR exists (or create it now with `gh pr create --fill --body "Closes #N"`)

## The two subagents

### cold-reviewer
Judges the code against the issue. Looks for bugs, dead code, inadequate
tests, missing edge cases. Verdict: APPROVE or CHANGES REQUESTED.
Its definition is in `.vibe/agents/cold-reviewer.toml` — the canonical
definition is `.claude/agents/cold-reviewer.md` (used by Claude Code):
keep them in sync when the definition changes.

### docs-auditor
Verifies bidirectionally that documentation matches the code. Looks for
missing docs, stale docs, contradictions, untracked deferrals. Verdict:
APPROVE or CHANGES REQUESTED.
Its definition is in `.vibe/agents/docs-auditor.toml` — the canonical
definition is `.claude/agents/docs-auditor.md`: keep them in sync.

## Procedure

### 1. Prepare context for the subagents

Gather:
- Issue number: `N`
- Branch name: `feat/N-slug`

### 2. Launch cold-reviewer

Spawn the `cold-reviewer` subagent with the `task` tool:

- `agent`: `cold-reviewer`
- `task`: only the minimal context, nothing else:

```
Issue: #N
Branch: feat/N-slug
```

### 3. Launch docs-auditor

Spawn the `docs-auditor` subagent with the `task` tool, same format:

```
Issue: #N
Branch: feat/N-slug
```

### 4. Collect verdicts

Wait for both subagents to complete. Read their reports:
- If both APPROVE: proceed to step 6
- If one or both CHANGES REQUESTED: proceed to step 5

### 5. Fix findings

For each finding in the reports:

- **Classify it** (S1–S4, see below). The reviewer proposes a class; you may
  re-classify with a written reason in the final report.
- **S1/S2 (blocking)**: fix it yourself in the branch, unless it is severe or
  hides a decision that belongs to Luca. In that case, bring the finding to
  Luca and wait for his decision.
- **S3**: fix it in the same round, with a regression test.
- **S4**: defer it: open a tech-debt issue, link it in the PR, and note the
  deferral in the report.
- **docs-auditor finding (documentation)**: fix it directly. If the finding
  indicates the **code** is wrong (direction A: doc claim not backed by code),
  apply the same classification and rules as cold-reviewer findings.
- **"undecided" finding**: decide from the issue's intent when clear enough,
  otherwise ask Luca.

After fixing:
1. Commit the fixes: `git add -A && git commit -m "fix(review): address review findings"`
2. Push: `git push`
3. **Re-run only the reviewers whose domain changed** (see below) — go back
   to step 2 for each
4. Apply the exit conditions below: the loop always ends

### 6. Final report

When both return APPROVE, tell the user:
- The two subagents' verdicts
- The list of findings fixed (if any)
- That the PR is ready for merge (but the merge waits for Luca)

## Rules

- **Never merge without APPROVE from both.**
- **Never give the subagents context beyond issue number and branch name.**
  Their value is in fresh eyes.
- **Do not skip the review gate**, not even for "small changes".
- **The reviewers are read-only.** They never commit, push, rebase or modify
  any file; the caller applies every finding and checks `git status` after
  each round.
- If a subagent finds a serious architectural problem, escalate to Luca before
  fixing.

## Severity classes

Every finding is classified into one of four classes. The reviewer proposes
a class for each finding; the caller may re-classify with a written reason
in the final report.

| Class | Meaning | Effect |
|---|---|---|
| S1 | Fail-open on a common, innocent command of the workflow: a commit on main, an `rm -rf`, a commit that should carry a changeset slips through | Blocks the merge |
| S2 | Over-block: a legitimate workflow command is refused (a commit on a feature branch blocked, the reviewers' read-only contract broken) | Blocks the merge |
| S3 | Inaccuracy in the safe direction: over-warning, false positives, imprecise state that causes no harm | Fix in the same round with a regression test, or defer with a tracked issue |
| S4 | Cosmetic, marginal robustness, or outside the threat model | Defer with a tracked tech-debt issue; never blocks |

A finding that restates a limitation already documented as accepted (the
hooks' "not a sandbox" docstring, a linked tech-debt issue) is not a
finding: it is a deferral.

## Exit conditions

The review always ends. The loop is bounded by:

- **Fix-or-defer.** A round with no S1/S2 closes when every S3/S4 finding
  is either fixed with a regression test or deferred in a tracked issue
  linked in the PR.
- **Verification round.** After a round that had only S3/S4, re-run each
  reviewer whose domain changed (see below) once. If it finds only S3/S4
  again, apply fix-or-defer and close: the review ends. Severity may not
  rise without blocking: an S1/S2 in a verification round reopens the loop.
- **Blocking cap.** At most 3 consecutive rounds with at least one S1/S2.
  A 4th consecutive blocking round stops the loop: the caller writes an
  escalation report for Luca — residual findings with their classes, what
  each round fixed, the hypothesis on the underlying problem, and the
  options (redesign, narrow the scope, accept the risk, defer) — and waits
  for his decision. The loop does not resume without it.
- **Absolute cap.** At most 5 rounds total from the adoption of this grid,
  whatever the classes. Same escalation as above.

## Re-running a reviewer

Re-run a reviewer only when files in its domain changed since its last
verdict: cold-reviewer for code and tests, docs-auditor for docs, skills,
agent definitions and changesets. A reviewer that APPROVEd is not re-run
for changes outside its domain.

## Threat model for the hooks

The `.vibe/tools/` hooks are a guard-rail for an honest but fallible agent,
not a sandbox: they analyze the command line textually, so a deliberately
hostile command can route around them (an alias, a renamed binary,
`git --git-dir=<foreign repo>`, editing `.git` directly). They exist to
catch the common accidents of the Mercury workflow — a commit on main, an
`rm -rf`, a commit that should carry a changeset — not to stop an
adversary. Findings outside this model are S4 deferrals, not blockers.

## After the review

Load the `mercury-release` skill for the post-merge release on main.
