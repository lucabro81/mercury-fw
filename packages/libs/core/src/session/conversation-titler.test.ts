import { describe, it, expect } from "bun:test";
import type { LanguageModel } from "ai";
import { createConversationTitler, OPENING_MAX_CHARS, TITLE_INSTRUCTIONS, type GenerateTextFn } from "./conversation-titler.ts";
import type { ConversationTitle } from "../memory/conversation-titles-store.ts";
import type { VerbatimMessage } from "../memory/verbatim-archive-store.ts";

const MODEL = {} as LanguageModel;

/** A message of the archive, as `listVerbatimBySession` gives it. */
function msg(role: "user" | "assistant", content: string, extra: Partial<VerbatimMessage> = {}): VerbatimMessage {
  return { userId: "u1", sessionKey: "u1:a", role, content, timestamp: "2026-11-05T10:00:00.000Z", ...extra };
}

/** A titler over fakes, recording what it asked and saved. */
function setUp(opts: {
  opening?: VerbatimMessage[];
  answer?: string | (() => Promise<string>);
  existing?: ConversationTitle;
  /** The title the second read finds, as if the person renamed the conversation meanwhile. */
  arrivesMeanwhile?: ConversationTitle;
}) {
  const prompts: Array<{ instructions?: string; prompt: string }> = [];
  const saved: Array<{ userId: string; sessionKey: string; title: string }> = [];
  const reads: Array<{ userId: string; sessionKey: string }> = [];
  const logs: string[] = [];
  let titleReads = 0;
  const generateTextFn: GenerateTextFn = async (params) => {
    prompts.push({ instructions: params.instructions, prompt: params.prompt });
    const answer = opts.answer ?? "Issue aperte";
    return { text: typeof answer === "string" ? answer : await answer() };
  };
  const title = createConversationTitler({
    model: MODEL,
    generateTextFn,
    readOpening: async (userId, sessionKey) => {
      reads.push({ userId, sessionKey });
      return opts.opening ?? [msg("user", "Quali issue ho aperte?"), msg("assistant", "Hai 3 issue aperte.")];
    },
    titleOf: async () => {
      titleReads++;
      return titleReads === 1 ? opts.existing : (opts.arrivesMeanwhile ?? opts.existing);
    },
    setTitle: async (userId, sessionKey, t) => {
      saved.push({ userId, sessionKey, title: t });
    },
    log: (m) => logs.push(m),
  });
  return { title, prompts, saved, reads, logs };
}

describe("createConversationTitler", () => {
  it("asks the model for a title from the person's first message and the answer, and saves it cleaned", async () => {
    const { title, prompts, saved, reads } = setUp({ answer: '"Issue aperte."' });
    await title("u1:a", "u1");
    expect(reads).toEqual([{ userId: "u1", sessionKey: "u1:a" }]);
    expect(prompts).toEqual([
      { instructions: TITLE_INSTRUCTIONS, prompt: "User: Quali issue ho aperte?\n\nAssistant: Hai 3 issue aperte." },
    ]);
    expect(saved).toEqual([{ userId: "u1", sessionKey: "u1:a", title: "Issue aperte" }]);
  });

  it("writes the instructions in English and asks for the person's language", () => {
    expect(TITLE_INSTRUCTIONS).toContain("title");
    expect(TITLE_INSTRUCTIONS).toContain("language");
  });

  it("skips a greeting the assistant opened with: the first question is the person's", async () => {
    const { title, prompts } = setUp({
      opening: [
        msg("assistant", "Ciao! Sono Mercury, come ti chiami?"),
        msg("user", "Luca. Quali issue ho aperte?"),
        msg("assistant", "Hai 3 issue aperte."),
        msg("user", "E le pull request?"),
        msg("assistant", "Due."),
      ],
    });
    await title("u1:a", "u1");
    expect(prompts[0]!.prompt).toBe("User: Luca. Quali issue ho aperte?\n\nAssistant: Hai 3 issue aperte.");
  });

  it("uses the first answer with words after the question, skipping an interrupted one and how a confirmation was resolved", async () => {
    const { title, prompts } = setUp({
      opening: [
        msg("user", "Chiudi KAN-1"),
        msg("assistant", "", { interrupted: true }),
        msg("assistant", "", { confirmation: { id: "c1", status: "ok" } }),
        msg("assistant", "Fatto: KAN-1 è chiusa."),
      ],
    });
    await title("u1:a", "u1");
    expect(prompts[0]!.prompt).toBe("User: Chiudi KAN-1\n\nAssistant: Fatto: KAN-1 è chiusa.");
  });

  it("titles from the question alone when no answer has words yet", async () => {
    const { title, prompts, saved } = setUp({ opening: [msg("user", "Chiudi KAN-1"), msg("assistant", "", { interrupted: true })] });
    await title("u1:a", "u1");
    expect(prompts[0]!.prompt).toBe("User: Chiudi KAN-1");
    expect(saved).toHaveLength(1);
  });

  it("cuts a long question and a long answer", async () => {
    const long = "a".repeat(OPENING_MAX_CHARS + 500);
    const { title, prompts } = setUp({ opening: [msg("user", long), msg("assistant", long)] });
    await title("u1:a", "u1");
    const a = "a".repeat(OPENING_MAX_CHARS);
    expect(prompts[0]!.prompt).toBe(`User: ${a}\n\nAssistant: ${a}`);
  });

  it("does nothing for a conversation that already has a title, generated or the person's", async () => {
    for (const existing of [
      { title: "Vecchio", source: "generated" as const },
      { title: "Mio", source: "person" as const },
    ]) {
      const { title, prompts, saved, reads } = setUp({ existing });
      await title("u1:a", "u1");
      expect(reads).toEqual([]);
      expect(prompts).toEqual([]);
      expect(saved).toEqual([]);
    }
  });

  it("keeps the title the person chose while the model was answering", async () => {
    const { title, prompts, saved } = setUp({ arrivesMeanwhile: { title: "Mio", source: "person" } });
    await title("u1:a", "u1");
    expect(prompts).toHaveLength(1);
    expect(saved).toEqual([]);
  });

  it("does nothing for a conversation with no message of the person", async () => {
    const { title, prompts, saved } = setUp({ opening: [msg("assistant", "Ciao! Come ti chiami?")] });
    await title("u1:a", "u1");
    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("saves nothing when the model answers nothing usable", async () => {
    const { title, saved } = setUp({ answer: '  ""  ' });
    await title("u1:a", "u1");
    expect(saved).toEqual([]);
  });

  // The title is enrichment: a model that can't be reached must leave the conversation as it was.
  it("logs and saves nothing when the model fails, without throwing", async () => {
    const { title, saved, logs } = setUp({
      answer: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await title("u1:a", "u1");
    expect(saved).toEqual([]);
    expect(logs).toEqual(["[titles] no title for u1:a: connect ECONNREFUSED"]);
  });

  it("generates once when asked twice for the same conversation at the same time", async () => {
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const { title, prompts, saved } = setUp({ answer: () => gate });
    const first = title("u1:a", "u1");
    const second = title("u1:a", "u1");
    await second;
    release("Issue aperte");
    await first;
    expect(prompts).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  it("can generate again for a conversation once the first attempt ended without a title", async () => {
    let calls = 0;
    const { title, saved } = setUp({
      answer: async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        return "Issue aperte";
      },
    });
    await title("u1:a", "u1");
    await title("u1:a", "u1");
    expect(saved).toEqual([{ userId: "u1", sessionKey: "u1:a", title: "Issue aperte" }]);
  });
});

// #23: each titling attempt says how it went in the traces.
describe("createConversationTitler: title events", () => {
  function traced(deps: Partial<Parameters<typeof createConversationTitler>[0]> = {}) {
    const events: Array<Record<string, unknown>> = [];
    const title = createConversationTitler({
      model: MODEL,
      generateTextFn: async () => ({ text: "Issue aperte" }),
      readOpening: async () => [msg("user", "Quali issue ho aperte?")],
      titleOf: async () => undefined,
      setTitle: async () => {},
      log: () => {},
      emit: (e) => void events.push(e),
      ...deps,
    });
    return { title, events };
  }

  it("generated, for the person and the conversation", async () => {
    const { title, events } = traced();
    await title("u1:a", "u1");
    expect(events).toEqual([{ kind: "title", session: "u1:a", person: "u1", outcome: "generated" }]);
  });

  it("exists, when the conversation already had one", async () => {
    const { title, events } = traced({ titleOf: async () => ({ title: "Mine", source: "person" }) as ConversationTitle });
    await title("u1:a", "u1");
    expect(events).toEqual([{ kind: "title", session: "u1:a", person: "u1", outcome: "exists" }]);
  });

  it("empty, when there was nothing to title from or the model gave nothing usable", async () => {
    const nothing = traced({ readOpening: async () => [] });
    await nothing.title("u1:a", "u1");
    const blank = traced({ generateTextFn: async () => ({ text: '""' }) });
    await blank.title("u1:a", "u1");
    expect([nothing.events[0]?.outcome, blank.events[0]?.outcome]).toEqual(["empty", "empty"]);
  });

  it("failed, with the error for the args level", async () => {
    const { title, events } = traced({
      generateTextFn: async () => {
        throw new Error("model down");
      },
    });
    await title("u1:a", "u1");
    expect(events).toEqual([{ kind: "title", session: "u1:a", person: "u1", outcome: "failed", args: { error: "model down" } }]);
  });
});
