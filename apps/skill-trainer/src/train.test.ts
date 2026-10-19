import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, parseSkill, type Plugin } from "@mercury-fw/plugin-types";
import type { SkillTraining, TrainingTask } from "./contract.ts";
import { withSkill } from "./skill-override.ts";
import { realTrainDeps, skillFile, stripSkillOptMarkers, trainCommand, trainConfig, type TrainDeps } from "./train.ts";
import { realUpdateDeps } from "./update-skillopt.ts";

const SKILL = { name: "jira", description: "Use for Jira: issues, searches, transitions.", body: "# Jira\n\nSearch with JQL." };

describe("stripSkillOptMarkers", () => {
  test("SkillOpt's slow-update and appendix blocks go, markers and all, the rest stays", () => {
    const trained = [
      "# Jira",
      "",
      "Search with JQL.",
      "",
      "<!-- SLOW_UPDATE_START -->",
      "## Lessons",
      "- prefer statusCategory",
      "<!-- SLOW_UPDATE_END -->",
      "",
      "Count with the search.",
      "",
      "<!-- APPENDIX_START -->",
      "## Execution Notes Appendix",
      "- note",
      "<!-- APPENDIX_END -->",
      "",
    ].join("\n");
    expect(stripSkillOptMarkers(trained)).toBe("# Jira\n\nSearch with JQL.\n\nCount with the search.");
  });

  // Collapsing every run of blank lines rewrote the rest of the body too, a code block's included.
  test("blank lines elsewhere in the body stay as they were", () => {
    const body = "# Jira\n\n```\na\n\n\n\nb\n```\n\n<!-- APPENDIX_START -->\nx\n<!-- APPENDIX_END -->\n\nEnd.";
    expect(stripSkillOptMarkers(body)).toBe("# Jira\n\n```\na\n\n\n\nb\n```\n\nEnd.");
  });

  test("a skill without markers is only trimmed", () => {
    expect(stripSkillOptMarkers("\n# Jira\n\nBody.\n\n")).toBe("# Jira\n\nBody.");
  });
});

describe("skillFile", () => {
  test("the plugin's name and description over a trained body: a SKILL.md the trainer and the core read back as the same skill", () => {
    const file = skillFile(SKILL, "# Jira\n\nTrained.");
    expect(parseSkill(file)).toEqual({ ...SKILL, body: "# Jira\n\nTrained." });
    const plugin = { apiVersion: PLUGIN_API_VERSION, name: "jira", skills: [SKILL] } as unknown as Plugin;
    expect(withSkill(plugin, "jira", file).skills![0]!.body).toBe("# Jira\n\nTrained.");
  });
});

describe("trainConfig", () => {
  const defaults = { train: { num_epochs: 2, batch_size: 8 }, model: { backend: "openai_compatible", openai_compatible_max_tokens: 32000 } };
  const env = { name: "mercury", skill_init: "/out/skill_init.md", split_mode: "split_dir", split_dir: "/out/splits", out_root: "/out/skillopt", mercury_command: ["bun", "/repo/bin.ts"], mercury_plugin: "jira" };

  test("the model is the one the skill runs on, Ollama's OpenAI-compatible endpoint, for the optimizer and the target", () => {
    const cfg = trainConfig(defaults, {}, env, { OLLAMA_HOST: "http://192.168.90.217:11434/", OLLAMA_MODEL: "qwen3.8:27b" });
    expect(cfg.model).toEqual({
      backend: "openai_compatible",
      openai_compatible_max_tokens: 32000,
      optimizer: "qwen3.8:27b",
      target: "qwen3.8:27b",
      openai_compatible_model: "qwen3.8:27b",
      openai_compatible_base_url: "http://192.168.90.217:11434/v1",
      openai_compatible_api_key: "ollama",
    });
    expect(cfg.env).toEqual(env);
    expect(cfg.train).toEqual({ num_epochs: 2, batch_size: 8 });
  });

  // The placeholder key went to whatever endpoint the run's config chose, a hosted one included.
  test("a run's config that moves the endpoint gets no placeholder key: its own, or none", () => {
    const vars = { OLLAMA_HOST: "http://h:11434", OLLAMA_MODEL: "m" };
    expect(trainConfig(defaults, { model: { openai_compatible_base_url: "https://api.example.com/v1" } }, env, vars).model).not.toHaveProperty("openai_compatible_api_key");
    expect(trainConfig(defaults, { model: { openai_compatible_base_url: "https://api.example.com/v1", openai_compatible_api_key: "sk-x" } }, env, vars).model).toMatchObject({ openai_compatible_api_key: "sk-x" });
  });

  test("the run's config goes over the defaults and the model, a hosted optimizer with its key included", () => {
    const user = { train: { num_epochs: 4 }, model: { optimizer: "gpt-5.5", optimizer_openai_compatible_base_url: "https://api.example.com/v1", optimizer_openai_compatible_api_key: "sk-test", optimizer_openai_compatible_model: "gpt-5.5" } };
    const cfg = trainConfig(defaults, user, env, { OLLAMA_HOST: "http://h:11434", OLLAMA_MODEL: "m" });
    expect(cfg.train).toEqual({ num_epochs: 4, batch_size: 8 });
    expect(cfg.model).toMatchObject({ optimizer: "gpt-5.5", target: "m", optimizer_openai_compatible_base_url: "https://api.example.com/v1", openai_compatible_base_url: "http://h:11434/v1" });
  });

  test("the env section is the trainer's: a run's config can't point SkillOpt at other tasks or another harness", () => {
    const cfg = trainConfig(defaults, { env: { split_dir: "/elsewhere", mercury_command: ["rm"] } }, env, { OLLAMA_HOST: "http://h:11434", OLLAMA_MODEL: "m" });
    expect(cfg.env).toEqual(env);
  });

  test("without OLLAMA_HOST or OLLAMA_MODEL, and no model in the run's config, there's no model to train with", () => {
    expect(() => trainConfig(defaults, {}, env, { OLLAMA_MODEL: "m" })).toThrow("OLLAMA_HOST");
    expect(() => trainConfig(defaults, {}, env, { OLLAMA_HOST: "http://h" })).toThrow("OLLAMA_MODEL");
    expect(trainConfig(defaults, { model: { optimizer: "o", target: "o", openai_compatible_model: "o", openai_compatible_base_url: "http://x/v1" } }, env, {}).model).toMatchObject({ optimizer: "o" });
  });
});

describe("trainCommand", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-trainer-train-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const task = (id: string, split: TrainingTask["split"]): TrainingTask => ({ id, split, taskType: "count", turns: [`question ${id}`], check: () => {} });
  const training: SkillTraining = {
    skill: "jira",
    plugin: () => ({ apiVersion: PLUGIN_API_VERSION, name: "jira", skills: [SKILL] }) as unknown as Plugin,
    fixtures: [],
    tasks: [task("a", "train"), task("b", "val"), task("c", "test")],
  };

  /** Deps whose SkillOpt writes `best` as its best skill (none when null) and exits `code`; the argv it got lands in `ran`, the secrets in `secrets`. */
  function deps({ best = "# Jira\n\nTrained.\n<!-- SLOW_UPDATE_START -->\nx\n<!-- SLOW_UPDATE_END -->" as string | null, code = 0 } = {}) {
    const ran: string[][] = [];
    const secrets: Array<Record<string, string>> = [];
    const printed: string[] = [];
    const d: TrainDeps = {
      loadTraining: async () => training,
      env: { OLLAMA_HOST: "http://h:11434", OLLAMA_MODEL: "m" },
      runSkillOpt: async (argv, env) => {
        ran.push(argv);
        secrets.push(env);
        const cfg = Bun.YAML.parse(readFileSync(argv[argv.indexOf("--config") + 1]!, "utf8")) as { env: { out_root: string } };
        mkdirSync(cfg.env.out_root, { recursive: true });
        if (best !== null) writeFileSync(join(cfg.env.out_root, "best_skill.md"), best);
        return code;
      },
      print: (l) => void printed.push(l),
    };
    return { d, ran, printed, secrets };
  }

  test("writes the tasks, the skill's body and SkillOpt's config into the output folder, runs SkillOpt on it, and writes the trained SKILL.md", async () => {
    const out = join(dir, "out");
    const { d, ran, printed } = deps();
    expect(await trainCommand({ plugin: "jira", out }, d)).toBe(0);
    expect(readFileSync(join(out, "skill_init.md"), "utf8")).toBe("# Jira\n\nSearch with JQL.\n");
    expect(JSON.parse(readFileSync(join(out, "splits", "val", "items.json"), "utf8"))).toEqual([{ id: "b", task_type: "count", question: "question b" }]);
    const config = join(out, "skillopt-config.yaml");
    expect(ran).toHaveLength(1);
    expect(ran[0]!.slice(-5)).toEqual(["-m", "mercury_skillopt", "train", "--config", config]);
    const cfg = Bun.YAML.parse(readFileSync(config, "utf8")) as { env: Record<string, unknown>; evaluation: { gate_metric: string } };
    expect(cfg.env).toMatchObject({ name: "mercury", skill_init: join(out, "skill_init.md"), split_dir: join(out, "splits"), out_root: join(out, "skillopt"), mercury_plugin: "jira" });
    expect(cfg.env.mercury_command).toEqual([process.execPath, join(import.meta.dir, "bin.ts")]);
    expect(cfg.evaluation.gate_metric).toBe("soft");
    expect(readFileSync(join(out, "SKILL.md"), "utf8")).toBe(skillFile(SKILL, "# Jira\n\nTrained."));
    expect(printed.at(-1)).toBe(`trained skill: ${join(out, "SKILL.md")} (SkillOpt's run: ${join(out, "skillopt")})`);
  });

  test("a --config file goes over the defaults", async () => {
    const out = join(dir, "out");
    const config = join(dir, "mine.yaml");
    writeFileSync(config, "train:\n  num_epochs: 5\n");
    const { d } = deps();
    await trainCommand({ plugin: "jira", out, config }, d);
    expect((Bun.YAML.parse(readFileSync(join(out, "skillopt-config.yaml"), "utf8")) as { train: { num_epochs: number } }).train.num_epochs).toBe(5);
  });

  // SkillOpt resumes from an output folder it has used before, reusing its cached patches.
  test("an output folder that isn't empty is refused before anything runs", async () => {
    const out = join(dir, "out");
    mkdirSync(out);
    writeFileSync(join(out, "old.txt"), "x");
    const { d, ran } = deps();
    await expect(trainCommand({ plugin: "jira", out }, d)).rejects.toThrow("isn't empty");
    expect(ran).toEqual([]);
  });

  // An API key in skillopt-config.yaml sat in clear text in the output folder: keys go to SkillOpt through its environment.
  test("no API key is written into the config: SkillOpt gets them in its environment", async () => {
    const out = join(dir, "out");
    const config = join(dir, "hosted.yaml");
    writeFileSync(config, "model:\n  optimizer_openai_compatible_base_url: https://api.example.com/v1\n  optimizer_openai_compatible_api_key: sk-test\n");
    const { d, secrets } = deps();
    await trainCommand({ plugin: "jira", out, config }, d);
    const written = readFileSync(join(out, "skillopt-config.yaml"), "utf8");
    expect(written).not.toContain("sk-test");
    expect(written).not.toContain("api_key");
    expect(secrets).toEqual([{ OPENAI_COMPATIBLE_API_KEY: "ollama", OPTIMIZER_OPENAI_COMPATIBLE_API_KEY: "sk-test" }]);
  });

  test("a SkillOpt that ends well but writes no best skill is an error saying so", async () => {
    const out = join(dir, "out");
    const { d } = deps({ best: null });
    await expect(trainCommand({ plugin: "jira", out }, d)).rejects.toThrow(`SkillOpt wrote no best skill in ${join(out, "skillopt")}`);
  });

  test("a plugin that can't be loaded leaves no output folder behind", async () => {
    const out = join(dir, "out");
    const { d } = deps();
    d.loadTraining = async () => {
      throw new Error("the nope plugin has no training data");
    };
    await expect(trainCommand({ plugin: "nope", out }, d)).rejects.toThrow("no training data");
    expect(existsSync(out)).toBe(false);
  });

  // The folder was made and filled before the config was built, so a run that failed on it left a
  // folder the next try with the same --out refused as not empty.
  test("no model, or a --config that can't be read, leaves no output folder behind", async () => {
    const out = join(dir, "out");
    const noModel = deps();
    noModel.d.env = {};
    await expect(trainCommand({ plugin: "jira", out }, noModel.d)).rejects.toThrow("no model endpoint");
    expect(existsSync(out)).toBe(false);
    await expect(trainCommand({ plugin: "jira", out, config: join(dir, "missing.yaml") }, deps().d)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  });

  test("a SkillOpt that fails leaves no SKILL.md and its exit code is the command's", async () => {
    const out = join(dir, "out");
    const { d } = deps({ code: 3 });
    expect(await trainCommand({ plugin: "jira", out }, d)).toBe(3);
    expect(existsSync(join(out, "SKILL.md"))).toBe(false);
  });

  test("without an output folder, a new one under results/ named after the plugin and the time", async () => {
    const { d, ran } = deps();
    d.now = () => new Date("2026-10-19T14:05:09Z");
    d.resultsDir = dir;
    await trainCommand({ plugin: "jira" }, d);
    expect(ran[0]!.at(-1)).toBe(join(dir, "train-jira-20261019-140509", "skillopt-config.yaml"));
  });
});

// bin.ts gives the process a throwaway HOME for the harness; uv keeps its cache and its Pythons
// under HOME, so with that one every train and update-skillopt fetched SkillOpt and Python anew.
describe("the uv runs get the real home", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-trainer-home-"));
    saved = process.env.HOME;
    process.env.HOME = join(dir, "throwaway");
  });
  afterEach(() => {
    process.env.HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const homeSeenBy = async (run: (argv: string[]) => Promise<number>) => {
    const file = join(dir, "home.txt");
    expect(await run(["sh", "-c", `printf %s "$HOME" > "${file}"`])).toBe(0);
    return readFileSync(file, "utf8");
  };

  test("train's", async () => {
    expect(await homeSeenBy((argv) => realTrainDeps(async () => ({}) as SkillTraining, "/Users/real").runSkillOpt(argv, {}))).toBe("/Users/real");
  });

  test("train's gets the keys it's handed in its environment", async () => {
    const file = join(dir, "key.txt");
    const runSkillOpt = realTrainDeps(async () => ({}) as SkillTraining, "/Users/real").runSkillOpt;
    expect(await runSkillOpt(["sh", "-c", `printf %s "$OPTIMIZER_OPENAI_COMPATIBLE_API_KEY" > "${file}"`], { OPTIMIZER_OPENAI_COMPATIBLE_API_KEY: "sk-test" })).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("sk-test");
  });

  test("update-skillopt's", async () => {
    expect(await homeSeenBy(realUpdateDeps("/Users/real").run)).toBe("/Users/real");
  });
});

