#!/usr/bin/env python3
"""Functional tests for block-secrets.py (the Vibe pre_tool hook in
.vibe/hooks.toml) and for the versioned wiring around it (hooks.toml shape,
gitignore pattern for personal knowledge).

Run from anywhere: python3 .vibe/tools/test_block_secrets.py
"""

import json
import subprocess
import sys
import tomllib
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parents[1]
sys.path.insert(0, str(TOOLS))

try:
    import block_secrets
except ImportError:
    block_secrets = None

passed = 0
failed = []


def check(name, cond):
    global passed
    if cond:
        passed += 1
    else:
        failed.append(name)


def evaluate(tool, tool_input):
    if block_secrets is None:
        return {"decision": "deny", "reason": "block_secrets module missing"}
    return block_secrets.evaluate(tool, tool_input)


def is_deny(result):
    return result is not None and result.get("decision") == "deny"


# --- bash: reads of .env-shaped files are denied -------------------------
for cmd in [
    "cat .env",
    "cat .env.local",
    "cat .env.example",
    "grep FOO .env",
    "tail -f .env.production",
    "cat ./apps/testbed/apps/demo/.env",
    "jq . .env",
]:
    check(f"deny bash: {cmd}", is_deny(evaluate("bash", {"command": cmd})))

# --- bash: the documented exceptions are allowed -------------------------
for cmd in [
    "printf 'X=1' >> .env",          # write-only append
    "echo X > .env",                 # write-only redirect
    "docker compose config --no-interpolate",
    "docker compose up -d --build",
    "jira doctor",
    "cat .environment.ts",           # .env not on a boundary
    "cat .envrc",                    # .env not on a boundary
    "ls",
    "git status",
]:
    check(f"allow bash: {cmd}", evaluate("bash", {"command": cmd}) is None)

# --- bash: docker compose config without --no-interpolate is denied ------
for cmd in [
    "docker compose config",
    "docker-compose config",
    "docker compose  config",
    "docker compose config .env",
]:
    check(f"deny bash: {cmd}", is_deny(evaluate("bash", {"command": cmd})))

# --- bash: CLI credential directories are denied -------------------------
for cmd in [
    "cat ~/.config/jira-cli/app.json",
    "cat /Users/lucabrognara/.config/bitbucket-cli/credentials.json",
    "jq . ~/.config/google-chat-cli/app.json",
]:
    check(f"deny bash: {cmd}", is_deny(evaluate("bash", {"command": cmd})))

# --- read_file: .env-shaped paths are denied ------------------------------
for path in [
    ".env",
    "/Users/lucabrognara/MyProjects/mercury/.env",
    ".env.production",
    ".env.example",
]:
    check(f"deny read_file: {path}", is_deny(evaluate("read_file", {"path": path})))
check(
    "deny read_file (file_path variant)",
    is_deny(evaluate("read_file", {"file_path": ".env.local"})),
)

# --- read_file: other paths are allowed -----------------------------------
for path in [
    "packages/libs/core/src/index.ts",
    "apps/testbed/README.md",
    ".env.example.md",
]:
    check(f"allow read_file: {path}", evaluate("read_file", {"path": path}) is None)

# --- edit / write_file: writes are not denied (a write cannot leak a value
# --- into chat; denying them would also block legitimate edits of the
# --- versioned .env.example). Only reads are denied.
check(
    "allow edit on .env.example",
    evaluate("edit", {"file_path": ".env.example", "old_string": "a", "new_string": "b"}) is None,
)
check(
    "allow write_file on .env",
    evaluate("write_file", {"path": ".env", "content": "X=1"}) is None,
)

# --- wire protocol: stdin event JSON -> stdout structured response --------
def run_hook(event):
    proc = subprocess.run(
        [sys.executable, str(TOOLS / "block_secrets.py")],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    return proc


if block_secrets is not None:
    proc = run_hook({"hook_event_name": "pre_tool", "tool_name": "bash",
                     "tool_input": {"command": "cat .env"}})
    out = json.loads(proc.stdout) if proc.stdout.strip() else {}
    check("wire: deny on cat .env", proc.returncode == 0 and out.get("decision") == "deny"
          and bool(out.get("reason")))

    proc = run_hook({"hook_event_name": "pre_tool", "tool_name": "bash",
                     "tool_input": {"command": "ls"}})
    check("wire: allow on ls (empty stdout, exit 0)",
          proc.returncode == 0 and proc.stdout.strip() == "")
else:
    check("wire: deny on cat .env", False)
    check("wire: allow on ls (empty stdout, exit 0)", False)

# --- .vibe/hooks.toml: the hook is declared with the required fields ------
hooks_path = REPO / ".vibe" / "hooks.toml"
check("hooks.toml exists", hooks_path.is_file())
if hooks_path.is_file():
    doc = tomllib.loads(hooks_path.read_text())
    hooks = {h.get("name"): h for h in doc.get("hooks", [])}
    h = hooks.get("block-secrets")
    check("hooks.toml: block-secrets declared", h is not None)
    if h is not None:
        check("hooks.toml: type pre_tool", h.get("type") == "pre_tool")
        check("hooks.toml: match covers bash/read_file/edit/write_file",
              h.get("match") == "re:(bash|read_file|edit|write_file)")
        check("hooks.toml: strict (fail closed)", h.get("strict") is True)
        check("hooks.toml: command runs block_secrets.py",
              "block_secrets.py" in str(h.get("command", "")))

# --- .gitignore: personal knowledge is ignored, the rest is committable --
def ignored(path):
    proc = subprocess.run(["git", "check-ignore", "-q", path],
                          capture_output=True, cwd=REPO)
    return proc.returncode == 0


check("gitignore: knowledge dir ignored",
      ignored(".vibe/plugins/mercury-memory/ai.mistral.vibe/knowledge/state/KNOWLEDGE.md"))
check("gitignore: plugin.json committable",
      not ignored(".vibe/plugins/mercury-memory/plugin.json"))
check("gitignore: hooks.toml committable", not ignored(".vibe/hooks.toml"))

# --- report ---------------------------------------------------------------
total = passed + len(failed)
for name in failed:
    print(f"FAIL: {name}")
print(f"\n{passed}/{total} passed")
if failed:
    sys.exit(1)
print("ALL PASS")
