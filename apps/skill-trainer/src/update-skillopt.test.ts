import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SkillOptPin } from "./skillopt.ts";
import { PYTHON_DIR } from "./skillopt.ts";
import { resolveRef, updateSkillOptCommand, type UpdateDeps } from "./update-skillopt.ts";

const OLD = "1a44050fc53aa4938a7a3927b6cca550491bfe51";
const NEW = "2b55161fd64bb5a49b8b4a38c7ddb661502cf062";
const TAG = "3c66272ae75cc6b5ac9c5b49d8eec772613d0173";
const PEELED = "4d77383bf86dd7c6bd0d6c5ae9ffd883724e1284";
const REPO = "https://github.com/microsoft/SkillOpt";

const LS_REMOTE = [`${NEW}\tHEAD`, `${NEW}\trefs/heads/main`, `${TAG}\trefs/tags/v0.3.0`, `${PEELED}\trefs/tags/v0.3.0^{}`].join("\n");

describe("resolveRef", () => {
  test("a branch is its head's commit", () => {
    expect(resolveRef(LS_REMOTE, "main")).toBe(NEW);
  });

  test("an annotated tag is the commit it points to, not the tag object", () => {
    expect(resolveRef(LS_REMOTE, "v0.3.0")).toBe(PEELED);
  });

  test("a ref the repository doesn't have is undefined", () => {
    expect(resolveRef(LS_REMOTE, "nope")).toBeUndefined();
  });
});

/** Deps where the pin is OLD, ls-remote answers LS_REMOTE, and each python run exits with what `codes` says. */
function deps(codes: { smoke?: number; tests?: number } = {}) {
  let pin: SkillOptPin = { repository: REPO, commit: OLD };
  const ran: string[][] = [];
  const printed: string[] = [];
  const lsRemote: string[][] = [];
  const d: UpdateDeps = {
    readPin: async () => pin,
    writePin: async (p) => void (pin = p),
    lsRemote: async (repository, ref) => {
      lsRemote.push([repository, ref]);
      return LS_REMOTE;
    },
    run: async (argv) => {
      ran.push(argv);
      if (argv.includes("smoke")) return codes.smoke ?? 0;
      return codes.tests ?? 0;
    },
    print: (l) => void printed.push(l),
  };
  return { d, ran, printed, lsRemote, pin: () => pin };
}

describe("updateSkillOptCommand", () => {
  test("latest main by default: smoke-tested and the adapter's tests run on the new commit, then the pin moves", async () => {
    const { d, ran, printed, lsRemote, pin } = deps();
    expect(await updateSkillOptCommand({}, d)).toBe(0);
    expect(lsRemote).toEqual([[REPO, "main"]]);
    expect(ran.map((argv) => argv.slice(argv.indexOf("--with") + 1, argv.indexOf("--with") + 2)[0])).toEqual([`git+${REPO}@${NEW}`, `git+${REPO}@${NEW}`]);
    expect(ran[0]!.slice(-3)).toEqual(["-m", "mercury_skillopt", "smoke"]);
    expect(ran[1]!.slice(-5)).toEqual(["-m", "unittest", "discover", "-s", join(PYTHON_DIR, "tests")]);
    expect(pin()).toEqual({ repository: REPO, commit: NEW });
    expect(printed.at(-1)).toBe(`SkillOpt moved from ${OLD} to ${NEW} (main)`);
  });

  test("a tag or a full commit given with --ref", async () => {
    const tagged = deps();
    await updateSkillOptCommand({ ref: "v0.3.0" }, tagged.d);
    expect(tagged.pin().commit).toBe(PEELED);
    const exact = deps();
    await updateSkillOptCommand({ ref: TAG }, exact.d);
    expect(exact.pin().commit).toBe(TAG);
    expect(exact.lsRemote).toEqual([]);
  });

  test("a failing smoke test leaves the pin where it was and stops before the tests", async () => {
    const { d, ran, printed, pin } = deps({ smoke: 1 });
    expect(await updateSkillOptCommand({}, d)).toBe(1);
    expect(pin().commit).toBe(OLD);
    expect(ran).toHaveLength(1);
    expect(printed.at(-1)).toBe(`SkillOpt ${NEW} lacks what the adapter relies on: the pin stays at ${OLD}`);
  });

  test("failing adapter tests leave the pin where it was", async () => {
    const { d, printed, pin } = deps({ tests: 1 });
    expect(await updateSkillOptCommand({}, d)).toBe(1);
    expect(pin().commit).toBe(OLD);
    expect(printed.at(-1)).toBe(`the adapter's tests fail on SkillOpt ${NEW}: the pin stays at ${OLD}`);
  });

  test("a ref the repository doesn't have is refused", async () => {
    const { d, ran } = deps();
    await expect(updateSkillOptCommand({ ref: "nope" }, d)).rejects.toThrow(`${REPO} has no ref "nope"`);
    expect(ran).toEqual([]);
  });

  test("already at that commit: nothing runs, nothing is written", async () => {
    const { d, ran, printed } = deps();
    d.readPin = async () => ({ repository: REPO, commit: NEW });
    d.writePin = async () => {
      throw new Error("written");
    };
    expect(await updateSkillOptCommand({}, d)).toBe(0);
    expect(ran).toEqual([]);
    expect(printed).toEqual([`SkillOpt is already at ${NEW} (main)`]);
  });
});
