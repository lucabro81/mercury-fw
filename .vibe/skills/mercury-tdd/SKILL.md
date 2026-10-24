---
name: mercury-tdd
description: Load when working on a Mercury branch (feat/<N>-<slug>) after the issue has been created. Enforces TDD — write the failing test first, then implement, then refactor. Atomic commits, one changeset per issue.
user-invocable: true
---

# Mercury TDD — Phase 4: Development on the Branch

This skill guides development work on branch `feat/<N>-<slug>`, applying
TDD (Test-Driven Development) and atomic commits.

## Prerequisites

- You are on branch `feat/<N>-<slug>` (verify with `git branch --show-current`)
- Issue `#N` exists and contains the approved plan
- The working tree is clean or contains only intentional changes

## TDD cycle

For each unit of work in the plan:

### 1. RED — Write the failing test

- Identify the impacted package (e.g. `packages/libs/core`, `apps/cli`)
- Write the test in the corresponding test file (co-located with the code:
  `src/foo.ts` → `src/foo.test.ts`)
- The test must:
  - Describe the expected behavior specifically
  - Cover edge cases and limit cases, not just the happy path
  - Use `bun:test` (`import { describe, it, expect } from 'bun:test'`)
- Run the test and **verify it fails** for the right reason:
  ```bash
  cd <package-dir> && bun test <test-file>
  ```
- Commit the test:
  ```bash
  git add <test-file>
  git commit -m "test(<scope>): <test description>"
  ```

### 2. GREEN — Implement the minimum to pass the test

- Write the minimum code needed to make the test pass
- Do not optimize, do not add unrequested features
- Run the test: it must pass
- Run all tests in the package to verify nothing broke:
  ```bash
  cd <package-dir> && bun test
  ```
- Commit the implementation:
  ```bash
  git add <source-files>
  git commit -m "feat(<scope>): <implementation description>"
  ```

### 3. REFACTOR — Improve the code

- Refactor while keeping tests green
- Remove duplication, improve names, simplify
- Run tests and typecheck after each change
- Commit the refactor (if significant):
  ```bash
  git commit -m "refactor(<scope>): <description>"
  ```

## Commit rules

- **Atomic**: one commit = one logical change. Do not mix test and
  implementation in the same commit (unless it's a minimal refactor).
- **Message**: follows Conventional Commits: `type(scope): description`
  - `type`: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`
  - `scope`: the package or area (e.g. `core`, `cli`, `plugin-jira`)
- **Never commit on main**: the hook blocks it, but always verify the current branch.

## Before every push

```bash
# Typecheck the modified package
cd <package-dir> && bun run typecheck

# All tests in the package
cd <package-dir> && bun test

# If the change touches multiple packages, typecheck at repo level
bun run typecheck
```

## Create the changeset

Before moving to the review gate, create the changeset so the reviewers can
audit it (its text becomes the public changelog):

```bash
bun run changeset
```

Answer the changesets prompts:
- **Impacted packages**: select the packages the diff touches. For a framework
  change (core, cli, contracts, etc.), select all in the `fixed` group. For a
  plugin/channel/auth, select only that one.
- **Bump type**: `patch` for bugfix, `minor` for feature, `major` for breaking
  change (never without a dedicated issue).
- **Description**: public text, in English, no internal references (no `D-XX`,
  `S-XX`, no milestone). Describe what changes for the user.

Verify and commit the changeset:
```bash
cat .changeset/<file-name>.md
git add .changeset/
git commit -m "chore: add changeset for #N"
```

## When you are done

- All tests pass
- Typecheck clean
- Every commit is atomic with a meaningful message
- The changeset is created and committed
- The branch is ready for the review gate

Load the `mercury-review` skill to proceed.

## For bugfixes

Bugfixes also follow TDD:
1. Write a test that reproduces the bug (fails)
2. Fix the bug (test passes)
3. Verify no regressions
