/**
 * How the trainer runs SkillOpt: never installed, never vendored, run with
 * `uv` at the one commit pinned in `skillopt.json`, next to the adapter
 * package in `python/` (editable, so it's always the repo's own).
 */
import { join } from "node:path";

/** The SkillOpt the trainer runs: its git repository and a full commit. */
export type SkillOptPin = { repository: string; commit: string };

/** Where the pin is. */
export const PIN_PATH = join(import.meta.dir, "..", "skillopt.json");
/** The adapter package. */
export const PYTHON_DIR = join(import.meta.dir, "..", "python");
/** The Python SkillOpt runs on (it needs 3.10 or later). */
const PYTHON = "3.12";

/** The pin in `text`; throws when it isn't a repository and a full commit. */
export function parsePin(text: string): SkillOptPin {
  const pin = JSON.parse(text) as Partial<SkillOptPin>;
  if (typeof pin.repository !== "string" || pin.repository === "") throw new Error("skillopt.json has no repository");
  if (typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`skillopt.json's commit "${pin.commit}" isn't a full commit`);
  return { repository: pin.repository, commit: pin.commit };
}

/** The pin in the repo. */
export async function readPin(): Promise<SkillOptPin> {
  return parsePin(await Bun.file(PIN_PATH).text());
}

/** The argv that runs `python <args>` with `pin`'s SkillOpt and the adapter. */
export function skilloptArgv(pin: SkillOptPin, args: string[]): string[] {
  return ["uv", "run", "--quiet", "--no-project", "--python", PYTHON, "--with", `git+${pin.repository}@${pin.commit}`, "--with-editable", PYTHON_DIR, "python", ...args];
}
