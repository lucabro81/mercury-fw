import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiNotes } from "./notes.ts";
import { initVault } from "./vault-init.ts";
import { readVisible } from "./vault-access.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-wiki-notes-"));
  dirs.push(dir);
  const path = join(dir, "vault");
  await initVault(path);
  return path;
}

const at = (n: number) => `2026-11-1${n}T10:00:00.000Z`;

describe("createWikiNotes (#393)", () => {
  it("promotes a person's fact to their inferred note, which their own wiki tools see", async () => {
    const path = await vault();
    const notes = createWikiNotes(path);
    const decision = await notes.promoteFact("google-chat:users/42", "team", async () => [
      { topic: "team", value: "platform", timestamp: at(1) },
      { topic: "team", value: "platform", timestamp: at(2) },
    ]);
    expect(decision).toBe("written");
    const text = await readVisible({ vaultPath: path, key: "google-chat:users/42" }, "personal/inferred/team.md");
    expect(text).toContain("platform");
  });

  it("reads back the person's facts: topic, body and the occurrences it came from, nobody else's", async () => {
    const path = await vault();
    const notes = createWikiNotes(path);
    await notes.promoteFact("static:alice", "role", async () => [{ topic: "role", value: "tester", timestamp: at(1) }]);
    await notes.promoteFact("static:bob", "role", async () => [{ topic: "role", value: "dev", timestamp: at(2) }]);
    expect(await notes.facts("static:alice")).toEqual([{ topic: "role", body: "tester", derivedFrom: [at(1)] }]);
    expect(await notes.facts("static:carol")).toEqual([]);
  });

  it("promotes a tool's correction to curated/standards/<tool>-<topic>.md, for everyone", async () => {
    const path = await vault();
    const notes = createWikiNotes(path);
    expect(await notes.promoteCorrection("jira", "jql", async () => [{ topic: "jql", value: "Quote the project key.", timestamp: at(1) }])).toBe("written");
    expect(await readVisible({ vaultPath: path, key: "static:anyone" }, "curated/standards/jira-jql.md")).toContain("Quote the project key.");
  });

  it("asks for the last occurrences, as many as the consolidation window", async () => {
    const path = await vault();
    const limits: number[] = [];
    await createWikiNotes(path).promoteFact("static:alice", "team", async (limit) => (limits.push(limit), []));
    expect(limits).toEqual([3]);
  });
});
