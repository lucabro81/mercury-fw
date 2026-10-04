/**
 * Finding and loading e2e test files: the app's own `e2e/*.e2e.ts` when no
 * file is named, and a test file's default export checked to be a test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTests, loadTest } from "./load.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mfw-e2e-load-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findTests", () => {
  test("named files, resolved from the current folder, in the order given", () => {
    expect(findTests(["b.e2e.ts", "/abs/a.e2e.ts"], { appDir: dir, cwd: "/here" })).toEqual(["/here/b.e2e.ts", "/abs/a.e2e.ts"]);
  });

  test("none named: the app's e2e/*.e2e.ts, sorted, nothing else", () => {
    mkdirSync(join(dir, "e2e", "results"), { recursive: true });
    for (const f of ["z.e2e.ts", "a.e2e.ts", "helpers.ts", "notes.md"]) writeFileSync(join(dir, "e2e", f), "");
    expect(findTests([], { appDir: dir, cwd: "/here" })).toEqual([join(dir, "e2e", "a.e2e.ts"), join(dir, "e2e", "z.e2e.ts")]);
  });

  test("none named and none in e2e/: an error saying where it looked", () => {
    expect(() => findTests([], { appDir: dir, cwd: dir })).toThrow(`No tests: none named, and no *.e2e.ts in ${join(dir, "e2e")}`);
  });
});

describe("loadTest", () => {
  test("the default export, when it's a test", async () => {
    const file = join(dir, "ok.e2e.ts");
    writeFileSync(file, 'export default { plugins: ["jira"], cases: [{ name: "c", turns: ["q"], check: () => {} }] };\n');
    const loaded = await loadTest(file);
    expect(loaded.plugins).toEqual(["jira"]);
    expect(loaded.cases.map((c) => c.name)).toEqual(["c"]);
  });

  test("a file without a test as its default export: an error naming it", async () => {
    const file = join(dir, "bad.e2e.ts");
    writeFileSync(file, "export const x = 1;\n");
    await expect(loadTest(file)).rejects.toThrow(`${file} doesn't export a test as default (export default e2e({ … }))`);
  });

  // #131 review: repeat: 0 ran nothing and passed.
  test("repeat and minPasses: positive whole numbers, minPasses no more than repeat", async () => {
    const cases: Array<[string, string]> = [
      ["repeat: 0", "repeat takes a positive whole number"],
      ["repeat: 1.5", "repeat takes a positive whole number"],
      ["minPasses: 0", "minPasses takes a positive whole number"],
      ["repeat: 2, minPasses: 3", "minPasses (3) is more than repeat (2)"],
      ["minPasses: 2", "minPasses (2) is more than repeat (1)"],
    ];
    for (const [i, [fields, message]] of cases.entries()) {
      const file = join(dir, `r${i}.e2e.ts`);
      writeFileSync(file, `export default { cases: [{ name: "c", turns: ["q"], ${fields}, check: () => {} }] };\n`);
      await expect(loadTest(file)).rejects.toThrow(`${file}: case 1 ("c") ${message}`);
    }
  });

  test("a case without name, turns or check: an error naming the file and the case", async () => {
    const file = join(dir, "half.e2e.ts");
    writeFileSync(file, 'export default { cases: [{ name: "c", turns: [] , check: () => {} }, { name: "d", check: () => {} }] };\n');
    await expect(loadTest(file)).rejects.toThrow(`${file}: case 1 ("c") has no turns`);
  });

  // #154: a case can send its turns in lanes that run at the same time.
  test("a case in lanes loads; it can't also have turns, and every lane needs turns", async () => {
    const lanes = join(dir, "lanes.e2e.ts");
    writeFileSync(lanes, 'export default { cases: [{ name: "l", channel: "http", lanes: [{ turns: ["a"] }, { turns: ["b"] }], check: () => {} }] };\n');
    expect((await loadTest(lanes)).cases[0]!.lanes).toHaveLength(2);

    const replLanes = join(dir, "repl-lanes.e2e.ts");
    writeFileSync(replLanes, 'export default { cases: [{ name: "r", lanes: [{ turns: ["a"] }], check: () => {} }] };\n');
    await expect(loadTest(replLanes)).rejects.toThrow(`${replLanes}: case 1 ("r") has lanes, which go with channel "http"`);

    const both = join(dir, "both.e2e.ts");
    writeFileSync(both, 'export default { cases: [{ name: "b", channel: "http", turns: ["a"], lanes: [{ turns: ["b"] }], check: () => {} }] };\n');
    await expect(loadTest(both)).rejects.toThrow(`${both}: case 1 ("b") has both turns and lanes`);

    const emptyLane = join(dir, "empty-lane.e2e.ts");
    writeFileSync(emptyLane, 'export default { cases: [{ name: "e", channel: "http", lanes: [{ turns: ["a"] }, { turns: [] }], check: () => {} }] };\n');
    await expect(loadTest(emptyLane)).rejects.toThrow(`${emptyLane}: case 1 ("e") lane 2 has no turns`);

    const noLanes = join(dir, "no-lanes.e2e.ts");
    writeFileSync(noLanes, 'export default { cases: [{ name: "n", channel: "http", lanes: [], check: () => {} }] };\n');
    await expect(loadTest(noLanes)).rejects.toThrow(`${noLanes}: case 1 ("n") has no turns`);
  });
});
