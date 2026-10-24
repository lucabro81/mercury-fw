#!/usr/bin/env python3
"""Hook post_tool: suggerisce test e typecheck dopo modifiche a file .ts (non test)."""
import json
import sys

# I tool di modifica nel payload degli hook arrivano in forma breve
# ("edit"/"write_file", documentata negli esempi) o in forma qualificata
# dall'Unified Harness di Vibe: il tool di edit è "file_system.search_replace",
# quello di scrittura "file_system.write_file".
EDIT_TOOL_NAMES = ("edit", "write_file", "file_system.search_replace", "file_system.write_file")


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name not in EDIT_TOOL_NAMES:
        sys.exit(0)

    status = data.get("tool_status", "")
    if status != "success":
        sys.exit(0)

    file_path = data.get("tool_input", {}).get("file_path") or data.get("tool_input", {}).get("path", "")
    if not file_path.endswith(".ts"):
        sys.exit(0)
    if file_path.endswith(".test.ts"):
        sys.exit(0)

    # Determina il package dal path
    parts = file_path.replace("\\", "/").split("/")
    package_hint = ""
    if "packages" in parts:
        idx = parts.index("packages")
        if idx + 2 < len(parts):
            package_hint = f" in `{parts[idx]}/{parts[idx+1]}/{parts[idx+2]}`"

    print(json.dumps({
        "decision": "allow",
        "hook_specific_output": {
            "additional_context": (
                f"\n\n📝 TypeScript file modified: `{file_path}`{package_hint}\n"
                f"After the changes, remember to run:\n"
                f"  • `bun run typecheck` — verify types\n"
                f"  • `bun test` — run the package tests\n"
                f"  • If the file is in a package, run tests from inside that package"
            ),
        },
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
