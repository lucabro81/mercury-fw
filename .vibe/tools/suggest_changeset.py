#!/usr/bin/env python3
"""Hook pre_tool: warn when a commit is missing a changeset.

Checks the files the commit would include — the staged ones, plus tracked
unstaged modifications when the commit uses -a/--all or a pathspec — and
warns if they touch a published workspace without a changeset. Repo
tooling (.vibe/, scripts/, .github/, docs site, test bed) does not require
a changeset.
"""
import json
import re
import shlex
import subprocess
import sys

# The bash tool in the hook payload arrives as "bash" (short form,
# documented in the examples), as "file_system.bash" or "process.start"
# (qualified forms sent by Vibe's Unified Harness): all of them are the
# bash tool.
BASH_TOOL_NAMES = ("bash", "file_system.bash", "process.start")

# Only changes to these workspaces (the ones published on npm) require
# a changeset.
CHANGESET_REQUIRED_PREFIXES = ("packages/", "apps/cli/", "apps/create-mercury-agent/")

# Private exceptions inside the prefixes above: not published on npm
# (the list is in scripts/check-pack.ts), so they do not require a changeset.
CHANGESET_EXCLUDED_PREFIXES = ("packages/config/",)

# `git commit` options that consume the next token
VALUE_OPTIONS = {
    "-m", "-F", "-t", "-C", "-c",
    "--message", "--file", "--template", "--author",
    "--cleanup", "--fixup", "--squash",
}


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, cwd=cwd,
    ).stdout.strip()


def commit_segment(command):
    """The part of the command after `git commit`, or None when there is no commit."""
    m = re.search(r"\bgit\s+commit\b([^|&;]*)", command)
    return m.group(1) if m else None


def includes_unstaged(segment):
    """True when the commit will also include tracked unstaged modifications.

    That is the case for `git commit -a`/`--all` (flag -a, also in clusters
    like -am) and for commits with a pathspec (`git commit -m msg -- file.ts`).
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in VALUE_OPTIONS:
            i += 2
            continue
        if token.startswith("-"):
            if token in ("-a", "--all") or re.fullmatch(r"-[a-zA-Z]*a[a-zA-Z]*", token):
                return True
            i += 1
            continue
        # A token that is not an option is a pathspec
        return True
    return False


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    segment = commit_segment(command)
    if segment is None:
        sys.exit(0)

    cwd = data.get("cwd", ".")

    try:
        files = set()
        for f in git(cwd, "diff", "--cached", "--name-only").split("\n"):
            if f:
                files.add(f)

        if includes_unstaged(segment):
            for f in git(cwd, "diff", "--name-only").split("\n"):
                if f:
                    files.add(f)

        # Only published workspaces require a changeset; .md files are
        # documentation and do not bump the version
        relevant = [
            f for f in files
            if f.startswith(CHANGESET_REQUIRED_PREFIXES)
            and not f.startswith(CHANGESET_EXCLUDED_PREFIXES)
            and not f.endswith(".md")
        ]
        if not relevant:
            sys.exit(0)

        # A changeset already present (staged, unstaged or in the last commit) covers
        changeset_status = git(cwd, "status", "--porcelain", ".changeset/")
        last_commit = git(cwd, "log", "-1", "--pretty=%s")

        has_changeset = (
            bool(changeset_status)
            or "changeset" in last_commit.lower()
        )

        if not has_changeset:
            print(json.dumps({
                "decision": "allow",
                "system_message": (
                    "⚠️  This commit modifies code without a changeset. "
                    "The Mercury workflow requires a changeset for every relevant change. "
                    "Run `bun run changeset` before committing, or include the changeset "
                    "in this commit. See skill mercury-tdd."
                ),
            }))
            sys.exit(0)

    except Exception:
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
