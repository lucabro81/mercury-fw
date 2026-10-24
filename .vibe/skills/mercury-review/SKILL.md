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

- **cold-reviewer finding (code)**: fix it yourself in the branch, unless it
  is severe or hides a decision that belongs to Luca. In that case, bring the
  finding to Luca and wait for his decision.
- **docs-auditor finding (documentation)**: fix it directly. If the finding
  indicates the **code** is wrong (direction A: doc claim not backed by code),
  apply the same rules as cold-reviewer findings.
- **"undecided" finding**: decide from the issue's intent when clear enough,
  otherwise ask Luca.

After fixing all findings:
1. Commit the fixes: `git add -A && git commit -m "fix(review): address review findings"`
2. Push: `git push`
3. **Re-launch both subagents** (go back to step 2)
4. Repeat until both return APPROVE

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
- If a subagent finds a serious architectural problem, escalate to Luca before
  fixing.

## After the review

Load the `mercury-release` skill for the post-merge release on main.
