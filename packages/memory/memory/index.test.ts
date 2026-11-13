import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, type ContextRequest, type FinishedTurn, type PluginRuntimeContext, type SessionToolContext, type TurnRecord } from "@mercury-fw/plugin-types";
import type { WikiFact } from "@mercury-fw/wiki";
import { memory, MEMORY_PROMPT_FRAGMENT, RECAP_INTRO, type MemoryOptions } from "./index.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

/** A model answering facts when asked for JSON and a summary otherwise, recording who called it. */
function fakeModel(id: string, used: string[], prompts: string[] = []) {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    doGenerate: async (opts: { responseFormat?: { type: string }; prompt?: unknown }) => {
      used.push(id);
      prompts.push(JSON.stringify(opts.prompt));
      const text = opts.responseFormat?.type === "json" ? JSON.stringify({ elements: [{ topic: "team", value: "platform" }] }) : "They asked about KAN-1.";
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("not streamed");
    },
  };
}

/** `memory()` built on a fake index, its jobs recorded and run at once. */
async function setUp(
  opts: {
    facts?: WikiFact[];
    captureEvery?: number;
    index?: ReturnType<typeof fakeVectorIndex>;
    /** The options as given to `memory()`, in place of the defaults below. */
    options?: MemoryOptions;
    env?: Record<string, string>;
    timeZone?: string;
  } = {},
) {
  const index = opts.index ?? fakeVectorIndex();
  const used: string[] = [];
  const prompts: string[] = [];
  const jobs: string[] = [];
  const logs: string[] = [];
  const promoted: string[] = [];
  const plugin = memory(
    opts.options ?? {
      captureEvery: opts.captureEvery ?? 4,
      wiki: {
        notes: {
          promoteFact: async (key, topic) => (promoted.push(`${key}/${topic}`), "written"),
          facts: async () => opts.facts ?? [],
        },
      },
    },
  );
  const ctx = {
    model: fakeModel("turn", used),
    backgroundModel: fakeModel("background", used, prompts),
    env: opts.env ?? {},
    log: (m: string) => void logs.push(m),
    vectorIndex: index,
    embed: async () => [1, 0, 0],
    job: async <T,>(name: string, urgency: string, fn: () => Promise<T>) => (jobs.push(`${name}:${urgency}`), fn()),
    profiles: { timeZoneOf: () => ("timeZone" in opts ? opts.timeZone : "Europe/Rome") },
  } as unknown as PluginRuntimeContext;
  const built = await plugin.build!(ctx);
  return { plugin, built, index, used, prompts, jobs, logs, promoted };
}

const turn = (overrides: Partial<FinishedTurn> = {}): FinishedTurn => ({
  sessionKey: "s1",
  person: { key: "static:alice" },
  operator: false,
  as: "anyone",
  input: "What's open on KAN?",
  answer: "Two issues.",
  calls: [],
  multiUser: false,
  ...overrides,
});

const payloads = (index: ReturnType<typeof fakeVectorIndex>, space: string) => (index.spaces.get(space) ?? []).map((p) => p.payload);

describe("memory", () => {
  it("is a plugin acting as no one, needing the vector index and the embedding model, describing recall_verbatim", () => {
    const plugin = memory();
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("memory");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toEqual(["vectorIndex", "embedding"]);
    expect(plugin.systemPromptFragment).toBe(MEMORY_PROMPT_FRAGMENT);
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  // The model read this block in the core's system prompt before #393, word for word.
  it("tells the model about recall_verbatim as the core did", () => {
    expect(MEMORY_PROMPT_FRAGMENT).toBe(
      [
        "You have access to the recall_verbatim tool.",
        "DO:",
        "- If asked about something said in an EARLIER conversation — beyond what you can see in this one — call recall_verbatim to retrieve the actual past messages and quote them, don't reconstruct from memory. This searches a durable archive of what you and this person really said before.",
        "- Use it only for what was said in past conversations, never for what you ran in the CURRENT one.",
      ].join("\n"),
    );
  });

  describe("the episodes", () => {
    it("captures a person's conversation every few messages, as a job on the background model: the summary, the facts, their promotion", async () => {
      const { built, index, used, jobs, promoted } = await setUp();
      await built.afterTurn!(turn());
      expect(jobs).toEqual([]);
      await built.afterTurn!(turn({ input: "And KAN-2?", answer: "Done." }));
      expect(jobs).toEqual(["capture:idle"]);
      expect(used.every((id) => id === "background")).toBe(true);
      expect(payloads(index, "episodic_memory")).toEqual([
        { userId: "static:alice", sessionKey: "s1", summary: "They asked about KAN-1.", timestamp: expect.any(String) },
      ]);
      expect(payloads(index, "semantic_facts")).toEqual([{ userId: "static:alice", topic: "team", value: "platform", timestamp: expect.any(String) }]);
      expect(promoted).toEqual(["static:alice/team"]);
    });

    it("captures what's left when the conversation closes", async () => {
      const { built, index, jobs } = await setUp();
      await built.afterTurn!(turn());
      await built.onSessionClose!({ sessionKey: "s1", person: { key: "static:alice" }, messages: [] });
      expect(jobs).toEqual(["capture:idle"]);
      expect(payloads(index, "episodic_memory")).toHaveLength(1);
    });

    // The operator holds the container: nothing of theirs is remembered, as before.
    it("remembers nothing of the operator's turns", async () => {
      const { built, jobs } = await setUp({ captureEvery: 1 });
      await built.afterTurn!(turn({ operator: true }));
      expect(jobs).toEqual([]);
    });

    // The summary quotes a date only from the stamp, as the core puts it before the person's message.
    it("stamps the person's messages with when and where, in their time zone, for the summary", async () => {
      const { built, prompts } = await setUp();
      await built.afterTurn!(turn());
      await built.afterTurn!(turn());
      expect(prompts[0]).toMatch(/user: \[[A-Z][a-z]+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Rome\]\\nWhat's open on KAN\?/);
    });

    it("stamps in the machine's time zone for a person who saved none", async () => {
      const { built, prompts } = await setUp({ timeZone: undefined });
      await built.afterTurn!(turn());
      await built.afterTurn!(turn());
      expect(prompts[0]).toContain(`${Intl.DateTimeFormat().resolvedOptions().timeZone}]\\nWhat's open on KAN?`);
    });
  });

  describe("how often it captures", () => {
    /** Turns of alice until the first capture: each one is two messages. */
    async function turnsUntilCapture(opts: Parameters<typeof setUp>[0]): Promise<number> {
      const { built, jobs } = await setUp(opts);
      for (let n = 1; n <= 10; n++) {
        await built.afterTurn!(turn());
        if (jobs.length > 0) return n;
      }
      return -1;
    }

    it("every 6 messages by default: three turns", async () => {
      expect(await turnsUntilCapture({ options: {} })).toBe(3);
    });

    it("every SESSION_CAPTURE_MESSAGE_THRESHOLD messages without captureEvery, and captureEvery wins over it", async () => {
      expect(await turnsUntilCapture({ options: {}, env: { SESSION_CAPTURE_MESSAGE_THRESHOLD: "2" } })).toBe(1);
      expect(await turnsUntilCapture({ options: { captureEvery: 8 }, env: { SESSION_CAPTURE_MESSAGE_THRESHOLD: "2" } })).toBe(4);
    });
  });

  describe("without a wiki", () => {
    it("keeps the facts in the index only, and the recap has no known facts", async () => {
      const index = fakeVectorIndex();
      const { built, promoted } = await setUp({ index, options: { captureEvery: 4 } });
      await built.afterTurn!(turn());
      await built.afterTurn!(turn());
      expect(payloads(index, "semantic_facts")).toHaveLength(1);
      expect(promoted).toEqual([]);
      const [recap] = (await built.context!.build({
        sessionKey: "s2",
        person: { key: "static:alice" },
        operator: false,
        as: "anyone",
        input: "hi",
        multiUser: false,
        knobs: {},
        reopened: false,
      }))!;
      expect(recap).toContain("Last session:");
      expect(recap).not.toContain("Known facts");
    });
  });

  describe("recall_verbatim", () => {
    const record: TurnRecord = {
      sessionKey: "s1",
      person: { key: "static:alice" },
      operator: false,
      as: "anyone",
      kind: "turn",
      turnId: "t1",
      multiUser: false,
      outcome: "done",
      origin: "person",
      input: "What's open on KAN?",
      startedAt: "2026-11-13T10:00:00.000Z",
      endedAt: "2026-11-13T10:00:05.000Z",
      answer: { content: "Two issues." },
    };

    it("indexes what each turn leaves, as a job, and nothing of the operator's", async () => {
      const { built, index, jobs } = await setUp();
      await built.onTurnRecord!(record);
      await built.onTurnRecord!({ ...record, operator: true });
      // The indexing is background work nobody waits on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(jobs).toEqual(["archive-index:soon", "archive-index:soon"]);
      expect(payloads(index, "verbatim_archive").map((p) => p.role)).toEqual(["user", "assistant"]);
    });

    it("gives the person recall_verbatim, finding their messages, and nothing to a turn acting as nobody", async () => {
      const { built } = await setUp();
      await built.onTurnRecord!(record);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const tools = built.sessionTools!({ sessionKey: "s1", person: { key: "static:alice" } } as unknown as SessionToolContext);
      const found = (await tools.recall_verbatim!.execute!({ query: "KAN" }, {} as never)) as { messages: Array<{ content: string }> };
      expect(found.messages.map((m) => m.content).sort()).toEqual(["Two issues.", "What's open on KAN?"]);
      expect(built.sessionTools!({ sessionKey: "s1", person: null } as unknown as SessionToolContext)).toEqual({});
    });
  });

  describe("the recap layer", () => {
    const request = (overrides: Partial<ContextRequest> = {}): ContextRequest => ({
      sessionKey: "s2",
      person: { key: "static:alice" },
      operator: false,
      as: "anyone",
      input: "hi",
      multiUser: false,
      knobs: {},
      reopened: false,
      ...overrides,
    });

    it("gives a new conversation the last one's summaries and the facts it reinforced, as background", async () => {
      const index = fakeVectorIndex();
      const first = await setUp({ index });
      await first.built.afterTurn!(turn());
      await first.built.afterTurn!(turn());
      const at = String(payloads(index, "episodic_memory")[0]!.timestamp);
      const { built } = await setUp({
        index,
        facts: [
          { topic: "team", body: "platform", derivedFrom: [at] },
          { topic: "role", body: "old news", derivedFrom: ["2020-01-01T00:00:00.000Z"] },
        ],
      });
      expect(built.context!.scope).toBe("session");
      expect(await built.context!.build(request())).toEqual([
        [RECAP_INTRO, "Known facts:\n- team: platform", "Last session:\n- They asked about KAN-1.", "Don't bring it up unless the person refers to it, never present it as current, and read any data from a service again with its tool."].join("\n"),
      ]);
    });

    it("adds nothing to a conversation its client reopened, to the operator, or without a past session", async () => {
      const index = fakeVectorIndex();
      const first = await setUp({ index });
      await first.built.afterTurn!(turn());
      await first.built.afterTurn!(turn());
      expect(await first.built.context!.build(request({ reopened: true }))).toEqual([]);
      expect(await first.built.context!.build(request({ operator: true }))).toEqual([]);
      expect(await first.built.context!.build(request({ person: { key: "static:bob" } }))).toEqual([]);
    });
  });

  describe("the summaries of a reopened conversation (conversationWindow's earlier)", () => {
    it("reads one conversation's summaries, oldest first", async () => {
      const { plugin, built } = await setUp();
      await built.afterTurn!(turn());
      await built.afterTurn!(turn());
      expect(await plugin.summariesOf({ person: "static:alice", sessionKey: "s1" })).toEqual([
        { summary: "They asked about KAN-1.", timestamp: expect.any(String) },
      ]);
    });

    it("has none before it's built", async () => {
      expect(await memory().summariesOf({ person: "static:alice", sessionKey: "s1" })).toEqual([]);
    });
  });

  it("makes its spaces as long as the embedding model's vectors, and moves a legacy id onto its user key", async () => {
    const index = fakeVectorIndex({ episodic_memory: [{ id: "p", vector: [1, 0, 0], payload: { userId: "users/42", sessionKey: "x", summary: "s", timestamp: "t" } }] });
    const { built } = await setUp({ index });
    await built.afterTurn!(turn({ person: { key: "static:carol" } }));
    await built.afterTurn!(turn({ person: { key: "static:carol" } }));
    expect(index.specs.get("episodic_memory")?.dimensions).toBe(3);
    expect(index.specs.get("semantic_facts")?.dimensions).toBe(3);
    expect(index.specs.get("verbatim_archive")?.dimensions).toBe(3);
    expect(payloads(index, "episodic_memory").map((p) => p.userId)).toContain("google-chat:users/42");
  });
});
