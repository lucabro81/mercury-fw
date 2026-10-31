/**
 * What a run was made under: the code (commit, and whether the tree had
 * changes), the model, the skill and the training data. Two runs compare only
 * when everything but the skill matches, since a difference anywhere else could
 * be what moved the score.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { MercuryModel } from "@mercury-fw/core";
import { modelSettingsFromEnv } from "./model-settings.ts";

export type RunConditions = {
  /** The repo's commit. */
  commit: string;
  /** Whether the tracked files had no changes: only then is the commit the code that ran. Files git
   * doesn't track don't count (a run's own --json file, a candidate skill): the skill and the training
   * data have hashes of their own. */
  clean: boolean;
  /** `OLLAMA_MODEL`, empty when unset. */
  model: string;
  /** `OLLAMA_HOST`, empty when unset. */
  host: string;
  /** The model's settings (think, temperature, top_p, top_k) from the env, only those set. Missing in a run recorded before they were. */
  settings?: MercuryModel;
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
  const [commit, status, data] = await Promise.all([deps.git(["rev-parse", "HEAD"]), deps.git(["status", "--porcelain", "--untracked-files=no"]), dataHash(dataDir)]);
  return {
    commit: commit.trim(),
    clean: status.trim() === "",
    model: deps.env.OLLAMA_MODEL ?? "",
    host: deps.env.OLLAMA_HOST ?? "",
    settings: modelSettingsFromEnv(deps.env),
    skill: sha256(skillBody),
    data,
  };
}

/** Whether two runs' settings are known and the same, whatever order their entries were written in. */
function sameSettings(a: MercuryModel | undefined, b: MercuryModel | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const keys: Array<keyof MercuryModel> = ["think", "temperature", "topP", "topK"];
  return keys.every((key) => a[key] === b[key]);
}

/** The conditions in which `a` and `b` differ, the skill aside; a tree with changes, or settings a run didn't record, always count as one. */
export function conditionsDiffer(a: RunConditions, b: RunConditions): Array<keyof RunConditions> {
  const differ: Array<keyof RunConditions> = [];
  if (a.commit !== b.commit) differ.push("commit");
  if (!a.clean || !b.clean) differ.push("clean");
  if (a.model !== b.model) differ.push("model");
  if (a.host !== b.host) differ.push("host");
  if (!sameSettings(a.settings, b.settings)) differ.push("settings");
  if (a.data !== b.data) differ.push("data");
  return differ;
}
