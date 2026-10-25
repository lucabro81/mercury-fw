#!/usr/bin/env python3
"""Functional tests for the .vibe hook scripts.

Runs each hook against real git repos in a temp dir and asserts the
decision for a battery of commands: branch detection, switch ordering
(including the previous-branch shorthands), `git -C` targets, separator
variants, `rm -rf` flag permutations, the changeset warning scope
(including the commit's target directory), tool-name coverage, and the
hooks.toml wiring.

Usage: python3 .vibe/tools/test_hooks.py
Exits non-zero when any case fails.
"""
import json
import os
import re
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

    prev_repo = os.path.join(fix, "prev-repo")
    subprocess.run(["git", "init", "-q", "-b", "main", prev_repo], check=True, capture_output=True)
    git(prev_repo, "commit", "-q", "--allow-empty", "-m", "init")
    git(prev_repo, "checkout", "-q", "-b", "feat/prev")

    cs_repo = os.path.join(fix, "cs-repo")
    subprocess.run(["git", "init", "-q", "-b", "feat/cs", cs_repo], check=True, capture_output=True)
    git(cs_repo, "commit", "-q", "--allow-empty", "-m", "init")
    cs_pkg = os.path.join(cs_repo, "packages/libs/core/src")
    os.makedirs(cs_pkg, exist_ok=True)
    with open(os.path.join(cs_pkg, "x.ts"), "w") as f:
        f.write("export const x = 1;\n")
    git(cs_repo, "add", "packages/libs/core/src/x.ts")

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
    expect("git commit-tree on main allowed (not a branch commit)",
           run_hook(BCM, "bash", "git commit-tree -m x", main_repo), "silent")
    expect("git commit-graph on main allowed (not a branch commit)",
           run_hook(BCM, "bash", "git commit-graph write", main_repo), "silent")

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
    expect("sh -c 'git commit' on main denied",
           run_hook(BCM, "bash", "sh -c 'git commit -m x'", main_repo), "deny")
    expect("sh -c 'git checkout main && git commit' denied",
           run_hook(BCM, "bash", "sh -c 'git checkout main && git commit -m x'", feat_repo), "deny")

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

    # --- block_commit_on_main: wrapper prefixes (env/command/xargs) ---
    expect("env git commit on main denied",
           run_hook(BCM, "bash", "env git commit -m x", main_repo), "deny")
    expect("command git commit on main denied",
           run_hook(BCM, "bash", "command git commit -m x", main_repo), "deny")
    expect("env git checkout main && git commit denied",
           run_hook(BCM, "bash", "env git checkout main && git commit -m x", feat_repo), "deny")

    # --- block_commit_on_main: cd tracking and path expansion ---
    expect("cd <main checkout> && git commit denied",
           run_hook(BCM, "bash", f"cd {main_repo} && git commit -m x", feat_repo), "deny")
    expect("cd <main> && cd <feat> && git commit allowed",
           run_hook(BCM, "bash", f"cd {main_repo} && cd {feat_repo} && git commit -m x", feat_repo), "silent")
    expect("cd into a feat subdir && git commit allowed",
           run_hook(BCM, "bash", f"cd {feat_repo}/packages && git commit -m x", feat_repo), "silent")
    expect("bash -c 'cd <main> && git commit' denied",
           run_hook(BCM, "bash", f"bash -c 'cd {main_repo} && git commit -m x'", feat_repo), "deny")
    os.environ["HOOKTEST_MAIN"] = main_repo
    expect("git -C $VAR commit denied (env var expansion)",
           run_hook(BCM, "bash", "git -C $HOOKTEST_MAIN commit -m x", feat_repo), "deny")
    del os.environ["HOOKTEST_MAIN"]

    # --- block_commit_on_main: switch-away resets a previous switch to main ---
    expect("switch to main then away then commit allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout feat/331-test && git commit -m x", feat_repo), "silent")
    expect("switch main then away (switch) then commit allowed",
           run_hook(BCM, "bash", "git switch main && git switch feat/331-test && git commit -m x", feat_repo), "silent")
    expect("pathspec restore is not a switch away: commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout feat/x -- file.ts && git commit -m x", feat_repo), "deny")

    # --- block_commit_on_main: switches to a previous branch (checkout - / @{-N}) ---
    # The shorthand resolves the way git resolves it at execution time,
    # against the checkout history the command implies so far: a switch
    # earlier in the same command line moves @{-N}.
    expect("checkout - (previous is main) + commit denied",
           run_hook(BCM, "bash", "git checkout - && git commit -m x", prev_repo), "deny")
    expect("git switch - (previous is main) + commit denied",
           run_hook(BCM, "bash", "git switch - && git commit -m x", prev_repo), "deny")
    expect("checkout @{-1} (previous is main) + commit denied",
           run_hook(BCM, "bash", "git checkout @{-1} && git commit -m x", prev_repo), "deny")
    expect("checkout - then a real switch to main + commit denied",
           run_hook(BCM, "bash", "git checkout - && git checkout main && git commit -m x", prev_repo), "deny")
    expect("checkout main then checkout - (back to feat) + commit allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout - && git commit -m x", prev_repo), "silent")
    expect("bash -c 'checkout - && commit' with previous main denied",
           run_hook(BCM, "bash", "bash -c 'git checkout - && git commit -m x'", prev_repo), "deny")
    expect("checkout -b <new> + commit allowed (not the previous-branch shorthand)",
           run_hook(BCM, "bash", "git checkout -b feat/new && git commit -m x", prev_repo), "silent")
    expect("checkout - -- <path> restores paths, it does not switch: commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout - -- file.ts && git commit -m x", prev_repo), "deny")
    git(prev_repo, "checkout", "-q", "-b", "feat/second")
    # on feat/second: @{-1} is feat/prev, @{-2} is main
    expect("checkout - (previous is a feature branch) + commit allowed",
           run_hook(BCM, "bash", "git checkout - && git commit -m x", prev_repo), "silent")
    expect("checkout @{-2} (main) + commit denied",
           run_hook(BCM, "bash", "git checkout @{-2} && git commit -m x", prev_repo), "deny")
    expect("checkout @{-2} then checkout - (back to feat) + commit allowed",
           run_hook(BCM, "bash", "git checkout @{-2} && git checkout - && git commit -m x", prev_repo), "silent")
    expect("git -C <repo> checkout @{-2} (main) && git -C <repo> commit denied",
           run_hook(BCM, "bash", f"git -C {prev_repo} checkout @{{-2}} && git -C {prev_repo} commit -m x", feat_repo), "deny")
    expect("checkout - with no previous branch: commit judged on the current branch (feat)",
           run_hook(BCM, "bash", "git checkout - && git commit -m x", feat_repo), "silent")
    expect("checkout - with no previous branch on main: direct commit still denied",
           run_hook(BCM, "bash", "git checkout - && git commit -m x", main_repo), "deny")

    # --- block_commit_on_main: the pathspec form is not a branch switch ---
    expect("git checkout main -- <path> is not a switch",
           run_hook(BCM, "bash", "git checkout main -- file.ts && git commit -m x", feat_repo), "silent")
    expect("git checkout main -- <path> then a real switch still denied",
           run_hook(BCM, "bash", "git checkout main -- file.ts && git checkout main && git commit -m x", feat_repo), "deny")

    # --- block_commit_on_main: separators inside quotes ---
    # A separator inside a quoted section does not split the command:
    # text in a message or an echo is not a switch, a wrapper's inner
    # command line is split the same way, and a cd inside a wrapper does
    # not leak to the segments after it.
    expect("echo mentioning a switch after a semicolon, then a commit -> allowed",
           run_hook(BCM, "bash", 'echo "a; git checkout main" && git commit -m x', feat_repo), "silent")
    expect("commit message mentioning a switch, then a real commit -> allowed",
           run_hook(BCM, "bash", 'git commit -m "msg; git checkout main" && git commit -m b', feat_repo), "silent")
    expect("commit message mentioning a switch with && -> allowed",
           run_hook(BCM, "bash", 'git commit -m "msg && git checkout main" && git commit -m b', feat_repo), "silent")
    expect("commit on main inside a wrapper with a quoted && -> denied",
           run_hook(BCM, "bash", "bash -c 'echo \"a && b\"; git commit -m x'", main_repo), "deny")
    expect("echo mentioning a switch inside a wrapper -> allowed",
           run_hook(BCM, "bash", "bash -c 'echo \"a; git checkout main\" && git commit -m x'", feat_repo), "silent")
    expect("a cd inside a wrapper does not leak to the next segment",
           run_hook(BCM, "bash", f"bash -c 'cd {main_repo}; git status' && git commit -m x", feat_repo), "silent")
    expect("a cd inside a wrapper still scopes the wrapper's own commit",
           run_hook(BCM, "bash", f"bash -c 'cd {main_repo}; git commit -m x'", feat_repo), "deny")

    # --- block_commit_on_main: a switch marks its own directory, not every commit ---
    expect("switch to main in a main checkout (cd), commit in a feat checkout allowed",
           run_hook(BCM, "bash", f"cd {main_repo} && git checkout main && cd {feat_repo} && git commit -m x", feat_repo), "silent")
    expect("switch to main in a main checkout (cd), git -C feat commit allowed",
           run_hook(BCM, "bash", f"cd {main_repo} && git checkout main && git -C {feat_repo} commit -m x", feat_repo), "silent")
    expect("git -C feat checkout main then git -C feat commit denied",
           run_hook(BCM, "bash", f"git -C {feat_repo} checkout main && git -C {feat_repo} commit -m x", main_repo), "deny")
    expect("git -C main checkout main then git -C main commit denied",
           run_hook(BCM, "bash", f"git -C {main_repo} checkout main && git -C {main_repo} commit -m x", feat_repo), "deny")
    expect("switch to main then commit from a subdirectory still denied",
           run_hook(BCM, "bash", f"cd {feat_repo} && git checkout main && cd {feat_repo}/packages && git commit -m x", main_repo), "deny")
    expect("switch to main, away from a subdirectory, commit allowed",
           run_hook(BCM, "bash", f"cd {feat_repo} && git checkout main && cd {feat_repo}/packages && git checkout feat/331-test && git commit -m x", main_repo), "silent")

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
    expect("bash -c 'rm -rf ...' denied",
           run_hook(RM, "bash", "bash -c 'rm -rf /tmp/x'", feat_repo), "deny")
    expect("sh -c 'rm -rf ...' denied",
           run_hook(RM, "bash", "sh -c 'rm -rf /tmp/x'", feat_repo), "deny")
    expect("bash -c 'rm -r -f dir' denied",
           run_hook(RM, "bash", "bash -c 'rm -r -f dir'", feat_repo), "deny")
    expect("bash -c 'git rm -rf ...' allowed",
           run_hook(RM, "bash", "bash -c 'git rm -rf file'", feat_repo), "silent")

    # --- block_rm_rf: separators inside quotes ---
    # A separator inside a quoted section does not split the command, and
    # a wrapper's inner command line is split the same way: text in an
    # echo is not an rm, a quoted path still counts as an argument.
    expect("echo mentioning rm -rf after a semicolon -> allowed",
           run_hook(RM, "bash", 'echo "a; rm -rf /tmp/x"', feat_repo), "silent")
    expect("echo mentioning rm -rf inside a wrapper -> allowed",
           run_hook(RM, "bash", "bash -c 'echo \"rm -rf x\"; ls'", feat_repo), "silent")
    expect("quoted path with a semicolon still denied",
           run_hook(RM, "bash", 'rm -rf "my; dir"', feat_repo), "deny")
    expect("rm -rf inside a wrapper after a quoted semicolon -> denied",
           run_hook(RM, "bash", "bash -c 'echo \"a; b\"; rm -rf /tmp/x'", feat_repo), "deny")

    # --- suggest_changeset: warning scope ---
    write("packages/libs/core/src/x.ts", "export const x = 1;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("staged packages/ change without changeset warns",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")
    expect("process.start: changeset warning fires",
           run_hook(CS, "process.start", "git commit -m x", feat_repo), "warn")
    expect("file_system.bash: changeset warning fires",
           run_hook(CS, "file_system.bash", "git commit -m x", feat_repo), "warn")
    expect("env git commit with staged code warns",
           run_hook(CS, "bash", "env git commit -m x", feat_repo), "warn")

    msg = (run_hook_raw(CS, "bash", "git commit -m x", feat_repo) or {}).get("system_message", "")
    check("changeset warning points at mercury-tdd",
          "mercury-tdd" in msg and "mercury-release" not in msg, msg)
    check("changeset warning is English and emoji-free",
          "Esegui" not in msg and "⚠" not in msg and not any(c in msg for c in "àèéìòù"), msg)
    expect("git commit-tree with staged code -> silent (not a branch commit)",
           run_hook(CS, "bash", "git commit-tree -m x", feat_repo), "silent")

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
    expect("commit --trailer <v>: value is not a pathspec",
           run_hook(CS, "bash", 'git commit --trailer "foo=bar" -m x', feat_repo), "silent")
    expect("commit --date <v>: value is not a pathspec",
           run_hook(CS, "bash", 'git commit --date "2020-01-01" -m x', feat_repo), "silent")
    expect("commit --pathspec-from-file=<f> counts as a pathspec commit",
           run_hook(CS, "bash", "git commit --pathspec-from-file=paths.txt -m x", feat_repo), "warn")
    expect("commit --pathspec-from-file <f> counts as a pathspec commit",
           run_hook(CS, "bash", "git commit --pathspec-from-file paths.txt -m x", feat_repo), "warn")

    # --- suggest_changeset: the last-commit heuristic uses files, not the subject ---
    git(feat_repo, "commit", "-q", "--allow-empty", "-m", "docs: explain the changeset flow")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("last commit mentioning 'changeset' without a changeset file does not silence",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")

    # --- suggest_changeset: a changeset counts only when the commit includes it ---
    git(feat_repo, "reset", "-q")
    write(".changeset/new-one.md", "---\n'@mercury-fw/core': patch\n---\n\nfix\n")
    write("packages/libs/core/src/x.ts", "export const x = 5;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("untracked changeset does not silence the warning",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")
    git(feat_repo, "add", ".changeset/new-one.md")
    git(feat_repo, "commit", "-q", "-m", "chore: add changeset")
    git(feat_repo, "commit", "-q", "--allow-empty", "-m", "code")
    write(".changeset/new-one.md", "---\n'@mercury-fw/core': patch\n---\n\nfix v2\n")
    write("packages/libs/core/src/x.ts", "export const x = 6;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("unstaged tracked changeset not included by a plain commit -> warns",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")
    expect("unstaged tracked changeset included by -am -> silent",
           run_hook(CS, "bash", "git commit -am x", feat_repo), "silent")

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

    # --- suggest_changeset: the commit's target directory (git -C, cd) ---
    # The warning reflects the repository the commit lands in, not the
    # shell's current directory: `git -C <path>` and a preceding `cd`
    # (also inside a wrapper) move the commit's target.
    expect("git -C <repo with staged code> commit warns (target repo, not cwd)",
           run_hook(CS, "bash", f"git -C {cs_repo} commit -m x", feat_repo), "warn")
    expect("cd <repo with staged code> && git commit warns",
           run_hook(CS, "bash", f"cd {cs_repo} && git commit -m x", feat_repo), "warn")
    expect("bash -c 'cd <repo> && git commit' warns",
           run_hook(CS, "bash", f"bash -c 'cd {cs_repo} && git commit -m x'", feat_repo), "warn")
    expect("relative git -C to a repo with staged code warns",
           run_hook(CS, "bash", f"git -C {os.path.relpath(cs_repo, feat_repo)} commit -m x", feat_repo), "warn")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("git -C <clean repo> commit with staged code in cwd -> silent",
           run_hook(CS, "bash", f"git -C {main_repo} commit -m x", feat_repo), "silent")
    expect("cd <clean repo> && git commit with staged code in cwd -> silent",
           run_hook(CS, "bash", f"cd {main_repo} && git commit -m x", feat_repo), "silent")
    git(feat_repo, "reset", "-q")

    # --- suggest_changeset: quoted arguments and separators inside quotes ---
    # A quoted message is one argument: a separator inside it neither
    # truncates the capture into a bogus pathspec nor splits the command,
    # and a bash -c wrapper's inner command line is split the same way.
    git(feat_repo, "checkout", "--", ".changeset/new-one.md")  # drop the leftover mod
    expect("quoted message with a semicolon: nothing staged -> silent",
           run_hook(CS, "bash", 'git commit -m "a b;c"', feat_repo), "silent")
    expect("bash -c quoted message: nothing staged -> silent",
           run_hook(CS, "bash", "bash -c 'git commit -m \"two words\"'", feat_repo), "silent")
    expect("-S with a separate -m: nothing staged -> silent",
           run_hook(CS, "bash", "git commit -S -m x", feat_repo), "silent")
    expect("-u with a separate -m: nothing staged -> silent",
           run_hook(CS, "bash", "git commit -u -m x", feat_repo), "silent")
    expect("pathspec after a semicolon in the message -> warns",
           run_hook(CS, "bash", 'git commit -m "fix; stuff" -- packages/libs/core/src/x.ts', feat_repo), "warn")
    expect("pathspec after && in the message -> warns",
           run_hook(CS, "bash", 'git commit -m "fix && stuff" -- packages/libs/core/src/x.ts', feat_repo), "warn")

    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("echo mentioning a commit after a semicolon, staged code -> silent",
           run_hook(CS, "bash", 'echo "a; git commit -m x"', feat_repo), "silent")
    expect("sh -c 'git commit -m x' with staged code -> warns",
           run_hook(CS, "bash", "sh -c 'git commit -m x'", feat_repo), "warn")
    expect("bash -c quoted message with staged code -> warns",
           run_hook(CS, "bash", "bash -c 'git commit -m \"two words\"'", feat_repo), "warn")
    expect("commit inside a wrapper after a quoted && -> warns",
           run_hook(CS, "bash", "bash -c 'echo \"a && b\"; git commit -m x'", feat_repo), "warn")
    expect("control: plain commit with staged code -> warns",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")

    # A bash -c wrapper with a quoted message must not misread the message
    # words as pathspecs: with staged code and an unstaged tracked changeset
    # the warning fires (the plain commit includes neither).
    git(feat_repo, "reset", "-q")
    write(".changeset/quoted-msg.md", "---\n'@mercury-fw/core': patch\n---\n\nquoted\n")
    git(feat_repo, "add", ".changeset/quoted-msg.md")
    git(feat_repo, "commit", "-q", "-m", "chore: add changeset")
    git(feat_repo, "commit", "-q", "--allow-empty", "-m", "code")
    write(".changeset/quoted-msg.md", "---\n'@mercury-fw/core': minor\n---\n\nquoted\n")  # unstaged, tracked
    write("packages/libs/core/src/x.ts", "export const x = 10;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("bash -c quoted message, staged code + unstaged changeset -> warns",
           run_hook(CS, "bash", "bash -c 'git commit -m \"two words\"'", feat_repo), "warn")
    expect("control: plain commit, staged code + unstaged changeset -> warns",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")
    git(feat_repo, "reset", "-q")

    # --- block_commit_on_main: a pathspec restore is not a switch away (round 10) ---
    # `git checkout .`, `git checkout HEAD`, `git checkout @` and
    # `git checkout <path>` restore paths and stay on the branch: they
    # must not un-mark a previous switch to main.
    expect("switch to main then 'checkout .' + commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout . && git commit -m x", feat_repo), "deny")
    expect("switch to main then 'checkout HEAD' + commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout HEAD && git commit -m x", feat_repo), "deny")
    expect("switch to main then 'checkout @' + commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout @ && git commit -m x", feat_repo), "deny")
    expect("switch to main then 'checkout <path>' + commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout README.md && git commit -m x", feat_repo), "deny")
    expect("switch to main then 'checkout main:<path>' + commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout main:README.md && git commit -m x", feat_repo), "deny")

    # --- block_commit_on_main: revision targets detach, --orphan creates (round 10) ---
    # A target that resolves to a commit (main~1, a tag, a sha) detaches
    # HEAD — it is not a switch to main. `git checkout --orphan <name>`
    # switches to an unborn branch. `git checkout -b <name>` creates and
    # switches.
    git(prev_repo, "checkout", "-q", "main")
    git(prev_repo, "commit", "-q", "--allow-empty", "-m", "second on main")
    git(prev_repo, "checkout", "-q", "feat/second")
    expect("checkout main~1 (detached) + commit allowed",
           run_hook(BCM, "bash", "git checkout main~1 && git commit -m x", prev_repo), "silent")
    expect("checkout main~1 then back to main + commit denied",
           run_hook(BCM, "bash", "git checkout main~1 && git checkout main && git commit -m x", prev_repo), "deny")
    expect("switch to main then 'checkout --orphan <new>' + commit allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout --orphan newbr && git commit -m x", feat_repo), "silent")
    expect("switch to main then 'checkout -b <new>' + commit allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout -b feat/new && git commit -m x", feat_repo), "silent")
    expect("checkout -b main + commit denied",
           run_hook(BCM, "bash", "git checkout -b main && git commit -m x", feat_repo), "deny")

    # --- block_commit_on_main: git global options before the subcommand (round 10) ---
    expect("git --no-pager commit on main denied",
           run_hook(BCM, "bash", "git --no-pager commit -m x", main_repo), "deny")
    expect("git -p commit on main denied",
           run_hook(BCM, "bash", "git -p commit -m x", main_repo), "deny")
    expect("git -c foo.bar=1 commit on main denied",
           run_hook(BCM, "bash", "git -c foo.bar=1 commit -m x", main_repo), "deny")
    expect("git --paginate=always commit on main denied",
           run_hook(BCM, "bash", "git --paginate=always commit -m x", main_repo), "deny")
    expect("git -C <main> -c foo.bar=1 commit denied",
           run_hook(BCM, "bash", f"git -C {main_repo} -c foo.bar=1 commit -m x", feat_repo), "deny")
    expect("git -C<main> commit denied (attached -C)",
           run_hook(BCM, "bash", f"git -C{main_repo} commit -m x", feat_repo), "deny")
    expect("git --no-pager checkout main && git commit denied",
           run_hook(BCM, "bash", "git --no-pager checkout main && git commit -m x", feat_repo), "deny")
    expect("git -c foo.bar=1 checkout - && git commit judged on the current branch",
           run_hook(BCM, "bash", "git -c foo.bar=1 checkout - && git commit -m x", feat_repo), "silent")

    # --- block_commit_on_main: wrapper and subshell variants (round 10) ---
    expect("bash -lc 'git commit' on main denied",
           run_hook(BCM, "bash", "bash -lc 'git commit -m x'", main_repo), "deny")
    expect("bash -l -c 'git commit' on main denied",
           run_hook(BCM, "bash", "bash -l -c 'git commit -m x'", main_repo), "deny")
    expect("/bin/bash -c 'git commit' on main denied",
           run_hook(BCM, "bash", "/bin/bash -c 'git commit -m x'", main_repo), "deny")
    expect("env -i bash -c 'git commit' on main denied",
           run_hook(BCM, "bash", "env -i bash -c 'git commit -m x'", main_repo), "deny")
    expect("(git commit) subshell on main denied",
           run_hook(BCM, "bash", "(git commit -m x)", main_repo), "deny")
    expect("echo $(git commit) command substitution on main denied",
           run_hook(BCM, "bash", "echo $(git commit -m x)", main_repo), "deny")
    expect("bash -lc 'git checkout main && git commit' denied",
           run_hook(BCM, "bash", "bash -lc 'git checkout main && git commit -m x'", feat_repo), "deny")
    expect("(git checkout main && git commit) subshell denied",
           run_hook(BCM, "bash", "(git checkout main && git commit -m x)", feat_repo), "deny")
    expect("echo $(git checkout main) && git commit denied",
           run_hook(BCM, "bash", "echo $(git checkout main) && git commit -m x", feat_repo), "deny")
    expect("nested wrapper: bash -c 'bash -c ...' denied",
           run_hook(BCM, "bash", "bash -c 'bash -c \"git commit -m x\"'", main_repo), "deny")

    # --- block_rm_rf: abbreviated long options, wrapper and subshell variants (round 10) ---
    expect("rm --rec --for denied (GNU abbreviations)",
           run_hook(RM, "bash", "rm --rec --for dir", feat_repo), "deny")
    expect("rm --r --f denied (GNU abbreviations)",
           run_hook(RM, "bash", "rm --r --f dir", feat_repo), "deny")
    expect("rm --recursive --for denied (mixed abbreviation)",
           run_hook(RM, "bash", "rm --recursive --for dir", feat_repo), "deny")
    expect("rm --recur alone allowed (no force)",
           run_hook(RM, "bash", "rm --recur dir", feat_repo), "silent")
    expect("rm --for alone allowed (no recursive)",
           run_hook(RM, "bash", "rm --for file", feat_repo), "silent")
    expect("bash -lc 'rm -rf ...' denied",
           run_hook(RM, "bash", "bash -lc 'rm -rf /tmp/x'", feat_repo), "deny")
    expect("/bin/bash -c 'rm -rf ...' denied",
           run_hook(RM, "bash", "/bin/bash -c 'rm -rf /tmp/x'", feat_repo), "deny")
    expect("env -i bash -c 'rm -rf ...' denied",
           run_hook(RM, "bash", "env -i bash -c 'rm -rf /tmp/x'", feat_repo), "deny")
    expect("(rm -rf ...) subshell denied",
           run_hook(RM, "bash", "(rm -rf /tmp/x)", feat_repo), "deny")
    expect("echo $(rm -rf ...) command substitution denied",
           run_hook(RM, "bash", "echo $(rm -rf /tmp/x)", feat_repo), "deny")

    # --- suggest_changeset: git global options, wrappers, subshells (round 10) ---
    expect("git --no-pager commit with staged code warns",
           run_hook(CS, "bash", "git --no-pager commit -m x", cs_repo), "warn")
    expect("git -c foo.bar=1 commit with staged code warns",
           run_hook(CS, "bash", "git -c foo.bar=1 commit -m x", cs_repo), "warn")
    expect("git -C<repo> commit with staged code warns (attached -C)",
           run_hook(CS, "bash", f"git -C{cs_repo} commit -m x", feat_repo), "warn")
    expect("bash -lc 'git commit' with staged code warns",
           run_hook(CS, "bash", "bash -lc 'git commit -m x'", cs_repo), "warn")
    expect("(git commit) subshell with staged code warns",
           run_hook(CS, "bash", "(git commit -m x)", cs_repo), "warn")
    expect("echo $(git commit) with staged code warns",
           run_hook(CS, "bash", "echo $(git commit -m x)", cs_repo), "warn")

    # --- suggest_changeset: redirect tokens are not pathspecs (round 10) ---
    # x.ts is tracked in feat_repo with an unstaged modification, and a
    # staged README.md is not a published workspace: a plain commit
    # touches neither, so it stays silent — and redirect tokens must not
    # be read as a pathspec that pulls the unstaged modification in.
    git(feat_repo, "checkout", "--", ".changeset/quoted-msg.md")  # no unstaged changeset
    write("README.md", "# r\n")
    git(feat_repo, "add", "README.md")
    expect("plain commit with only a staged README -> silent",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "silent")
    expect("commit > log: redirect is not a pathspec -> silent",
           run_hook(CS, "bash", "git commit -m x > log.txt", feat_repo), "silent")
    expect("commit >> log: redirect is not a pathspec -> silent",
           run_hook(CS, "bash", "git commit -m x >> log.txt", feat_repo), "silent")
    expect("commit 2> log: redirect is not a pathspec -> silent",
           run_hook(CS, "bash", "git commit -m x 2> log.txt", feat_repo), "silent")
    expect("commit 2>&1: redirect is not a pathspec -> silent",
           run_hook(CS, "bash", "git commit -m x 2>&1", feat_repo), "silent")
    expect("commit < in: redirect is not a pathspec -> silent",
           run_hook(CS, "bash", "git commit -m x < in.txt", feat_repo), "silent")
    expect("commit >log (attached target): redirect is not a pathspec -> silent",
           run_hook(CS, "bash", "git commit -m x >log.txt", feat_repo), "silent")
    expect("commit -am x > log still warns (-a includes unstaged)",
           run_hook(CS, "bash", "git commit -am x > log.txt", feat_repo), "warn")
    expect("commit with pathspec > log still warns",
           run_hook(CS, "bash", "git commit -m x -- packages/libs/core/src/x.ts > log.txt", feat_repo), "warn")
    git(feat_repo, "reset", "-q")

    # --- suggest_changeset: a git add earlier in the command stages its files (round 11, S1) ---
    # x.ts is tracked in feat_repo with an unstaged modification and
    # nothing is staged: the commit's file set must include what the
    # same command's `git add` would stage.
    expect("git add <pkg file> && git commit warns",
           run_hook(CS, "bash", "git add packages/libs/core/src/x.ts && git commit -m x", feat_repo), "warn")
    expect("git add -A && git commit warns",
           run_hook(CS, "bash", "git add -A && git commit -m x", feat_repo), "warn")
    expect("git add . && git commit warns",
           run_hook(CS, "bash", "git add . && git commit -m x", feat_repo), "warn")
    expect("git add -n (dry-run) stages nothing: commit silent",
           run_hook(CS, "bash", "git add -n packages/libs/core/src/x.ts && git commit -m x", feat_repo), "silent")
    expect("git add <non-pkg file> && git commit silent",
           run_hook(CS, "bash", "git add README.md && git commit -m x", feat_repo), "silent")
    expect("cd <repo> && git add <pkg file> && git commit warns",
           run_hook(CS, "bash", f"cd {feat_repo} && git add packages/libs/core/src/x.ts && git commit -m x", main_repo), "warn")
    expect("git -C <repo> add <pkg file> && git -C <repo> commit warns",
           run_hook(CS, "bash", f"git -C {feat_repo} add packages/libs/core/src/x.ts && git -C {feat_repo} commit -m x", main_repo), "warn")
    write("packages/libs/core/src/new.ts", "export const n = 1;\n")
    expect("git add <untracked pkg file> && git commit warns",
           run_hook(CS, "bash", "git add packages/libs/core/src/new.ts && git commit -m x", feat_repo), "warn")
    os.remove(os.path.join(feat_repo, "packages/libs/core/src/new.ts"))

    # --- suggest_changeset: a pathspec commit includes only its pathspecs (round 11, S3) ---
    # x.ts is modified-unstaged in feat_repo: a commit whose pathspec is
    # README.md includes no package code, so it stays silent.
    expect("pathspec commit includes only its pathspecs -> silent",
           run_hook(CS, "bash", "git commit -m x -- README.md", feat_repo), "silent")

    # --- block_commit_on_main: git switch --create / -C (round 11) ---
    expect("git switch --create master + commit denied",
           run_hook(BCM, "bash", "git switch --create master && git commit -m x", feat_repo), "deny")
    expect("git switch -C master + commit denied",
           run_hook(BCM, "bash", "git switch -C master && git commit -m x", feat_repo), "deny")
    expect("git switch --create <feat> + commit allowed",
           run_hook(BCM, "bash", "git switch --create feat/x && git commit -m x", feat_repo), "silent")

    # --- block_commit_on_main: the two-argument pathspec form is not a switch (round 12, S2+S1) ---
    # `git checkout <target> <path>` (no `--`) restores paths from <target> and
    # does not switch: a switch requires no bare word after the target. Options
    # after the target are fine — `git checkout main -q` really switches.
    expect("git checkout main <path> is not a switch + commit allowed",
           run_hook(BCM, "bash", "git checkout main file.txt && git commit -m x", feat_repo), "silent")
    git(feat_repo, "branch", "feat/x")
    expect("switch to main then 'checkout feat/x <path>' + commit still denied",
           run_hook(BCM, "bash", "git checkout main && git checkout feat/x file.txt && git commit -m x", feat_repo), "deny")
    git(feat_repo, "branch", "-D", "feat/x")
    # a fresh repo keeps prev_repo's checkout history untouched
    dash_repo = os.path.join(fix, "dash-repo")
    subprocess.run(["git", "init", "-q", "-b", "main", dash_repo], check=True, capture_output=True)
    git(dash_repo, "commit", "-q", "--allow-empty", "-m", "init")
    git(dash_repo, "checkout", "-q", "-b", "feat/dash")
    git(dash_repo, "checkout", "-q", "main")
    expect("git checkout - <path> restores paths (no switch back) + commit on main denied",
           run_hook(BCM, "bash", "git checkout - file.txt && git commit -m x", dash_repo), "deny")
    expect("git switch main <path> is not a switch + commit allowed",
           run_hook(BCM, "bash", "git switch main file.txt && git commit -m x", feat_repo), "silent")
    expect("control: git checkout main -q (option after the target) really switches",
           run_hook(BCM, "bash", "git checkout main -q && git commit -m x", feat_repo), "deny")

    # --- suggest_changeset: a changeset staged by the command's own git add counts (round 12) ---
    # x.ts is tracked in feat_repo with an unstaged modification and nothing
    # is staged: the commit's file set includes what the same command's
    # `git add` stages — changeset files included.
    write(".changeset/addtest.md", "---\n'@mercury-fw/core': patch\n---\n\naddtest\n")
    expect("git add -A (changeset included) && git commit silent",
           run_hook(CS, "bash", "git add -A && git commit -m x", feat_repo), "silent")
    expect("git add <changeset> <pkg file> && git commit silent",
           run_hook(CS, "bash", "git add .changeset/addtest.md packages/libs/core/src/x.ts && git commit -m x", feat_repo), "silent")
    expect("control: git add -n (dry-run) stages no changeset -> warns",
           run_hook(CS, "bash", "git add -n .changeset/addtest.md && git commit -am x", feat_repo), "warn")
    os.remove(os.path.join(feat_repo, ".changeset/addtest.md"))

    # --- suggest_changeset: a git add inside a wrapper/subshell stages for an outer commit (round 12) ---
    expect("bash -c 'git add <pkg file>' && git commit warns",
           run_hook(CS, "bash", "bash -c 'git add packages/libs/core/src/x.ts' && git commit -m x", feat_repo), "warn")
    expect("(git add <pkg file>) && git commit warns",
           run_hook(CS, "bash", "(git add packages/libs/core/src/x.ts) && git commit -m x", feat_repo), "warn")
    expect("control: bash -c 'git add <pkg file> && git commit' warns",
           run_hook(CS, "bash", "bash -c 'git add packages/libs/core/src/x.ts && git commit -m x'", feat_repo), "warn")

    # --- suggest_changeset: git queries run from the repo root (round 12) ---
    # A commit from a subdirectory: `git diff` prints root-relative paths from
    # anywhere, but a `.changeset/` pathspec is working-directory-relative and
    # `git ls-files` prints working-directory-relative paths — so every query
    # runs from the repository root, with pathspecs rewritten to root-relative
    # form.
    write(".changeset/subdir.md", "---\n'@mercury-fw/core': patch\n---\n\nsubdir\n")
    git(feat_repo, "add", ".changeset/subdir.md", "packages/libs/core/src/x.ts")
    expect("commit from a subdir with a staged changeset -> silent",
           run_hook(CS, "bash", "cd packages/libs/core/src && git commit -m x", feat_repo), "silent")
    git(feat_repo, "reset", "-q")
    os.remove(os.path.join(feat_repo, ".changeset/subdir.md"))
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("control: commit from a subdir without a changeset -> warns",
           run_hook(CS, "bash", "cd packages/libs/core/src && git commit -m x", feat_repo), "warn")
    git(feat_repo, "reset", "-q")
    write(".changeset/subdir2.md", "---\n'@mercury-fw/core': patch\n---\n\nsubdir2\n")
    expect("git add from a subdir stages root-relative paths -> silent",
           run_hook(CS, "bash", "cd packages/libs/core/src && git add x.ts ../../../../.changeset/subdir2.md && git commit -m x", feat_repo), "silent")
    os.remove(os.path.join(feat_repo, ".changeset/subdir2.md"))

    # --- all hooks: a bare & separates commands (round 12) ---
    # `cmd & cmd2` backgrounds cmd and runs cmd2: the second command is
    # analyzed like one after a `;`. The `&` of a redirect (`&>`, `2>&1`) is
    # not a separator.
    expect("sleep 0.1 & git commit on main denied",
           run_hook(BCM, "bash", "sleep 0.1 & git commit -m x", main_repo), "deny")
    expect("true & rm -rf denied",
           run_hook(RM, "bash", "true & rm -rf /tmp/x", feat_repo), "deny")
    expect("true & git commit with staged code warns",
           run_hook(CS, "bash", "true & git commit -m x", cs_repo), "warn")
    expect("bash -c 'true & git commit' on main denied",
           run_hook(BCM, "bash", "bash -c 'true & git commit -m x'", main_repo), "deny")
    expect("guard: git commit -m x 2>&1 on main still denied",
           run_hook(BCM, "bash", "git commit -m x 2>&1", main_repo), "deny")
    expect("guard: git commit -m x 2>&1 with staged code still warns",
           run_hook(CS, "bash", "git commit -m x 2>&1", cs_repo), "warn")
    expect("guard: echo a &> log && git commit on feat allowed",
           run_hook(BCM, "bash", "echo a &> log && git commit -m x", feat_repo), "silent")

    # --- block_commit_on_main: shell comments are stripped before analysis (round 13, S1) ---
    # A `#` at a word start (the beginning of the line, after whitespace, or
    # after a ; & | ( ) > < operator) runs to the end of the line: a switch
    # followed by a comment still switches, and a comment hides the
    # separators and commands inside it. A `#` inside quotes, escaped, or
    # mid-word (`a#b`, `$#`, `"a"#c`) is literal.
    expect("switch to main with a trailing comment, then commit -> denied",
           run_hook(BCM, "bash", "git checkout main # sync with origin\ngit commit -m x", feat_repo), "deny")
    expect("switch to main then away with a trailing comment, then commit -> allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout feat/331-test # back\ngit commit -m x", feat_repo), "silent")
    expect("a comment hides the separator and the commit inside it -> silent",
           run_hook(BCM, "bash", "git checkout main # c; git commit -m x", feat_repo), "silent")
    expect("comment inside a wrapper's inner command line -> denied",
           run_hook(BCM, "bash", "bash -c 'git checkout main # c\ngit commit -m x'", feat_repo), "deny")
    expect("a quote inside a comment does not open a quote -> denied",
           run_hook(BCM, "bash", "git checkout main # don't panic\ngit commit -m x", feat_repo), "deny")
    expect("a full-line comment does not hide a commit on main -> denied",
           run_hook(BCM, "bash", "# just a comment\ngit commit -m x", main_repo), "deny")
    expect("a trailing comment after a commit on main -> denied",
           run_hook(BCM, "bash", "git commit -m x # trailing note", main_repo), "deny")
    expect("a # inside a quoted message is literal: commit on main denied",
           run_hook(BCM, "bash", 'git commit -m "fix #331"', main_repo), "deny")
    expect("a # mid-word is literal: commit on main denied",
           run_hook(BCM, "bash", "git commit -m fix#331", main_repo), "deny")
    expect("control: a # in an echo does not hide a commit on main",
           run_hook(BCM, "bash", "echo A#not-a-comment && git commit -m x", main_repo), "deny")
    expect("control: a quoted message then a comment, commit on main -> denied",
           run_hook(BCM, "bash", 'git commit -m "a" # c', main_repo), "deny")

    # --- block_commit_on_main: long options between checkout/switch and the target (round 13, S1) ---
    # `git checkout --quiet main` really switches: the subcommand's own long
    # options are skipped like the short ones (a bare `--` still is not).
    expect("git checkout --quiet main && git commit denied",
           run_hook(BCM, "bash", "git checkout --quiet main && git commit -m x", feat_repo), "deny")
    expect("git switch --quiet main && git commit denied",
           run_hook(BCM, "bash", "git switch --quiet main && git commit -m x", feat_repo), "deny")
    expect("git checkout --force main && git commit denied",
           run_hook(BCM, "bash", "git checkout --force main && git commit -m x", feat_repo), "deny")
    expect("switch to main then away with a long option, then commit -> allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout --quiet feat/331-test && git commit -m x", feat_repo), "silent")
    expect("git checkout --quiet main <path> is the two-argument pathspec form -> allowed",
           run_hook(BCM, "bash", "git checkout --quiet main file.txt && git commit -m x", feat_repo), "silent")
    expect("git checkout --quiet main -q (option after the target) still switches -> denied",
           run_hook(BCM, "bash", "git checkout --quiet main -q && git commit -m x", feat_repo), "deny")
    expect("switch to main then 'checkout --detach main~1' (a revision) + commit allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout --detach main~1 && git commit -m x", prev_repo), "silent")
    expect("switch to main then 'checkout --detach HEAD' + commit still denied (detached at main's commit)",
           run_hook(BCM, "bash", "git checkout main && git checkout --detach HEAD && git commit -m x", feat_repo), "deny")

    # --- block_rm_rf: a comment hides the separators inside it (round 13, S1) ---
    expect("a comment hides '; rm -rf' -> allowed (the rm never runs)",
           run_hook(RM, "bash", "true # a; rm -rf /tmp/x", feat_repo), "silent")
    expect("a comment hides '&& rm -rf' -> allowed (the rm never runs)",
           run_hook(RM, "bash", "echo done # note && rm -rf /tmp/x", feat_repo), "silent")
    expect("control: rm -rf with a trailing comment -> denied",
           run_hook(RM, "bash", "rm -rf /tmp/x # note && echo done", feat_repo), "deny")
    expect("control: a quoted # in the path -> denied",
           run_hook(RM, "bash", "rm -rf '/tmp/a#b'", feat_repo), "deny")

    # --- suggest_changeset: shell comments (round 13, S1) ---
    # x.ts is tracked in feat_repo with an unstaged modification (the state
    # the round-12 sections left behind).
    expect("control: git add <pkg file> with a trailing comment && git commit warns",
           run_hook(CS, "bash", "git add packages/libs/core/src/x.ts # stage it\ngit commit -m x", feat_repo), "warn")
    expect("a comment hides '; git commit' -> silent (the commit never runs)",
           run_hook(CS, "bash", "git add packages/libs/core/src/x.ts # c; git commit -m x", feat_repo), "silent")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    expect("git commit with a trailing comment and staged code -> warns",
           run_hook(CS, "bash", "git commit -m x # no changeset yet", feat_repo), "warn")
    expect("git commit with a comment line after it and staged code -> warns",
           run_hook(CS, "bash", "git commit -m x # c\ngit status", feat_repo), "warn")
    expect("control: a quoted message then a comment, staged code -> warns",
           run_hook(CS, "bash", 'git commit -m "msg" # c', feat_repo), "warn")
    git(feat_repo, "reset", "-q")

    # --- suggest_changeset: a pathspec commit counts only its pathspecs, staged side too (round 13, S3) ---
    # A `git commit -- <paths>` includes only the named paths: unrelated staged
    # changes stay staged, so they must not trigger the warning — and a staged
    # changeset outside the pathspecs is not included by the commit either.
    git(feat_repo, "add", "README.md")
    git(feat_repo, "commit", "-q", "-m", "docs: readme")  # README.md tracked now
    write("README.md", "# r2\n")  # tracked modification for the pathspec commit
    write("packages/libs/core/src/x.ts", "export const x = 20;\n")
    git(feat_repo, "add", "packages/libs/core/src/x.ts")  # unrelated staged code
    expect("pathspec commit of a doc with unrelated staged code -> silent",
           run_hook(CS, "bash", "git commit -m x -- README.md", feat_repo), "silent")
    expect("control: plain commit with the same staged code -> warns",
           run_hook(CS, "bash", "git commit -m x", feat_repo), "warn")
    expect("pathspec commit matching the staged code -> warns",
           run_hook(CS, "bash", "git commit -m x -- packages/libs/core/src/x.ts", feat_repo), "warn")
    write(".changeset/cs3.md", "---\n'@mercury-fw/core': patch\n---\n\ncs3\n")
    git(feat_repo, "add", ".changeset/cs3.md")
    expect("pathspec commit excluding the staged changeset -> warns (the commit includes no changeset)",
           run_hook(CS, "bash", "git commit -m x -- packages/libs/core/src/x.ts", feat_repo), "warn")
    expect("pathspec commit including the staged changeset -> silent",
           run_hook(CS, "bash", "git commit -m x -- packages/libs/core/src/x.ts .changeset/cs3.md", feat_repo), "silent")
    git(feat_repo, "reset", "-q")
    os.remove(os.path.join(feat_repo, ".changeset/cs3.md"))

    # --- suggest_changeset: git add -u stages no untracked files (round 13, S3) ---
    # `git add -u` stages tracked modifications only: an untracked file under
    # packages/ on disk is staged by no commit form, so `git add -u && git
    # commit` warns for nothing. `git add -A` stages untracked files too.
    git(feat_repo, "add", "packages/libs/core/src/x.ts")
    git(feat_repo, "commit", "-q", "-m", "code")  # x.ts clean now
    write("packages/libs/core/src/untracked.ts", "export const u = 1;\n")
    expect("git add -u && git commit with only an untracked pkg file -> silent",
           run_hook(CS, "bash", "git add -u && git commit -m x", feat_repo), "silent")
    expect("control: git add -A && git commit with the untracked pkg file -> warns",
           run_hook(CS, "bash", "git add -A && git commit -m x", feat_repo), "warn")
    os.remove(os.path.join(feat_repo, "packages/libs/core/src/untracked.ts"))
    write("packages/libs/core/src/x.ts", "export const x = 21;\n")  # tracked modification
    expect("control: git add -u && git commit with a tracked modification -> warns",
           run_hook(CS, "bash", "git add -u && git commit -m x", feat_repo), "warn")
    expect("control: git add --update && git commit with a tracked modification -> warns",
           run_hook(CS, "bash", "git add --update && git commit -m x", feat_repo), "warn")
    git(feat_repo, "reset", "-q")

    # --- block_commit_on_main: redirects after a switch target (round 14, S1) ---
    # Bash allows a redirect anywhere in a command: `git checkout main
    # 2>/dev/null` really switches, so a redirect after the target does
    # not turn the switch into a pathspec form — and a bare word (or a
    # bare `--`) after a redirect still does (`git checkout main >log
    # file.txt` and `git checkout main >log -- file.txt` restore paths,
    # they do not switch).
    expect("switch to main with >log 2>&1, then commit -> denied",
           run_hook(BCM, "bash", "git checkout main >log 2>&1 && git commit -m x", feat_repo), "deny")
    expect("switch to main with 2>/dev/null, then commit -> denied",
           run_hook(BCM, "bash", "git checkout main 2>/dev/null && git commit -m x", feat_repo), "deny")
    expect("switch to main with &>log, then commit -> denied",
           run_hook(BCM, "bash", "git checkout main &>log && git commit -m x", feat_repo), "deny")
    expect("git switch to main with >log, then commit -> denied",
           run_hook(BCM, "bash", "git switch main >log && git commit -m x", feat_repo), "deny")
    expect("switch to main piped through a redirect, then commit -> denied",
           run_hook(BCM, "bash", "git checkout main 2>&1 | tee log && git commit -m x", feat_repo), "deny")
    expect("switch to main with a separated redirect target, then commit -> denied",
           run_hook(BCM, "bash", "git checkout main > log && git commit -m x", feat_repo), "deny")
    expect("switch to main with a quoted redirect target, then commit -> denied",
           run_hook(BCM, "bash", 'git checkout main >"my log" && git commit -m x', feat_repo), "deny")
    expect("switch to main then away with a redirect, then commit -> allowed",
           run_hook(BCM, "bash", "git checkout main && git checkout feat/331-test >log && git commit -m x", feat_repo), "silent")
    expect("a bare word after a redirect is the two-argument pathspec form -> allowed",
           run_hook(BCM, "bash", "git checkout main >log file.txt && git commit -m x", feat_repo), "silent")
    expect("a bare -- after a redirect is the pathspec form -> allowed",
           run_hook(BCM, "bash", "git checkout main >log -- file.txt && git commit -m x", feat_repo), "silent")

    # --- block_commit_on_main: quoted previous-branch targets, = attached create values (round 14, S3) ---
    # `git checkout "@{-1}"` resolves like the bare shorthand, and a long
    # option takes its value after `=` (`--force-create=main` really
    # resets main) while a short option's `=` is part of the value
    # (`-b=main` creates a branch named `=main`).
    qprev_repo = os.path.join(fix, "qprev-repo")
    subprocess.run(["git", "init", "-q", "-b", "main", qprev_repo], check=True, capture_output=True)
    git(qprev_repo, "commit", "-q", "--allow-empty", "-m", "init")
    git(qprev_repo, "checkout", "-q", "-b", "feat/q")
    expect("checkout \"@{-1}\" (previous is main) + commit denied",
           run_hook(BCM, "bash", 'git checkout "@{-1}" && git commit -m x', qprev_repo), "deny")
    expect("checkout '@{-1}' (previous is main) + commit denied",
           run_hook(BCM, "bash", "git checkout '@{-1}' && git commit -m x", qprev_repo), "deny")
    expect("checkout \"-\" (previous is main) + commit denied",
           run_hook(BCM, "bash", 'git checkout "-" && git commit -m x', qprev_repo), "deny")
    expect("checkout \"@{-1}\" with a redirect, previous is main -> denied",
           run_hook(BCM, "bash", 'git checkout "@{-1}" 2>/dev/null && git commit -m x', qprev_repo), "deny")
    expect("checkout \"@{-9}\" (no such previous) + commit judged on the current branch",
           run_hook(BCM, "bash", 'git checkout "@{-9}" && git commit -m x', qprev_repo), "silent")
    expect("control: a quoted non-shorthand target is an ordinary switch away",
           run_hook(BCM, "bash", 'git checkout "feat/q" && git commit -m x', qprev_repo), "silent")
    expect("git switch --force-create=main + commit denied",
           run_hook(BCM, "bash", "git switch --force-create=main && git commit -m x", feat_repo), "deny")
    expect("git switch --create=master + commit denied",
           run_hook(BCM, "bash", "git switch --create=master && git commit -m x", feat_repo), "deny")
    expect("git switch --force-create=<feat> + commit allowed",
           run_hook(BCM, "bash", "git switch --force-create=feat/new && git commit -m x", feat_repo), "silent")
    expect("control: -b=main creates a branch named =main (not main) -> allowed",
           run_hook(BCM, "bash", "git checkout -b=main && git commit -m x", feat_repo), "silent")

    # --- all pre_tool hooks: leading redirects and line continuations (round 14, S3) ---
    # Bash allows a redirect before the command (`2>/dev/null git commit`
    # really commits) and a backslash at the end of a line continues the
    # command on the next one (`git checkout \` + newline + `main` is one
    # command; an escaped `\\` ends it instead).
    expect("leading 2>/dev/null: commit on main denied",
           run_hook(BCM, "bash", "2>/dev/null git commit -m x", main_repo), "deny")
    expect("leading >log: commit on main denied",
           run_hook(BCM, "bash", ">log git commit -m x", main_repo), "deny")
    expect("leading &>log: commit on main denied",
           run_hook(BCM, "bash", "&>log git commit -m x", main_repo), "deny")
    expect("leading redirect with a quoted target: commit on main denied",
           run_hook(BCM, "bash", '>"my log" git commit -m x', main_repo), "deny")
    expect("leading redirect on a switch, then commit -> denied",
           run_hook(BCM, "bash", "2>/dev/null git checkout main && git commit -m x", feat_repo), "deny")
    expect("continuation inside a switch, then commit -> denied",
           run_hook(BCM, "bash", "git checkout \\\nmain && git commit -m x", feat_repo), "deny")
    expect("continuation inside a commit on main -> denied",
           run_hook(BCM, "bash", "git commit -m \\\nx", main_repo), "deny")
    expect("an escaped backslash ends the command: the commit after it still runs -> denied",
           run_hook(BCM, "bash", "echo foo\\\\\ngit commit -m x", main_repo), "deny")
    expect("control: a continuation inside an echo is one command -> silent",
           run_hook(BCM, "bash", "echo foo \\\nbar", feat_repo), "silent")
    expect("leading 2>/dev/null: rm -rf denied",
           run_hook(RM, "bash", "2>/dev/null rm -rf /tmp/x", feat_repo), "deny")
    expect("leading >log: rm -rf denied",
           run_hook(RM, "bash", ">log rm -rf /tmp/x", feat_repo), "deny")
    expect("continuation splits the rm flags -> denied",
           run_hook(RM, "bash", "rm -r \\\n-f /tmp/x", feat_repo), "deny")
    expect("continuation splits the rm path -> denied",
           run_hook(RM, "bash", "rm -rf \\\n/tmp/x", feat_repo), "deny")
    expect("control: a leading redirect on an echo is not an rm -> silent",
           run_hook(RM, "bash", "2>/dev/null echo rm -rf", feat_repo), "silent")
    expect("control: a continuation inside an echo -> silent",
           run_hook(RM, "bash", "echo hi \\\nthere", feat_repo), "silent")
    expect("leading 2>/dev/null: commit with staged code warns",
           run_hook(CS, "bash", "2>/dev/null git commit -m x", cs_repo), "warn")
    expect("continuation inside a commit with staged code -> warns",
           run_hook(CS, "bash", "git commit \\\n-m x", cs_repo), "warn")
    expect("control: a leading redirect on a non-commit -> silent",
           run_hook(CS, "bash", "2>/dev/null git status", cs_repo), "silent")

    # --- every hook's docstring states its threat model (round 14, S4) ---
    for script in (BCM, RM, CS, TS):
        with open(os.path.join(TOOLS, script)) as f:
            source = " ".join(f.read().split())
        check(f"{script} docstring states its threat model",
              "honest but fallible agent" in source and "not a sandbox" in source, script)

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
    foreign = os.path.join(fix, "foreign-repo")
    subprocess.run(["git", "init", "-q", "-b", "main", foreign], check=True, capture_output=True)
    os.makedirs(os.path.join(foreign, ".vibe"), exist_ok=True)
    with open(os.path.join(foreign, ".vibe", "hooks.toml"), "w") as f:
        f.write("# a foreign Vibe project's hooks\n")
    p = subprocess.run(["sh", "-c", rm_hook["command"]], input=payload, capture_output=True, text=True, cwd=foreign)
    check("hooks.toml command fails open in a foreign Vibe project",
          p.returncode == 0 and not p.stdout.strip(), p.stdout + p.stderr)
    p = subprocess.run(["sh", "-c", rm_hook["command"]], input="not json", capture_output=True, text=True, cwd=REPO)
    check("hooks.toml command surfaces an in-repo hook crash",
          p.returncode != 0, f"rc={p.returncode}")

    # --- hooks.toml match patterns vs Vibe's fullmatch + candidate names ---
    # Vibe's Unified Harness fullmatches a re: pattern against candidate
    # names: the qualified name, the leaf, the underscore-joined name and
    # the model-facing alias.
    MODEL_ALIASES = {
        "file_system.bash": "bash",
        "file_system.search_replace": "edit",
        "file_system.write_file": "write_file",
    }

    def candidates(qualified):
        leaf = qualified.split(".")[-1]
        return {qualified, leaf, qualified.replace(".", "_"), MODEL_ALIASES.get(qualified, leaf)}

    def match_fires(pattern, qualified):
        rx = re.compile(pattern[len("re:"):])
        return any(rx.fullmatch(c) for c in candidates(qualified))

    bash_match = next(h["match"] for h in hooks if h["name"] == "block-rm-rf")
    for tool in ("bash", "file_system.bash", "process.start"):
        check(f"bash match fires for {tool}", match_fires(bash_match, tool))
    for tool in ("read_file", "file_system.read_file", "edit"):
        check(f"bash match does not fire for {tool}", not match_fires(bash_match, tool))
    edit_match = next(h["match"] for h in hooks if h["name"] == "suggest-test-after-ts-edit")
    for tool in ("edit", "write_file", "file_system.search_replace", "file_system.write_file"):
        check(f"edit match fires for {tool}", match_fires(edit_match, tool))
    check("edit match does not fire for bash", not match_fires(edit_match, "bash"))

    # The match patterns also fullmatch the qualified tool names literally,
    # not only the leaf/alias candidates Vibe derives from them.
    for h in hooks:
        rx = re.compile(h["match"][len("re:"):])
        names = (("bash", "file_system.bash", "process.start") if h["type"] == "pre_tool"
                 else ("edit", "write_file", "file_system.search_replace", "file_system.write_file"))
        check(f"hook {h['name']} match literally fullmatches the qualified tool names",
              all(rx.fullmatch(n) for n in names), h["match"])

    # --- .vibe/agents profiles stay in sync with the .claude agent docs ---
    # The toml instructions are the .md body after the frontmatter, modulo the
    # blank lines around it.
    agents_dir = os.path.join(REPO, ".vibe", "agents")
    for fname in sorted(os.listdir(agents_dir)):
        if not fname.endswith(".toml"):
            continue
        with open(os.path.join(agents_dir, fname), "rb") as f:
            instructions = tomllib.load(f)["instructions"]
        md_path = os.path.join(REPO, ".claude", "agents", fname[: -len(".toml")] + ".md")
        with open(md_path) as f:
            body = f.read().split("---", 2)[2]
        check(f"{fname} instructions match the .claude agent doc",
              body.strip("\n") == instructions.strip("\n"), fname)

    print()
    print(f"{cases - len(failures)}/{cases} passed")
    if failures:
        print("\n".join(failures))
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
