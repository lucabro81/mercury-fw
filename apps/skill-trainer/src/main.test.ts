import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import type { RunConditions } from "./conditions.ts";
import type { SkillTraining, TrainingTask } from "./contract.ts";
import type { HarnessDeps } from "./harness.ts";
import { compareCommand, runCommand, seedVaultFiles, type CommandDeps, type RunFile } from "./main.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-trainer-main-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const task = (id: string, answerNeeded: string): TrainingTask => ({
  id,
  split: "train",
  taskType: "t",
  turns: ["go"],
  check: (_r, e) => e.answer(answerNeeded),
});

const training: SkillTraining = {
  skill: "jira",
  plugin: () => ({ apiVersion: PLUGIN_API_VERSION, name: "jira", skills: [{ name: "jira", description: "d", body: "b" }] }) as unknown as Plugin,
  fixtures: [],
  tasks: [task("a", "done"), task("b", "something else")],
};

const CONDITIONS: RunConditions = { commit: "abc123", clean: true, model: "m", host: "h", skill: "s", data: "d" };

/** Deps answering every turn "done", calling `onOpen` first; the skill bodies the conditions were taken for land in `bodies`. */
function deps(onOpen: () => void = () => {}, { failOpen = false } = {}): { deps: CommandDeps; printed: string[]; bodies: Array<[string, string]> } {
  const printed: string[] = [];
  const bodies: Array<[string, string]> = [];
  const harness: HarnessDeps = {
    open: async () => {
      onOpen();
      if (failOpen) throw new Error("model unreachable");
      return { send: async () => ({ steps: [{ content: [{ type: "text", text: "done" }] }], text: "done" }), close: async () => {} };
    },
    makeVault: async () => join(dir, "vault"),
    removeVault: async () => {},
    seedVault: async () => {},
    now: () => 0,
  };
  const conditions = async (body: string, plugin: string) => {
    bodies.push([body, plugin]);
    return CONDITIONS;
  };
  return { deps: { loadTraining: async () => training, harness, conditions, print: (l) => void printed.push(l) }, printed, bodies };
}

type Written = { conditions: RunConditions | null; results: Array<{ id: string; hard: number; repeat: number }> };
const readFile = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Written;
const readJson = (path: string) => readFile(path).results;

describe("seedVaultFiles", () => {
  test("writes each note at its path in the vault, folders made as needed", async () => {
    await seedVaultFiles(dir, { "curated/jira-projects.md": "the shop: WEB", "curated/deep/note.md": "x" });
    expect(readFileSync(join(dir, "curated/jira-projects.md"), "utf8")).toBe("the shop: WEB");
    expect(readFileSync(join(dir, "curated/deep/note.md"), "utf8")).toBe("x");
  });
});

describe("runCommand", () => {
  test("prints the report and exits 0 when every task ran, failing checks included", async () => {
    const { deps: d, printed } = deps();
    expect(await runCommand({ plugin: "jira" }, d)).toBe(0);
    expect(printed.at(-1)).toBe("hard 1/2 tasks, soft 0.50");
  });

  test("exits 1 when a task couldn't run", async () => {
    const { deps: d } = deps(() => {}, { failOpen: true });
    expect(await runCommand({ plugin: "jira", ids: ["a"] }, d)).toBe(1);
  });

  test("writes the results to the JSON file", async () => {
    const path = join(dir, "results.json");
    await runCommand({ plugin: "jira", json: path }, deps().deps);
    expect(readJson(path).map((r) => [r.id, r.hard])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  test("empties the JSON file before any task runs, and fills it as each task ends", async () => {
    const path = join(dir, "results.json");
    writeFileSync(path, JSON.stringify({ conditions: null, results: [{ id: "stale", hard: 1 }] }));
    const seen: string[][] = [];
    await runCommand({ plugin: "jira", json: path }, deps(() => void seen.push(readJson(path).map((r) => r.id))).deps);
    expect(seen).toEqual([[], ["a"]]);
  });

  test("a JSON file it can't write stops the run before any task", async () => {
    let opened = false;
    const path = join(dir, "missing", "results.json");
    await expect(runCommand({ plugin: "jira", json: path }, deps(() => void (opened = true)).deps)).rejects.toThrow();
    expect(opened).toBe(false);
  });

  test("a run that fails to start leaves no stale results in the JSON file", async () => {
    const path = join(dir, "results.json");
    writeFileSync(path, JSON.stringify({ conditions: null, results: [{ id: "stale", hard: 1 }] }));
    const { deps: d } = deps();
    d.loadTraining = async () => {
      throw new Error("the jira plugin has no training data");
    };
    await expect(runCommand({ plugin: "jira", json: path }, d)).rejects.toThrow("no training data");
    expect(existsSync(path) ? readJson(path) : []).toEqual([]);
  });

  test("reads a candidate skill from its file", async () => {
    const skill = join(dir, "candidate.md");
    writeFileSync(skill, "candidate body");
    let body: string | undefined;
    const { deps: d } = deps();
    const open = d.harness.open;
    d.harness.open = async (plugin, vault) => {
      body = plugin.skills?.[0]?.body;
      return open(plugin, vault);
    };
    await runCommand({ plugin: "jira", skill, ids: ["a"] }, d);
    expect(body).toBe("candidate body");
  });

  test("the JSON file holds the run's conditions, taken for the skill body that runs", async () => {
    const path = join(dir, "results.json");
    const own = deps();
    await runCommand({ plugin: "jira", json: path }, own.deps);
    expect(readFile(path).conditions).toEqual(CONDITIONS);
    expect(own.bodies).toEqual([["b", "jira"]]);
    const skill = join(dir, "candidate.md");
    writeFileSync(skill, "---\nname: jira\ndescription: d\n---\ncandidate body");
    const candidate = deps();
    await runCommand({ plugin: "jira", skill, json: path }, candidate.deps);
    expect(candidate.bodies).toEqual([["candidate body", "jira"]]);
  });

  test("the conditions are taken before any task runs", async () => {
    const order: string[] = [];
    const { deps: d } = deps(() => void order.push("task"));
    const conditions = d.conditions;
    d.conditions = async (body, plugin) => {
      order.push("conditions");
      return conditions(body, plugin);
    };
    await runCommand({ plugin: "jira", ids: ["a"] }, d);
    expect(order).toEqual(["conditions", "task"]);
  });

  test("--repeat runs every task that many times, each result with its repeat, the file filled as they end", async () => {
    const path = join(dir, "results.json");
    const seen: number[] = [];
    await runCommand({ plugin: "jira", json: path, repeat: 3 }, deps(() => void seen.push(readJson(path).length)).deps);
    expect(readJson(path).map((r) => [r.id, r.repeat, r.hard])).toEqual([
      ["a", 1, 1],
      ["b", 1, 0],
      ["a", 2, 1],
      ["b", 2, 0],
      ["a", 3, 1],
      ["b", 3, 0],
    ]);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("without --repeat every result is repeat 1", async () => {
    const path = join(dir, "results.json");
    await runCommand({ plugin: "jira", json: path }, deps().deps);
    expect(readJson(path).map((r) => r.repeat)).toEqual([1, 1]);
  });
});

describe("runCommand --skillopt-out", () => {
  test("writes what SkillOpt reads of the run into the folder: a conversation per task, and the results", async () => {
    const out = join(dir, "rollout");
    await runCommand({ plugin: "jira", skilloptOut: out }, deps().deps);
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Array<{ id: string; hard: number }>;
    expect(results.map((r) => [r.id, r.hard])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
    expect(existsSync(join(out, "predictions", "a", "conversation.json"))).toBe(true);
    expect(existsSync(join(out, "predictions", "b", "conversation.json"))).toBe(true);
  });
});

describe("compareCommand", () => {
  /** A run file of two tasks, `pass` saying which passed. */
  const file = (name: string, skill: string, pass: [boolean, boolean]) => {
    const path = join(dir, name);
    const results = (["count-1", "count-2"] as const).map((id, i) => ({ id, split: "test" as const, taskType: "count", hard: pass[i] ? (1 as const) : (0 as const), soft: 0, checks: [], turns: [], unmatched: [], seconds: 1, repeat: 1 }));
    writeFileSync(path, JSON.stringify({ conditions: { ...CONDITIONS, skill }, results } satisfies RunFile));
    return path;
  };

  test("prints the comparison of the two files and exits 0, whatever the verdict", async () => {
    const { deps: d, printed } = deps();
    expect(await compareCommand({ baseline: file("b.json", "s1", [true, false]), candidate: file("c.json", "s2", [true, true]) }, d)).toBe(0);
    expect(printed[0]).toBe("2 tasks in common, 1 repeats each (baseline), 1 (candidate)");
    expect(printed[1]).toStartWith("not distinguishable: +50.0 points");
  });

  test("a file that isn't a run's results is refused, naming it", async () => {
    const path = join(dir, "notes.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    await expect(compareCommand({ baseline: path, candidate: file("c.json", "s2", [true, true]) }, deps().deps)).rejects.toThrow(`${path} isn't the results of a skill-trainer run`);
  });
});
