import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfirmationNote } from "../data/confirmation-notes.ts";
import { createResolveReferenceTool } from "./resolve-reference-tool.ts";

const ALICE = "static:alice";
const BOB = "static:bob";
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function notesRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-resolve-reference-"));
  tempDirs.push(dir);
  return dir;
}

/** Runs the tool with `input`, the way the model would. */
async function call(tool: { execute?: unknown }, input: unknown): Promise<Record<string, unknown>> {
  return (await (tool.execute as (i: unknown, o: never) => Promise<unknown>)(input, {} as never)) as Record<string, unknown>;
}

const pending = {
  status: "pending" as const,
  requestedAt: "2026-07-27T12:20:00Z",
  resolvedAt: null,
  command: "jira issue delete KAN-1 --confirm",
};

describe("resolve_reference", () => {
  it("reads the person's own confirmation note by token", async () => {
    const root = await notesRoot();
    await writeConfirmationNote(root, ALICE, "j3h4b5", pending);

    const result = await call(createResolveReferenceTool({ notesRoot: root, key: ALICE }).resolve_reference, { token: "j3h4b5" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("command: jira issue delete KAN-1 --confirm");
    expect(result.content).toContain("status: pending");
  });

  it("returns a self-correctable error for an unknown or expired token", async () => {
    const root = await notesRoot();
    const result = await call(createResolveReferenceTool({ notesRoot: root, key: ALICE }).resolve_reference, { token: "nope00" });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("cannot resolve another person's token even if the string matches, nor climb out with one", async () => {
    const root = await notesRoot();
    await writeConfirmationNote(root, BOB, "j3h4b5", pending);
    const { resolve_reference } = createResolveReferenceTool({ notesRoot: root, key: ALICE });

    expect((await call(resolve_reference, { token: "j3h4b5" })).ok).toBe(false);
    expect((await call(resolve_reference, { token: "../static%3Abob/j3h4b5" })).ok).toBe(false);
  });
});
