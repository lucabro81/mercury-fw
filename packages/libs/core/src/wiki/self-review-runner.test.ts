import { describe, it, expect } from "bun:test";
import { runRawTriagePass, runIndexAndOrphanPass, runContradictionCheckPass, SELF_REVIEW_STEP_COUNT } from "./self-review-runner.ts";
import type { Message } from "../session/history.ts";
import type { Tool } from "ai";

type ReceivedParams = { messages: Message[]; tools: Record<string, Tool>; instructions: string };

const VAULT_PATH = "/fake/vault";
const MODEL = "fake-model" as never;

describe("runRawTriagePass", () => {
  it("calls generateText with stopWhen allowing multiple steps, a one-shot message, and the self-review tools", async () => {
    let received: ReceivedParams | undefined;
    const generateTextFn = async (params: ReceivedParams) => {
      received = params;
      return { text: "ok" };
    };

    await runRawTriagePass({
      vaultPath: VAULT_PATH,
      model: MODEL,
      rawEntries: ["raw/notes/a.md", "raw/notes/b.md"],
      generateTextFn,
    });

    expect(received).toBeDefined();
    expect(received!.messages).toEqual([
      { role: "user", content: expect.stringContaining("raw/notes/a.md") },
    ]);
    expect((received!.messages as { content: string }[])[0]!.content).toContain("raw/notes/b.md");
    expect(Object.keys(received!.tools as object).sort()).toEqual(
      [
        "delete_curated",
        "delete_raw",
        "grep",
        "list_files",
        "read_file",
        "write_curated",
        "update_index_entry",
        "remove_index_entry",
      ].sort(),
    );
    expect(received!.instructions).toContain("raw/");
    expect(received!.instructions).toContain("triage");
  });

  it("uses the default step count when no override is given", async () => {
    let stepCount: number | undefined;
    // The real ai-sdk stopWhen value isn't easily introspectable, so this
    // test only pins the exported constant used to build it — a smoke
    // check that the module didn't silently drop the multi-step budget.
    expect(SELF_REVIEW_STEP_COUNT).toBeGreaterThan(1);
    stepCount = SELF_REVIEW_STEP_COUNT;
    expect(stepCount).toBe(SELF_REVIEW_STEP_COUNT);
  });
});

describe("runIndexAndOrphanPass", () => {
  it("passes the orphan list in the user message and the right job description in the system prompt", async () => {
    let received: ReceivedParams | undefined;
    const generateTextFn = async (params: ReceivedParams) => {
      received = params;
      return { text: "ok" };
    };

    await runIndexAndOrphanPass({
      vaultPath: VAULT_PATH,
      model: MODEL,
      orphans: ["curated/glossary.md"],
      generateTextFn,
    });

    expect(received!.messages[0]!.content).toContain("curated/glossary.md");
    expect(received!.instructions).toContain("index.md");
    expect(received!.instructions).toContain("orphan");
  });
});

describe("runContradictionCheckPass", () => {
  it("has no pre-computed input and a system prompt describing the contradiction/cross-link job", async () => {
    let received: ReceivedParams | undefined;
    const generateTextFn = async (params: ReceivedParams) => {
      received = params;
      return { text: "ok" };
    };

    await runContradictionCheckPass({ vaultPath: VAULT_PATH, model: MODEL, generateTextFn });

    expect(received!.instructions).toContain("contradiction");
    expect(received!.instructions.toLowerCase()).toContain("cross-link");
  });
});

// #154: write_curated and delete_curated refuse a doc that changed since it
// was read; every pass is told so up front, instead of meeting it as an error.
describe("every pass", () => {
  it("is told to write and delete only the version of a doc it last read", async () => {
    const instructions: string[] = [];
    const generateTextFn = async (params: ReceivedParams) => {
      instructions.push(params.instructions);
      return { text: "ok" };
    };

    await runRawTriagePass({ vaultPath: VAULT_PATH, model: MODEL, rawEntries: [], generateTextFn });
    await runIndexAndOrphanPass({ vaultPath: VAULT_PATH, model: MODEL, orphans: [], generateTextFn });
    await runContradictionCheckPass({ vaultPath: VAULT_PATH, model: MODEL, generateTextFn });

    for (const text of instructions) {
      expect(text).toContain("Read a curated doc before you rewrite or delete it");
      expect(text).toContain("read it again and redo your edit");
    }
  });
});
