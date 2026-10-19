import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectConditions, conditionsDiffer, type ConditionsDeps, type RunConditions } from "./conditions.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-trainer-conditions-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "index.ts"), "export default {};");
  writeFileSync(join(dir, "nested", "tasks.ts"), "export const tasks = [];");
  writeFileSync(join(dir, "index.test.ts"), "test()");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Deps with a clean tree at `abc123` and the model in the env. */
const deps = (over: Partial<ConditionsDeps> = {}): ConditionsDeps => ({
  git: async (args) => (args[0] === "rev-parse" ? "abc123\n" : ""),
  env: { OLLAMA_MODEL: "qwen3.8:27b", OLLAMA_HOST: "http://192.168.90.217:11434" },
  ...over,
});

describe("collectConditions", () => {
  test("the commit, a clean tree, the model and host, the hashes of the skill and the data", async () => {
    const conditions = await collectConditions("the skill body", dir, deps());
    expect(conditions).toEqual({
      commit: "abc123",
      clean: true,
      model: "qwen3.8:27b",
      host: "http://192.168.90.217:11434",
      skill: expect.stringMatching(/^[0-9a-f]{64}$/),
      data: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  // run --json writes its file before the conditions are taken; in a folder git doesn't ignore, that
  // untracked file made every such run "not clean", and compare refused it.
  test("files git doesn't track don't count: only changes to tracked ones do", async () => {
    const asked: string[][] = [];
    await collectConditions("b", dir, deps({ git: async (args) => (asked.push(args), args[0] === "rev-parse" ? "abc123\n" : "") }));
    expect(asked).toContainEqual(["status", "--porcelain", "--untracked-files=no"]);
  });

  test("a tree with changes isn't clean", async () => {
    const conditions = await collectConditions("b", dir, deps({ git: async (args) => (args[0] === "rev-parse" ? "abc123\n" : " M src/x.ts\n") }));
    expect(conditions.clean).toBe(false);
  });

  test("another skill body is another skill hash, the same body the same", async () => {
    const [a, again, b] = await Promise.all([collectConditions("one", dir, deps()), collectConditions("one", dir, deps()), collectConditions("two", dir, deps())]);
    expect(a.skill).toBe(again.skill);
    expect(a.skill).not.toBe(b.skill);
  });

  test("a changed data file changes the data hash, a changed test doesn't", async () => {
    const before = (await collectConditions("b", dir, deps())).data;
    writeFileSync(join(dir, "index.test.ts"), "test(); test();");
    expect((await collectConditions("b", dir, deps())).data).toBe(before);
    writeFileSync(join(dir, "nested", "tasks.ts"), "export const tasks = [1];");
    expect((await collectConditions("b", dir, deps())).data).not.toBe(before);
  });

  // A rename keeps every content but changes what the plugin loads: the hash must see paths, not only contents.
  test("a renamed data file changes the data hash", async () => {
    const before = (await collectConditions("b", dir, deps())).data;
    rmSync(join(dir, "nested", "tasks.ts"));
    writeFileSync(join(dir, "nested", "other.ts"), "export const tasks = [];");
    expect((await collectConditions("b", dir, deps())).data).not.toBe(before);
  });

  test("an unset model or host is recorded as empty, not guessed", async () => {
    const conditions = await collectConditions("b", dir, deps({ env: {} }));
    expect([conditions.model, conditions.host]).toEqual(["", ""]);
  });
});

describe("conditionsDiffer", () => {
  const base: RunConditions = { commit: "c1", clean: true, model: "m", host: "h", skill: "s1", data: "d1" };

  test("two runs that differ only in the skill compare", () => {
    expect(conditionsDiffer(base, { ...base, skill: "s2" })).toEqual([]);
  });

  test("every other difference is named", () => {
    expect(conditionsDiffer(base, { ...base, commit: "c2", model: "m2", data: "d2" })).toEqual(["commit", "model", "data"]);
  });

  // A dirty tree means the code that ran isn't the commit recorded: the two runs can't be shown to match.
  test("a run on a tree with changes never compares", () => {
    expect(conditionsDiffer(base, { ...base, clean: false })).toEqual(["clean"]);
    expect(conditionsDiffer({ ...base, clean: false }, { ...base, clean: false })).toEqual(["clean"]);
  });
});
