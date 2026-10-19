"""A whole SkillOpt training through the adapter, offline: the stand-in harness
passes a task when the skill says "GOOD", and a stand-in model (an
OpenAI-compatible server) always proposes adding it. A training that works end
to end applies the edit, sees val go up, keeps it as the best skill. It also
proves skillopt-defaults.yaml holds every setting SkillOpt's trainer needs."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import yaml

from test_adapter import FAKE, write_splits

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS = os.path.join(HERE, "..", "..", "skillopt-defaults.yaml")

EDIT = {"op": "append", "content": "Always say GOOD."}
ANSWER = {"batch_size": 1, "failure_summary": [], "patch": {"reasoning": "the tasks want GOOD", "edits": [EDIT]}, "edits": [EDIT], "reasoning": "merged"}


class StubModel(BaseHTTPRequestHandler):
    """Every chat completion answers ANSWER, as an Ollama or a hosted API would wrap it."""

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        body = json.dumps({
            "id": "stub",
            "object": "chat.completion",
            "created": 0,
            "model": "stub",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(ANSWER)}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


class TrainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.server = HTTPServer(("127.0.0.1", 0), StubModel)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_a_training_keeps_the_edit_that_makes_the_tasks_pass(self) -> None:
        root = self.tmp.name
        skill_init = os.path.join(root, "skill_init.md")
        with open(skill_init, "w", encoding="utf-8") as f:
            f.write("# The skill\n\nAnswer the request.\n")
        with open(DEFAULTS, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        out_root = os.path.join(root, "skillopt")
        cfg["env"] = {"name": "mercury", "skill_init": skill_init, "split_mode": "split_dir", "split_dir": write_splits(root), "out_root": out_root, "mercury_command": FAKE, "mercury_plugin": "jira"}
        cfg["train"].update({"num_epochs": 1, "batch_size": 2})
        base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        cfg["model"].update({"optimizer": "stub", "target": "stub", "openai_compatible_base_url": base_url, "openai_compatible_api_key": "none", "openai_compatible_model": "stub", "openai_compatible_timeout_seconds": 30})
        config = os.path.join(root, "config.yaml")
        with open(config, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg, f)

        proc = subprocess.run([sys.executable, "-m", "mercury_skillopt", "train", "--config", config], cwd=root, capture_output=True, text=True, timeout=300)

        self.assertEqual(proc.returncode, 0, proc.stdout[-3000:] + proc.stderr[-3000:])
        with open(os.path.join(out_root, "best_skill.md"), encoding="utf-8") as f:
            self.assertIn("Always say GOOD.", f.read())


if __name__ == "__main__":
    unittest.main()
