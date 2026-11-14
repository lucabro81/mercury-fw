/**
 * The vault CLI (`mfw vault`) run as the script it is, on a temporary vault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "vault-cli.ts");
let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "mercury-vault-cli-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Runs the CLI with `args` on the temporary vault, `stdin` as its input. */
async function run(args: string[], stdin = "") {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, WIKI_VAULT_PATH: vault },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("vault-cli read", () => {
  test("a note that exists is printed", async () => {
    expect((await run(["write-curated", "curated/x.md"], "Hello.\n")).code).toBe(0);
    const r = await run(["read", "curated/x.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Hello.");
  });

  // Regression: reading a missing note died with Bun's ENOENT stack trace.
  test("a missing note is one clear line, exit 1", async () => {
    expect(await run(["read", "curated/nope.md"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "no note at curated/nope.md (mfw vault list shows them)\n",
    });
  });
});

// Regression: read joined the path onto the vault unchecked, so "../" printed
// files outside it (the container's own, the operator's env file included).
describe("vault-cli read outside the vault", () => {
  test("a path that leaves the vault is refused, exit 1, nothing printed", async () => {
    const outside = join(vault, "..", `${vault.split("/").pop()}-outside.md`);
    await Bun.write(outside, "secret");
    try {
      for (const path of [`../${outside.split("/").pop()}`, outside, "curated/../../x.md"]) {
        expect(await run(["read", path])).toEqual({ code: 1, stdout: "", stderr: `not a path in the vault: ${path}\n` });
      }
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("vault-cli grep", () => {
  // #138: wiki grep ignores case, here as in the model's tool.
  test("ignores case", async () => {
    expect((await run(["write-curated", "curated/projects/names.md"], "Monorepo: MON\n")).code).toBe(0);
    const r = await run(["grep", "monorepo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("curated/projects/names.md:");
    expect(r.stdout).toContain("Monorepo: MON");
  });
});

describe("vault-cli write-raw", () => {
  // The limit is on the file that lands in raw/ (the entry and its final newline), the same the triage measures.
  test("an entry whose file would be over the raw/ limit is refused, exit 1, nothing written", async () => {
    const r = await run(["write-raw", "raw/huge.md"], "x".repeat(64 * 1024));
    expect(r).toEqual({
      code: 1,
      stdout: "",
      stderr: "raw/huge.md is over the raw/ limit (65537 bytes, the limit is 65536): the nightly review triages only smaller entries\n",
    });
    expect(await Bun.file(join(vault, "raw", "huge.md")).exists()).toBe(false);
  });

  test("an entry whose file is exactly at the limit is written, and the triage takes it", async () => {
    expect((await run(["write-raw", "raw/full.md"], "x".repeat(64 * 1024 - 1))).code).toBe(0);
    const { triageableRawEntries } = await import("./raw-limit.ts");
    const logs: string[] = [];
    expect(await triageableRawEntries(vault, ["raw/full.md"], (m) => logs.push(m))).toEqual(["raw/full.md"]);
    expect(logs).toEqual([]);
  });
});

/** Writes the review entry `entry` on the temporary vault, as the nightly passes would. */
async function openEntry(entry: Parameters<typeof import("./review-entries.ts").openReview>[1]) {
  const { openReview } = await import("./review-entries.ts");
  const { initVault } = await import("./vault-init.ts");
  await initVault(vault);
  return openReview(vault, entry);
}

const ENTRY = {
  note: "curated/release.md",
  kind: "curated" as const,
  evidence: ["turn-1", "turn-2"],
  opened_at: "2026-11-14T04:00:00.000Z",
  reason: "Two people said the order is the other way round.",
  proposed: "Merge first, then tag.",
};

describe("vault-cli review", () => {
  test("list prints one line per entry: id, kind, note, when it was opened", async () => {
    await openEntry(ENTRY);
    await openEntry({ ...ENTRY, note: "curated/standards/jira-fields.md", kind: "standard", proposed: undefined });
    expect(await run(["review", "list"])).toEqual({
      code: 0,
      stdout:
        "curated--release  curated  curated/release.md  2026-11-14T04:00:00.000Z\n" +
        "curated--standards--jira-fields  standard  curated/standards/jira-fields.md  2026-11-14T04:00:00.000Z\n",
      stderr: "",
    });
  });

  test("list with nothing open says so", async () => {
    expect(await run(["review", "list"])).toEqual({ code: 0, stdout: "no review entries\n", stderr: "" });
  });

  test("show prints the entry whole", async () => {
    await openEntry(ENTRY);
    expect(await run(["review", "show", "curated--release"])).toEqual({
      code: 0,
      stdout:
        "note: curated/release.md\nkind: curated\nopened: 2026-11-14T04:00:00.000Z\nevidence: turn-1, turn-2\n\n" +
        "Two people said the order is the other way round.\n\nproposed:\n\nMerge first, then tag.\n",
      stderr: "",
    });
  });

  test("accept and reject decide the entry and say what came of the note", async () => {
    expect((await run(["write-curated", "curated/release.md"], "Tag first.")).code).toBe(0);
    await openEntry(ENTRY);
    expect(await run(["review", "accept", "curated--release"])).toEqual({
      code: 0,
      stdout: "accepted curated--release: curated/release.md rewritten\n",
      stderr: "",
    });
    expect((await run(["read", "curated/release.md"])).stdout).toContain("Merge first, then tag.");

    await openEntry(ENTRY);
    expect(await run(["review", "reject", "curated--release"])).toEqual({
      code: 0,
      stdout: "rejected curated--release: curated/release.md kept\n",
      stderr: "",
    });
  });

  test("an id with no entry is one clear line, exit 1", async () => {
    for (const command of ["show", "accept", "reject"]) {
      expect(await run(["review", command, "curated--nope"])).toEqual({
        code: 1,
        stdout: "",
        stderr: "no review entry curated--nope (mfw vault review list shows them)\n",
      });
    }
  });
});

describe("vault-cli lock and unlock", () => {
  test("lock sets locked on a curated note, unlock removes it, the text untouched", async () => {
    expect((await run(["write-curated", "curated/policy.md"], "Policy.")).code).toBe(0);

    expect(await run(["lock", "curated/policy.md"])).toEqual({ code: 0, stdout: "locked curated/policy.md\n", stderr: "" });
    const locked = (await run(["read", "curated/policy.md"])).stdout;
    expect(locked).toContain("locked: true");
    expect(locked).toContain("Policy.");

    expect(await run(["unlock", "curated/policy.md"])).toEqual({ code: 0, stdout: "unlocked curated/policy.md\n", stderr: "" });
    expect((await run(["read", "curated/policy.md"])).stdout).not.toContain("locked");
  });

  test("locks a curated note written by hand, with no frontmatter", async () => {
    const { initVault } = await import("./vault-init.ts");
    await initVault(vault);
    await Bun.write(join(vault, "curated", "policy.md"), "Policy.\n");
    expect(await run(["lock", "curated/policy.md"])).toEqual({ code: 0, stdout: "locked curated/policy.md\n", stderr: "" });
    expect((await run(["read", "curated/policy.md"])).stdout).toContain("type: curated\nlocked: true");
  });

  test("refuses anything but a curated doc a person writes: a person's notes, a standard, a missing note", async () => {
    await openEntry(ENTRY);
    const { writeToolCorrectionNote } = await import("./wiki-note.ts");
    await writeToolCorrectionNote(vault, "jira", "fields", { confidence: "low", derived_from: ["t"], last_reviewed: null }, "x");
    expect(await run(["lock", "users/a/notes/x.md"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "only a curated doc is locked here (curated/…); a person locks their own notes\n",
    });
    expect(await run(["lock", "curated/standards/jira-fields.md"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "curated/standards/jira-fields.md is the consolidation's (a learned standard): lock it with the wiki's locked paths instead\n",
    });
    expect(await run(["lock", "curated/nope.md"])).toEqual({ code: 1, stdout: "", stderr: "no note at curated/nope.md (mfw vault list shows them)\n" });
  });
});
