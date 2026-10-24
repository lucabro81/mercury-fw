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


def segment_has_dangerous_rm(segment):
    """True se il segmento di comando inizia con `rm` (non `git rm`) e ha
    sia il flag ricorsivo che force."""
    m = re.match(
        r"\s*(?:sudo\s+)?(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*rm\b",
        segment,
    )
    if not m:
        return False
    # Escludi git rm (strutturalmente non matchato dal regex sopra, ma per
    # sicurezza verifichiamo che non ci sia `git` prima di `rm`)
    prefix = segment[:m.start()].strip()
    if re.search(r"\bgit\s*$", prefix):
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
