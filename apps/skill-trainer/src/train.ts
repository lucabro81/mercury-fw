/**
 * `skill-trainer train`: SkillOpt trains a plugin's skill on its training
 * tasks. Everything SkillOpt needs goes into a fresh output folder (the tasks
 * as its split items, the skill's body without its frontmatter, which SkillOpt
 * knows nothing of, and its config); SkillOpt runs on it through the adapter,
 * each rollout a `skill-trainer run`; its best skill comes back as a whole
 * `SKILL.md`, SkillOpt's own blocks taken out and the plugin's name and
 * description put back. Nothing is written into the plugin: adopting a
 * trained skill is a change made by hand, after `compare` on the test split.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "@mercury-fw/plugin-types";
import type { SkillTraining } from "./contract.ts";
import { selectTasks } from "./harness.ts";
import { withSkill } from "./skill-override.ts";
import { readPin, skilloptArgv } from "./skillopt.ts";
import { skillOptItems } from "./skillopt-out.ts";

/** What `train` was asked for. */
export type TrainOptions = { plugin: string; config?: string; out?: string };

export type TrainDeps = {
  loadTraining: (plugin: string) => Promise<SkillTraining>;
  env: Record<string, string | undefined>;
  /** Runs `argv` (uv running SkillOpt) with `secrets` added to its environment, and returns its exit code. */
  runSkillOpt: (argv: string[], secrets: Record<string, string>) => Promise<number>;
  print: (line: string) => void;
  now?: () => Date;
  /** Where an output folder goes when none is given. */
  resultsDir?: string;
};

/** The settings `train` starts from. */
const DEFAULTS_PATH = join(import.meta.dir, "..", "skillopt-defaults.yaml");
const RESULTS_DIR = join(import.meta.dir, "..", "results");

type Config = Record<string, unknown> & { env?: unknown; model?: Record<string, unknown> };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `over` merged into `base`, section by section: a value in `over` wins. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = isObject(value) && isObject(out[key]) ? merge(out[key] as Record<string, unknown>, value) : value;
  return out;
}

/** `text` without SkillOpt's slow-update and appendix blocks, trimmed. */
export function stripSkillOptMarkers(text: string): string {
  return text
    .replace(/\n*<!-- SLOW_UPDATE_START -->[\s\S]*?<!-- SLOW_UPDATE_END -->\n*/g, "\n\n")
    .replace(/\n*<!-- APPENDIX_START -->[\s\S]*?<!-- APPENDIX_END -->\n*/g, "\n\n")
    .trim();
}

/** A whole `SKILL.md`: `skill`'s name and description over `body`. */
export function skillFile(skill: Pick<Skill, "name" | "description">, body: string): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${body}\n`;
}

/**
 * SkillOpt's config: the defaults, then the model the skill runs on (Ollama's
 * OpenAI-compatible endpoint, for the optimizer and the target, which SkillOpt
 * never calls here: the rollouts are the harness's), then the run's own config,
 * then the env section, which is the trainer's alone. Throws when no model is
 * set either way.
 */
export function trainConfig(defaults: Config, user: Config, env: Record<string, unknown>, vars: Record<string, string | undefined>): Config {
  const host = vars.OLLAMA_HOST?.replace(/\/+$/, "");
  const model = vars.OLLAMA_MODEL;
  const ollama = host === undefined || host === "" ? undefined : `${host}/v1`;
  const fromOllama: Record<string, unknown> = {};
  if (ollama !== undefined) fromOllama.openai_compatible_base_url = ollama;
  if (model !== undefined && model !== "") Object.assign(fromOllama, { optimizer: model, target: model, openai_compatible_model: model });
  const cfg = merge(merge(defaults, { model: fromOllama }), user) as Config;
  const chosen = cfg.model ?? {};
  // Ollama asks for no key but the client sends one: a placeholder, only to Ollama.
  if (chosen.openai_compatible_base_url === ollama && chosen.openai_compatible_api_key === undefined) chosen.openai_compatible_api_key = "ollama";
  if (!chosen.openai_compatible_base_url) throw new Error("no model endpoint: set OLLAMA_HOST, or model.openai_compatible_base_url in --config");
  if (!chosen.optimizer || !chosen.openai_compatible_model) throw new Error("no model: set OLLAMA_MODEL, or model.optimizer and model.openai_compatible_model in --config");
  return { ...cfg, env };
}

/** `cfg` without its API keys, and the keys as the environment variables SkillOpt reads them from
 * (`model.optimizer_openai_compatible_api_key` is `OPTIMIZER_OPENAI_COMPATIBLE_API_KEY`): a key never
 * lands in the config file the output folder keeps. */
export function splitKeys(cfg: Config): { config: Config; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const model: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg.model ?? {})) {
    if (/(^|_)openai_compatible_api_key$/.test(key)) secrets[key.toUpperCase()] = String(value);
    else model[key] = value;
  }
  return { config: { ...cfg, model }, secrets };
}

/** `date` as `YYYYMMDD-HHMMSS`, UTC. */
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** The real dependencies; `home` is the user's real home folder. */
export const realTrainDeps = (loadTraining: TrainDeps["loadTraining"], home: string | undefined): TrainDeps => ({
  loadTraining,
  env: process.env,
  // The real home, not the run's throwaway one: uv keeps its cache and its Pythons there.
  runSkillOpt: (argv, secrets) => Bun.spawn(argv, { stdout: "inherit", stderr: "inherit", env: { ...process.env, HOME: home, ...secrets } }).exited,
  print: console.log,
});

/** `skill-trainer train`; returns SkillOpt's exit code. */
export async function trainCommand(opts: TrainOptions, deps: TrainDeps): Promise<number> {
  const out = opts.out ?? join(deps.resultsDir ?? RESULTS_DIR, `train-${opts.plugin}-${stamp((deps.now ?? (() => new Date()))())}`);
  if (existsSync(out) && (await readdir(out)).length > 0) throw new Error(`${out} isn't empty: SkillOpt would resume from what's there, so give train a new folder`);

  // Everything that can fail on the input comes before the first write: a run that stops there leaves
  // no folder behind, which the next try with the same --out would refuse as not empty.
  const training = await deps.loadTraining(opts.plugin);
  const tasks = selectTasks(training.tasks, {});
  const plugin = withSkill(training.plugin(async () => ({ ok: false, exitCode: 1, error: "no CLI" })), training.skill, undefined);
  const skill = plugin.skills!.find((s) => s.name === training.skill)!;
  const skillInit = join(out, "skill_init.md");
  const splits = join(out, "splits");
  const skilloptOut = join(out, "skillopt");
  const env = {
    name: "mercury",
    skill_init: skillInit,
    split_mode: "split_dir",
    split_dir: splits,
    out_root: skilloptOut,
    mercury_command: [process.execPath, join(import.meta.dir, "bin.ts")],
    mercury_plugin: opts.plugin,
  };
  const defaults = Bun.YAML.parse(await Bun.file(DEFAULTS_PATH).text()) as Config;
  const user = opts.config === undefined ? {} : ((Bun.YAML.parse(await Bun.file(opts.config).text()) ?? {}) as Config);
  const { config: written, secrets } = splitKeys(trainConfig(defaults, user, env, deps.env));

  await mkdir(out, { recursive: true });
  await writeFile(skillInit, `${skill.body}\n`);
  for (const [split, items] of Object.entries(skillOptItems(tasks))) {
    await mkdir(join(splits, split), { recursive: true });
    await writeFile(join(splits, split, "items.json"), `${JSON.stringify(items, null, 2)}\n`);
  }
  const config = join(out, "skillopt-config.yaml");
  // JSON is YAML too, and leaves nothing to SkillOpt's YAML parser to guess.
  await writeFile(config, `${JSON.stringify(written, null, 2)}\n`);

  const code = await deps.runSkillOpt(skilloptArgv(await readPin(), ["-m", "mercury_skillopt", "train", "--config", config]), secrets);
  if (code !== 0) return code;
  const bestPath = join(skilloptOut, "best_skill.md");
  if (!existsSync(bestPath)) throw new Error(`SkillOpt wrote no best skill in ${skilloptOut}, though it exited 0`);
  const best = await Bun.file(bestPath).text();
  const trained = join(out, "SKILL.md");
  await writeFile(trained, skillFile(skill, stripSkillOptMarkers(best)));
  deps.print(`trained skill: ${trained} (SkillOpt's run: ${skilloptOut})`);
  return 0;
}
