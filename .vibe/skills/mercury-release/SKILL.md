---
name: mercury-release
description: Load after the PR has been squash-merged and main is synced. Runs the release on main — version bump, tags, push — and verifies the GitHub Release and docs site deploy. Supervised by Luca.
user-invocable: true
---

# Mercury Release — Phase 6: Post-Merge Release on Main

This skill is used **after** the PR has been squash-merged and `main` is
synced locally. It runs the release on `main` — version bump, tags, push —
and verifies the downstream CI (GitHub Release, docs site).

The changeset was already created and committed on the branch (in
`mercury-tdd`), reviewed by the gate, and merged into `main` with the PR.

## Prerequisites

- The PR is merged (squash-merge, issue auto-closed via `Closes #N`)
- You are on `main`: `git checkout main`
- `main` is synced: `git pull`
- The changeset file exists in `.changeset/` (merged from the branch)
- The feature branch is deleted: `git branch -d feat/<N>-<slug>`

## Steps

### 1. Run the release

```bash
bun run release
```

This runs: `changeset version` (consumes the changeset, bumps versions,
updates CHANGELOGs), lockfile refresh, commit, and tags.

Verify:
```bash
git log --oneline -3    # must show the version-bump commit
git tag --points-at HEAD  # must show the created tags
```

### 2. Push with tags

```bash
git push && git push --tags
```

This is the exact command `scripts/release.ts` prints. It pushes the release
commit to `main` and all tags.

### 3. Verify CI downstream

The push triggers `.github/workflows/publish.yml`:

- **publish**: builds types, packs, publishes to npm (only versions not yet
  on the registry)
- **releases**: creates the GitHub Release for each tag on npm
- **site**: builds and deploys the docs site to GitHub Pages

Check the pipeline:
```bash
gh run list --branch main --limit 3
```

### 4. Close the loop

Update project memory with anything worth carrying to a future session, and
bring `README.md` in line if the change affects what it documents.

## Rules

- **One changeset per issue.** Never batch.
- **Never `changeset publish` or `npm publish`** on a workspace folder.
- **The changeset text is public**: it is the changelog users read.
- **The release runs on `main`, never on a feature branch.**
- **The release is supervised by Luca.** This skill describes the mechanical
  steps; the decision to release is always his.

## After the release

The unit of work is complete. Start a new unit with the `mercury-plan` skill.
