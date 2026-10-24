#!/usr/bin/env python3
"""Hook pre_tool: blocca rm -rf e varianti pericolose.

Riconosce la combinazione ricorsivo+force sia in flag combinati (-rf, -fr,
-Rvf, in qualsiasi ordine e caso) sia in flag separati (rm -r -f), e anche
quando le opzioni vengono dopo il percorso (rm dir -rf, permutazione GNU).
`git rm` non è bloccato: è l'alternativa sicura per i file tracciati.

Controlla solo le invocazioni di `rm` come comando (all'inizio di un segmento
di comando, dopo ;, &&, ||, |, \n), non le sottostringhe in echo, grep, ecc.
Gestisce prefissi env-assignment generici (FOO=1 rm -rf).
"""
import json
import re
import sys

SEPARATORS = r"&&|\|\||;|\||\n"

# Il tool bash nel payload degli hook arriva come "bash" (forma breve,
# documentata negli esempi) o come "file_system.bash" (forma qualificata
# inviata dall'Unified Harness di Vibe): entrambi sono il tool bash.
BASH_TOOL_NAMES = ("bash", "file_system.bash")


def segment_has_dangerous_rm(segment):
    """True se il segmento di comando contiene `rm` con flag ricorsivo+force.

    Gestisce prefissi: sudo, env, command, xargs, env-assignment (FOO=1).
    `git rm` è escluso strutturalmente (il regex non matcha `git rm`).
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
    """True se qualche segmento di comando contiene un rm -rf pericoloso."""
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
