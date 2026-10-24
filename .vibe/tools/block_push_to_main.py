#!/usr/bin/env python3
"""Hook pre_tool: blocca git push verso main/master.

Analizza il refspec del comando push (non una sottostringa qualsiasi della
riga di comando): blocca solo se la destinazione è main/master, se si pusha
--all/--mirror (che includono main), o se il branch corrente è main/master.
"""
import json
import re
import subprocess
import sys


def push_segment(command):
    """Il segmento `git push ...` del comando, o None se non c'è un push.

    Cerca il push come comando proprio (all'inizio o dopo un separatore
    shell), non come sottostringa di un altro comando o di una stringa.
    """
    for segment in re.split(r"&&|\|\||;|\|", command):
        m = re.match(r"\s*(?:sudo\s+)?git\s+push\b(.*)", segment, re.S)
        if m:
            return m.group(1)
    return None


def push_targets(rest):
    """Le destinazioni dei refspec (la parte dopo ':'), senza opzioni."""
    targets = []
    for token in rest.split():
        if token.startswith("-"):
            continue
        token = token.strip("\"'").lstrip("+")
        if ":" in token:
            token = token.split(":", 1)[1]
        if token.startswith("refs/heads/"):
            token = token[len("refs/heads/"):]
        if token:
            targets.append(token)
    return targets


def deny(reason):
    print(json.dumps({"decision": "deny", "reason": reason}))
    sys.exit(0)


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    rest = push_segment(command)
    if rest is None:
        sys.exit(0)

    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=data.get("cwd", "."),
        ).stdout.strip()
    except Exception:
        sys.exit(0)

    # --all e --mirror pushano ogni branch locale, main compreso
    if re.search(r"--all\b|--mirror\b", rest):
        deny("Push con --all/--mirror bloccato: pusherebbe anche main. "
             "Il workflow Mercury richiede PR + review gate. Vedi skill mercury-review.")

    # Blocca push esplicito verso main/master
    if any(target in ("main", "master") for target in push_targets(rest)):
        deny("Push verso main/master bloccato. Il workflow Mercury richiede PR + review gate. "
             "Vedi skill mercury-review.")

    # Blocca push del branch corrente se è main
    if branch in ("main", "master"):
        deny(f"Push dal branch '{branch}' bloccato. Si pusha solo da branch feat/<N>-<slug>.")

    sys.exit(0)


if __name__ == "__main__":
    main()
