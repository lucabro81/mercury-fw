#!/usr/bin/env python3
"""Hook pre_tool: block rm -rf and dangerous variants.

Recognizes the recursive+force combination both in combined flags (-rf,
-fr, -Rvf, in any order and case) and in separate flags (rm -r -f), and
also when the options come after the path (rm dir -rf, GNU permutation).
Long options are matched as GNU accepts them: unambiguous abbreviations
(--rec, --for) count too. `git rm` is not blocked: it is the safe
alternative for tracked files.

Only `rm` invocations as a command are checked (at the start of a command
segment, after ;, &&, ||, |, &, \n — outside quotes, so text inside a quoted
argument is not a command), not substrings inside echo, grep, etc.
Handles generic env-assignment prefixes (FOO=1 rm -rf). A
`bash -c '...'` / `sh -c '...'` wrapper (with flags or an absolute path,
e.g. `bash -lc`, `/bin/bash -c`) is unwrapped and its inner command
line is checked the same way, and so is the inner command line of a
`( ... )` / `$( ... )` subshell.

This hook is a guard-rail for an honest but fallible agent, not a
sandbox: the analysis is textual, so a deliberately hostile command can
route around it (an alias, a renamed binary, `mv .git` away). It exists
to catch the common accidents of the Mercury workflow — an `rm -rf` —
not to stop an adversary.
"""
import json
import re
import shlex
import sys

# The bash tool in the hook payload arrives as "bash" (short form,
# documented in the examples), as "file_system.bash" or "process.start"
# (qualified forms sent by Vibe's Unified Harness): all of them are the
# bash tool.
BASH_TOOL_NAMES = ("bash", "file_system.bash", "process.start")

# A command prefix: sudo/env/command/xargs wrappers (env and sudo take
# flags, e.g. `env -i`) and env assignments.
PREFIX = r"\s*(?:(?:sudo|env|command|xargs)(?:\s+-\w+)*\s+)*" \
         r"(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"

# `rm` as a standalone command — with sudo/env/command/xargs prefixes and
# env assignments. `git rm` is excluded structurally: the regex is anchored
# at the segment start, so it does not match `git rm`.
RM_RE = re.compile(PREFIX + r"rm\b")

# A bash/sh -c '...' wrapper: the segment stands for its inner command
# line, which is checked in place of the segment (group 1 is the
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


def wrapper_inner(match):
    """The inner command line of a WRAPPER_RE match."""
    return match.group(1) if match.group(1) is not None else match.group(2)


def subshell_spans(command):
    """The inner command lines of ( ... ) and $( ... ) subshells.

    Quote-aware and nesting-aware: a subshell executes its inner command
    line, so an `rm` inside one counts like a direct segment.
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


def segment_has_dangerous_rm(segment):
    """True when the command segment contains `rm` with recursive+force flags.

    Handles prefixes: sudo, env, command, xargs, env-assignment (FOO=1).
    `git rm` is excluded structurally (the regex does not match `git rm`).
    """
    m = RM_RE.match(segment)
    if not m:
        return False
    rest = segment[m.end():]
    try:
        tokens = shlex.split(rest)
    except ValueError:
        tokens = rest.split()
    recursive = force = False
    for token in tokens:
        if token == "--":
            break
        if token.startswith("--"):
            # GNU rm accepts unambiguous abbreviations of its long
            # options (--rec, --for); macOS's BSD rm rejects them, so
            # blocking them is a false positive there, never a miss
            name = token[2:].split("=", 1)[0]
            if name and "recursive".startswith(name):
                recursive = True
            elif name and "force".startswith(name):
                force = True
        elif token.startswith("-") and len(token) > 1:
            flags = token[1:]
            if "r" in flags or "R" in flags:
                recursive = True
            if "f" in flags or "F" in flags:
                force = True
    return recursive and force


def is_dangerous_rm(command):
    """True when some command segment contains a dangerous rm -rf."""
    for segment in split_segments(command):
        wrapped = WRAPPER_RE.match(segment)
        if wrapped:
            if is_dangerous_rm(wrapper_inner(wrapped)):
                return True
        for span in subshell_spans(segment):
            # a subshell executes its inner command line
            if is_dangerous_rm(span):
                return True
        if wrapped:
            continue
        if segment_has_dangerous_rm(segment):
            return True
    return False


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")

    if is_dangerous_rm(command):
        print(json.dumps({
            "decision": "deny",
            "reason": "rm -rf blocked. Use git rm for tracked files, or verify the path manually.",
        }))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
