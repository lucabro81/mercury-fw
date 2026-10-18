import { describe, expect, test } from "bun:test";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import type { Fixture, RunCli, SkillTraining, TrainingTask } from "./contract.ts";
import { runBatch, selectTasks, type Conversation, type HarnessDeps } from "./harness.ts";

const ok = (data: unknown) => ({ ok: true as const, data });

/** A step with one tool call and its result, and a step with the model's text, as `/dump` has them. */
function callStep(id: string, command: string, output: unknown) {
  return {
    content: [
      { type: "tool-call", toolCallId: id, toolName: "jiraCommand", input: { command } },
      { type: "tool-result", toolCallId: id, output },
    ],
  };
}
const textStep = (text: string) => ({ content: [{ type: "text", text }] });

/** A plugin factory remembering the CLI runner it was built on, so a fake turn can call it like the tool would. */
function trainingWith(tasks: TrainingTask[], fixtures: Fixture[] = []): { training: SkillTraining; cli: () => RunCli } {
  let last: RunCli | undefined;
  const training: SkillTraining = {
    skill: "jira",
    plugin: (runCliFn) => {
      last = runCliFn;
      return {
        apiVersion: PLUGIN_API_VERSION,
        name: "jira",
        actsAs: "person",
        skills: [{ name: "jira", description: "Jira.", body: "own body" }],
        build: () => ({}),
      } as unknown as Plugin;
    },
    fixtures,
    tasks,
  };
  return { training, cli: () => last! };
}

const task = (over: Partial<TrainingTask> = {}): TrainingTask => ({
  id: "t1",
  split: "train",
  taskType: "search",
  turns: ["list my issues"],
  check: (_run, e) => e.answer("done"),
  ...over,
});

/** Deps whose conversation answers every turn with `reply(text, cli)`, recording what it saw. */
function fakeDeps(reply: (text: string, cli: RunCli) => Promise<{ steps: unknown[]; text: string }>, cli: () => RunCli) {
  const seen = { plugins: [] as Plugin[], vaults: [] as string[], removed: [] as string[], closed: 0 };
  let clock = 0;
  let vaults = 0;
  const deps: HarnessDeps = {
    open: async (plugin, vaultPath): Promise<Conversation> => {
      seen.plugins.push(plugin);
      seen.vaults.push(vaultPath);
      return { send: (text) => reply(text, cli()), close: async () => void seen.closed++ };
    },
    makeVault: async () => `/tmp/vault-${++vaults}`,
    removeVault: async (path) => void seen.removed.push(path),
    seedVault: async () => {},
    now: () => (clock += 500),
  };
  return { deps, seen };
}

describe("runBatch", () => {
  test("a task whose checks all pass scores hard 1 and soft 1, with its calls and answer", async () => {
    const { training, cli } = trainingWith([task({ check: (_r, e) => (e.call("jiraCommand"), e.answer("done")) })]);
    const { deps } = fakeDeps(async () => ({ steps: [callStep("1", "jira issue search", { ok: true }), textStep("all done")], text: "all done" }), cli);
    const [result] = await runBatch(training, training.tasks, undefined, deps);
    expect(result).toEqual({
      id: "t1",
      split: "train",
      taskType: "search",
      hard: 1,
      soft: 1,
      checks: [
        { label: "a jiraCommand call", ok: true },
        { label: 'answer contains "done"', ok: true },
      ],
      turns: [
        {
          sent: "list my issues",
          calls: [{ tool: "jiraCommand", input: { command: "jira issue search" }, output: { ok: true }, ok: true, pending: false }],
          answer: "all done",
          seconds: 0.5,
        },
      ],
      unmatched: [],
      seconds: 1.5,
    });
  });

  test("a task passing some of its checks scores hard 0 and the passed fraction as soft", async () => {
    const check: TrainingTask["check"] = (_r, e) => {
      e.answer("done");
      e.answer("KAN-1");
      e.answer("KAN-2");
      e.call("jiraCommand");
    };
    const { training, cli } = trainingWith([task({ check })]);
    const { deps } = fakeDeps(async () => ({ steps: [textStep("done: KAN-1")], text: "done: KAN-1" }), cli);
    const [result] = await runBatch(training, training.tasks, undefined, deps);
    expect(result?.hard).toBe(0);
    expect(result?.soft).toBe(0.5);
  });

  test("a task that checks nothing fails: it proves nothing", async () => {
    const { training, cli } = trainingWith([task({ check: () => {} })]);
    const { deps } = fakeDeps(async () => ({ steps: [textStep("x")], text: "x" }), cli);
    const [result] = await runBatch(training, training.tasks, undefined, deps);
    expect(result).toMatchObject({ hard: 0, soft: 0, checks: [{ label: "the task made no checks", ok: false }] });
  });

  test("a check that throws keeps the checks made before and fails", async () => {
    const check: TrainingTask["check"] = (_r, e) => {
      e.answer("x");
      throw new Error("boom");
    };
    const { training, cli } = trainingWith([task({ check })]);
    const { deps } = fakeDeps(async () => ({ steps: [textStep("x")], text: "x" }), cli);
    const [result] = await runBatch(training, training.tasks, undefined, deps);
    expect(result?.checks).toEqual([
      { label: 'answer contains "x"', ok: true },
      { label: "check threw: boom", ok: false },
    ]);
    expect(result).toMatchObject({ hard: 0, soft: 0.5 });
  });

  test("a turn that fails scores 0 with the error, keeps the turns before it, and still cleans up", async () => {
    const { training, cli } = trainingWith([task({ turns: ["first", "second"] })]);
    let n = 0;
    const { deps, seen } = fakeDeps(async () => {
      if (++n === 2) throw new Error("model unreachable");
      return { steps: [textStep("one")], text: "one" };
    }, cli);
    const [result] = await runBatch(training, training.tasks, undefined, deps);
    expect(result).toMatchObject({
      hard: 0,
      soft: 0,
      error: "model unreachable",
      checks: [{ label: "run failed: model unreachable", ok: false }],
    });
    expect(result?.turns.map((t) => t.sent)).toEqual(["first"]);
    expect(seen.closed).toBe(1);
    expect(seen.removed).toEqual(["/tmp/vault-1"]);
  });

  // The real case: the plugin's build() throwing (JIRA_SITE_URL unset) surfaces
  // when the conversation opens, and it must fail that task, not the batch.
  test("a failure opening the conversation is the task's, not the batch's", async () => {
    const { training, cli } = trainingWith([task({ id: "a" }), task({ id: "b" })]);
    const { deps, seen } = fakeDeps(async () => ({ steps: [textStep("done")], text: "done" }), cli);
    const open = deps.open;
    let first = true;
    deps.open = async (plugin, vault) => {
      if (first) {
        first = false;
        throw new Error("the jira plugin didn't load: JIRA_SITE_URL is not set");
      }
      return open(plugin, vault);
    };
    const results = await runBatch(training, training.tasks, undefined, deps);
    expect(results.map((r) => [r.id, r.hard, r.error])).toEqual([
      ["a", 0, "the jira plugin didn't load: JIRA_SITE_URL is not set"],
      ["b", 1, undefined],
    ]);
    expect(seen.removed).toEqual(["/tmp/vault-1", "/tmp/vault-2"]);
  });

  test("a turn given as a function gets the turn before it", async () => {
    const { training, cli } = trainingWith([task({ turns: ["first", (prev) => `follow-up to: ${prev.answer}`] })]);
    const sent: string[] = [];
    const { deps } = fakeDeps(async (text) => {
      sent.push(text);
      return { steps: [textStep(`answer ${sent.length}`)], text: "" };
    }, cli);
    await runBatch(training, training.tasks, undefined, deps);
    expect(sent).toEqual(["first", "follow-up to: answer 1"]);
  });

  test("the answer is the model's text in the steps; a turn without calls or text falls back to the reply", async () => {
    const { training, cli } = trainingWith([task({ turns: ["a", "b"], check: (_r, e) => e.answer("x") })]);
    let n = 0;
    const { deps } = fakeDeps(async () => (++n === 1 ? { steps: [textStep("from steps")], text: "from steps + list" } : { steps: [], text: "only reply" }), cli);
    const [result] = await runBatch(training, training.tasks, undefined, deps);
    expect(result?.turns.map((t) => t.answer)).toEqual(["from steps", "only reply"]);
  });

  test("the CLI answers from the task's fixtures first, then the plugin's, and records what neither answers", async () => {
    const own: Fixture = { command: ["issue", "search"], result: ok("task fixture") };
    const shared: Fixture[] = [
      { command: ["issue", "search"], result: ok("plugin fixture") },
      { command: ["user", "search"], result: ok("user") },
    ];
    const { training, cli } = trainingWith([task({ id: "a", fixtures: [own] }), task({ id: "b" })], shared);
    const outputs: unknown[] = [];
    const { deps } = fakeDeps(async (_text, run) => {
      outputs.push(await run("jira", ["issue", "search"]));
      outputs.push(await run("jira", ["user", "search"]));
      await run("jira", ["sprint", "list"]);
      return { steps: [textStep("done")], text: "done" };
    }, cli);
    const results = await runBatch(training, training.tasks, undefined, deps);
    expect(outputs).toEqual([ok("task fixture"), ok("user"), ok("plugin fixture"), ok("user")]);
    expect(results.map((r) => r.unmatched)).toEqual([[["sprint", "list"]], [["sprint", "list"]]]);
  });

  // Fixtures given as functions hold state (a transition moves an issue): each
  // task must start from a fresh one, or one task's writes reach the next.
  test("fixtures given as functions are made anew for every task", async () => {
    let made = 0;
    const counter = (): Fixture[] => {
      const n = ++made;
      return [{ command: ["whoami"], result: ok(n) }];
    };
    const { training, cli } = trainingWith([task({ id: "a", fixtures: counter }), task({ id: "b", fixtures: counter })]);
    training.fixtures = () => [{ command: ["shared"], result: ok("shared") }];
    const outputs: unknown[] = [];
    const { deps } = fakeDeps(async (_text, run) => {
      outputs.push(await run("jira", ["whoami"]), await run("jira", ["shared"]));
      return { steps: [textStep("done")], text: "done" };
    }, cli);
    await runBatch(training, training.tasks, undefined, deps);
    expect(outputs).toEqual([ok(1), ok("shared"), ok(2), ok("shared")]);
  });

  test("each task gets its own vault, its own plugin and the candidate skill", async () => {
    const { training, cli } = trainingWith([task({ id: "a" }), task({ id: "b" })]);
    const { deps, seen } = fakeDeps(async () => ({ steps: [textStep("done")], text: "done" }), cli);
    await runBatch(training, training.tasks, "candidate body", deps);
    expect(seen.vaults).toEqual(["/tmp/vault-1", "/tmp/vault-2"]);
    expect(seen.removed).toEqual(["/tmp/vault-1", "/tmp/vault-2"]);
    expect(seen.plugins[0]).not.toBe(seen.plugins[1]);
    expect(seen.plugins.map((p) => p.skills?.[0]?.body)).toEqual(["candidate body", "candidate body"]);
    expect(seen.closed).toBe(2);
  });

  test("hands over the results so far after every task", async () => {
    const { training, cli } = trainingWith([task({ id: "a" }), task({ id: "b" })]);
    const { deps } = fakeDeps(async () => ({ steps: [textStep("done")], text: "done" }), cli);
    const seen: string[][] = [];
    await runBatch(training, training.tasks, undefined, deps, async (so_far) => void seen.push(so_far.map((r) => r.id)));
    expect(seen).toEqual([["a"], ["a", "b"]]);
  });

  test("a task's vault notes are written into its vault before the conversation opens", async () => {
    const { training, cli } = trainingWith([task({ id: "a", vault: { "curated/projects.md": "The shop is WEB." } }), task({ id: "b" })]);
    const { deps, seen } = fakeDeps(async () => ({ steps: [textStep("done")], text: "done" }), cli);
    const seeded: Array<[string, Record<string, string>]> = [];
    deps.seedVault = async (vault, files) => {
      seeded.push([vault, files]);
      expect(seen.vaults).not.toContain(vault);
    };
    await runBatch(training, training.tasks, undefined, deps);
    expect(seeded).toEqual([["/tmp/vault-1", { "curated/projects.md": "The shop is WEB." }]]);
  });

  test("without a candidate the plugin keeps its own skill", async () => {
    const { training, cli } = trainingWith([task()]);
    const { deps, seen } = fakeDeps(async () => ({ steps: [textStep("done")], text: "done" }), cli);
    await runBatch(training, training.tasks, undefined, deps);
    expect(seen.plugins[0]?.skills?.[0]?.body).toBe("own body");
  });

  test("a candidate for a skill the plugin lacks fails the batch before any turn", async () => {
    const { training, cli } = trainingWith([task()]);
    training.skill = "bitbucket";
    const { deps, seen } = fakeDeps(async () => ({ steps: [], text: "" }), cli);
    await expect(runBatch(training, training.tasks, "x", deps)).rejects.toThrow('no "bitbucket" skill');
    expect(seen.vaults).toEqual([]);
  });
});

describe("selectTasks", () => {
  const tasks = [task({ id: "a", split: "train" }), task({ id: "b", split: "val" }), task({ id: "c", split: "test" }), task({ id: "d", split: "val" })];

  test("every task by default, in order", () => {
    expect(selectTasks(tasks, {}).map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("the tasks of a split", () => {
    expect(selectTasks(tasks, { split: "val" }).map((t) => t.id)).toEqual(["b", "d"]);
  });

  test("the tasks named, in the order named", () => {
    expect(selectTasks(tasks, { ids: ["d", "a"] }).map((t) => t.id)).toEqual(["d", "a"]);
  });

  test("ids within a split must belong to it", () => {
    expect(() => selectTasks(tasks, { split: "val", ids: ["a"] })).toThrow('no task "a" in the val split');
  });

  test("an unknown id is an error naming it", () => {
    expect(() => selectTasks(tasks, { ids: ["zz"] })).toThrow('no task "zz"');
  });

  test("two tasks with one id are an error: results are keyed by id", () => {
    expect(() => selectTasks([task({ id: "a" }), task({ id: "a" })], {})).toThrow('two tasks have the id "a"');
  });

  test("a task id named twice is an error: results are keyed by id", () => {
    expect(() => selectTasks(tasks, { ids: ["a", "a"] })).toThrow('the task "a" is named twice');
  });

  test("a task without turns is an error naming it", () => {
    expect(() => selectTasks([task({ id: "empty", turns: [] })], {})).toThrow('the task "empty" has no turns');
  });

  test("a task whose first turn is a function is an error: there's no turn before it", () => {
    expect(() => selectTasks([task({ id: "f", turns: [(prev) => prev.answer] })], {})).toThrow(
      'the task "f" starts with a function turn, which needs a turn before it',
    );
  });

  test("a vault note outside the vault is an error naming it", () => {
    expect(() => selectTasks([task({ id: "v", vault: { "../escape.md": "x" } })], {})).toThrow('the task "v" has a vault note outside the vault: ../escape.md');
    expect(() => selectTasks([task({ id: "w", vault: { "/etc/x.md": "x" } })], {})).toThrow("outside the vault: /etc/x.md");
  });

  test("an id that isn't safe as a file name is an error", () => {
    expect(() => selectTasks([task({ id: "../x" })], {})).toThrow('the task id "../x" isn\'t safe as a file name');
  });
});
