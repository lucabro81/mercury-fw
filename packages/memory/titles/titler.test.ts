import { describe, it, expect } from "bun:test";
import type { LanguageModel } from "ai";
import { createConversationTitler, OPENING_MAX_CHARS, TITLE_INSTRUCTIONS, type GenerateTextFn, type TitledTurn } from "./titler.ts";

const MODEL = {} as LanguageModel;

const turn: TitledTurn = { sessionKey: "u1:a", userId: "u1", question: "Quali issue ho aperte?", answer: "Hai 3 issue aperte." };

/** A titler over fakes, recording what it asked and saved. */
function setUp(opts: {
  answer?: string | (() => Promise<string>);
  existing?: boolean;
  /** Whether the second read finds a title, as if the person renamed the conversation meanwhile. */
  arrivesMeanwhile?: boolean;
}) {
  const prompts: Array<{ instructions?: string; prompt: string }> = [];
  const saved: Array<{ userId: string; sessionKey: string; title: string }> = [];
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
    hasTitle: async () => {
      titleReads++;
      return titleReads === 1 ? (opts.existing ?? false) : (opts.arrivesMeanwhile ?? opts.existing ?? false);
    },
    setTitle: async (userId, sessionKey, t) => {
      saved.push({ userId, sessionKey, title: t });
    },
    log: (m) => logs.push(m),
  });
  return { title, prompts, saved, logs };
}

describe("createConversationTitler", () => {
  it("asks the model for a title from what the person wrote and the answer, and saves it cleaned", async () => {
    const { title, prompts, saved } = setUp({ answer: '"Issue aperte."' });
    await title(turn);
    expect(prompts).toEqual([
      { instructions: TITLE_INSTRUCTIONS, prompt: "User: Quali issue ho aperte?\n\nAssistant: Hai 3 issue aperte." },
    ]);
    expect(saved).toEqual([{ userId: "u1", sessionKey: "u1:a", title: "Issue aperte" }]);
  });

  it("writes the instructions in English and asks for the person's language", () => {
    expect(TITLE_INSTRUCTIONS).toContain("title");
    expect(TITLE_INSTRUCTIONS).toContain("language");
  });

  it("titles from the question alone when the answer has no words", async () => {
    const { title, prompts, saved } = setUp({});
    await title({ ...turn, answer: "  " });
    expect(prompts[0]!.prompt).toBe("User: Quali issue ho aperte?");
    expect(saved).toHaveLength(1);
  });

  it("cuts a long question and a long answer", async () => {
    const long = "a".repeat(OPENING_MAX_CHARS + 500);
    const { title, prompts } = setUp({});
    await title({ ...turn, question: long, answer: long });
    const a = "a".repeat(OPENING_MAX_CHARS);
    expect(prompts[0]!.prompt).toBe(`User: ${a}\n\nAssistant: ${a}`);
  });

  it("does nothing for a conversation that already has a title, generated or the person's", async () => {
    const { title, prompts, saved } = setUp({ existing: true });
    await title(turn);
    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("keeps the title the person chose while the model was answering", async () => {
    const { title, prompts, saved } = setUp({ arrivesMeanwhile: true });
    await title(turn);
    expect(prompts).toHaveLength(1);
    expect(saved).toEqual([]);
  });

  it("does nothing for a turn with nothing the person wrote", async () => {
    const { title, prompts, saved } = setUp({});
    await title({ ...turn, question: " " });
    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("saves nothing when the model answers nothing usable", async () => {
    const { title, saved } = setUp({ answer: '  ""  ' });
    await title(turn);
    expect(saved).toEqual([]);
  });

  // The title is enrichment: a model that can't be reached must leave the conversation as it was.
  it("logs and saves nothing when the model fails, without throwing", async () => {
    const { title, saved, logs } = setUp({
      answer: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await title(turn);
    expect(saved).toEqual([]);
    expect(logs).toEqual(["[titles] no title for u1:a: connect ECONNREFUSED"]);
  });

  it("generates once when asked twice for the same conversation at the same time", async () => {
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const { title, prompts, saved } = setUp({ answer: () => gate });
    const first = title(turn);
    const second = title(turn);
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
    await title(turn);
    await title(turn);
    expect(saved).toEqual([{ userId: "u1", sessionKey: "u1:a", title: "Issue aperte" }]);
  });
});
