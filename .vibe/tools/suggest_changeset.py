#!/usr/bin/env python3
"""Hook pre_tool: warn when a commit is missing a changeset.

Checks the files the commit would include — the staged ones (all of them,
or only the files matching a pathspec commit's pathspecs), the files a
`git add` earlier in the same command would stage (filtered the same way
for a pathspec commit), plus tracked unstaged modifications when the
commit uses -a/--all (the whole tree) or a pathspec (only the files
matching it) — and warns if they touch a published workspace without a
changeset. Repo tooling (.vibe/, scripts/, .github/, docs site, test
bed) does not require a changeset.

Line comments are stripped before the analysis the way bash parses them
(an unquoted `#` at a word start runs to the end of the line), so a
comment cannot hide a commit or smuggle in a pathspec. A backslash at
the end of a line continues the command on the next one (an escaped `\\`
ends it instead), and a redirect at the start of a segment does not hide
the command after it (`2>/dev/null git commit` really commits).

The commit's target directory is tracked through `cd` segments and the
commit's own `git -C <path>` (with ~ and $VAR expansion), so the warning
reflects the repository the commit lands in, not the shell's current
directory. Git queries run from that repository's root, so a commit
issued from a subdirectory is analyzed the same as one from the root.

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

# A redirect token: an operator (`>`, `>>`, `<`, `<>`, `>|`, `&>`, `&>>`,
# `2>`, `2>>`, `2>&1`, `2>&-`, `>&2`, and the here-doc/here-string forms
# `<<`, `<<-`, `<<<`) with its optional target word, attached (`>log`) or
# separated (`> log`), quoted or bare. Bash allows a redirect before the
# command, so a segment may start with them (`2>/dev/null git commit`
# really commits).
REDIRECT_TOKEN = (
    r"(?:&>>?|>\||<>|<<-|<<?|\d*>&|\d*>>?|\d*<&|\d*<)"
    r"(?:\s*(?:\"[^\"]*\"|'[^']*'|[^\s;&|<>#]+))?"
)

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

# `git add` as a standalone command (git add, git -C <path> add, git
# --no-pager add), anchored at segment start like COMMIT_ARGS_RE. Group 1
# captures the git global options, group 2 the add's arguments.
ADD_ARGS_RE = re.compile(
    PREFIX +
    r"git\s+" + GIT_OPTS +
    r"add(?![\w-])"
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


def strip_comments(command):
    """Remove line comments the way bash parses them: an unquoted `#` at
    a word start (the beginning of the line, after whitespace, or after
    a `; & | ( ) > <` operator) runs to the end of the line; the newline
    itself is kept, it still separates commands. A `#` inside quotes,
    one escaped with a backslash, or mid-word (`a#b`, `$#`, `${#x}`,
    `"a"#c`) is literal.
    """
    out = []
    quote = None
    word_start = True
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if quote == "'":
            out.append(ch)
            if ch == "'":
                quote = None
            word_start = False
            i += 1
            continue
        if quote == '"':
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(command[i + 1])
                word_start = False
                i += 2
                continue
            if ch == '"':
                quote = None
            word_start = False
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(ch)
            out.append(command[i + 1])
            word_start = False
            i += 2
            continue
        if ch == "'" or ch == '"':
            quote = ch
            out.append(ch)
            word_start = False
            i += 1
            continue
        if ch == "#" and word_start:
            # a comment runs to the end of the line; the newline is kept
            while i < n and command[i] != "\n":
                i += 1
            continue
        out.append(ch)
        word_start = ch in " \t\n;&|()><"
        i += 1
    return "".join(out)


def split_segments(command):
    """Split a command line on separators (&&, ||, ;, |, &, newline).

    A separator inside a quoted section or inside a ( ... ) / $( ... )
    subshell does not split: the shell parses it as part of the
    subshell's command line, not as a command separator of the outer
    line. A bare `&` backgrounds the command before it, so the rest of
    the line is a new command; the `&` of a redirect (`&>`, `2>&1`) is
    not a separator.
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
        elif depth == 0 and ch == "&" and not command.startswith("&>", i) \
                and (i == 0 or command[i - 1] != ">"):
            segments.append("".join(current))
            current = []
            i += 1
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


def strip_leading_redirects(segment):
    """Remove redirect tokens at the start of a segment: bash allows a
    redirect before the command (`2>/dev/null git commit` really
    commits), so the command after them is the segment's command."""
    while True:
        m = re.match(r"\s*" + REDIRECT_TOKEN, segment)
        if not m:
            return segment
        segment = segment[m.end():]


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


def repo_root(directory):
    """The git root of directory, or directory itself when it is not a repo."""
    out = git(directory, "rev-parse", "--show-toplevel")
    return os.path.normpath(out) if out else os.path.normpath(directory)


def commit_target(command, directory, adds=None):
    """The first `git commit` standalone command: its arguments, the
    directory it commits in, and the files earlier `git add` segments in
    the same scope would stage, or None.

    `directory` is the scope's working directory: a `cd` segment moves it
    for the rest of the scope (a `cd` inside a bash -c wrapper stays
    inside the wrapper), and a segment's own `git -C <path>` overrides
    it. A `git add` before the commit stages its pathspecs — the whole
    tree for -A/--all (untracked files included), only tracked
    modifications for -u/--update; a --dry-run add stages nothing.
    `adds` is the list of `git add`s earlier in the same scope, shared
    with the wrapper and subshell recursions: an add inside a `bash -c`
    wrapper or a `( ... )` subshell stages into the same index, so it
    counts for a commit after it too.
    """
    if adds is None:
        adds = []  # (directory, (kind, pathspecs))
    command = strip_comments(command)
    # a backslash at the end of a line continues the command on the next
    # one (`git commit \` + newline + `-m x` is one command); join before
    # splitting. An escaped backslash (`\\`) ends the command instead, so
    # it is not joined.
    command = re.sub(r"(?<!\\)\\\n", " ", command)
    for segment in split_segments(command):
        # a redirect at the start of a segment (`2>/dev/null git commit`)
        # really runs the command after it
        segment = strip_leading_redirects(segment)
        wrapped = WRAPPER_RE.match(segment)
        if wrapped:
            found = commit_target(wrapper_inner(wrapped), directory, adds)
            if found is not None:
                return found
        for span in subshell_spans(segment):
            # a subshell executes its inner command line in this scope
            found = commit_target(span, directory, adds)
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
        m = ADD_ARGS_RE.match(segment)
        if m:
            parsed = parse_add_args(m.group(2))
            if parsed is not None:  # None = --dry-run: stages nothing
                adds.append((git_target_dir(segment, directory), parsed))
            continue
        m = COMMIT_ARGS_RE.match(segment)
        if m:
            target_dir = git_target_dir(segment, directory)
            added = set()
            root = repo_root(target_dir)
            for add_dir, (kind, pathspecs) in adds:
                if repo_root(add_dir) == root:
                    added |= add_files(root, kind, root_pathspecs(add_dir, root, pathspecs))
            return m.group(2), target_dir, added
    return None


# A redirect token: `>`, `>>`, `2>`, `2>&1`, `&>`, `<` and their attached
# targets (`>log`, `2>file`). Group 1 is the operator, group 2 the
# attached target (empty when the target is the next token).
REDIRECT_RE = re.compile(r"([&]?\d*>+|&\d*>?|<)(.*)")


def parse_add_args(args):
    """A `git add`'s arguments: None when the add stages nothing
    (--dry-run), else (kind, pathspecs) — kind is "all" for -A/--all (the
    whole tree, untracked files included), "update" for -u/--update (the
    tracked modifications only: `git add -u` never stages untracked
    files), or "paths" for a plain pathspec add."""
    try:
        tokens = shlex.split(args)
    except ValueError:
        tokens = args.split()
    kind = "paths"
    pathspecs = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token == "--":
            pathspecs.extend(tokens[i + 1:])
            break
        if token in ("-n", "--dry-run"):
            return None
        if token in ("-A", "--all"):
            kind = "all"
            i += 1
            continue
        if token in ("-u", "--update"):
            kind = "update"
            i += 1
            continue
        if token.startswith("--pathspec-from-file"):
            # the paths come from a file: treat the add as whole-tree
            kind = "all"
            i += 2 if "=" not in token else 1
            continue
        if token.startswith("--"):
            i += 1
            continue
        if token.startswith("-") and len(token) > 1:
            # a short option cluster; only -n matters and is handled above
            i += 1
            continue
        pathspecs.append(token)
        i += 1
    return kind, pathspecs


def root_pathspecs(directory, root, pathspecs):
    """Pathspecs rewritten as seen from the repo root: git resolves a
    pathspec against the working directory it is given, so one written
    in a subdirectory is prefixed with that subdirectory's
    root-relative path. Magic pathspecs (:...) and root-relative ones
    (/) are left alone."""
    # realpath: git reports the toplevel symlink-resolved (/private/var/...)
    # while the shell's cwd may be the unresolved path (/var/...)
    prefix = os.path.relpath(os.path.realpath(directory), os.path.realpath(root))
    if prefix == ".":
        return list(pathspecs)
    out = []
    for path in pathspecs:
        if path.startswith(":") or path.startswith("/"):
            out.append(path)
        else:
            out.append(os.path.normpath(os.path.join(prefix, path)))
    return out


def add_files(directory, kind, pathspecs):
    """The files a `git add` would stage. "all" (-A/--all): the tracked
    modifications and the untracked files, of the whole tree or of the
    pathspecs. "update" (-u/--update): the tracked modifications only —
    `git add -u` never stages untracked files. "paths": the tracked
    modifications and the untracked files matching the pathspecs."""
    files = set()
    if kind in ("all", "update"):
        for path in pathspecs or [None]:
            diff_args = ["diff", "--name-only"] + ([] if path is None else ["--", path])
            for f in git(directory, *diff_args).split("\n"):
                if f:
                    files.add(f)
            if kind == "all":
                others_args = ["ls-files", "--others", "--exclude-standard"] \
                    + ([] if path is None else ["--", path])
                for f in git(directory, *others_args).split("\n"):
                    if f:
                        files.add(f)
        return files
    for path in pathspecs:
        for f in git(directory, "diff", "--name-only", "--", path).split("\n"):
            if f:
                files.add(f)
        for f in git(directory, "ls-files", "--others", "--exclude-standard", "--", path).split("\n"):
            if f:
                files.add(f)
    return files


def commit_scope(args):
    """What a commit includes beyond the staged set: ('all', None) for
    -a/--all (the whole tree) or --pathspec-from-file, ('paths',
    [pathspecs]) for a pathspec commit, ('none', None) otherwise.
    Redirect tokens are not pathspecs."""
    try:
        tokens = shlex.split(args)
    except ValueError:
        tokens = args.split()
    pathspecs = []
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
            return "all", None
        if token in VALUE_OPTIONS:
            i += 2
            continue
        if token in ("-a", "--all"):
            return "all", None
        if token == "--":
            pathspecs.extend(tokens[i + 1:])
            break
        if token.startswith("--"):
            i += 1
            continue
        if token.startswith("-") and len(token) > 1:
            flags = token[1:]
            j = 0
            while j < len(flags):
                letter = flags[j]
                if letter == "a":
                    return "all", None
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
        pathspecs.append(token)
        i += 1
    if pathspecs:
        return "paths", pathspecs
    return "none", None


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    found = commit_target(command, os.path.abspath(data.get("cwd", ".")))
    if found is None:
        sys.exit(0)
    args, target_dir, added = found

    scope, pathspecs = commit_scope(args)
    # Git queries run from the repository root: `git diff` prints
    # root-relative paths from any directory, but a pathspec is
    # working-directory-relative (`.changeset/` from a subdirectory
    # fails) and `git ls-files` prints working-directory-relative
    # paths — so the pathspecs are rewritten to root-relative form
    # and every query runs from the root.
    root = repo_root(target_dir)
    pathspecs = root_pathspecs(target_dir, root, pathspecs or [])

    # The staged set the commit includes: all of it, or — for a pathspec
    # commit — only the files matching its pathspecs (the other staged
    # changes stay staged, the commit does not include them). The files
    # an earlier `git add` would stage are filtered the same way.
    if scope == "paths":
        staged = [
            f for f in git(root, "diff", "--cached", "--name-only", "--", *pathspecs).split("\n")
            if f
        ]
        matching = set()
        for f in git(root, "ls-files", "--", *pathspecs).split("\n"):
            if f:
                matching.add(f)
        for f in git(root, "ls-files", "--others", "--exclude-standard", "--", *pathspecs).split("\n"):
            if f:
                matching.add(f)
        included_added = added & matching
    else:
        staged = [f for f in git(root, "diff", "--cached", "--name-only").split("\n") if f]
        included_added = added

    files = set(staged) | included_added
    if scope == "all":
        for f in git(root, "diff", "--name-only").split("\n"):
            if f:
                files.add(f)
    elif scope == "paths":
        for f in git(root, "diff", "--name-only", "--", *pathspecs).split("\n"):
            if f:
                files.add(f)

    # Only published workspaces require a changeset; .md files are
    # out of scope (the hook's scope is code changes)
    relevant = [
        f for f in files
        if f.startswith(CHANGESET_REQUIRED_PREFIXES)
        and not f.startswith(CHANGESET_EXCLUDED_PREFIXES)
        and not f.endswith(".md")
    ]
    if not relevant:
        sys.exit(0)

    # A changeset the commit would include covers: staged changeset
    # files (all of them, or only the ones matching a pathspec commit's
    # pathspecs), the ones the command's own `git add` would stage
    # (filtered the same way), plus tracked unstaged ones when the
    # commit includes unstaged modifications. An untracked changeset
    # file is included by no commit form, so it does not count.
    changeset_files = {f for f in staged if f.startswith(".changeset/")}
    if scope == "all":
        for f in git(root, "diff", "--name-only", ".changeset/").split("\n"):
            if f:
                changeset_files.add(f)
    elif scope == "paths":
        for f in git(root, "diff", "--name-only", "--", *pathspecs).split("\n"):
            if f and f.startswith(".changeset/"):
                changeset_files.add(f)
    # a changeset staged by the command's own `git add` is included too
    changeset_files |= {f for f in included_added if f.startswith(".changeset/")}

    # ...or the last commit already carried one
    last_commit_files = git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
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

    sys.exit(0)


if __name__ == "__main__":
    main()
