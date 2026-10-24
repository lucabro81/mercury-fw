#!/usr/bin/env python3
"""Hook pre_tool: blocca rm -rf e varianti pericolose."""
import json
import re
import sys

DANGEROUS_PATTERNS = [
    r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-\w*f\w*r\w*|--recursive\s+--force)\b",
    r"\brm\s+(-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-\w*r\w*f\w*|--force\s+--recursive)\b",
    r"\brm\s+-rf\b",
    r"\brm\s+-fr\b",
    r"\brm\s+--recursive\s+--force\b",
    r"\brm\s+--force\s+--recursive\b",
]


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")

    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, command):
            print(json.dumps({
                "decision": "deny",
                "reason": "Comando rm -rf bloccato. Usa git rm per file tracciati, o verifica il path manualmente.",
            }))
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
