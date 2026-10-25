---
name: mercury-issue
description: Load after Luca has approved a plan in plan mode. Creates the GitHub issue with the approved plan in its body, then creates the working branch from the issue. Use only after explicit approval.
user-invocable: true
---

# Mercury Issue — Phase 2: Issue and Branch

This skill is used **only after** Luca has approved the plan in plan mode.
An agreement in chat is not an approval — it must be explicit.

## Prerequisites

Before proceeding, verify that:
1. The plan has been approved by Luca (the user must confirm explicitly)
2. You are on the `main` branch and the working tree is clean: `git status --porcelain`
3. `main` is up to date: `git fetch origin && git status`

## Steps

### 1. Create the issue

```bash
gh issue create \
  --title "<plan title>" \
  --body "<approved plan body>" \
  --repo lucabro81/mercury-fw
```

The issue body must contain the full plan, formatted in Markdown.
Add a line at the top: `> Plan approved by @lucabro81 in plan mode.`

### 2. Create the branch from the issue

```bash
gh issue develop <N> --base main --name feat/<N>-<slug> --repo lucabro81/mercury-fw
```

Where `<N>` is the number of the issue just created and `<slug>` is a
kebab-case version of the title (max 40 characters).

### 3. Verify

```bash
git branch --show-current   # must show feat/<N>-<slug>
git log --oneline -1        # must point to main
```

### 4. Report

Tell the user:
- Issue number: `#N`
- Issue URL
- Branch name: `feat/<N>-<slug>`
- Next step: load the `mercury-tdd` skill to start TDD work

## Rules

- Never commit to `main`. The branch is the only place to commit.
- The branch name always follows `feat/<N>-<slug>`.
- If the issue already exists (e.g. the user created it manually), skip step 1
  and go directly to step 2 with the existing issue number.
