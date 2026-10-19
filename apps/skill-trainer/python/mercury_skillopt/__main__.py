"""`python -m mercury_skillopt train|smoke [SkillOpt's arguments]`.

SkillOpt has no plugin mechanism for environments: each of its CLIs keeps a
registry of its own. `train` adds the adapter to its training CLI's registry,
then hands over to SkillOpt's own `main()` with the rest of the arguments
(evaluating a skill is `skill-trainer run --repeat`, not SkillOpt's). `smoke`
checks that the SkillOpt installed still has everything the adapter relies on
(`skill-trainer update-skillopt` runs it before moving the pin).
"""
from __future__ import annotations

import inspect
import sys

ENV_NAME = "mercury"

USAGE = "usage: python -m mercury_skillopt train|smoke [SkillOpt's arguments]"


def register(module) -> None:
    """Adds the adapter to the registry of SkillOpt's training CLI."""
    from mercury_skillopt.adapter import MercuryAdapter

    module._ENV_REGISTRY[ENV_NAME] = MercuryAdapter


def smoke() -> list[str]:
    """What the installed SkillOpt lacks of what the adapter relies on; empty when nothing."""
    problems: list[str] = []
    try:
        import scripts.train as train
        from skillopt.datasets.base import SplitDataLoader
        from skillopt.envs.base import EnvAdapter
    except ImportError as err:
        return [f"SkillOpt doesn't import: {err}"]
    if not isinstance(getattr(train, "_ENV_REGISTRY", None), dict):
        problems.append("scripts.train has no _ENV_REGISTRY dict")
    if not callable(getattr(train, "main", None)) or inspect.signature(train.main).parameters:
        problems.append("scripts.train has no main() taking no arguments")
    expected = {"build_train_env", "build_eval_env", "rollout", "get_task_types"}
    if set(EnvAdapter.__abstractmethods__) != expected:
        problems.append(f"EnvAdapter's abstract methods are {sorted(EnvAdapter.__abstractmethods__)}, not {sorted(expected)}")
    for method in ("setup", "build_train_batch", "build_eval_batch", "get_split_items"):
        if not callable(getattr(SplitDataLoader, method, None)):
            problems.append(f"SplitDataLoader has no {method}")
    if not problems:
        from mercury_skillopt.adapter import MercuryAdapter

        try:
            MercuryAdapter()
        except TypeError as err:
            problems.append(f"the adapter can't be built: {err}")
    return problems


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in {"train", "smoke"}:
        print(USAGE, file=sys.stderr)
        return 2
    command, rest = argv[0], argv[1:]
    if command == "smoke":
        problems = smoke()
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0
    import scripts.train as cli

    register(cli)
    sys.argv = [f"skillopt-{command}", *rest]
    cli.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
