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

# Il tool bash nel payload degli hook arriva come "bash" (forma breve,
# documentata negli esempi) o come "file_system.bash" (forma qualificata
# inviata dall'Unified Harness di Vibe): entrambi sono il tool bash.
BASH_TOOL_NAMES = ("bash", "file_system.bash")


def find_commit_segments(command):
    """Tutti i segmenti che contengono `git commit` come comando proprio.

    Gestisce: git commit, git -C <path> commit, bash -c 'git commit ...',
    sudo git commit, FOO=1 git commit.
    """
    segments = []
    for segment in re.split(SEPARATORS, command):
        m = re.match(
            r"\s*(?:sudo\s+)?(?:\w+=(?:\"[^\"]*\"|'[^']*'|\S+)\s+)*"
            r"(?:git\s+(?:-C\s+\S+\s+)?commit\b"
            r"|bash\s+-c\s+['\"].*?git\s+commit\b)",
            segment, re.S,
        )
        if m:
            segments.append(segment)
    return segments


def switches_to_main(command):
    """True se il comando contiene git checkout/switch verso main/master locale."""
    return re.search(
        r"\bgit\s+(?:checkout|switch)\s+(?:-\S+\s+)*(?:(?:main|master)|refs/heads/(?:main|master))\b(?:\s|$)",
        command,
    ) is not None


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
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
