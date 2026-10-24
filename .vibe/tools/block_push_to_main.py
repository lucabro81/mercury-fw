#!/usr/bin/env python3
"""Hook pre_tool: blocca git push verso main/master.

Analizza TUTTI i segmenti `git push` nel comando (non solo il primo).
Blocca se una destinazione è main/master, se si pusha --all/--mirror,
o se il branch corrente è main/master. Controlla anche `git checkout/switch
main` prima del push.
"""
import json
import re
import subprocess
import sys

SEPARATORS = r"&&|\|\||;|\||\n"

# Il tool bash nel payload degli hook arriva come "bash" (forma breve,
# documentata negli esempi) o come "file_system.bash" (forma qualificata
# inviata dall'Unified Harness di Vibe): entrambi sono il tool bash.
BASH_TOOL_NAMES = ("bash", "file_system.bash")


def find_push_segments(command):
    """Tutti i segmenti che contengono `git push` come comando proprio."""
    segments = []
    for segment in re.split(SEPARATORS, command):
        m = re.match(
            r"\s*(?:sudo\s+)?(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*git\s+push\b(.*)",
            segment, re.S,
        )
        if m:
            segments.append(m.group(1))
    return segments


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


def switches_to_main(command):
    """True se il comando contiene git checkout/switch verso main/master."""
    return re.search(
        r"\bgit\s+(?:checkout|switch)\s+(?:\S+\s+)*?(?:main|master)\b",
        command,
    ) is not None


def deny(reason):
    print(json.dumps({"decision": "deny", "reason": reason}))
    sys.exit(0)


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    push_rests = find_push_segments(command)
    if not push_rests:
        sys.exit(0)

    # Se il comando switcha a main prima di pushare, blocca
    if switches_to_main(command):
        deny("Il comando switcha a main/master prima di pushare. "
             "Il workflow Mercury richiede PR + review gate. Vedi skill mercury-review.")

    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=data.get("cwd", "."),
        ).stdout.strip()
    except Exception:
        sys.exit(0)

    for rest in push_rests:
        # --all e --mirror pushano ogni branch locale, main compreso
        if re.search(r"--all\b|--mirror\b", rest):
            deny("Push con --all/--mirror bloccato: pusherebbe anche main. "
                 "Il workflow Mercury richiede PR + review gate. Vedi skill mercury-review.")

        # Blocca push esplicito verso main/master
        if any(target in ("main", "master") for target in push_targets(rest)):
            deny("Push verso main/master bloccato. "
                 "Il workflow Mercury richiede PR + review gate. Vedi skill mercury-review.")

    # Blocca push del branch corrente se è main
    if branch in ("main", "master"):
        deny(f"Push dal branch '{branch}' bloccato. "
             "Si pusha solo da branch feat/<N>-<slug>.")

    sys.exit(0)


if __name__ == "__main__":
    main()
