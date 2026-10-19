/**
 * What a run was made under: the code (commit, and whether the tree had
 * changes), the model, the skill and the training data. Two runs compare only
 * when everything but the skill matches, since a difference anywhere else could
 * be what moved the score.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type RunConditions = {
  /** The repo's commit. */
  commit: string;
  /** Whether the tree had no changes: only then is the commit the code that ran. */
  clean: boolean;
  /** `OLLAMA_MODEL`, empty when unset. */
  model: string;
  /** `OLLAMA_HOST`, empty when unset. */
  host: string;
  /** sha256 of the skill body that ran. */
  skill: string;
  /** sha256 of the plugin's training data (its `skill-training/` folder, tests left out). */
  data: string;
};

export type ConditionsDeps = {
  /** Runs git with `args` in the repo and returns its stdout. */
  git: (args: string[]) => Promise<string>;
  env: Record<string, string | undefined>;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every file under `dir`, recursively, as paths relative to it, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** sha256 over the paths and contents of the files under `dir`, tests left out: they don't change a run. */
async function dataHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of (await filesUnder(dir)).filter((p) => !p.endsWith(".test.ts"))) {
    hash.update(`${path}\0`);
    hash.update(await readFile(join(dir, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The conditions of a run of `skillBody` on the training data in `dataDir`. */
export async function collectConditions(skillBody: string, dataDir: string, deps: ConditionsDeps): Promise<RunConditions> {
  const [commit, status, data] = await Promise.all([deps.git(["rev-parse", "HEAD"]), deps.git(["status", "--porcelain"]), dataHash(dataDir)]);
  return {
    commit: commit.trim(),
    clean: status.trim() === "",
    model: deps.env.OLLAMA_MODEL ?? "",
    host: deps.env.OLLAMA_HOST ?? "",
    skill: sha256(skillBody),
    data,
  };
}

/** The conditions in which `a` and `b` differ, the skill aside; a tree with changes always counts as one. */
export function conditionsDiffer(a: RunConditions, b: RunConditions): Array<keyof RunConditions> {
  const differ: Array<keyof RunConditions> = [];
  if (a.commit !== b.commit) differ.push("commit");
  if (!a.clean || !b.clean) differ.push("clean");
  if (a.model !== b.model) differ.push("model");
  if (a.host !== b.host) differ.push("host");
  if (a.data !== b.data) differ.push("data");
  return differ;
}
