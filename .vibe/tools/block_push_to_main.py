#!/usr/bin/env python3
"""Hook pre_tool: blocca git push verso main/master."""
import json
import subprocess
import sys


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if "git push" not in command:
        sys.exit(0)

    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=data.get("cwd", "."),
        ).stdout.strip()
    except Exception:
        sys.exit(0)

    # Blocca push esplicito verso main/master
    if "main" in command or "master" in command:
        print(json.dumps({
            "decision": "deny",
            "reason": "Push verso main/master bloccato. Il workflow Mercury richiede PR + review gate. Vedi skill mercury-review.",
        }))
        sys.exit(0)

    # Blocca push del branch corrente se è main
    if branch in ("main", "master"):
        print(json.dumps({
            "decision": "deny",
            "reason": f"Push dal branch '{branch}' bloccato. Si pusha solo da branch feat/<N>-<slug>.",
        }))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
