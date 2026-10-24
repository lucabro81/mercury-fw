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
wrapper (with flags or an absolute path, e.g. `bash -lc`, `/bin/bash -c`)
is unwrapped and its inner command line is analyzed the same way, and so
is the inner command line of a `( ... )` / `$( ... )` subshell. Git
global options before the subcommand (`git --no-pager commit`,
`git -C <path> -c x=y commit`) are accepted.

This hook is a guard-rail for an honest but fallible agent, not a
sandbox: the analysis is textual, so a deliberately hostile command can
route around it (an alias, a renamed binary, `git --git-dir=<foreign
repo>`, editing .git directly). It exists to catch the common accidents
of the Mercury workflow — a commit that should carry a changeset — not
to stop an adversary.
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

# A command prefix: sudo/env/command/xargs wrappers (env and sudo take
# flags, e.g. `env -i`) and env assignments.
PREFIX = r"\s*(?:(?:sudo|env|command|xargs)(?:\s+-\w+)*\s+)*(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"

# Git global options between `git` and the subcommand: -C <path> (also
# attached, -C<path>), -c <name>=<value>, short globals (-p) and long
# globals (--no-pager, --paginate=always). Only -C changes the directory
# the commit lands in; the rest are accepted so the subcommand is still
# recognized. --git-dir/--work-tree are accepted but not tracked: a
# segment that points at a foreign repository is outside this hook's
# threat model (see the module docstring). Group 1 captures the region.
GIT_OPTS = (
    r"((?:"
    r"(?:-C|-c)\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s*"
    r"|-C(?:\"[^\"]*\"|'[^']*'|\S+)\s*"
    r"|--[\w-]+(?:=\S+)?\s*"
    r"|-[a-zA-Z]\s*"
    r")*)"
)

# The -C <path> global option (separate or attached), used to extract the
# last one from a GIT_OPTS region; the lookbehind keeps it from matching
# inside a longer token. The path is in group 1 (double-quoted), group 2
# (single-quoted) or group 3 (bare).
GIT_C_RE = re.compile(r"(?<![\w=.-])-C\s*(?:\"([^\"]*)\"|'([^']*)'|(\S+))")

# `git commit` as a standalone command (git commit, git -C <path> commit,
# git --no-pager commit), anchored at segment start so a "git commit"
# inside another command's arguments (echo "git commit", grep 'git
# commit') does not count. Group 1 captures the git global options, group
# 2 the commit's arguments; quoted sections are captured whole, so a
# message containing a separator (`git commit -m "a b;c"`) is one
# argument, not a truncated capture misread as a pathspec. The lookahead
# after `commit` keeps plumbing subcommands (commit-tree, commit-graph)
# from counting as one.
COMMIT_ARGS_RE = re.compile(
    PREFIX +
    r"git\s+" + GIT_OPTS +
    r"commit(?![\w-])"
    r"((?:[^|&;\"']|\"[^\"]*\"|'[^']*')*)",
    re.S,
)

# A bash/sh -c '...' wrapper: the segment stands for its inner command
# line, which is analyzed in place of the segment (group 1 is the
# single-quoted, group 2 the double-quoted inner command). The shell may
# carry flags (bash -lc, bash -l -c), an absolute path (/bin/bash) and
# an env/sudo prefix with its own flags (env -i bash -c).
WRAPPER_RE = re.compile(
    PREFIX +
    r"(?:[\w./-]+/)?(?:bash|sh)\s+"
    r"(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\s+"
    r"(?:'([^']*)'|\"([^\"]*)\")"
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

    A separator inside a quoted section or inside a ( ... ) / $( ... )
    subshell does not split: the shell parses it as part of the
    subshell's command line, not as a command separator of the outer
    line.
    """
    segments = []
    current = []
    quote = None
    depth = 0
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
        elif depth == 0 and (command.startswith("&&", i) or command.startswith("||", i)):
            segments.append("".join(current))
            current = []
            i += 2
        elif depth == 0 and (ch == ";" or ch == "|" or ch == "\n"):
            segments.append("".join(current))
            current = []
            i += 1
        elif ch == "(":
            depth += 1
            current.append(ch)
            i += 1
        elif command.startswith("$(", i):
            depth += 1
            current.append("$(")
            i += 2
        elif ch == ")" and depth > 0:
            depth -= 1
            current.append(ch)
            i += 1
        else:
            current.append(ch)
            i += 1
    segments.append("".join(current))
    return segments


def wrapper_inner(match):
    """The inner command line of a WRAPPER_RE match."""
    return match.group(1) if match.group(1) is not None else match.group(2)


def subshell_spans(command):
    """The inner command lines of ( ... ) and $( ... ) subshells.

    Quote-aware and nesting-aware: a subshell executes its inner command
    line, so a commit inside one counts like a direct segment. The spans
    are analyzed in the caller's scope: a `cd` inside a subshell does not
    change the caller's directory.
    """
    spans = []
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if ch == "'":
            j = command.find("'", i + 1)
            i = n if j == -1 else j + 1
            continue
        if ch == '"':
            j = i + 1
            while j < n and command[j] != '"':
                j += 2 if command[j] == "\\" else 1
            i = j + 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch == "(":
            open_len = 1
        elif command.startswith("$(", i):
            open_len = 2
        else:
            i += 1
            continue
        start = i + open_len
        depth = 1
        j = start
        while j < n and depth:
            c = command[j]
            if c == "'":
                k = command.find("'", j + 1)
                j = n if k == -1 else k + 1
                continue
            if c == '"':
                k = j + 1
                while k < n and command[k] != '"':
                    k += 2 if command[k] == "\\" else 1
                j = k + 1
                continue
            if c == "\\":
                j += 2
                continue
            if c == "(":
                depth += 1
                j += 1
                continue
            if command.startswith("$(", j):
                depth += 1
                j += 2
                continue
            if c == ")":
                depth -= 1
                if depth == 0:
                    spans.append(command[start:j])
                j += 1
                continue
            j += 1
        i = j
    return spans


def git_target_dir(segment, cwd):
    """The directory a commit segment lands in: its last `git -C` global
    option (the last one wins), else cwd."""
    m = re.match(PREFIX + r"git\s+" + GIT_OPTS, segment)
    if not m:
        return cwd
    target = None
    for cm in GIT_C_RE.finditer(m.group(1) or ""):
        target = cm.group(1) or cm.group(2) or cm.group(3)
    if target is None:
        return cwd
    return resolve_path(target, cwd)


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
        for span in subshell_spans(segment):
            # a subshell executes its inner command line in this scope
            found = commit_target(span, directory)
            if found is not None:
                return found
        if wrapped:
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
            return m.group(2), git_target_dir(segment, directory)
    return None


# A redirect token: `>`, `>>`, `2>`, `2>&1`, `&>`, `<` and their attached
# targets (`>log`, `2>file`). Group 1 is the operator, group 2 the
# attached target (empty when the target is the next token).
REDIRECT_RE = re.compile(r"([&]?\d*>+|&\d*>?|<)(.*)")


def includes_unstaged(segment):
    """True when the commit will also include tracked unstaged modifications.

    That is the case for `git commit -a`/`--all` (flag -a, also inside
    clusters like -am) and for commits with a pathspec
    (`git commit -m msg -- file.ts`). Redirect tokens are not pathspecs.
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        redir = REDIRECT_RE.match(token)
        if redir:
            # a redirect is not a pathspec; a bare operator takes its
            # target as the next token
            i += 2 if not redir.group(2) else 1
            continue
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
