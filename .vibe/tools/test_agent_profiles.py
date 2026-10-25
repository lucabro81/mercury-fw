#!/usr/bin/env python3
"""Drift guard for the .vibe agent profiles.

Asserts that every `.vibe/agents/<name>.toml` profile's `instructions` match
the body of the canonical `.claude/agents/<name>.md` definition (the part
after the frontmatter), modulo the blank lines around it. Fails when the
Vibe profiles and the Claude Code definitions diverge.

Usage: python3 .vibe/tools/test_agent_profiles.py
Exits non-zero when any case fails.
"""
import os
import sys
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


def main():
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
