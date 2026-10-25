#!/usr/bin/env python3
"""Print the review-scope line for the mercury-review skill.

The review gate scopes each reviewer's verdict: full branch on a
reviewer's first round, the delta since that reviewer's last round
afterwards. This tool computes the line deterministically so the caller
does not assemble it by hand:

    review_scope.py                -> Scope: full branch
    review_scope.py --since <sha>  -> Scope: delta since <sha> — files: <f1>, <f2>, ...
                                      (or "Scope: no changes" when the delta is
                                      empty: the reviewer is not re-run)

`--repo` selects the repository (default: the current directory); the
file list is `git diff --name-only <sha>..HEAD`, sorted. This is a
caller's tool: when git fails (a bad sha, not a repository) it fails
loud — a non-zero exit and the error on stderr — so a broken scope
line never reaches a reviewer silently.
"""
import argparse
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(
        description="Print the review-scope line for the mercury-review skill.",
    )
    parser.add_argument("--repo", default=".", help="the repository (default: cwd)")
    parser.add_argument("--since", help="the HEAD the reviewer last returned a verdict on")
    args = parser.parse_args()

    if not args.since:
        print("Scope: full branch")
        return

    proc = subprocess.run(
        ["git", "diff", "--name-only", f"{args.since}..HEAD"],
        capture_output=True, text=True, cwd=args.repo,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(1)
    files = sorted(f for f in proc.stdout.split("\n") if f)
    if not files:
        print("Scope: no changes")
        return
    print(f"Scope: delta since {args.since} — files: {', '.join(files)}")


if __name__ == "__main__":
    main()
