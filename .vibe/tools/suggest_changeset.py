#!/usr/bin/env python3
"""Hook pre_tool: warn when a commit is missing a changeset.

Checks the files the commit would include — the staged ones, plus tracked
unstaged modifications when the commit uses -a/--all or a pathspec — and
warns if they touch a published workspace without a changeset. Repo
tooling (.vibe/, scripts/, .github/, docs site, test bed) does not require
a changeset.

The commit's target directory is tracked through `cd` segments and the
commit's own `git -C <path>` (with ~ and $VAR expansion), so the warning
reflects the repository the commit lands in, not the shell's current
directory.

The command line is split on separators outside quotes, so a message
containing a separator is one argument; a `bash -c '...'` / `sh -c '...'`
wrapper is unwrapped and its inner command line is analyzed the same way.
"""
import json
import os
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

# A command prefix: sudo/env/command/xargs wrappers and env assignments.
PREFIX = r"\s*(?:(?:sudo|env|command|xargs)\s+)*(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"

# `git commit` as a standalone command (git commit, git -C <path> commit),
# anchored at segment start so a "git commit" inside another command's
# arguments (echo "git commit", grep 'git commit') does not count. Group 1
# captures the commit's `git -C` target, group 2 the commit's arguments;
# quoted sections are captured whole, so a message containing a separator
# (`git commit -m "a b;c"`) is one argument, not a truncated capture
# misread as a pathspec. The lookahead after `commit` keeps plumbing
# subcommands (commit-tree, commit-graph) from counting as one.
COMMIT_ARGS_RE = re.compile(
    PREFIX +
    r"git\s+(?:-C\s+(\"[^\"]*\"|'[^']*'|\S+)\s+)?commit(?![\w-])"
    r"((?:[^|&;\"']|\"[^\"]*\"|'[^']*')*)",
    re.S,
)

# A bash -c '...' / sh -c '...' wrapper: the segment stands for its inner
# command line, which is analyzed in place of the segment (group 1 is the
# single-quoted, group 2 the double-quoted inner command).
WRAPPER_RE = re.compile(
    PREFIX + r"(?:bash|sh)\s+-c\s+(?:'([^']*)'|\"([^\"]*)\")"
)

# A cd that changes the working directory for the rest of the command
# line: `cd <path>` as a standalone segment (a bare `cd` goes home). The
# target path is captured in group 1.
CD_RE = re.compile(r"\s*cd\b\s*(?:(\"[^\"]*\"|'[^']*'|\S+)\s*)?$")

# `git commit` options that consume the next token
VALUE_OPTIONS = {
    "-m", "-F", "-t", "-C", "-c",
    "--message", "--file", "--template", "--author",
    "--cleanup", "--fixup", "--squash", "--trailer", "--date",
}

# Short options of `git commit` that take a value: attached to the rest of
# the cluster (-mx), or as the next token when they are the cluster's last
# letter (-m x, -pm x)
SHORT_VALUE_OPTIONS = frozenset("mFtCc")

# Short options whose value is optional and only ever attached to the
# cluster (-S<keyid>, -u<mode>): a standalone -S/-u is complete on its own
# and never consumes the next token.
SHORT_OPTIONAL_VALUE_OPTIONS = frozenset("Su")


def split_segments(command):
    """Split a command line on separators (&&, ||, ;, |, newline).

    A separator inside a quoted section does not split: the shell parses
    it as part of a word, not as a command separator.
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


def resolve_path(path, base):
    """Resolve a path against base, expanding ~ and environment variables."""
    path = os.path.expandvars(os.path.expanduser(path))
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    return os.path.normpath(path)


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, cwd=cwd,
    ).stdout.strip()


def commit_target(command, directory):
    """The first `git commit` standalone command: its arguments and the
    directory it commits in, or None.

    `directory` is the scope's working directory: a `cd` segment moves it
    for the rest of the scope (a `cd` inside a bash -c wrapper stays
    inside the wrapper), and the commit's own `git -C <path>` overrides it.
    """
    for segment in split_segments(command):
        wrapped = WRAPPER_RE.match(segment)
        if wrapped:
            found = commit_target(wrapper_inner(wrapped), directory)
            if found is not None:
                return found
            continue
        cd = CD_RE.match(segment)
        if cd:
            target = cd.group(1)
            if target is None:
                directory = os.path.expanduser("~")
            else:
                directory = resolve_path(target.strip("\"'"), directory)
            continue
        m = COMMIT_ARGS_RE.match(segment)
        if m:
            target_dir = directory
            if m.group(1) is not None:
                target_dir = resolve_path(m.group(1).strip("\"'"), directory)
            return m.group(2), target_dir
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
                if letter in SHORT_OPTIONAL_VALUE_OPTIONS:
                    # the value, if any, is the rest of the cluster
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
    found = commit_target(command, os.path.abspath(data.get("cwd", ".")))
    if found is None:
        sys.exit(0)
    args, target_dir = found

    try:
        files = set()
        for f in git(target_dir, "diff", "--cached", "--name-only").split("\n"):
            if f:
                files.add(f)

        if includes_unstaged(args):
            for f in git(target_dir, "diff", "--name-only").split("\n"):
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
        for f in git(target_dir, "diff", "--cached", "--name-only", ".changeset/").split("\n"):
            if f:
                changeset_files.add(f)
        if includes_unstaged(args):
            for f in git(target_dir, "diff", "--name-only", ".changeset/").split("\n"):
                if f:
                    changeset_files.add(f)

        # ...or the last commit already carried one
        last_commit_files = git(target_dir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
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
