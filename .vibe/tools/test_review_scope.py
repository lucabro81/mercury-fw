#!/usr/bin/env python3
"""Functional tests for .vibe/tools/review_scope.py.

Runs the scope-line calculator against real git repos in a temp dir and
asserts its output: full branch without --since, the sorted delta file
list with --since, the no-changes marker, and fail-loud outside a repo
or on a bad sha.

Usage: python3 .vibe/tools/test_review_scope.py
Exits non-zero when any case fails.
"""
import os
import subprocess
import sys
import tempfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(TOOLS, "review_scope.py")

failures = []
cases = 0


def check(desc, ok, detail=""):
    global cases
    cases += 1
    if ok:
        print(f"ok   {desc}")
    else:
        failures.append(f"FAIL: {desc}" + (f"\n  {detail}" if detail else ""))
        print(f"FAIL {desc}" + (f" — {detail}" if detail else ""))


def run_scope(args, cwd):
    """Run review_scope.py; returns (returncode, stdout, stderr)."""
    p = subprocess.run(
        ["python3", SCRIPT, *args],
        capture_output=True, text=True, cwd=cwd,
    )
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def expect(desc, got, want):
    check(desc, got == want, f"want {want!r}, got {got!r}")


def main():
    fix = tempfile.mkdtemp(prefix="mercury-scopetest-")
    repo = os.path.join(fix, "repo")

    def git(*args):
        subprocess.run(
            ["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", *args],
            check=True, capture_output=True,
        )

    subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True, capture_output=True)
    git("commit", "-q", "--allow-empty", "-m", "init")
    head = subprocess.run(
        ["git", "-C", repo, "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()

    def write(rel, content):
        path = os.path.join(repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)

    delta_line = (f"Scope: delta since {head} — files: "
                  "packages/libs/core/src/a.ts, packages/libs/core/src/b.ts")

    # no --since: full branch (no git needed)
    rc, out, err = run_scope([], repo)
    check("no --since exits 0", rc == 0, f"rc={rc} {err}")
    expect("no --since -> full branch", out, "Scope: full branch")

    # --since HEAD: the delta is empty
    rc, out, err = run_scope(["--since", head], repo)
    check("--since HEAD exits 0", rc == 0, f"rc={rc} {err}")
    expect("--since HEAD -> no changes", out, "Scope: no changes")

    # a delta of two files, listed sorted
    write("packages/libs/core/src/b.ts", "export const b = 1;\n")
    write("packages/libs/core/src/a.ts", "export const a = 1;\n")
    git("add", "packages/libs/core/src/a.ts", "packages/libs/core/src/b.ts")
    git("commit", "-q", "-m", "add a and b")
    rc, out, err = run_scope(["--since", head], repo)
    check("--since with a delta exits 0", rc == 0, f"rc={rc} {err}")
    expect("delta lists the files sorted", out, delta_line)

    # a new file in a later commit is listed too (the delta is commit-based:
    # staged-but-uncommitted files do not appear)
    write("packages/libs/core/src/new.ts", "export const n = 1;\n")
    git("add", "packages/libs/core/src/new.ts")
    git("commit", "-q", "-m", "add new")
    rc, out, err = run_scope(["--since", head], repo)
    check("--since with a new file exits 0", rc == 0, f"rc={rc} {err}")
    expect("delta lists the new file", out, delta_line + ", packages/libs/core/src/new.ts")

    # from a subdirectory (no --repo): same result
    subdir = os.path.join(repo, "packages/libs/core/src")
    rc, out, err = run_scope(["--since", head], subdir)
    check("from a subdirectory exits 0", rc == 0, f"rc={rc} {err}")
    expect("from a subdirectory -> same delta", out, delta_line + ", packages/libs/core/src/new.ts")

    # --repo points at the repository from anywhere
    rc, out, err = run_scope(["--repo", repo, "--since", head], fix)
    check("--repo from outside exits 0", rc == 0, f"rc={rc} {err}")
    expect("--repo -> same delta", out, delta_line + ", packages/libs/core/src/new.ts")

    # outside a repo with --since: fail loud (a caller's tool, not a hook)
    rc, out, err = run_scope(["--since", head], fix)
    check("outside a repo exits non-zero", rc != 0, f"rc={rc}")
    check("outside a repo prints to stderr", bool(err), err)

    # a bad sha: fail loud
    rc, out, err = run_scope(["--since", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], repo)
    check("bad sha exits non-zero", rc != 0, f"rc={rc}")
    check("bad sha prints to stderr", bool(err), err)

    print()
    print(f"{cases - len(failures)}/{cases} passed")
    if failures:
        print("\n".join(failures))
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
