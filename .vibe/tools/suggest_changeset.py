#!/usr/bin/env python3
"""Hook pre_tool: avvisa se manca un changeset prima di git commit.

Controlla se ci sono file modificati (staged) che non sono changeset,
e se il commit non è un commit di changeset stesso.
"""
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

    cwd = data.get("cwd", ".")

    # Se è un commit di changeset, va bene
    if ".changeset/" in command or "changeset" in command.lower():
        sys.exit(0)

    try:
        # File staged
        staged = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True, text=True, cwd=cwd,
        ).stdout.strip().split("\n")
        staged = [f for f in staged if f]

        if not staged:
            sys.exit(0)

        # File che non sono changeset e non sono docs-only
        non_changeset = [
            f for f in staged
            if not f.startswith(".changeset/")
            and not f.endswith(".md")
        ]

        if not non_changeset:
            sys.exit(0)

        # Verifica se esiste un changeset non committato
        unstaged_changeset = subprocess.run(
            ["git", "status", "--porcelain", ".changeset/"],
            capture_output=True, text=True, cwd=cwd,
        ).stdout.strip()

        # Verifica se l'ultimo commit era un changeset
        last_commit = subprocess.run(
            ["git", "log", "-1", "--pretty=%s"],
            capture_output=True, text=True, cwd=cwd,
        ).stdout.strip()

        has_changeset = (
            bool(unstaged_changeset)
            or "changeset" in last_commit.lower()
        )

        if not has_changeset:
            print(json.dumps({
                "decision": "allow",
                "system_message": (
                    "⚠️  Questo commit modifica codice senza un changeset. "
                    "Il workflow Mercury richiede un changeset per ogni change rilevante. "
                    "Esegui `bun run changeset` prima di committare, o includi il changeset "
                    "in questo commit. Vedi skill mercury-release."
                ),
            }))
            sys.exit(0)

    except Exception:
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
