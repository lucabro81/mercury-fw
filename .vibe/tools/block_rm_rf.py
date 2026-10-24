#!/usr/bin/env python3
"""Hook pre_tool: block rm -rf and dangerous variants.

Recognizes the recursive+force combination both in combined flags (-rf,
-fr, -Rvf, in any order and case) and in separate flags (rm -r -f), and
also when the options come after the path (rm dir -rf, GNU permutation).
`git rm` is not blocked: it is the safe alternative for tracked files.

Only `rm` invocations as a command are checked (at the start of a command
segment, after ;, &&, ||, |, \n), not substrings inside echo, grep, etc.
Handles generic env-assignment prefixes (FOO=1 rm -rf).
"""
import json
import re
import sys

SEPARATORS = r"&&|\|\||;|\||\n"

# The bash tool in the hook payload arrives as "bash" (short form,
# documented in the examples), as "file_system.bash" or "process.start"
# (qualified forms sent by Vibe's Unified Harness): all of them are the
# bash tool.
BASH_TOOL_NAMES = ("bash", "file_system.bash", "process.start")


def segment_has_dangerous_rm(segment):
    """True when the command segment contains `rm` with recursive+force flags.

    Handles prefixes: sudo, env, command, xargs, env-assignment (FOO=1).
    `git rm` is excluded structurally (the regex does not match `git rm`).
    """
    m = re.match(
        r"\s*(?:sudo\s+|env\s+|command\s+|xargs\s+)*"
        r"(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*rm\b",
        segment,
    )
    if not m:
        return False
    rest = segment[m.end():]
    recursive = force = False
    for token in rest.split():
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
    segments = re.split(SEPARATORS, command)
    return any(segment_has_dangerous_rm(seg) for seg in segments)


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
