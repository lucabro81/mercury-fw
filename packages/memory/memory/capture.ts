/**
 * How a session's messages become memory: an episodic summary of what was
 * said, asked and decided, and the standing facts about the person found in
 * them, kept in the vector index and, with a wiki, promoted to the person's
 * notes (`captureToMemory`). The messages wait in a buffer per session and
 * person (`createSessionBuffers`) until there are enough of them, or the
 * session closes.
 */
import type { ConsolidationDecision } from "@mercury-fw/wiki";
import type { EpisodicSummary } from "./episodic-store.ts";
import type { Message } from "./messages.ts";
import type { SemanticFact } from "./semantic-fact-extractor.ts";
import type { SemanticFactEntry } from "./semantic-facts-store.ts";

export type CaptureDeps = {
  summarize: (messages: Message[]) => Promise<string>;
  storeSummary: (entry: EpisodicSummary) => Promise<void>;
  extractFacts: (messages: Message[]) => Promise<SemanticFact[]>;
  storeFact: (entry: SemanticFactEntry) => Promise<void>;
  /** Promotes the person's fact on `topic` to their wiki note; absent without a wiki. */
  promoteFact?: (userId: string, topic: string) => Promise<ConsolidationDecision>;
  log: (msg: string) => void;
  /** Test seam; defaults to `() => new Date()`. */
  now?: () => Date;
};

/**
 * Summarizes and keeps `messages` of the person `userId` in `sessionKey`, then
 * extracts, keeps and promotes the facts in them. A summary that can't be
 * made or kept rejects; the facts are enrichment, and their failure is only
 * logged. The summary and the facts share one timestamp, which the recap uses
 * to tell which facts a session reinforced.
 */
export async function captureToMemory(userId: string, sessionKey: string, messages: Message[], deps: CaptureDeps): Promise<void> {
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const summary = await deps.summarize(messages);
  await deps.storeSummary({ userId, sessionKey, summary, timestamp });
  let facts: SemanticFact[];
  try {
    facts = await deps.extractFacts(messages);
  } catch (err) {
    deps.log(`[memory] facts not extracted for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const fact of facts) {
    try {
      await deps.storeFact({ userId, topic: fact.topic, value: fact.value, timestamp });
      if (deps.promoteFact) deps.log(`[memory] fact ${fact.topic} for ${sessionKey}: ${await deps.promoteFact(userId, fact.topic)}`);
    } catch (err) {
      deps.log(`[memory] fact ${fact.topic} for ${sessionKey} not kept: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type SessionBuffersDeps = {
  /** How many messages of a person in a session make a capture. */
  threshold: number;
  capture: (person: string, sessionKey: string, messages: Message[]) => Promise<void>;
  /** Runs a capture as work nobody waits on. */
  job: (fn: () => Promise<void>) => Promise<void>;
  log: (msg: string) => void;
};

export type SessionBuffers = {
  /** Adds `messages` of `person` in `sessionKey`, capturing them once there are `threshold`. */
  add: (sessionKey: string, person: string, messages: Message[]) => Promise<void>;
  /** Captures what's left of every person of `sessionKey`, and forgets the session. */
  close: (sessionKey: string) => Promise<void>;
  /** How many messages of `person` in `sessionKey` wait for a capture. */
  pending: (sessionKey: string, person: string) => number;
};

/** The buffers of the sessions open (see the module comment). */
export function createSessionBuffers(deps: SessionBuffersDeps): SessionBuffers {
  // Per session, per person: the messages not captured yet, and whether a capture of them runs.
  const sessions = new Map<string, Map<string, { messages: Message[]; capturing: boolean }>>();

  /** Captures what `buffer` holds now; on success drops those messages, on failure keeps them. */
  async function flush(sessionKey: string, person: string, buffer: { messages: Message[]; capturing: boolean }): Promise<void> {
    if (buffer.capturing || buffer.messages.length === 0) return;
    buffer.capturing = true;
    const taken = buffer.messages.length;
    try {
      await deps.job(() => deps.capture(person, sessionKey, buffer.messages.slice(0, taken)));
      buffer.messages.splice(0, taken);
    } catch (err) {
      deps.log(`[memory] capture of ${sessionKey} failed, kept for the next one: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      buffer.capturing = false;
    }
  }

  return {
    add: async (sessionKey, person, messages) => {
      const people = sessions.get(sessionKey) ?? new Map();
      sessions.set(sessionKey, people);
      const buffer = people.get(person) ?? { messages: [], capturing: false };
      people.set(person, buffer);
      buffer.messages.push(...messages);
      if (buffer.messages.length >= deps.threshold) await flush(sessionKey, person, buffer);
    },
    close: async (sessionKey) => {
      const people = sessions.get(sessionKey);
      if (people === undefined) return;
      sessions.delete(sessionKey);
      for (const [person, buffer] of people) await flush(sessionKey, person, buffer);
    },
    pending: (sessionKey, person) => sessions.get(sessionKey)?.get(person)?.messages.length ?? 0,
  };
}
