"""A stand-in for `skill-trainer run ... --skillopt-out <dir>`, for the adapter's tests.

It records its argv and the skill it was given, then writes what the real
harness writes: a result per task (passed when the skill contains "GOOD") and a
conversation per task. FAKE_HARNESS_MODE=crash exits 3 without writing results;
FAKE_HARNESS_MODE=task-error exits 1 after writing them, as the real harness
does when a task couldn't run.
"""
import json
import os
import sys


def main() -> int:
    args = sys.argv[1:]
    out = args[args.index("--skillopt-out") + 1]
    skill = open(args[args.index("--skill") + 1], encoding="utf-8").read()
    ids = args[args.index("--task") + 1 :]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "argv.json"), "w", encoding="utf-8") as f:
        json.dump(args, f)
    mode = os.environ.get("FAKE_HARNESS_MODE", "")
    if mode == "crash":
        print("the jira plugin didn't load", file=sys.stderr)
        return 3
    passed = 1 if "GOOD" in skill else 0
    results = []
    for task_id in ids:
        os.makedirs(os.path.join(out, "predictions", task_id), exist_ok=True)
        with open(os.path.join(out, "predictions", task_id, "conversation.json"), "w", encoding="utf-8") as f:
            json.dump([{"role": "user", "content": task_id}], f)
        results.append({"id": task_id, "hard": passed, "soft": float(passed), "task_type": "t", "task_description": task_id, "fail_reason": "", "predicted_answer": "", "n_turns": 1})
    with open(os.path.join(out, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f)
    return 1 if mode == "task-error" else 0


if __name__ == "__main__":
    sys.exit(main())
