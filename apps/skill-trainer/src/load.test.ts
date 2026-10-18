import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTraining, trainingPath } from "./load.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-trainer-load-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Writes a plugin's skill-training/index.ts under `root` with `source` as its body. */
function writeTraining(plugin: string, source: string): void {
  const dir = join(root, "packages", "tools", `plugin-${plugin}`, "skill-training");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

describe("trainingPath", () => {
  test("is the plugin's skill-training/index.ts in the repo", () => {
    expect(trainingPath("jira", "/repo")).toBe("/repo/packages/tools/plugin-jira/skill-training/index.ts");
  });

  test("refuses a name that isn't a plugin's", () => {
    expect(() => trainingPath("../core", "/repo")).toThrow('"../core" isn\'t a plugin name');
  });
});

describe("loadTraining", () => {
  test("loads the default export", async () => {
    writeTraining("demo", `export default { skill: "demo", plugin: () => ({}), fixtures: [], tasks: [{ id: "a" }] };`);
    const training = await loadTraining("demo", root);
    expect(training.skill).toBe("demo");
    expect(training.tasks).toHaveLength(1);
  });

  test("a plugin without training data says where it looked", async () => {
    await expect(loadTraining("nothing", root)).rejects.toThrow(
      `the nothing plugin has no training data: no ${join(root, "packages/tools/plugin-nothing/skill-training/index.ts")}`,
    );
  });

  test("a default export of the wrong shape is an error saying what's missing", async () => {
    writeTraining("bad", `export default { skill: "bad", fixtures: [] };`);
    await expect(loadTraining("bad", root)).rejects.toThrow(
      "the bad plugin's skill-training/index.ts doesn't export a training: it needs skill, plugin, fixtures and tasks",
    );
  });

  test("a module without a default export is the same error", async () => {
    writeTraining("none", `export const x = 1;`);
    await expect(loadTraining("none", root)).rejects.toThrow("doesn't export a training");
  });
});
