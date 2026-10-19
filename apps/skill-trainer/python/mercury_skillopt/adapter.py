"""SkillOpt's environment for a plugin's training tasks.

A rollout is `skill-trainer run <plugin> --skill <candidate> --task <ids>
--skillopt-out <out_dir>`: the tasks run as real Mercury turns, and the
harness writes what SkillOpt reads (the results, and the conversation of each
task for reflection) into the rollout folder. Everything about what a task
is, how it's scored and what the analyst sees lives in the TypeScript
harness; this adapter only runs it and hands its output over.
"""
from __future__ import annotations

import json
import os
import subprocess

from skillopt.datasets.base import SplitDataLoader
from skillopt.envs.base import EnvAdapter


class MercuryAdapter(EnvAdapter):
    """The tasks of `mercury_plugin`, from the split folder `skill-trainer train`
    writes, run by `mercury_command` (the argv that starts skill-trainer)."""

    def __init__(
        self,
        split_dir: str = "",
        split_mode: str = "split_dir",
        mercury_command: list[str] | None = None,
        mercury_plugin: str = "",
        analyst_workers: int = 2,
        failure_only: bool = False,
        minibatch_size: int = 8,
        edit_budget: int = 4,
        seed: int = 42,
        limit: int = 0,
    ) -> None:
        self.mercury_command = list(mercury_command or [])
        self.mercury_plugin = mercury_plugin
        # Read by the inherited reflect.
        self.analyst_workers = analyst_workers
        self.failure_only = failure_only
        self.minibatch_size = minibatch_size
        self.edit_budget = edit_budget
        self.dataloader = SplitDataLoader(split_dir=split_dir, split_mode=split_mode, seed=seed, limit=limit)

    def setup(self, cfg: dict) -> None:
        super().setup(cfg)
        self.dataloader.setup(cfg)

    def get_dataloader(self):
        return self.dataloader

    def build_train_env(self, batch_size: int, seed: int, **kwargs):
        return list(self.dataloader.build_train_batch(batch_size=batch_size, seed=seed).payload or [])

    def build_eval_env(self, env_num: int, split: str, seed: int, **kwargs):
        return list(self.dataloader.build_eval_batch(env_num=env_num, split=split, seed=seed).payload or [])

    def rollout(self, env_manager, skill_content: str, out_dir: str, **kwargs) -> list[dict]:
        """Runs the batch's tasks with `skill_content` through the harness and
        returns its results. A task that couldn't run is a failed result, not an
        error; a harness that wrote no results at all, or a batch where no task
        could run, is."""
        ids = [str(item["id"]) for item in env_manager]
        if not ids:
            return []
        os.makedirs(out_dir, exist_ok=True)
        skill_path = os.path.join(out_dir, "candidate_skill_body.md")
        with open(skill_path, "w", encoding="utf-8") as f:
            f.write(skill_content)
        results_path = os.path.join(out_dir, "results.json")
        if os.path.exists(results_path):
            os.remove(results_path)
        argv = [*self.mercury_command, "run", self.mercury_plugin, "--skill", skill_path, "--skillopt-out", out_dir, "--task", *ids]
        proc = subprocess.run(argv, capture_output=True, text=True)
        if not os.path.isfile(results_path):
            raise RuntimeError(f"skill-trainer exited {proc.returncode} without results: {proc.stderr.strip()[-2000:]}")
        with open(results_path, encoding="utf-8") as f:
            results = json.load(f)
        # One task that couldn't run is a failure like any other; a batch where none could is a model
        # that's down, and training on it would gate every edit on zeros.
        if results and all(r.get("error") for r in results):
            raise RuntimeError(f"no task could run in this batch: {results[0]['error']}")
        return results

    def get_task_types(self) -> list[str]:
        seen: list[str] = []
        for item in self.dataloader.train_items + self.dataloader.val_items + self.dataloader.test_items:
            task_type = str(item.get("task_type") or "task")
            if task_type not in seen:
                seen.append(task_type)
        return seen
