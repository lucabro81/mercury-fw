#!/usr/bin/env python3
"""Hook pre_tool: block git commit on the main branch.

Analyzes the command line segment by segment (split on ;, &&, ||, | and
newlines, outside quotes) for `git commit` as a standalone command.
Blocks when the branch the commit would land on is main/master. The
commit's target directory is tracked through `cd` segments and `git -C
<path>` (with ~ and $VAR expansion), and a checkout/switch to
main/master earlier in the command marks its target directory — keyed by
git root, so a commit from a subdirectory of a switched repository counts
too — because the branch is checked before execution: a switch followed
by a commit in the same repository is caught even though the branch still
shows the old name, while a switch in a different checkout does not block
a commit that lands on a feature branch.

A `bash -c '...'` / `sh -c '...'` segment is unwrapped and its inner
command line is analyzed in the same scope: a switch inside it marks the
repository for commits after the wrapper too, while a `cd` inside it
stays inside — the wrapper's shell does not change the caller's
directory.
"""
import json
import os
import re
import subprocess
import sys

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
# env git commit, FOO=1 git commit.
COMMIT_RE = re.compile(
    PREFIX + r"git\s+(?:-C\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s+)?commit\b"
)

# A switch to the local main/master branch as a standalone command:
# git checkout/switch main, git -C <path> checkout main. The lookaheads
# after the branch name reject longer names (mainline, main-x, main/x)
# and the pathspec form (`git checkout main -- <paths>` restores paths,
# it does not switch).
SWITCH_RE = re.compile(
    PREFIX +
    r"git\s+(?:-C\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s+)?(?:checkout|switch)\s+"
    + OPTIONS +
    r"(?:main|master|refs/heads/(?:main|master))(?![/\w-])(?!\s*--)"
)

# A switch to any other branch as a standalone command: un-marks a
# directory a previous switch to main/master marked. The pathspec form
# (`git checkout <target> -- <paths>`) is excluded, as is a switch to
# main/master itself.
SWITCH_AWAY_RE = re.compile(
    PREFIX +
    r"git\s+(?:-C\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s+)?(?:checkout|switch)\s+"
    + OPTIONS +
    r"(?!(?:main|master|refs/heads/(?:main|master))(?![/\w-]))"
    r"(?!-)"
    r"(\"[^\"]*\"|'[^']*'|\S+)"
    r"(?![/\w-])(?!\s*--)"
)

# A cd that changes the working directory for the rest of the command
# line: `cd <path>` as a standalone segment (a bare `cd` goes home). The
# target path is captured in group 1.
CD_RE = re.compile(r"\s*cd\b\s*(?:(\"[^\"]*\"|'[^']*'|\S+)\s*)?$")

# A bash -c '...' / sh -c '...' wrapper: the segment stands for its inner
# command line, which is analyzed in place of the segment (group 1 is the
# single-quoted, group 2 the double-quoted inner command).
WRAPPER_RE = re.compile(
    PREFIX + r"(?:bash|sh)\s+-c\s+(?:'([^']*)'|\"([^\"]*)\")"
)


def split_segments(command):
    """Split a command line on separators (&&, ||, ;, |, newline).

    A separator inside a quoted section does not split: bash parses it as
    part of a word, not as a command separator.
    """
    segments = []
    current = []
    quote = None
    i = 0
    while i < len(command):
        ch = command[i]
        if quote is not None:
            current.append(ch)
            if ch == quote:
                quote = None
            i += 1
        elif ch == "\"" or ch == "'":
            quote = ch
            current.append(ch)
            i += 1
        elif command.startswith("&&", i) or command.startswith("||", i):
            segments.append("".join(current))
            current = []
            i += 2
        elif ch == ";" or ch == "|" or ch == "\n":
            segments.append("".join(current))
            current = []
            i += 1
        else:
            current.append(ch)
            i += 1
    segments.append("".join(current))
    return segments


def wrapper_inner(match):
    """The inner command line of a WRAPPER_RE match."""
    return match.group(1) if match.group(1) is not None else match.group(2)


def switch_target_dir(segment, cwd):
    """The directory a checkout/switch segment operates on: its `git -C` target, else cwd."""
    m = re.search(
        r"\bgit\s+-C\s+(\"[^\"]*\"|'[^']*'|\S+)\s+(?:checkout|switch)\b", segment,
    )
    if not m:
        return cwd
    return resolve_path(m.group(1).strip("\"'"), cwd)


def repo_root(directory):
    """The git root of directory, or directory itself when it is not a repo."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, cwd=directory,
        ).stdout.strip()
    except Exception:
        out = ""
    return os.path.normpath(out) if out else os.path.normpath(directory)


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


def run_command_line(command, directory, switched_to_main):
    """Analyze one shell scope; return the deny payload, or None.

    `directory` is the scope's working directory: a `cd` inside a
    bash -c wrapper changes it for the wrapper's own segments only (the
    recursion scopes it), while a switch marks a git root in
    `switched_to_main`, which is shared across scopes — a switch inside a
    wrapper still decides what a commit after the wrapper lands on.
    """
    for segment in split_segments(command):
        wrapped = WRAPPER_RE.match(segment)
        if wrapped:
            payload = run_command_line(wrapper_inner(wrapped), directory, switched_to_main)
            if payload:
                return payload
            continue
        cd = CD_RE.match(segment)
        if cd:
            target = cd.group(1)
            if target is None:
                directory = os.path.expanduser("~")
            else:
                directory = resolve_path(target.strip("\"'"), directory)
            continue
        if COMMIT_RE.match(segment):
            # A commit segment. A checkout/switch to main/master matching
            # the same segment is a commit message mentioning one, not a
            # switch: the branch the commit lands on is read below.
            target = commit_target_dir(segment, directory)
            root = repo_root(target)
            if root in switched_to_main:
                return {
                    "decision": "deny",
                    "reason": "The command switches to main/master before committing. "
                              "The Mercury workflow requires: branch feat/<N>-<slug>. "
                              "See skill mercury-issue.",
                }
            branch = current_branch(target)
            if branch in ("main", "master"):
                return {
                    "decision": "deny",
                    "reason": f"Direct commit on '{branch}' blocked. "
                              "The Mercury workflow requires: branch feat/<N>-<slug> "
                              "from an approved issue. See skill mercury-issue.",
                }
            continue
        if SWITCH_RE.match(segment):
            switched_to_main.add(repo_root(switch_target_dir(segment, directory)))
            continue
        if SWITCH_AWAY_RE.match(segment):
            switched_to_main.discard(repo_root(switch_target_dir(segment, directory)))
            continue
    return None


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    payload = run_command_line(command, os.path.abspath(data.get("cwd", ".")), set())
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


if __name__ == "__main__":
    main()
