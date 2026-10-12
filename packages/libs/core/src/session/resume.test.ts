import { describe, expect, test } from "bun:test";
import { resumeConversation, resumeBudget, parseResumeMaxChars, DEFAULT_RESUME_MAX_CHARS, type ResumeDeps } from "./resume.ts";
import { MAX_HISTORY_CHARS } from "./history.ts";
import type { VerbatimTail } from "../memory/verbatim-archive-store.ts";

const query = { userId: "zitadel:1", sessionKey: "1:conv-a", maxChars: 400 };

/** Deps over a fixed tail and summaries, recording what was asked. */
function deps(tail: VerbatimTail, summaries: string[] = []) {
  const calls: { tail: unknown[]; summaries: unknown[] } = { tail: [], summaries: [] };
  const logs: string[] = [];
  const d: ResumeDeps = {
    readTail: async (q) => {
      calls.tail.push(q);
      return tail;
    },
    readSummaries: async (q) => {
      calls.summaries.push(q);
      return summaries.map((summary) => ({ summary }));
    },
    log: (m) => logs.push(m),
  };
  return { d, calls, logs };
}

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

describe("resumeConversation", () => {
  test("a tail that reaches the start comes back alone, without reading summaries", async () => {
    const { d, calls, logs } = deps({ messages: [user("verde"), assistant("ok")], complete: true }, ["unused"]);
    expect(await resumeConversation(query, d)).toEqual({ messages: [user("verde"), assistant("ok")] });
    expect(calls.tail).toEqual([query]);
    expect(calls.summaries).toEqual([]);
    expect(logs).toEqual(["[memory] resumed 1:conv-a: 2 messages, no summary"]);
  });

  test("a partial tail gets the newest summaries that fit a quarter of the budget, and the tail the rest", async () => {
    // Budget 400: summaries get 100. The newest two (40 + 50) fit, the oldest (30) no longer does.
    const tail = { messages: [user("a".repeat(100)), assistant("b".repeat(100)), user("c".repeat(100)), assistant("d".repeat(80))], complete: false };
    const { d, calls, logs } = deps(tail, ["o".repeat(30), "m".repeat(40), "n".repeat(50)]);

    const resumed = await resumeConversation(query, d);

    expect(calls.summaries).toEqual([{ userId: "zitadel:1", sessionKey: "1:conv-a" }]);
    expect(resumed?.summary).toBe(`${"m".repeat(40)}\n\n${"n".repeat(50)}`);
    // 400 - 92 (summary and separator) = 308 for the tail: the oldest message no longer fits,
    // and the tail then opens on the assistant message, which is dropped too.
    expect(resumed?.messages).toEqual([user("c".repeat(100)), assistant("d".repeat(80))]);
    expect(logs).toEqual(["[memory] resumed 1:conv-a: 2 messages, summary"]);
  });

  test("a partial tail with no summary that fits comes back alone", async () => {
    const { d } = deps({ messages: [user("x")], complete: false }, ["s".repeat(200)]);
    expect(await resumeConversation(query, d)).toEqual({ messages: [user("x")] });
  });

  test("a budget of 0 or less reads nothing and resumes nothing", async () => {
    const { d, calls } = deps({ messages: [user("x")], complete: true });
    expect(await resumeConversation({ ...query, maxChars: 0 }, d)).toBeUndefined();
    expect(await resumeConversation({ ...query, maxChars: -1 }, d)).toBeUndefined();
    expect(calls.tail).toEqual([]);
  });

  test("nothing archived resumes nothing, and says nothing", async () => {
    const { d, logs } = deps({ messages: [], complete: true });
    expect(await resumeConversation(query, d)).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("an archive that fails resumes nothing, with a log line", async () => {
    const logs: string[] = [];
    const failing: ResumeDeps = {
      readTail: async () => {
        throw new Error("qdrant down");
      },
      readSummaries: async () => [],
      log: (m) => logs.push(m),
    };
    expect(await resumeConversation(query, failing)).toBeUndefined();
    expect(logs).toEqual(["[memory] couldn't resume 1:conv-a, it starts without its earlier messages: Error: qdrant down"]);
  });

  test("summaries that fail leave the tail on its own", async () => {
    const logs: string[] = [];
    const d: ResumeDeps = {
      readTail: async () => ({ messages: [user("x")], complete: false }),
      readSummaries: async () => {
        throw new Error("qdrant down");
      },
      log: (m) => logs.push(m),
    };
    expect(await resumeConversation(query, d)).toEqual({ messages: [user("x")] });
  });
});

describe("the resume budget", () => {
  test("defaults to half of what the history holds before compressing, and reads SESSION_RESUME_MAX_CHARS", () => {
    expect(DEFAULT_RESUME_MAX_CHARS).toBe(MAX_HISTORY_CHARS / 2);
    expect(parseResumeMaxChars(undefined)).toBe(DEFAULT_RESUME_MAX_CHARS);
    expect(parseResumeMaxChars("")).toBe(DEFAULT_RESUME_MAX_CHARS);
    expect(parseResumeMaxChars(" 12000 ")).toBe(12000);
    expect(parseResumeMaxChars("0")).toBe(0);
  });

  test("anything but a whole number from 0 up is refused, naming the variable", () => {
    for (const bad of ["-1", "1.5", "abc", "1e3"]) {
      expect(() => parseResumeMaxChars(bad)).toThrow(`SESSION_RESUME_MAX_CHARS must be a whole number from 0 up, got "${bad}"`);
    }
  });

  test("a turn without resume gets none; the channel's budget wins over the instance's", () => {
    expect(resumeBudget(undefined, 30_000)).toBe(0);
    expect(resumeBudget({}, 30_000)).toBe(30_000);
    expect(resumeBudget({ maxChars: 500 }, 30_000)).toBe(500);
    expect(resumeBudget({ maxChars: 0 }, 30_000)).toBe(0);
    expect(resumeBudget({ maxChars: 500 }, 0)).toBe(500);
  });
});
