#!/usr/bin/env python3
"""Hook pre_tool: block git commit on the main branch.

Analyzes every command segment (split on ;, &&, ||, |, \\n) for
`git commit` as a standalone command. Blocks when the branch the commit
would land on is main/master — the target directory is tracked through
`cd` segments and `git -C <path>` (with ~ and $VAR expansion) — or when
the command switches to main/master before the commit (the branch is
checked before execution).
"""
import json
import os
import re
import subprocess
import sys

SEPARATORS = r"&&|\|\||;|\||\n"

# The bash tool in the hook payload arrives as "bash" (short form,
# documented in the examples), as "file_system.bash" or "process.start"
# (qualified forms sent by Vibe's Unified Harness): all of them are the
# bash tool.
BASH_TOOL_NAMES = ("bash", "file_system.bash", "process.start")

# A command prefix: sudo/env/command/xargs wrappers and env assignments.
PREFIX = r"\s*(?:(?:sudo|env|command|xargs)\s+)*(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"

# Checkout/switch options (short options only, never a bare `--`).
OPTIONS = r"(?:-(?!-)\S+\s+)*"

# A commit as a standalone command: git commit, git -C <path> commit,
# bash -c 'git commit ...', env git commit, FOO=1 git commit.
COMMIT_RE = re.compile(
    PREFIX +
    r"(?:git\s+(?:-C\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s+)?commit\b"
    r"|bash\s+-c\s+['\"].*?git\s+commit\b)",
    re.S,
)

# A switch to the local main/master branch as a standalone command:
# git checkout/switch main, or the same inside bash -c '...'. The
# lookaheads after the branch name reject longer names (mainline, main-x,
# main/x) and the pathspec form (`git checkout main -- <paths>` restores
# paths, it does not switch).
SWITCH_RE = re.compile(
    PREFIX +
    r"(?:git\s+(?:checkout|switch)\s+" + OPTIONS +
    r"(?:main|master|refs/heads/(?:main|master))(?![/\w-])(?!\s*--)"
    r"|bash\s+-c\s+['\"].*?"
    r"git\s+(?:checkout|switch)\s+" + OPTIONS +
    r"(?:main|master|refs/heads/(?:main|master))(?![/\w-])(?!\s*--))",
    re.S,
)

# A switch to any other branch as a standalone command: resets a previous
# switch to main/master. The pathspec form (`git checkout <target> --
# <paths>`) is excluded, as is a switch to main/master itself.
SWITCH_AWAY_RE = re.compile(
    PREFIX +
    r"git\s+(?:checkout|switch)\s+" + OPTIONS +
    r"(?!(?:main|master|refs/heads/(?:main|master))(?![/\w-]))"
    r"(?!-)"
    r"(\"[^\"]*\"|'[^']*'|\S+)"
    r"(?![/\w-])(?!\s*--)"
)

# A cd that changes the working directory for the rest of the command
# line: `cd <path>` as a standalone segment (a bare `cd` goes home), or
# the first `cd <path>` inside bash -c '...' / sh -c '...'. The target
# path is captured in group 1 (direct form) or group 2 (bash -c form).
CD_RE = re.compile(
    r"\s*cd\b\s*(?:(\"[^\"]*\"|'[^']*'|\S+)\s*)?$"
    r"|\s*(?:bash|sh)\s+-c\s+['\"](?:[^'\"]*[;&|]\s*)?cd\s+(\"[^\"]*\"|'[^']*'|\S+)"
)


def find_commit_segments(command):
    """All segments containing `git commit` as a standalone command."""
    return [
        segment
        for segment in re.split(SEPARATORS, command)
        if COMMIT_RE.match(segment)
    ]


def commit_lands_on_main(command):
    """True if a switch to main/master happens before a commit, in command order.

    Segments run left to right, so a checkout/switch to main/master as a
    standalone command in an earlier segment means a later commit lands on
    main — unless a later segment switches away from main/master again. A
    switch after the commit (e.g. `git commit -m x && git checkout main`)
    is fine, and a "checkout main" inside another command's arguments
    (echo, grep, a commit message) does not count.
    """
    switched = False
    for segment in re.split(SEPARATORS, command):
        if SWITCH_RE.match(segment):
            switched = True
        elif SWITCH_AWAY_RE.match(segment):
            switched = False
        elif COMMIT_RE.match(segment) and switched:
            return True
    return False


def resolve_path(path, base):
    """Resolve a path against base, expanding ~ and environment variables."""
    path = os.path.expandvars(os.path.expanduser(path))
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    return os.path.normpath(path)


def commit_target_dir(segment, cwd):
    """The directory a commit segment operates on: its `git -C` target, else cwd."""
    m = re.search(r"\bgit\s+-C\s+(\"[^\"]*\"|'[^']*'|\S+)\s+commit\b", segment)
    if not m:
        return cwd
    return resolve_path(m.group(1).strip("\"'"), cwd)


def current_branch(directory):
    try:
        return subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=directory,
        ).stdout.strip()
    except Exception:
        return ""


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not find_commit_segments(command):
        sys.exit(0)

    # If the command switches to main before committing, block
    if commit_lands_on_main(command):
        print(json.dumps({
            "decision": "deny",
            "reason": "The command switches to main/master before committing. "
                      "The Mercury workflow requires: branch feat/<N>-<slug>. See skill mercury-issue.",
        }))
        sys.exit(0)

    cwd = data.get("cwd", ".")
    directory = os.path.abspath(cwd)
    for segment in re.split(SEPARATORS, command):
        cd = CD_RE.match(segment)
        if cd:
            # groups are numbered across alternatives: the direct form
            # captures the path in group 1, the bash -c form in group 2
            target = cd.group(1) or cd.group(2)
            if target is None:
                directory = os.path.expanduser("~")
            else:
                directory = resolve_path(target.strip("\"'"), directory)
            continue
        if not COMMIT_RE.match(segment):
            continue
        branch = current_branch(commit_target_dir(segment, directory))
        if branch in ("main", "master"):
            print(json.dumps({
                "decision": "deny",
                "reason": f"Direct commit on '{branch}' blocked. "
                          "The Mercury workflow requires: branch feat/<N>-<slug> from an approved issue. "
                          "See skill mercury-issue.",
            }))
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
