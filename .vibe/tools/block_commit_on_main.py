#!/usr/bin/env python3
"""Hook pre_tool: blocca git commit sul branch main.

Analizza ogni segmento di comando (separati da ;, &&, ||, |, \n) per
individuare `git commit` come comando proprio. Blocca se il branch corrente
è main/master, o se il comando contiene `git checkout/switch main/master`
prima del commit (il branch viene controllato prima dell'esecuzione).
"""
import json
import re
import subprocess
import sys

SEPARATORS = r"&&|\|\||;|\||\n"


def find_commit_segments(command):
    """Tutti i segmenti che contengono `git commit` come comando proprio."""
    segments = []
    for segment in re.split(SEPARATORS, command):
        m = re.match(
            r"\s*(?:sudo\s+)?(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*git\s+commit\b",
            segment, re.S,
        )
        if m:
            segments.append(segment)
    return segments


def switches_to_main(command):
    """True se il comando contiene git checkout/switch verso main/master."""
    return re.search(
        r"\bgit\s+(?:checkout|switch)\s+(?:\S+\s+)*?(?:main|master)\b",
        command,
    ) is not None


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    commits = find_commit_segments(command)
    if not commits:
        sys.exit(0)

    # Se il comando switcha a main prima di committare, blocca
    if switches_to_main(command):
        print(json.dumps({
            "decision": "deny",
            "reason": "Il comando switcha a main/master prima di committare. "
                      "Il workflow Mercury richiede: branch feat/<N>-<slug>. Vedi skill mercury-issue.",
        }))
        sys.exit(0)

    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=data.get("cwd", "."),
        ).stdout.strip()
    except Exception:
        sys.exit(0)

    if branch in ("main", "master"):
        print(json.dumps({
            "decision": "deny",
            "reason": f"Commit diretto su '{branch}' bloccato. "
                      "Il workflow Mercury richiede: branch feat/<N>-<slug> da una issue approvata. "
                      "Vedi skill mercury-issue.",
        }))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
