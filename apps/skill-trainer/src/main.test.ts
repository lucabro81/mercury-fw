import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import type { SkillTraining, TrainingTask } from "./contract.ts";
import type { HarnessDeps } from "./harness.ts";
import { runCommand, type CommandDeps } from "./main.ts";

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

/** Deps answering every turn "done", calling `onOpen` first; the JSON file's content is read through `json()`. */
function deps(onOpen: () => void = () => {}, { failOpen = false } = {}): { deps: CommandDeps; printed: string[] } {
  const printed: string[] = [];
  const harness: HarnessDeps = {
    open: async () => {
      onOpen();
      if (failOpen) throw new Error("model unreachable");
      return { send: async () => ({ steps: [{ content: [{ type: "text", text: "done" }] }], text: "done" }), close: async () => {} };
    },
    makeVault: async () => join(dir, "vault"),
    removeVault: async () => {},
    now: () => 0,
  };
  return { deps: { loadTraining: async () => training, harness, print: (l) => void printed.push(l) }, printed };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Array<{ id: string; hard: number }>;

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
    writeFileSync(path, JSON.stringify([{ id: "stale", hard: 1 }]));
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
    writeFileSync(path, JSON.stringify([{ id: "stale", hard: 1 }]));
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
});
