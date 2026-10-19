"""The adapter against a stand-in harness: it runs inside SkillOpt (`uv run`
with SkillOpt pinned, see skillopt.json), so these tests also check that the
SkillOpt it's pinned to still has what the adapter relies on."""
import json
import os
import sys
import tempfile
import unittest

from mercury_skillopt import __main__ as entry
from mercury_skillopt.adapter import MercuryAdapter

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = [sys.executable, os.path.join(HERE, "fake_harness.py")]


def write_splits(root: str) -> str:
    """A split folder as `skill-trainer train` writes it."""
    splits = os.path.join(root, "splits")
    items = {
        "train": [{"id": "a", "task_type": "count", "question": "How many?"}, {"id": "b", "task_type": "list", "question": "Show me."}],
        "val": [{"id": "c", "task_type": "count", "question": "How many now?"}],
        "test": [{"id": "d", "task_type": "move", "question": "Close it."}],
    }
    for split, rows in items.items():
        os.makedirs(os.path.join(splits, split))
        with open(os.path.join(splits, split, "items.json"), "w", encoding="utf-8") as f:
            json.dump(rows, f)
    return splits


class AdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.adapter = MercuryAdapter(split_dir=write_splits(self.root), split_mode="split_dir", mercury_command=FAKE, mercury_plugin="jira")
        self.adapter.setup({"split_dir": self.adapter.dataloader.split_dir, "split_mode": "split_dir"})
        os.environ.pop("FAKE_HARNESS_MODE", None)

    def tearDown(self) -> None:
        self.tmp.cleanup()
        os.environ.pop("FAKE_HARNESS_MODE", None)

    def test_the_splits_and_task_types_come_from_the_split_folder(self) -> None:
        loader = self.adapter.get_dataloader()
        self.assertEqual([i["id"] for i in loader.train_items], ["a", "b"])
        self.assertEqual([i["id"] for i in loader.get_split_items("valid_seen")], ["c"])
        self.assertEqual([i["id"] for i in loader.get_split_items("valid_unseen")], ["d"])
        self.assertEqual(self.adapter.get_task_types(), ["count", "list", "move"])

    def test_eval_envs_are_lists_of_the_splits_items(self) -> None:
        both = self.adapter.build_eval_env(0, "train", 1) + self.adapter.build_eval_env(0, "valid_seen", 1)
        self.assertEqual([i["id"] for i in both], ["a", "b", "c"])

    def test_a_rollout_runs_the_harness_on_the_items_with_the_skill_and_returns_its_results(self) -> None:
        out = os.path.join(self.root, "step", "rollout")
        items = self.adapter.build_eval_env(0, "train", 1)
        results = self.adapter.rollout(items, "a GOOD skill", out)
        self.assertEqual([(r["id"], r["hard"]) for r in results], [("a", 1), ("b", 1)])
        with open(os.path.join(out, "argv.json"), encoding="utf-8") as f:
            argv = json.load(f)
        self.assertEqual(argv[:2], ["run", "jira"])
        self.assertEqual(argv[argv.index("--task") + 1 :], ["a", "b"])
        self.assertEqual(argv[argv.index("--skillopt-out") + 1], out)
        with open(argv[argv.index("--skill") + 1], encoding="utf-8") as f:
            self.assertEqual(f.read(), "a GOOD skill")
        self.assertTrue(os.path.isfile(os.path.join(out, "predictions", "a", "conversation.json")))

    def test_a_task_that_couldnt_run_still_returns_the_results(self) -> None:
        os.environ["FAKE_HARNESS_MODE"] = "task-error"
        results = self.adapter.rollout(self.adapter.build_eval_env(0, "valid_seen", 1), "plain", os.path.join(self.root, "r"))
        self.assertEqual([(r["id"], r["hard"]) for r in results], [("c", 0)])

    def test_a_harness_that_writes_no_results_is_an_error_with_its_stderr(self) -> None:
        os.environ["FAKE_HARNESS_MODE"] = "crash"
        with self.assertRaisesRegex(RuntimeError, r"exited 3.*didn't load"):
            self.adapter.rollout(self.adapter.build_eval_env(0, "valid_seen", 1), "plain", os.path.join(self.root, "r"))

    def test_an_empty_batch_runs_nothing(self) -> None:
        self.assertEqual(self.adapter.rollout([], "plain", os.path.join(self.root, "r")), [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "r", "argv.json")))

    def test_reflection_finds_the_settings_it_reads_on_the_adapter(self) -> None:
        adapter = MercuryAdapter(analyst_workers=2, failure_only=True, minibatch_size=4, edit_budget=3)
        self.assertEqual((adapter.analyst_workers, adapter.failure_only, adapter.minibatch_size, adapter.edit_budget), (2, True, 4, 3))


class EntrypointTest(unittest.TestCase):
    def test_registering_adds_the_adapter_to_skillopts_training_registry_and_it_stays(self) -> None:
        import scripts.train as train

        entry.register(train)
        self.assertIs(train._ENV_REGISTRY[entry.ENV_NAME], MercuryAdapter)
        train._register_builtins()
        self.assertIs(train._ENV_REGISTRY[entry.ENV_NAME], MercuryAdapter)

    def test_the_smoke_check_passes_on_the_pinned_skillopt(self) -> None:
        self.assertEqual(entry.smoke(), [])

    def test_an_unknown_command_is_a_usage_error(self) -> None:
        self.assertEqual(entry.main(["frobnicate"]), 2)
        self.assertEqual(entry.main(["eval"]), 2)
        self.assertEqual(entry.main([]), 2)


if __name__ == "__main__":
    unittest.main()
