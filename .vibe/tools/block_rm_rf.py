#!/usr/bin/env python3
"""Hook pre_tool: block rm -rf and dangerous variants.

Recognizes the recursive+force combination both in combined flags (-rf,
-fr, -Rvf, in any order and case) and in separate flags (rm -r -f), and
also when the options come after the path (rm dir -rf, GNU permutation).
`git rm` is not blocked: it is the safe alternative for tracked files.

Only `rm` invocations as a command are checked (at the start of a command
segment, after ;, &&, ||, |, \n — outside quotes, so text inside a quoted
argument is not a command), not substrings inside echo, grep, etc.
Handles generic env-assignment prefixes (FOO=1 rm -rf). A
`bash -c '...'` / `sh -c '...'` wrapper is unwrapped and its inner command
line is checked the same way.
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

# A command prefix: sudo/env/command/xargs wrappers and env assignments.
PREFIX = r"\s*(?:sudo\s+|env\s+|command\s+|xargs\s+)*" \
         r"(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"

# `rm` as a standalone command — with sudo/env/command/xargs prefixes and
# env assignments. `git rm` is excluded structurally: the regex is anchored
# at the segment start, so it does not match `git rm`.
RM_RE = re.compile(PREFIX + r"rm\b")

# A bash -c '...' / sh -c '...' wrapper: the segment stands for its inner
# command line, which is checked in place of the segment (group 1 is the
# single-quoted, group 2 the double-quoted inner command).
WRAPPER_RE = re.compile(
    PREFIX + r"(?:bash|sh)\s+-c\s+(?:'([^']*)'|\"([^\"]*)\")"
)


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
            if token == "--recursive":
                recursive = True
            elif token == "--force":
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
