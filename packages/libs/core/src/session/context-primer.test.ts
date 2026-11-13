import { describe, it, expect } from "bun:test";
import { buildContextPrimer, primerOptions, type ContextPrimer, type ContextPrimerDeps } from "./context-primer.ts";
import type { EpisodicSummary } from "../memory/episodic-store.ts";

/** Both parts of a primer as one text, current state first. */
const all = (p: ContextPrimer): string => [p.current, p.recap].filter(Boolean).join("\n\n");

function fakeDeps(overrides: Partial<ContextPrimerDeps> = {}): ContextPrimerDeps {
  return {
    getLastSessionEntries: async () => [],
    pendingTokens: async () => [],
    log: () => {},
    ...overrides,
  };
}

const lastSessionEntry: EpisodicSummary = {
  userId: "google-chat:users/42",
  sessionKey: "spaces/X:users/42:session-1",
  summary: "Discussed KAN-1 rollout",
  timestamp: "2026-07-25T18:00:00.000Z",
};

describe("buildContextPrimer", () => {
  it("is empty when there's no prior session and nothing pending", async () => {
    expect(await buildContextPrimer("google-chat:users/42", fakeDeps())).toEqual({ current: "", recap: "" });
  });

  it("recaps the last session's entries, asked for the person's own", async () => {
    const asked: string[] = [];
    const second = { ...lastSessionEntry, summary: "Agreed on the release date" };
    const deps = fakeDeps({ getLastSessionEntries: async (key) => (asked.push(key), [lastSessionEntry, second]) });

    expect(await buildContextPrimer("google-chat:users/42", deps)).toEqual({
      current: "",
      recap: "Last session:\n- Discussed KAN-1 rollout\n- Agreed on the release date",
    });
    expect(asked).toEqual(["google-chat:users/42"]);
  });

  // Regression guard for the stale-primer bug: a pending confirmation must
  // surface only as an opaque, non-narrative [REQ:<token>] marker — never
  // the command or the fact it's "still waiting" as prose the model could
  // react to on its own. Resolving it into something meaningful requires
  // deliberately calling resolve_reference (tools/resolve-reference-tool.ts) with the token.
  describe("Open references (pending confirmations)", () => {
    it("includes an opaque [REQ:<token>] marker for each pending confirmation", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [lastSessionEntry],
        pendingTokens: async () => ["j3h4b5", "k9m2"],
      });

      expect((await buildContextPrimer("google-chat:users/42", deps)).current).toBe("Open references:\n- [REQ:j3h4b5]\n- [REQ:k9m2]");
    });

    it("has no section when nothing is pending", async () => {
      const deps = fakeDeps({ getLastSessionEntries: async () => [lastSessionEntry], pendingTokens: async () => [] });

      expect(all(await buildContextPrimer("google-chat:users/42", deps))).not.toContain("Open references");
    });

    it("surfaces pending references even when there's no last-session episodic recap at all", async () => {
      const deps = fakeDeps({ getLastSessionEntries: async () => [], pendingTokens: async () => ["j3h4b5"] });

      expect(all(await buildContextPrimer("google-chat:users/42", deps))).toBe("Open references:\n- [REQ:j3h4b5]");
    });

    it("asks for the person's own pending tokens", async () => {
      const asked: string[] = [];
      const deps = fakeDeps({ pendingTokens: async (key) => (asked.push(key), []) });

      await buildContextPrimer("google-chat:users/42", deps);

      expect(asked).toEqual(["google-chat:users/42"]);
    });
  });

  // Regression (#68): the last-session query hits Qdrant with no catch, so while
  // Qdrant was down the first turn of every new tracked session failed.
  describe("Qdrant unreachable", () => {
    it("builds the primer without the recap and logs why", async () => {
      const logs: string[] = [];
      const deps = fakeDeps({
        getLastSessionEntries: async () => {
          throw new Error("ConnectionRefused");
        },
        pendingTokens: async () => ["j3h4b5"],
        log: (m) => logs.push(m),
      });

      const primer = all(await buildContextPrimer("google-chat:users/42", deps));

      // The pending confirmations survive; only the recap goes.
      expect(primer).toBe("Open references:\n- [REQ:j3h4b5]");
      expect(logs).toEqual(["last session for google-chat:users/42 unavailable, primer built without it: Error: ConnectionRefused"]);
    });
  });
});

// #233: on a channel where the person opens and reopens conversations at will,
// a new conversation is a fresh start. The last one's recap brought in data
// nobody asked for, so it stays out.
describe("buildContextPrimer without the last session", () => {
  it("keeps the pending refs and leaves out the recap", async () => {
    let askedForLastSession = false;
    const deps = fakeDeps({
      getLastSessionEntries: async () => ((askedForLastSession = true), [lastSessionEntry]),
      pendingTokens: async () => ["tok-1"],
    });
    const primer = all(await buildContextPrimer("google-chat:users/42", deps, { lastSession: false }));
    expect(primer).toBe("Open references:\n- [REQ:tok-1]");
    expect(askedForLastSession).toBe(false);
  });

  it("is empty when there's nothing else", async () => {
    const deps = fakeDeps({ getLastSessionEntries: async () => [lastSessionEntry] });
    expect(all(await buildContextPrimer("google-chat:users/42", deps, { lastSession: false }))).toBe("");
  });
});

// Review of #233: the primer holds two different things. What is current (the
// confirmations still pending) the model must use as is; only the recap of an
// earlier conversation is background that may be out of date.
describe("buildContextPrimer: current state and recap apart", () => {
  it("puts the pending refs in current, the last session in recap", async () => {
    const deps = fakeDeps({
      getLastSessionEntries: async () => [lastSessionEntry],
      pendingTokens: async () => ["tok-1"],
    });
    expect(await buildContextPrimer("google-chat:users/42", deps)).toEqual({
      current: "Open references:\n- [REQ:tok-1]",
      recap: "Last session:\n- Discussed KAN-1 rollout",
    });
  });
});

// #233: the wiring that decides it. A conversation its client reopens at will
// (HTTP, `resume` set, even empty) starts without the last one.
describe("primerOptions", () => {
  it("leaves the last session out of a conversation the client reopens", () => {
    expect(primerOptions({})).toEqual({ lastSession: false });
    expect(primerOptions({ maxChars: 500 })).toEqual({ lastSession: false });
  });

  it("keeps it on a single running stream", () => {
    expect(primerOptions(undefined)).toEqual({ lastSession: true });
  });
});
