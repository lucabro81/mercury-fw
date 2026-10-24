#!/usr/bin/env python3
"""Hook pre_tool: avvisa se manca un changeset prima di git commit.

Controlla i file che il commit includerebbe — quelli staged, più le
modifiche tracciate non staged quando il commit usa -a/--all o un pathspec —
e avvisa se toccano un workspace pubblicato senza un changeset. Tooling di
repo (.vibe/, scripts/, .github/, docs site, test bed) non richiede changeset.
"""
import json
import re
import shlex
import subprocess
import sys

# Il tool bash nel payload degli hook arriva come "bash" (forma breve,
# documentata negli esempi) o come "file_system.bash" (forma qualificata
# inviata dall'Unified Harness di Vibe): entrambi sono il tool bash.
BASH_TOOL_NAMES = ("bash", "file_system.bash")

# Solo le modifiche a questi workspace (quelli pubblicati su npm) richiedono
# un changeset.
CHANGESET_REQUIRED_PREFIXES = ("packages/", "apps/cli/", "apps/create-mercury-agent/")

# Eccezioni private dentro i prefissi sopra: non sono pubblicate su npm
# (l'elenco è in scripts/check-pack.ts), quindi non richiedono changeset.
CHANGESET_EXCLUDED_PREFIXES = ("packages/config/",)

# Opzioni di `git commit` che consumano il token successivo
VALUE_OPTIONS = {
    "-m", "-F", "-t", "-C", "-c",
    "--message", "--file", "--template", "--author",
    "--cleanup", "--fixup", "--squash",
}


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, cwd=cwd,
    ).stdout.strip()


def commit_segment(command):
    """La parte del comando dopo `git commit`, o None se non c'è un commit."""
    m = re.search(r"\bgit\s+commit\b([^|&;]*)", command)
    return m.group(1) if m else None


def includes_unstaged(segment):
    """True se il commit includerà anche modifiche tracciate non staged.

    È il caso di `git commit -a`/`--all` (flag -a, anche in cluster come
    -am) e dei commit con pathspec (`git commit -m msg -- file.ts`).
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in VALUE_OPTIONS:
            i += 2
            continue
        if token.startswith("-"):
            if token in ("-a", "--all") or re.fullmatch(r"-[a-zA-Z]*a[a-zA-Z]*", token):
                return True
            i += 1
            continue
        # Un token che non è un'opzione è un pathspec
        return True
    return False


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in BASH_TOOL_NAMES:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    segment = commit_segment(command)
    if segment is None:
        sys.exit(0)

    cwd = data.get("cwd", ".")

    try:
        files = set()
        for f in git(cwd, "diff", "--cached", "--name-only").split("\n"):
            if f:
                files.add(f)

        if includes_unstaged(segment):
            for f in git(cwd, "diff", "--name-only").split("\n"):
                if f:
                    files.add(f)

        # Solo i workspace pubblicati richiedono un changeset; i .md sono
        # documentazione e non bumpano versione
        relevant = [
            f for f in files
            if f.startswith(CHANGESET_REQUIRED_PREFIXES)
            and not f.startswith(CHANGESET_EXCLUDED_PREFIXES)
            and not f.endswith(".md")
        ]
        if not relevant:
            sys.exit(0)

        # Un changeset già presente (staged, non staged o nell'ultimo commit) copre
        changeset_status = git(cwd, "status", "--porcelain", ".changeset/")
        last_commit = git(cwd, "log", "-1", "--pretty=%s")

        has_changeset = (
            bool(changeset_status)
            or "changeset" in last_commit.lower()
        )

        if not has_changeset:
            print(json.dumps({
                "decision": "allow",
                "system_message": (
                    "⚠️  This commit modifies code without a changeset. "
                    "The Mercury workflow requires a changeset for every relevant change. "
                    "Esegui `bun run changeset` prima di committare, o includi il changeset "
                    "in questo commit. See skill mercury-release."
                ),
            }))
            sys.exit(0)

    except Exception:
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
