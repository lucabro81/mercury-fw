#!/usr/bin/env python3
"""Hook pre_tool: block git commit on the main branch.

Analyzes the command line segment by segment (split on ;, &&, ||, |, & and
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

A switch to a previous branch (`git checkout -`, `git switch -`,
`git checkout @{-2}`) is resolved the way git resolves it at execution
time — against the checkout history the command implies so far, because
a switch earlier in the same command line moves `@{-N}` — and marks or
un-marks its target directory like a literal switch.

A switch target that is not a branch is resolved the way git resolves
it: a revision (a tag, a sha, `main~1`) detaches HEAD and un-marks, a
pathspec (`git checkout .`, `git checkout <file>`, `git checkout HEAD`)
restores paths and changes nothing. A branch-creating switch
(`git checkout -b <name>`, `git switch -c <name>`,
`git checkout --orphan <name>`) marks or un-marks by the branch it
creates. Git global options before the subcommand (`git --no-pager
commit`, `git -C <path> -c x=y commit`) are accepted; a `bash -c`-style
wrapper with flags or an absolute path, and a `( ... )` / `$( ... )`
subshell, are analyzed for their inner command line too.

This hook is a guard-rail for an honest but fallible agent, not a
sandbox: the analysis is textual, so a deliberately hostile command can
route around it (an alias, a renamed binary, `git --git-dir=<foreign
repo>`, editing .git directly). It exists to catch the common accidents
of the Mercury workflow — a commit on main — not to stop an adversary.
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

# A command prefix: sudo/env/command/xargs wrappers (env and sudo take
# flags, e.g. `env -i`) and env assignments.
PREFIX = r"\s*(?:(?:sudo|env|command|xargs)(?:\s+-\w+)*\s+)*(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"

# Git global options between `git` and the subcommand: -C <path> (also
# attached, -C<path>), -c <name>=<value>, short globals (-p) and long
# globals (--no-pager, --paginate=always). Only -C changes the directory
# a segment operates on; the rest are accepted so the subcommand is
# still recognized. --git-dir/--work-tree are accepted but not tracked:
# a segment that points at a foreign repository is outside this hook's
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

# Checkout/switch options (short options only, never a bare `--`).
OPTIONS = r"(?:-(?!-)\S+\s+)*"

# A commit as a standalone command: git commit, git -C <path> commit,
# git --no-pager commit, env git commit, FOO=1 git commit. The lookahead
# after `commit` keeps plumbing subcommands (commit-tree, commit-graph)
# from counting as one.
COMMIT_RE = re.compile(
    PREFIX + r"git\s+" + GIT_OPTS + r"commit(?![\w-])"
)

# A switch to the local main/master branch as a standalone command:
# git checkout/switch main, git -C <path> checkout main. The lookaheads
# after the branch name reject longer names (mainline, main-x, main/x)
# and revision suffixes (main~1 detaches HEAD, it does not switch), and
# the pathspec form (`git checkout main -- <paths>` restores paths, it
# does not switch). A bare word after the branch is the two-argument
# pathspec form (`git checkout main <path>`): it restores paths and does
# not switch either; options after the branch are fine (`git checkout
# main -q` really switches). Group 2 captures the branch (group 1 is
# the git global options).
SWITCH_RE = re.compile(
    PREFIX +
    r"git\s+" + GIT_OPTS +
    r"(?:checkout|switch)\s+"
    + OPTIONS +
    r"((?:main|master)|refs/heads/(?:main|master))(?![/\w-])(?=\s*(?:-|$))(?!\s*--)"
)

# A branch-creating checkout/switch (`git checkout -b <name>`,
# `git switch -c <name>` / `--create`, `git switch -C <name>`,
# `git checkout --orphan <name>`) as a standalone command: the command
# switches to the branch it creates (an unborn one for --orphan), so it
# marks or un-marks like a literal switch. Group 2 is the option, group 3
# the branch name (attached or separate).
CREATE_RE = re.compile(
    PREFIX +
    r"git\s+" + GIT_OPTS +
    r"(?:checkout|switch)\s+"
    + OPTIONS +
    r"(-b|-B|-c|-C|--create|--force-create|--orphan)\s*"
    r"(\"[^\"]*\"|'[^']*'|\S+)"
)

# A switch to any other target as a standalone command: un-marks a
# directory a previous switch to main/master marked when the target is a
# branch or a revision (a revision detaches HEAD); a pathspec target
# restores paths and changes nothing (resolved via git, see below). The
# pathspec forms (`git checkout <target> -- <paths>` and the
# two-argument `git checkout <target> <path>`) are excluded, as is a
# switch to main/master itself. Group 2 captures the target.
SWITCH_AWAY_RE = re.compile(
    PREFIX +
    r"git\s+" + GIT_OPTS +
    r"(?:checkout|switch)\s+"
    + OPTIONS +
    r"(?!(?:main|master|refs/heads/(?:main|master))(?=\s|$|--))"
    r"(?!-)"
    r"(\"[^\"]*\"|'[^']*'|\S+)"
    r"(?=\s*(?:-|$))(?!\s*--)"
)

# A switch to a previous branch as a standalone command: the previous-
# checkout shorthand (`git checkout -`, `git switch -`) and its numbered
# form (`git checkout @{-2}`). Group 2 captures the target (group 1 is
# the git global options). The pathspec forms (`git checkout - -- <paths>`
# and `git checkout - <path>` restore paths, they do not switch) are
# excluded, and so are option clusters: the shorthand is a bare `-`,
# never `-b` or `--`.
PREV_SWITCH_RE = re.compile(
    PREFIX +
    r"git\s+" + GIT_OPTS +
    r"(?:checkout|switch)\s+"
    + OPTIONS +
    r"(-|@\{-\d+\})(?![\w-])(?=\s*(?:-|$))(?!\s*--)"
)

# A cd that changes the working directory for the rest of the command
# line: `cd <path>` as a standalone segment (a bare `cd` goes home). The
# target path is captured in group 1.
CD_RE = re.compile(r"\s*cd\b\s*(?:(\"[^\"]*\"|'[^']*'|\S+)\s*)?$")

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


def split_segments(command):
    """Split a command line on separators (&&, ||, ;, |, &, newline).

    A separator inside a quoted section or inside a ( ... ) / $( ... )
    subshell does not split: bash parses it as part of the subshell's
    command line, not as a command separator of the outer line. A bare
    `&` backgrounds the command before it, so the rest of the line is a
    new command; the `&` of a redirect (`&>`, `2>&1`) is not a
    separator.
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


def wrapper_inner(match):
    """The inner command line of a WRAPPER_RE match."""
    return match.group(1) if match.group(1) is not None else match.group(2)


def subshell_spans(command):
    """The inner command lines of ( ... ) and $( ... ) subshells.

    Quote-aware and nesting-aware: a subshell executes its inner command
    line, so a commit, a switch or a `cd` inside one counts like a
    direct segment. The spans are analyzed in the caller's scope: a `cd`
    inside a subshell does not change the caller's directory, while a
    switch marks the shared state.
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
    """The directory a git segment operates on: its last `git -C` global
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


def resolve_switch_target(root, target):
    """How git resolves a checkout/switch target: 'branch' when it names
    a local branch, 'rev' when it resolves to a commit (a tag, a sha,
    main~1 — the switch detaches HEAD), '' otherwise (a pathspec: the
    command restores paths and stays on the branch)."""
    if subprocess.run(
        ["git", "-C", root, "show-ref", "--verify", "--quiet",
         f"refs/heads/{target}"],
        capture_output=True,
    ).returncode == 0:
        return "branch"
    if subprocess.run(
        ["git", "-C", root, "rev-parse", "--verify", "--quiet",
         f"{target}^{{commit}}"],
        capture_output=True,
    ).returncode == 0:
        return "rev"
    return ""


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


def current_branch(directory):
    try:
        return subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=directory,
        ).stdout.strip()
    except Exception:
        return ""


def branch_history(root):
    """The checkout history `@{-N}` resolves against, read live.

    `prevs[0]` is what `@{-1}` stands for — the position before the most
    recent checkout — `prevs[1]` the one before that, and so on: the
    "from" side of git's `checkout: moving from X to Y` reflog entries,
    newest first. A previous position that was a detached HEAD is
    recorded as its commit id, which never names main/master.
    """
    current = current_branch(root)
    if not current:
        # a detached HEAD: record the commit id, like the reflog does
        try:
            current = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, cwd=root,
            ).stdout.strip()
        except Exception:
            current = ""
    prevs = []
    try:
        log = subprocess.run(
            ["git", "reflog", "show", "HEAD", "--format=%gs"],
            capture_output=True, text=True, cwd=root,
        ).stdout
        for line in log.splitlines():
            marker = "checkout: moving from "
            if not line.startswith(marker):
                continue
            source, sep, _target = line[len(marker):].partition(" to ")
            if sep and source:
                prevs.append(source)
    except Exception:
        pass
    return {"current": current, "prevs": prevs}


def sim_state(sim, root):
    """A git root's checkout history after the segments processed so far."""
    if root not in sim:
        sim[root] = branch_history(root)
    return sim[root]


def apply_switch(sim, root, branch):
    """Record a switch to `branch` in a root's simulated checkout history."""
    state = sim_state(sim, root)
    state["prevs"] = [state["current"]] + state["prevs"]
    state["current"] = branch
    state["touched"] = True


def previous_branch(sim, root, target):
    """The branch a previous-branch switch target resolves to, or ''.

    A switch earlier in the same command line moves `@{-N}`, so the live
    reflog alone would answer for the wrong point in the command: the
    history the segments so far imply is used instead.
    """
    if target == "-":
        n = 1
    else:
        n = int(re.fullmatch(r"@\{-(\d+)\}", target).group(1))
    prevs = sim_state(sim, root)["prevs"]
    return prevs[n - 1] if n <= len(prevs) else ""


def run_command_line(command, directory, switched_to_main, sim):
    """Analyze one shell scope; return the deny payload, or None.

    `directory` is the scope's working directory: a `cd` inside a
    bash -c wrapper changes it for the wrapper's own segments only (the
    recursion scopes it), while a switch marks a git root in
    `switched_to_main`, which is shared across scopes — a switch inside a
    wrapper still decides what a commit after the wrapper lands on.
    `sim` holds each git root's checkout history as the command implies
    it so far (shared across scopes the same way); it resolves
    previous-branch switch targets.
    """
    for segment in split_segments(command):
        wrapped = WRAPPER_RE.match(segment)
        if wrapped:
            payload = run_command_line(wrapper_inner(wrapped), directory, switched_to_main, sim)
            if payload:
                return payload
        for span in subshell_spans(segment):
            # a subshell executes its inner command line in this scope
            payload = run_command_line(span, directory, switched_to_main, sim)
            if payload:
                return payload
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
        if COMMIT_RE.match(segment):
            # A commit segment. A checkout/switch to main/master matching
            # the same segment is a commit message mentioning one, not a
            # switch: the branch the commit lands on is read below — from
            # the simulated history when the command switches the
            # repository earlier, from the live branch otherwise.
            target = git_target_dir(segment, directory)
            root = repo_root(target)
            if root in switched_to_main:
                return {
                    "decision": "deny",
                    "reason": "The command switches to main/master before committing. "
                              "The Mercury workflow requires: branch feat/<N>-<slug>. "
                              "See skill mercury-issue.",
                }
            state = sim.get(root)
            if state and state.get("touched"):
                branch = state["current"]
            else:
                branch = current_branch(target)
            if branch in ("main", "master"):
                return {
                    "decision": "deny",
                    "reason": f"Direct commit on '{branch}' blocked. "
                              "The Mercury workflow requires: branch feat/<N>-<slug> "
                              "from an approved issue. See skill mercury-issue.",
                }
            continue
        switch = SWITCH_RE.match(segment)
        if switch:
            root = repo_root(git_target_dir(segment, directory))
            switched_to_main.add(root)
            apply_switch(sim, root, switch.group(2).removeprefix("refs/heads/"))
            continue
        create = CREATE_RE.match(segment)
        if create:
            # `git checkout -b <name>` / `git switch -c <name>` /
            # `git checkout --orphan <name>`: switch to the branch they
            # create (an unborn one for --orphan)
            root = repo_root(git_target_dir(segment, directory))
            name = create.group(3).strip("\"'").removeprefix("refs/heads/")
            apply_switch(sim, root, name)
            if name in ("main", "master"):
                switched_to_main.add(root)
            else:
                switched_to_main.discard(root)
            continue
        prev = PREV_SWITCH_RE.match(segment)
        if prev:
            root = repo_root(git_target_dir(segment, directory))
            branch = previous_branch(sim, root, prev.group(2))
            if branch:
                apply_switch(sim, root, branch)
                if branch in ("main", "master"):
                    switched_to_main.add(root)
                else:
                    switched_to_main.discard(root)
            continue
        away = SWITCH_AWAY_RE.match(segment)
        if away:
            target = away.group(2).strip("\"'")
            if target in ("HEAD", "@"):
                # `git checkout HEAD` / `git checkout @` stay on the branch
                continue
            root = repo_root(git_target_dir(segment, directory))
            kind = resolve_switch_target(root, target)
            if kind == "branch":
                switched_to_main.discard(root)
                apply_switch(sim, root, target.removeprefix("refs/heads/"))
            elif kind == "rev":
                # a tag, a sha or main~1: the switch detaches HEAD
                switched_to_main.discard(root)
                apply_switch(sim, root, target)
            # else: a pathspec — the command restores paths and stays on
            # the branch, no state change
            continue
    return None


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    payload = run_command_line(command, os.path.abspath(data.get("cwd", ".")), set(), {})
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


if __name__ == "__main__":
    main()
