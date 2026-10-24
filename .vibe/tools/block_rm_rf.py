#!/usr/bin/env python3
"""Hook pre_tool: blocca rm -rf e varianti pericolose.

Riconosce la combinazione ricorsivo+force sia in flag combinati (-rf, -fr,
-Rvf, in qualsiasi ordine e caso) sia in flag separati (rm -r -f), e anche
quando le opzioni vengono dopo il percorso (rm dir -rf, permutazione GNU).
`git rm` non è bloccato: è l'alternativa sicura per i file tracciati.
"""
import json
import re
import sys


def is_git_rm(command, start):
    """True se l'occorrenza di `rm` in `start` è il comando `git rm`."""
    prefix = command[max(0, start - 10):start]
    return re.search(r"(?:sudo\s+)?git\s+$", prefix) is not None


def is_dangerous_rm(command):
    for m in re.finditer(r"(?<![\w./-])rm\b", command):
        if is_git_rm(command, m.start()):
            continue
        segment = re.split(r"&&|\|\||;|\|", command[m.end():])[0]
        recursive = force = False
        for token in segment.split():
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
        if recursive and force:
            return True
    return False


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")

    if is_dangerous_rm(command):
        print(json.dumps({
            "decision": "deny",
            "reason": "Comando rm -rf bloccato. Usa git rm per file tracciati, o verifica il path manualmente.",
        }))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
