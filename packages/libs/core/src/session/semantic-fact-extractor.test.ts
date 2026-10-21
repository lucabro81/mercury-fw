import { describe, it, expect } from "bun:test";
import { createSemanticFactExtractor, SemanticFactSchema, type SemanticFact } from "./semantic-fact-extractor.ts";
import type { LanguageModel } from "ai";
import type { Message } from "./history.ts";

const MODEL = "fake-model" as unknown as LanguageModel;

const MESSAGES: Message[] = [
  { role: "user", content: "preferisco che le risposte siano in italiano" },
  { role: "assistant", content: "ok, risponderò in italiano" },
];

describe("createSemanticFactExtractor", () => {
  it("returns the facts produced by generateObjectFn", async () => {
    const facts: SemanticFact[] = [{ topic: "role", value: "developer" }];
    const generateObjectFn = async () => ({ object: facts });

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    const result = await extract(MESSAGES);

    expect(result).toEqual(facts);
  });

  it("passes the model and the joined messages through unchanged", async () => {
    let received: { model: LanguageModel; prompt: string } | undefined;
    const generateObjectFn = async (params: { model: LanguageModel; prompt: string }) => {
      received = params;
      return { object: [] };
    };

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    await extract(MESSAGES);

    expect(received?.model).toBe(MODEL);
    expect(received?.prompt).toContain("preferisco che le risposte siano in italiano");
    expect(received?.prompt).toContain("ok, risponderò in italiano");
  });

  it("returns an empty array when nothing qualifies", async () => {
    const generateObjectFn = async () => ({ object: [] });

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    const result = await extract(MESSAGES);

    expect(result).toEqual([]);
  });

  // The system prompt is what keeps this from extracting one-off task
  // details as if they were standing facts about the user.
  it("instructs the model to extract only stable, standing facts — not one-off task details", async () => {
    let received: { instructions: string } | undefined;
    const generateObjectFn = async (params: { instructions: string }) => {
      received = params;
      return { object: [] };
    };

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    await extract(MESSAGES);

    expect(received?.instructions.toLowerCase()).toMatch(/stable|recurring/);
    // Model-facing prompts are written in English.
    expect(received?.instructions).not.toMatch(/utente|conversazione|restituisci/i);
  });

  // Point 5: identity/name is already available directly from a
  // registered Chat app's own MESSAGE event (sender.displayName) — a
  // semantic fact about "who the user is" would only ever duplicate or
  // contradict that more authoritative source, never add anything.
  it("instructs the model not to extract the user's identity/name", async () => {
    let received: { instructions: string } | undefined;
    const generateObjectFn = async (params: { instructions: string }) => {
      received = params;
      return { object: [] };
    };

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    await extract(MESSAGES);

    expect(received?.instructions.toLowerCase()).toMatch(/identity|name/);
  });

  // Point 4: index.ts prepends "[Da: <name>]" to every user message before
  // it reaches history — a bookkeeping marker Mercury wrote itself, not
  // something the user said. Left in, the extractor mistakes the repeated
  // marker for a "stable, recurring fact" (this is exactly how the
  // duplicate name/user-name topics happened live).
  it("strips the '[Da: <name>]' sender marker from user messages before building the prompt", async () => {
    let received: { prompt: string } | undefined;
    const generateObjectFn = async (params: { prompt: string }) => {
      received = params;
      return { object: [] };
    };

    const markedMessages: Message[] = [
      { role: "user", content: "[Da: Luca Brognara]\npreferisco che le risposte siano in italiano" },
      { role: "assistant", content: "ok, risponderò in italiano" },
    ];

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    await extract(markedMessages);

    expect(received?.prompt).not.toContain("[Da:");
    expect(received?.prompt).not.toContain("Luca Brognara");
    expect(received?.prompt).toContain("preferisco che le risposte siano in italiano");
  });

  // #293: the core stamps every turn with when it was written, before the
  // sender marker; the time repeating in every turn isn't a fact either.
  it("strips the turn's stamp, then the sender marker, from user messages", async () => {
    let received: { prompt: string } | undefined;
    const generateObjectFn = async (params: { prompt: string }) => {
      received = params;
      return { object: [] };
    };

    const extract = createSemanticFactExtractor(MODEL, generateObjectFn);
    await extract([
      { role: "user", content: "[Wednesday 2026-10-21 14:32 Europe/Rome]\n[Da: Luca Brognara]\nlavoro nel team piattaforma" },
      { role: "user", content: "[Wednesday 2026-10-21 14:40 Europe/Rome]\nuso Jira" },
    ]);

    expect(received?.prompt).toBe("user: lavoro nel team piattaforma\nuser: uso Jira");
  });
});

describe("SemanticFactSchema", () => {
  // Point 3: a closed vocabulary eliminates topic drift at the source —
  // the model can no longer invent a new key ("name" vs "user-name") for
  // the same concept, since only these exact values are valid output.
  it("accepts only the closed set of known topics", () => {
    for (const topic of ["team", "role", "tools-used"]) {
      expect(SemanticFactSchema.safeParse({ topic, value: "x" }).success).toBe(true);
    }
  });

  // #279: the person's language is a profile setting they choose
  // (`set_preferred_language`); a language inferred from conversations would
  // only compete with it.
  it("has no topic for the person's language", () => {
    expect(SemanticFactSchema.safeParse({ topic: "preferred-language", value: "italiano" }).success).toBe(false);
  });

  // Point 5: identity/name is deliberately not part of the enum — see the
  // system-prompt test above for why.
  it("rejects identity-shaped topics and anything else outside the closed set", () => {
    for (const topic of ["name", "user-name", "identity", "email", "Team"]) {
      expect(SemanticFactSchema.safeParse({ topic, value: "x" }).success).toBe(false);
    }
  });
});
