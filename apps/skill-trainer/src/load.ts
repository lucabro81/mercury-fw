/**
 * Finds a plugin's training data in the repo: the `skill-training/index.ts`
 * next to the plugin's code, `packages/tools/plugin-<name>/`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillTraining } from "./contract.ts";

/** The repo this app is in. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** What a plugin name may be: the folder's suffix. */
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Where `plugin`'s training data is in the repo at `root`. */
export function trainingPath(plugin: string, root: string = REPO_ROOT): string {
  if (!PLUGIN_NAME.test(plugin)) throw new Error(`"${plugin}" isn't a plugin name`);
  return join(root, "packages", "tools", `plugin-${plugin}`, "skill-training", "index.ts");
}

/** Whether `value` has a training's fields. */
function isTraining(value: unknown): value is SkillTraining {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  const fixtures = Array.isArray(t.fixtures) || typeof t.fixtures === "function";
  return typeof t.skill === "string" && typeof t.plugin === "function" && fixtures && Array.isArray(t.tasks);
}

/** `plugin`'s training, the default export of its `skill-training/index.ts`. */
export async function loadTraining(plugin: string, root: string = REPO_ROOT): Promise<SkillTraining> {
  const path = trainingPath(plugin, root);
  if (!existsSync(path)) throw new Error(`the ${plugin} plugin has no training data: no ${path}`);
  const module = (await import(path)) as { default?: unknown };
  if (!isTraining(module.default)) {
    throw new Error(`the ${plugin} plugin's skill-training/index.ts doesn't export a training: it needs skill, plugin, fixtures and tasks`);
  }
  return module.default;
}
