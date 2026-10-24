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

SEPARATORS = r"&&|\|\||;|\||\n"

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

# `git commit` as a standalone command (git commit, git -C <path> commit,
# bash -c '...'), anchored at segment start so a "git commit" inside
# another command's arguments (echo "git commit", grep 'git commit')
# does not count. Group 1 captures the commit's arguments.
COMMIT_ARGS_RE = re.compile(
    r"\s*(?:(?:sudo|env|command|xargs)\s+)*(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"
    r"(?:git\s+(?:-C\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s+)?commit\b"
    r"|bash\s+-c\s+['\"].*?git\s+commit\b)"
    r"([^|&;]*)",
    re.S,
)

# `git commit` options that consume the next token
VALUE_OPTIONS = {
    "-m", "-F", "-t", "-C", "-c",
    "--message", "--file", "--template", "--author",
    "--cleanup", "--fixup", "--squash", "--trailer", "--date",
}

# Short options of `git commit` that take a value: attached to the rest of
# the cluster (-mx), or as the next token when they are the cluster's last
# letter (-m x, -pm x)
SHORT_VALUE_OPTIONS = frozenset("mFtCcSu")


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, cwd=cwd,
    ).stdout.strip()


def commit_segment(command):
    """The arguments of the first `git commit` standalone command, or None."""
    for segment in re.split(SEPARATORS, command):
        m = COMMIT_ARGS_RE.match(segment)
        if m:
            return m.group(1)
    return None


def includes_unstaged(segment):
    """True when the commit will also include tracked unstaged modifications.

    That is the case for `git commit -a`/`--all` (flag -a, also inside
    clusters like -am) and for commits with a pathspec
    (`git commit -m msg -- file.ts`).
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.startswith("--pathspec-from-file"):
            # the commit takes the paths listed in the file, working-tree
            # contents included
            return True
        if token in VALUE_OPTIONS:
            i += 2
            continue
        if token in ("-a", "--all"):
            return True
        if token == "--":
            # everything after -- is a pathspec
            return i + 1 < len(tokens)
        if token.startswith("--"):
            i += 1
            continue
        if token.startswith("-") and len(token) > 1:
            flags = token[1:]
            j = 0
            while j < len(flags):
                letter = flags[j]
                if letter == "a":
                    return True
                if letter in SHORT_VALUE_OPTIONS:
                    if j < len(flags) - 1:
                        # the rest of the cluster is the option's value
                        break
                    # the value is the next token
                    i += 1
                    break
                j += 1
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

        # A changeset the commit would include covers: staged changeset
        # files, plus tracked unstaged ones when the commit includes
        # unstaged modifications. An untracked changeset file is included
        # by no commit form, so it does not count.
        changeset_files = set()
        for f in git(cwd, "diff", "--cached", "--name-only", ".changeset/").split("\n"):
            if f:
                changeset_files.add(f)
        if includes_unstaged(segment):
            for f in git(cwd, "diff", "--name-only", ".changeset/").split("\n"):
                if f:
                    changeset_files.add(f)

        # ...or the last commit already carried one
        last_commit_files = git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
        has_changeset = bool(changeset_files) or any(
            f.startswith(".changeset/") for f in last_commit_files.split("\n") if f
        )

        if not has_changeset:
            print(json.dumps({
                "decision": "allow",
                "system_message": (
                    "This commit modifies code without a changeset. "
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
