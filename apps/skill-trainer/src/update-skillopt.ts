/**
 * `skill-trainer update-skillopt`: moves the SkillOpt pin to a new commit
 * (latest `main` by default), and only once that commit has passed the
 * adapter's smoke check (SkillOpt still has the registries, entry points and
 * base classes the adapter relies on, many of them private) and the adapter's
 * own tests. A commit that fails either leaves the pin where it was.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PIN_PATH, PYTHON_DIR, readPin, skilloptArgv, type SkillOptPin } from "./skillopt.ts";

/** What `update-skillopt` was asked for. */
export type UpdateOptions = { ref?: string };

export type UpdateDeps = {
  readPin: () => Promise<SkillOptPin>;
  writePin: (pin: SkillOptPin) => Promise<void>;
  /** `git ls-remote <repository> <ref>`'s stdout. */
  lsRemote: (repository: string, ref: string) => Promise<string>;
  /** Runs `argv` and returns its exit code. */
  run: (argv: string[]) => Promise<number>;
  print: (line: string) => void;
};

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** The commit `ref` names in `git ls-remote` output: a branch's head, or the
 * commit an annotated tag points to (its peeled `^{}` line), not the tag object. */
export function resolveRef(lsRemote: string, ref: string): string | undefined {
  const lines = lsRemote.split("\n").map((l) => l.split("\t")) as Array<[string, string]>;
  const find = (name: string) => lines.find(([, r]) => r === name)?.[0];
  return find(`refs/tags/${ref}^{}`) ?? find(`refs/tags/${ref}`) ?? find(`refs/heads/${ref}`) ?? find(ref);
}

/** git's stdout for `git ls-remote <repository> <ref>`; throws when git fails. */
async function gitLsRemote(repository: string, ref: string): Promise<string> {
  const proc = Bun.spawn(["git", "ls-remote", repository, ref, `${ref}^{}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ls-remote ${repository} failed: ${err.trim()}`);
  return out;
}

/** The real dependencies; `home` is the user's real home folder, where uv keeps its cache and its Pythons. */
export const realUpdateDeps = (home: string | undefined): UpdateDeps => ({
  readPin,
  writePin: (pin) => writeFile(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`),
  lsRemote: gitLsRemote,
  run: (argv) => Bun.spawn(argv, { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...(home === undefined ? {} : { HOME: home }) } }).exited,
  print: console.log,
});

/** `skill-trainer update-skillopt`; 0 when the pin moved or was already there, 1 when the new commit failed a check. */
export async function updateSkillOptCommand(opts: UpdateOptions, deps: UpdateDeps): Promise<number> {
  const pin = await deps.readPin();
  const ref = opts.ref ?? "main";
  const commit = FULL_COMMIT.test(ref) ? ref : resolveRef(await deps.lsRemote(pin.repository, ref), ref);
  if (commit === undefined) throw new Error(`${pin.repository} has no ref "${ref}"`);
  if (commit === pin.commit) {
    deps.print(`SkillOpt is already at ${commit} (${ref})`);
    return 0;
  }
  const candidate = { repository: pin.repository, commit };
  if ((await deps.run(skilloptArgv(candidate, ["-m", "mercury_skillopt", "smoke"]))) !== 0) {
    deps.print(`SkillOpt ${commit} lacks what the adapter relies on: the pin stays at ${pin.commit}`);
    return 1;
  }
  if ((await deps.run(skilloptArgv(candidate, ["-m", "unittest", "discover", "-s", join(PYTHON_DIR, "tests")]))) !== 0) {
    deps.print(`the adapter's tests fail on SkillOpt ${commit}: the pin stays at ${pin.commit}`);
    return 1;
  }
  await deps.writePin(candidate);
  deps.print(`SkillOpt moved from ${pin.commit} to ${commit} (${ref})`);
  return 0;
}
