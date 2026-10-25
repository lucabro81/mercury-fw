#!/usr/bin/env python3
"""Vibe pre_tool hook: block secret exposure.

Port of .claude/hooks/block-env-read.sh to Vibe's hook protocol. Reads the
hook event JSON on stdin and prints a structured response on stdout:
{"decision": "deny", "reason": "..."} blocks the call; empty stdout (exit 0)
allows it. A runtime error fails open (allow + stderr diagnostic) so a script
bug cannot lock the workflow out; `strict = true` in .vibe/hooks.toml fails
closed when the hook cannot run at all (missing script, missing python).
"""

import json
import re
import sys

ENV_FILE_RE = re.compile(r"(^|[^A-Za-z0-9_.-])\.env(?:\.[A-Za-z0-9_-]+)?($|[^A-Za-z0-9_.-])")
WRITE_REDIRECT_RE = re.compile(r">>?\s*\.env(?:\.[A-Za-z0-9_-]+)?")
COMPOSE_RE = re.compile(r"(docker\s+compose|docker-compose)")
COMPOSE_CONFIG_RE = re.compile(r"(^|\s)config($|\s)")
CLI_CREDENTIALS_RE = re.compile(r"\.config/[A-Za-z0-9_.-]*-cli\b")

READ_ENV_REASON = (
    "reads a .env-shaped file. Never cat/tail/head/grep/read .env directly, "
    "even to check formatting or key names — it holds live secrets. A "
    "write-only append (printf ... >> .env) is fine; ask Luca if you need to "
    "see a value."
)
COMPOSE_REASON = (
    "'docker compose config' resolves and prints the FULL interpolated "
    "environment for every service, including secrets injected via .env — not "
    "just YAML structure. Add --no-interpolate to keep ${VAR} placeholders "
    "unresolved, or ask Luca to run it himself."
)
CREDENTIALS_REASON = (
    "touches a CLI's own credential directory (~/.config/<name>-cli/). Never "
    "open that file for any reason, including just checking key names — use "
    "the CLI's own safe subcommand (doctor, auth whoami) instead, or ask Luca."
)


def deny(reason):
    return {"decision": "deny", "reason": reason}


def evaluate_bash(command):
    # A write-only redirect ("... >> .env" / "... > .env") is not a read, so
    # it is stripped before the check — otherwise the recommended escape hatch
    # (a targeted printf append) would trip the same rule it satisfies.
    sanitized = WRITE_REDIRECT_RE.sub("", command)
    if ENV_FILE_RE.search(sanitized):
        return deny(f"Blocked: command {READ_ENV_REASON}")
    if (
        COMPOSE_RE.search(command)
        and COMPOSE_CONFIG_RE.search(command)
        and "--no-interpolate" not in command
    ):
        return deny(f"Blocked: command {COMPOSE_REASON}")
    if CLI_CREDENTIALS_RE.search(command):
        return deny(f"Blocked: command {CREDENTIALS_REASON}")
    return None


def evaluate(tool_name, tool_input):
    """Return a deny payload for the call, or None to allow it."""
    if tool_name == "bash":
        return evaluate_bash(tool_input.get("command") or "")
    if tool_name == "read_file":
        path = tool_input.get("path") or tool_input.get("file_path") or ""
        if ENV_FILE_RE.search(path):
            return deny(f"Blocked: {READ_ENV_REASON}")
    # edit / write_file are matched by the hook but not denied: a write cannot
    # leak a value into chat the way a read can, and denying writes would also
    # block legitimate edits of the versioned .env.example.
    return None


def main():
    try:
        event = json.load(sys.stdin)
        result = evaluate(event.get("tool_name", ""), event.get("tool_input") or {})
    except Exception as exc:  # fail open: never lock the workflow out
        print(f"block-secrets: hook error, allowing: {exc}", file=sys.stderr)
        return
    if result is not None:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
