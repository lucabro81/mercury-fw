#!/usr/bin/env python3
"""Hook pre_tool: blocca git commit sul branch main."""
import json
import subprocess
import sys


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if "git commit" not in command:
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
            "reason": f"Commit diretto su '{branch}' bloccato. Il workflow Mercury richiede: branch feat/<N>-<slug> da una issue approvata. Vedi skill mercury-issue.",
        }))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
