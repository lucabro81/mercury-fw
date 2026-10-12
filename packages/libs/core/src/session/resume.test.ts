import { describe, expect, test } from "bun:test";
import { resumeConversation, resumeBudget, parseResumeMaxChars, DEFAULT_RESUME_MAX_CHARS, type ResumeDeps } from "./resume.ts";
import { MAX_HISTORY_CHARS } from "./history.ts";
import type { VerbatimTail } from "../memory/verbatim-archive-store.ts";

const query = { userId: "zitadel:1", sessionKey: "1:conv-a", maxChars: 400 };

/** Deps over a fixed tail and summaries, recording what was asked. */
function deps(tail: VerbatimTail, summaries: Array<{ summary: string; timestamp: string }> = []) {
  const calls: { tail: unknown[]; summaries: unknown[] } = { tail: [], summaries: [] };
  const logs: string[] = [];
  const d: ResumeDeps = {
    readTail: async (q) => {
      calls.tail.push(q);
      return tail;
    },
    readSummaries: async (q) => {
      calls.summaries.push(q);
      return summaries;
    },
    log: (m) => logs.push(m),
  };
  return { d, calls, logs };
}

/** 10:MM as a timestamp. */
const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, "0")}:00.000Z`;
const user = (content: string, minute = 0) => ({ role: "user" as const, content, timestamp: at(minute) });
const assistant = (content: string, minute = 0) => ({ role: "assistant" as const, content, timestamp: at(minute) });
/** What the history gets: no timestamps. */
const plain = (m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content });
const summary = (text: string, minute: number) => ({ summary: text, timestamp: at(minute) });

describe("resumeConversation", () => {
  test("a tail that reaches the start comes back alone, without reading summaries", async () => {
    const { d, calls, logs } = deps({ messages: [user("verde", 1), assistant("ok", 2)], complete: true }, [summary("unused", 3)]);
    expect(await resumeConversation(query, d)).toEqual({ messages: [plain(user("verde")), plain(assistant("ok"))] });
    expect(calls.tail).toEqual([query]);
    expect(calls.summaries).toEqual([]);
    expect(logs).toEqual(["[memory] resumed 1:conv-a: 2 messages, no summary"]);
  });

  test("a partial tail keeps three quarters of the budget, and the summaries of what came before it the rest", async () => {
    // Budget 400: the tail keeps at most 300, so "a" (oldest) goes, and "b" with it (a tail opens with the person).
    const tail = {
      messages: [user("a".repeat(100), 10), assistant("b".repeat(100), 11), user("c".repeat(100), 12), assistant("d".repeat(80), 13)],
      complete: false,
      leftOutAt: at(9),
    };
    const { d, calls, logs } = deps(tail, [summary("o".repeat(100), 4), summary("m".repeat(100), 8), summary("n".repeat(100), 11)]);

    const resumed = await resumeConversation(query, d);

    expect(calls.summaries).toEqual([{ userId: "zitadel:1", sessionKey: "1:conv-a" }]);
    expect(resumed?.messages).toEqual([plain(user("c".repeat(100))), plain(assistant("d".repeat(80)))]);
    // The tail starts at 10:12 and left out what ran up to 10:11: the summary
    // written at 10:11 covers it, and the two before it fit what's left (220).
    expect(resumed?.summary).toBe(`${"m".repeat(100)}\n\n${"n".repeat(100)}`);
    expect(logs).toEqual(["[memory] resumed 1:conv-a: 2 messages, summary"]);
  });

  // Regression (live test of #163): the newest summary was of the very
  // messages the tail held, so the model got them twice and nothing of what
  // came before.
  test("a summary of what the tail already holds is left out", async () => {
    const tail = { messages: [user("e la macchina?", 56), assistant("una Panda rossa", 57)], complete: false, leftOutAt: at(54) };
    const { d } = deps(tail, [summary("colore verde", 46), summary("poesia sul verde", 55), summary("la macchina", 58)]);

    const resumed = await resumeConversation(query, d);

    expect(resumed?.summary).toBe("colore verde\n\npoesia sul verde");
  });

  test("a summary written after the tail started stays when nothing older covers what was left out", async () => {
    // Left out up to 10:54, but the newest summary before the tail is from 10:46.
    const tail = { messages: [user("e la macchina?", 56)], complete: false, leftOutAt: at(54) };
    const { d } = deps(tail, [summary("colore verde", 46), summary("poesia e macchina", 58), summary("dopo", 59)]);

    expect((await resumeConversation(query, d))?.summary).toBe("colore verde\n\npoesia e macchina");
  });

  test("an empty tail takes every summary that fits", async () => {
    const { d } = deps({ messages: [], complete: false, leftOutAt: at(59) }, [summary("uno", 1), summary("due", 2)]);
    expect(await resumeConversation(query, d)).toEqual({ summary: "uno\n\ndue", messages: [] });
  });

  test("summaries are taken newest first, and stop at the first that doesn't fit", async () => {
    const tail = { messages: [user("x".repeat(290), 30)], complete: false, leftOutAt: at(29) };
    // 110 chars left: the older one would fit, but the newer one doesn't, and a gap is worse than less.
    const { d } = deps(tail, [summary("o".repeat(50), 1), summary("n".repeat(120), 2)]);
    expect(await resumeConversation(query, d)).toEqual({ messages: [plain(user("x".repeat(290)))] });
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
      readTail: async () => ({ messages: [user("x")], complete: false, leftOutAt: at(0) }),
      readSummaries: async () => {
        throw new Error("qdrant down");
      },
      log: (m) => logs.push(m),
    };
    expect(await resumeConversation(query, d)).toEqual({ messages: [plain(user("x"))] });
    expect(logs[0]).toBe("[memory] couldn't read the summaries of 1:conv-a, it resumes without them: Error: qdrant down");
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
