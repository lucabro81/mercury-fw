#!/usr/bin/env python3
"""Drift guard for the .vibe agent profiles.

Asserts that every `.vibe/agents/<name>.toml` profile's `instructions` match
the body of the canonical `.claude/agents/<name>.md` definition (the part
after the frontmatter), modulo the blank lines around it — in both
directions: a profile without its doc, or a doc without its profile, is a
failure. Fails when the Vibe profiles and the Claude Code definitions
diverge.

Usage: python3 .vibe/tools/test_agent_profiles.py [--selftest]
Exits non-zero when any case fails. --selftest exercises the guard's
failure paths against fixture trees (the repo itself is in sync, so those
paths would otherwise never run).
"""
import os
import sys
import tempfile
import tomllib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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


def guard_cases(agents_dir, claude_dir):
    """Yields (desc, ok, detail) for every profile/doc pair, both directions."""
    tomls = sorted(f for f in os.listdir(agents_dir) if f.endswith(".toml"))
    mds = sorted(f for f in os.listdir(claude_dir) if f.endswith(".md"))
    # The toml instructions are the .md body after the frontmatter, modulo the
    # blank lines around it.
    for fname in tomls:
        md_path = os.path.join(claude_dir, fname[: -len(".toml")] + ".md")
        if not os.path.exists(md_path):
            yield (f"{fname} has a matching .claude agent doc", False, md_path)
            continue
        with open(os.path.join(agents_dir, fname), "rb") as f:
            instructions = tomllib.load(f)["instructions"]
        with open(md_path) as f:
            body = f.read().split("---", 2)[2]
        yield (f"{fname} instructions match the .claude agent doc",
               body.strip("\n") == instructions.strip("\n"), fname)
    for fname in mds:
        toml_path = os.path.join(agents_dir, fname[: -len(".md")] + ".toml")
        yield (f"{fname} has a matching .vibe agent profile",
               os.path.exists(toml_path), toml_path)


def report():
    print()
    print(f"{cases - len(failures)}/{cases} passed")
    if failures:
        print("\n".join(failures))
        sys.exit(1)
    print("ALL PASS")


def main():
    agents_dir = os.path.join(REPO, ".vibe", "agents")
    claude_dir = os.path.join(REPO, ".claude", "agents")
    for desc, ok, detail in guard_cases(agents_dir, claude_dir):
        check(desc, ok, detail)
    report()


def selftest():
    fix = tempfile.mkdtemp(prefix="mercury-drift-")
    agents_dir = os.path.join(fix, "vibe", "agents")
    claude_dir = os.path.join(fix, "claude", "agents")
    os.makedirs(agents_dir)
    os.makedirs(claude_dir)
    toml_body = (
        'display_name = "Fixture"\n'
        'description = "fixture"\n'
        'safety = "neutral"\n'
        'agent_type = "subagent"\n'
        'disabled_tools = ["write_file", "edit"]\n'
        'instructions = """\nYou are a fixture reviewer.\n"""\n'
    )

    def write(rel, content):
        with open(os.path.join(fix, rel), "w") as f:
            f.write(content)

    # a synced pair
    write("vibe/agents/synced.toml", toml_body)
    write("claude/agents/synced.md",
          "---\nname: synced\n---\n\nYou are a fixture reviewer.\n")
    # a divergent pair (same names, different instructions)
    write("vibe/agents/diverged.toml", toml_body)
    write("claude/agents/diverged.md",
          "---\nname: diverged\n---\n\nYou are a divergent doc.\n")
    # a profile without its doc, and a doc without its profile
    write("vibe/agents/orphan.toml", toml_body)
    write("claude/agents/mdonly.md",
          "---\nname: mdonly\n---\n\nYou are a doc without a profile.\n")

    results = {desc: ok for desc, ok, _ in guard_cases(agents_dir, claude_dir)}
    check("selftest: a synced pair passes",
          results.get("synced.toml instructions match the .claude agent doc") is True)
    check("selftest: a divergent pair fails",
          results.get("diverged.toml instructions match the .claude agent doc") is False)
    check("selftest: a profile without its doc fails cleanly",
          results.get("orphan.toml has a matching .claude agent doc") is False)
    check("selftest: a doc without its profile fails",
          results.get("mdonly.md has a matching .vibe agent profile") is False)
    check("selftest: six cases ran", len(results) == 6, str(len(results)))
    report()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
