#!/usr/bin/env python3
"""Functional tests for the .vibe hook scripts.

Runs each hook against real git repos in a temp dir and asserts the
decision for a battery of commands: branch detection, switch ordering,
`git -C` targets, separator variants, `rm -rf` flag permutations, the
changeset warning scope, tool-name coverage, and the hooks.toml wiring.

Usage: python3 .vibe/tools/test_hooks.py
Exits non-zero when any case fails.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.join(REPO, ".vibe", "tools")

BCM = "block_commit_on_main.py"
RM = "block_rm_rf.py"
CS = "suggest_changeset.py"
TS = "suggest_test_after_ts.py"

failures = []
cases = 0


def check(desc, ok, detail=""):
    global cases
    cases += 1
    if ok:
        print(f"ok   {desc}")
    else:
        failures.append(f"FAIL: {desc}" + (f"\n  {detail}" if detail else ""))
        print(f"FAIL {desc}" + (f" — {detail}" if detail else ""))


def run_hook(script, tool_name, command, cwd):
    """Run a hook script with a hook payload; returns silent|deny|warn|ctx."""
    payload = json.dumps({
        "tool_name": tool_name,
        "tool_input": {"command": command},
        "cwd": cwd,
    })
    p = subprocess.run(
        ["python3", os.path.join(TOOLS, script)],
        input=payload, capture_output=True, text=True, cwd=cwd,
    )
    out = p.stdout.strip()
    if not out:
        return "silent"
    d = json.loads(out)
    if d.get("decision") == "deny":
        return "deny"
    if "system_message" in d:
        return "warn"
    if d.get("hook_specific_output", {}).get("additional_context"):
        return "ctx"
    return "allow:" + out


def run_hook_raw(script, tool_name, command, cwd):
    """Run a hook script and return the parsed JSON decision (or None)."""
    payload = json.dumps({
        "tool_name": tool_name,
        "tool_input": {"command": command},
        "cwd": cwd,
    })
    p = subprocess.run(
        ["python3", os.path.join(TOOLS, script)],
        input=payload, capture_output=True, text=True, cwd=cwd,
    )
    out = p.stdout.strip()
    return json.loads(out) if out else None


def expect(desc, got, want):
    check(desc, got == want, f"want {want}, got {got}")


def main():
    fix = tempfile.mkdtemp(prefix="mercury-hooktest-")
    main_repo = os.path.join(fix, "main-repo")
    feat_repo = os.path.join(fix, "feat-repo")

    def git(repo, *args):
        subprocess.run(
            ["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", *args],
            check=True, capture_output=True,
        )

    subprocess.run(["git", "init", "-q", "-b", "main", main_repo], check=True, capture_output=True)
    git(main_repo, "commit", "-q", "--allow-empty", "-m", "init")
    subprocess.run(["git", "init", "-q", "-b", "feat/331-test", feat_repo], check=True, capture_output=True)
    git(feat_repo, "commit", "-q", "--allow-empty", "-m", "init")

    pkg_dir = os.path.join(feat_repo, "packages/libs/core/src")
    os.makedirs(pkg_dir, exist_ok=True)

    def write(rel, content):
        path = os.path.join(feat_repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)

    # --- block_commit_on_main: branch detection ---
    expect("commit on feat branch allowed",
           run_hook(BCM, "bash", "git commit -m x", feat_repo), "silent")
    expect("commit on main denied",
           run_hook(BCM, "bash", "git commit -m x", main_repo), "deny")
    expect("sudo git commit on main denied",
           run_hook(BCM, "bash", "sudo git commit -m x", main_repo), "deny")
    expect("FOO=1 git commit on main denied",
           run_hook(BCM, "bash", "FOO=1 git commit -m x", main_repo), "deny")

    # --- block_commit_on_main: switch before/after commit, separators ---
    expect("switch to main before commit denied",
           run_hook(BCM, "bash", "git checkout main && git commit -m x", feat_repo), "deny")
    expect("switch to main AFTER commit allowed",
           run_hook(BCM, "bash", "git commit -m x && git checkout main", feat_repo), "silent")
    expect("git switch master; git commit denied",
           run_hook(BCM, "bash", "git switch master; git commit", feat_repo), "deny")
    expect("git checkout main;git commit denied (no space)",
           run_hook(BCM, "bash", "git checkout main;git commit", feat_repo), "deny")
    expect("git checkout main&&git commit denied (no spaces)",
           run_hook(BCM, "bash", "git checkout main&&git commit", feat_repo), "deny")
    expect("refs/heads/main switch denied",
           run_hook(BCM, "bash", "git checkout refs/heads/main && git commit -m x", feat_repo), "deny")
    expect("commit, switch to main, commit again -> denied",
           run_hook(BCM, "bash", "git commit -m x && git checkout main && git commit -m y", feat_repo), "deny")
    expect("bash -c 'git checkout main && git commit' denied",
           run_hook(BCM, "bash", "bash -c 'git checkout main && git commit -m x'", feat_repo), "deny")

    # --- block_commit_on_main: mentions inside other commands don't count ---
    expect("'git checkout main' inside a commit message allowed",
           run_hook(BCM, "bash", 'git commit -m "git checkout main"', feat_repo), "silent")
    expect("echo \"git checkout main\" && git commit allowed",
           run_hook(BCM, "bash", 'echo "git checkout main" && git commit -m x', feat_repo), "silent")
    expect("grep \"git checkout main\" && git commit allowed",
           run_hook(BCM, "bash", 'grep "git checkout main" README.md && git commit -m x', feat_repo), "silent")
    expect("git log --grep=... && git commit allowed",
           run_hook(BCM, "bash", 'git log --grep="git checkout main" && git commit -m x', feat_repo), "silent")
    expect("checkout mainline is not main",
           run_hook(BCM, "bash", "git checkout mainline && git commit", feat_repo), "silent")
    expect("checkout of another branch + commit allowed",
           run_hook(BCM, "bash", "git checkout feature && git commit -m x", feat_repo), "silent")
    expect("echo 'git commit' is not a commit",
           run_hook(BCM, "bash", 'echo "git commit -m x"', feat_repo), "silent")
    expect("no commit in command -> silent",
           run_hook(BCM, "bash", "git status", feat_repo), "silent")

    # --- block_commit_on_main: git -C targets ---
    expect("git -C <main checkout> commit denied",
           run_hook(BCM, "bash", f"git -C {main_repo} commit -m x", feat_repo), "deny")
    expect("git -C <feat checkout> commit allowed",
           run_hook(BCM, "bash", f"git -C {feat_repo} commit -m x", feat_repo), "silent")
    expect("relative git -C to main checkout denied",
           run_hook(BCM, "bash", f"git -C {os.path.relpath(main_repo, feat_repo)} commit -m x", feat_repo), "deny")

    # --- block_commit_on_main: tool-name coverage + English messages ---
    expect("process.start: commit on main denied",
           run_hook(BCM, "process.start", "git commit -m x", main_repo), "deny")
    expect("process.start: switch+commit denied",
           run_hook(BCM, "process.start", "git checkout main && git commit -m x", feat_repo), "deny")
    expect("file_system.bash: commit on main denied",
           run_hook(BCM, "file_system.bash", "git commit -m x", main_repo), "deny")
    reason = (run_hook_raw(BCM, "bash", "git commit -m x", main_repo) or {}).get("reason", "")
    check("deny reason is English",
          "workflow Mercury richiede" not in reason and not any(c in reason for c in "àèéìòù"),
          reason)

    # --- block_rm_rf ---
    expect("rm -rf denied", run_hook(RM, "bash", "rm -rf /tmp/x", feat_repo), "deny")
    expect("process.start: rm -rf denied", run_hook(RM, "process.start", "rm -rf /tmp/x", feat_repo), "deny")
    expect("file_system.bash: rm -rf denied", run_hook(RM, "file_system.bash", "rm -rf /tmp/x", feat_repo), "deny")
    expect("rm -rf with no path denied", run_hook(RM, "bash", "rm -rf", feat_repo), "deny")
    expect("rm -r -f denied", run_hook(RM, "bash", "rm -r -f dir", feat_repo), "deny")
    expect("rm dir -rf denied (GNU permutation)", run_hook(RM, "bash", "rm dir -rf", feat_repo), "deny")
    expect("rm -rf after && denied", run_hook(RM, "bash", "true && rm -rf dir", feat_repo), "deny")
    expect("git rm -rf allowed", run_hook(RM, "bash", "git rm -rf file", feat_repo), "silent")
    expect("rm -r alone allowed", run_hook(RM, "bash", "rm -r dir", feat_repo), "silent")
    expect("rm -f alone allowed", run_hook(RM, "bash", "rm -f file", feat_repo), "silent")
    expect("echo rm -rf allowed", run_hook(RM, "bash", "echo rm -rf", feat_repo), "silent")
    expect("quoted filename with -f inside allowed",
           run_hook(RM, "bash", "rm -r 'my -f file'", feat_repo), "silent")
    expect("quoted filename with -rf inside allowed",
           run_hook(RM, "bash", 'rm -r "a -rf b"', feat_repo), "silent")

    # --- suggest_changeset: warning scope ---
    write("packages/libs/core/src/x.ts", "export const x = 1;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("staged packages/ change without changeset warns",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")
    expect("process.start: changeset warning fires",
           run_hook(CS, "process.start", "git commit -m x", feat_repo), "warn")
    expect("file_system.bash: changeset warning fires",
           run_hook(CS, "file_system.bash", "git commit -m x", feat_repo), "warn")

    msg = (run_hook_raw(CS, "bash", "git commit -m x", feat_repo) or {}).get("system_message", "")
    check("changeset warning points at mercury-tdd",
          "mercury-tdd" in msg and "mercury-release" not in msg, msg)
    check("changeset warning is English and emoji-free",
          "Esegui" not in msg and "⚠" not in msg and not any(c in msg for c in "àèéìòù"), msg)

    git(feat_repo, "reset", "-q")
    write(".vibe/note.py", "# x\n")
    git(feat_repo, "add", ".vibe/note.py")
    expect("staged .vibe/ change only -> silent",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "silent")

    git(feat_repo, "reset", "-q")
    write("packages/config/y.ts", "export const y = 1;\n")
    git(feat_repo, "add", "packages/config/y.ts")
    expect("staged packages/config change -> silent (excluded)",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "silent")

    git(feat_repo, "reset", "-q")
    write("packages/libs/core/src/README.md", "# x\n")
    git(feat_repo, "add", "packages/libs/core/src/README.md")
    expect("staged .md under packages -> silent",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "silent")

    git(feat_repo, "reset", "-q")
    write(".changeset/tame-pandas.md", "---\n'@mercury-fw/core': patch\n---\n\nfix\n")
    write("packages/libs/core/src/x.ts", "export const x = 2;\n")
    git(feat_repo, "add", ".changeset/tame-pandas.md", "packages/libs/core/src/x.ts")
    expect("staged packages change + staged changeset -> silent",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "silent")
    shutil.rmtree(os.path.join(feat_repo, ".changeset"), ignore_errors=True)

    # --- suggest_changeset: unstaged tracked modifications ---
    git(feat_repo, "reset", "-q")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    git(feat_repo, "commit", "-q", "-m", "add x")
    write("packages/libs/core/src/x.ts", "export const x = 3;\n")  # unstaged modification
    expect("unstaged change, plain commit -> silent",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "silent")
    expect("unstaged change, commit -am -> warns",
           run_hook(CS, "bash", "git commit -am x", feat_repo), "warn")
    expect("unstaged change, commit --all -> warns",
           run_hook(CS, "bash", "git commit --all -m x", feat_repo), "warn")
    expect("unstaged change, commit with pathspec -> warns",
           run_hook(CS, "bash", "git commit -m x -- packages/libs/core/src/x.ts", feat_repo), "warn")
    expect("commit -uall does not count as -a",
           run_hook(CS, "bash", "git commit -uall -m x", feat_repo), "silent")
    expect("commit -S<keyid> does not count as -a",
           run_hook(CS, "bash", "git commit -Sdeadbeef -m x", feat_repo), "silent")
    expect("commit -pm x: message token is not a pathspec",
           run_hook(CS, "bash", "git commit -pm x", feat_repo), "silent")
    expect("commit -ma: bundled value option",
           run_hook(CS, "bash", "git commit -ma", feat_repo), "silent")

    # --- suggest_changeset: 'git commit' inside other commands doesn't count ---
    git(feat_repo, "reset", "-q")
    write("packages/libs/core/src/x.ts", "export const x = 4;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("echo \"git commit\" && git add . -> silent",
           run_hook(CS, "bash", 'echo "git commit" && git add .', feat_repo), "silent")
    expect("grep 'git commit' -> silent",
           run_hook(CS, "bash", "grep -rn 'git commit' packages/", feat_repo), "silent")
    expect("printf 'git commit' -> silent",
           run_hook(CS, "bash", "printf 'git commit\\n'", feat_repo), "silent")
    expect("bash -c 'git commit -m x' still warns",
           run_hook(CS, "bash", "bash -c 'git commit -m x'", feat_repo), "warn")
    git(feat_repo, "reset", "-q")

    # --- suggest_test_after_ts (post_tool shape) ---
    def run_ts(tool_name, file_path, status="success"):
        payload = json.dumps({
            "tool_name": tool_name,
            "tool_status": status,
            "tool_input": {"file_path": file_path},
        })
        p = subprocess.run(
            ["python3", os.path.join(TOOLS, TS)],
            input=payload, capture_output=True, text=True,
        )
        return p.stdout.strip()

    ctx = run_ts("edit", "packages/libs/core/src/foo.ts")
    check("edit of a .ts file -> context reminder", "additional_context" in ctx, ctx)
    check("reminder is emoji-free", "📝" not in ctx, ctx)
    expect("edit of a .test.ts file -> silent",
           run_ts("edit", "packages/libs/core/src/foo.test.ts") or "silent", "silent")
    expect("edit of a non-.ts file -> silent",
           run_ts("edit", "README.md") or "silent", "silent")
    expect("failed edit -> silent",
           run_ts("edit", "packages/libs/core/src/foo.ts", status="error") or "silent", "silent")

    # --- hooks.toml structure + end-to-end wiring ---
    with open(os.path.join(REPO, ".vibe", "hooks.toml"), "rb") as f:
        hooks = tomllib.load(f)["hooks"]
    check("hooks.toml declares 4 hooks", len(hooks) == 4, str(len(hooks)))
    for h in hooks:
        script = h["command"].split(".vibe/tools/")[-1].split(".py")[0] + ".py"
        check(f"hook {h['name']} references an existing script",
              os.path.isfile(os.path.join(TOOLS, script)), script)

    rm_hook = next(h for h in hooks if h["name"] == "block-rm-rf")
    payload = json.dumps({"tool_name": "bash", "tool_input": {"command": "rm -rf /tmp/x"}, "cwd": feat_repo})
    p = subprocess.run(["sh", "-c", rm_hook["command"]], input=payload, capture_output=True, text=True, cwd=REPO)
    check("hooks.toml command end-to-end: deny survives the wrapper",
          p.returncode == 0 and json.loads(p.stdout)["decision"] == "deny", p.stdout + p.stderr)
    p = subprocess.run(["sh", "-c", rm_hook["command"]], input=payload, capture_output=True, text=True, cwd=fix)
    check("hooks.toml command fails open outside the repo",
          p.returncode == 0 and not p.stdout.strip(), p.stdout + p.stderr)

    print()
    print(f"{cases - len(failures)}/{cases} passed")
    if failures:
        print("\n".join(failures))
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
