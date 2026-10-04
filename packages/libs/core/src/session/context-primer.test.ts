import { describe, it, expect } from "bun:test";
import { buildContextPrimer, type ContextPrimerDeps } from "./context-primer.ts";
import type { EpisodicSummary } from "../memory/episodic-store.ts";

function inferredNote(fields: { confidence: string; derived_from: string[] }, body: string): string {
  const derivedFromYaml = fields.derived_from.map((ts) => `  - "${ts}"`).join("\n");
  return (
    `---\ntype: inferred\nsource: agent\nconfidence: ${fields.confidence}\n` +
    `derived_from:\n${derivedFromYaml}\nlast_reviewed: null\n---\n\n${body}\n`
  );
}

function resolvedNote(body: string): string {
  return `---\ntype: resolved\nsource: api\nresolved_at: "2026-01-01T00:00:00.000Z"\ndisplay_name: "${body}"\nemail: null\n---\n\n${body}\n`;
}

function confirmationNote(status: "pending" | "confirmed" | "failed"): string {
  return `---\ntype: confirmation\nstatus: ${status}\nrequested_at: "2026-07-27T12:20:00.000Z"\nresolved_at: null\ncommand: "jira issue delete KAN-1 --confirm"\n---\n\n`;
}

function fakeDeps(overrides: Partial<ContextPrimerDeps> = {}): ContextPrimerDeps {
  return {
    vaultPath: "/vault",
    getLastSessionEntries: async () => [],
    listWikiFilesInRootsFn: async () => [],
    readWikiFileInRootsFn: async () => "",
    readIndexFileFn: async () => "",
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
  it("returns an empty string when there's no prior session for the user", async () => {
    const deps = fakeDeps({ getLastSessionEntries: async () => [] });
    expect(await buildContextPrimer("google-chat:users/42", deps)).toBe("");
  });

  it("includes only wiki facts whose derived_from contains one of the last session's entry timestamps, excluding non-matching and provenance-less notes", async () => {
    let listCallArgs: unknown;
    const readCalls: Array<{ roots: string[]; file: string }> = [];
    const deps = fakeDeps({
      getLastSessionEntries: async () => [lastSessionEntry],
      listWikiFilesInRootsFn: async (vaultPath, roots) => {
        listCallArgs = { vaultPath, roots };
        // A real listWikiFilesInRoots scopes strictly by root — this fake
        // must too, now that buildContextPrimer also queries a second,
        // unrelated root (the person's confirmations/) for pending references.
        if (roots.some((r) => r.includes("confirmations"))) return [];
        return ["users/google-chat%3Ausers%2F42/inferred/role.md", "users/google-chat%3Ausers%2F42/inferred/team.md", "users/google-chat%3Ausers%2F42/inferred/resolved-name.md"];
      },
      readWikiFileInRootsFn: async (_vaultPath, roots, file) => {
        readCalls.push({ roots, file });
        if (file.endsWith("role.md")) {
          return inferredNote(
            { confidence: "high", derived_from: ["2026-07-25T18:00:00.000Z"] },
            "Backend engineer focused on the memory pipeline.",
          );
        }
        if (file.endsWith("team.md")) {
          // derived_from timestamp is from an unrelated, older occurrence —
          // this session's entry timestamp isn't in it, must be excluded.
          return inferredNote({ confidence: "medium", derived_from: ["2026-01-01T00:00:00.000Z"] }, "Platform team.");
        }
        // resolved-name.md: a "resolved" note, not "inferred" — no
        // derived_from field at all, must be excluded without crashing.
        return resolvedNote("Luca");
      },
    });

    const primer = await buildContextPrimer("google-chat:users/42", deps);

    expect(listCallArgs).toEqual({ vaultPath: "/vault", roots: ["/vault/users/google-chat%3Ausers%2F42/inferred"] });
    expect(readCalls).toHaveLength(3);
    expect(primer).toBe(
      "Known facts:\n- role: Backend engineer focused on the memory pipeline.\n\n" +
        "Last session:\n- Discussed KAN-1 rollout",
    );
  });

  it("omits the 'Known facts' section but still includes the session recap when no wiki facts match", async () => {
    const deps = fakeDeps({
      getLastSessionEntries: async () => [lastSessionEntry],
      listWikiFilesInRootsFn: async () => ["users/google-chat%3Ausers%2F42/inferred/team.md"],
      readWikiFileInRootsFn: async () =>
        inferredNote({ confidence: "medium", derived_from: ["2020-01-01T00:00:00.000Z"] }, "Platform team."),
    });

    const primer = await buildContextPrimer("google-chat:users/42", deps);

    expect(primer).toBe("Last session:\n- Discussed KAN-1 rollout");
  });

  it("joins multiple episodic entries from the same last session as separate bullets", async () => {
    const secondEntry: EpisodicSummary = {
      ...lastSessionEntry,
      summary: "Also fixed the login bug",
      timestamp: "2026-07-25T17:00:00.000Z",
    };
    const deps = fakeDeps({ getLastSessionEntries: async () => [lastSessionEntry, secondEntry] });

    const primer = await buildContextPrimer("google-chat:users/42", deps);

    expect(primer).toBe("Last session:\n- Discussed KAN-1 rollout\n- Also fixed the login bug");
  });

  it("scopes the wiki read to the person's own inferred/ folder, never curated/ or another person's", async () => {
    let receivedRoots: string[] | undefined;
    const deps = fakeDeps({
      getLastSessionEntries: async () => [lastSessionEntry],
      listWikiFilesInRootsFn: async (_vaultPath, roots) => {
        receivedRoots = roots;
        return [];
      },
    });

    await buildContextPrimer("google-chat:users/42", deps);

    expect(receivedRoots).toEqual(["/vault/users/google-chat%3Ausers%2F42/inferred"]);
  });

  it("returns just the recap (no crash) when the vault has no matching inferred files at all", async () => {
    const deps = fakeDeps({
      getLastSessionEntries: async () => [lastSessionEntry],
      listWikiFilesInRootsFn: async () => [],
    });

    expect(await buildContextPrimer("google-chat:users/42", deps)).toBe("Last session:\n- Discussed KAN-1 rollout");
  });

  // Regression guard for the stale-primer bug: a pending confirmation must
  // surface only as an opaque, non-narrative [REQ:<token>] marker — never
  // the command or the fact it's "still waiting" as prose the model could
  // react to on its own. Resolving it into something meaningful requires
  // deliberately calling resolve_reference (wiki-tools.ts) with the token.
  describe("Riferimenti aperti (pending confirmations)", () => {
    it("includes an opaque [REQ:<token>] marker for a pending confirmation note", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [lastSessionEntry],
        listWikiFilesInRootsFn: async (_vaultPath, roots) => {
          if (roots.some((r) => r.includes("confirmations"))) return ["users/google-chat%3Ausers%2F42/confirmations/j3h4b5.md"];
          return [];
        },
        readWikiFileInRootsFn: async (_vaultPath, roots) => (roots.some((r) => r.includes("confirmations")) ? confirmationNote("pending") : ""),
      });

      const primer = await buildContextPrimer("google-chat:users/42", deps);

      expect(primer).toContain("Riferimenti aperti:\n- [REQ:j3h4b5]");
      expect(primer).not.toContain("jira issue delete"); // opaque — no command text leaked into the primer
    });

    it("excludes confirmed/failed confirmation notes — only still-pending ones surface", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [lastSessionEntry],
        listWikiFilesInRootsFn: async (_vaultPath, roots) =>
          roots.some((r) => r.includes("confirmations"))
            ? ["users/google-chat%3Ausers%2F42/confirmations/tok1.md", "users/google-chat%3Ausers%2F42/confirmations/tok2.md"]
            : [],
        readWikiFileInRootsFn: async (_vaultPath, roots, file) => {
          if (!roots.some((r) => r.includes("confirmations"))) return "";
          return file.endsWith("tok1.md") ? confirmationNote("confirmed") : confirmationNote("failed");
        },
      });

      const primer = await buildContextPrimer("google-chat:users/42", deps);

      expect(primer).not.toContain("Riferimenti aperti");
    });

    it("surfaces pending references even when there's no last-session episodic recap at all", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [],
        listWikiFilesInRootsFn: async (_vaultPath, roots) =>
          roots.some((r) => r.includes("confirmations")) ? ["users/google-chat%3Ausers%2F42/confirmations/j3h4b5.md"] : [],
        readWikiFileInRootsFn: async () => confirmationNote("pending"),
      });

      const primer = await buildContextPrimer("google-chat:users/42", deps);

      expect(primer).toBe("Riferimenti aperti:\n- [REQ:j3h4b5]");
    });

    it("scopes the confirmations lookup to the person's own confirmations/ folder", async () => {
      let confirmationsRoots: string[] | undefined;
      const deps = fakeDeps({
        getLastSessionEntries: async () => [],
        listWikiFilesInRootsFn: async (_vaultPath, roots) => {
          if (roots.some((r) => r.includes("confirmations"))) confirmationsRoots = roots;
          return [];
        },
      });

      await buildContextPrimer("google-chat:users/42", deps);

      expect(confirmationsRoots).toEqual(["/vault/users/google-chat%3Ausers%2F42/confirmations"]);
    });
  });

  describe("Wiki index", () => {
    it("includes the wiki index's actual content, not just a reference to it, even with no prior session", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [],
        readIndexFileFn: async () => "- [[standards/jira-fields]] — custom field conventions\n",
      });

      const primer = await buildContextPrimer("google-chat:users/42", deps);

      expect(primer).toBe("Wiki index:\n- [[standards/jira-fields]] — custom field conventions");
    });

    it("omits the section entirely when index.md is empty or missing", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [],
        readIndexFileFn: async () => "",
      });

      expect(await buildContextPrimer("google-chat:users/42", deps)).toBe("");
    });

    it("places the wiki index before the per-user sections", async () => {
      const deps = fakeDeps({
        getLastSessionEntries: async () => [lastSessionEntry],
        readIndexFileFn: async () => "- [[glossary]] — team glossary\n",
      });

      const primer = await buildContextPrimer("google-chat:users/42", deps);

      expect(primer).toBe(
        "Wiki index:\n- [[glossary]] — team glossary\n\n" + "Last session:\n- Discussed KAN-1 rollout",
      );
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
        readIndexFileFn: async () => "- [[glossary]] — team glossary\n",
        listWikiFilesInRootsFn: async (_vaultPath, roots) =>
          roots.some((r) => r.includes("confirmations")) ? ["users/google-chat%3Ausers%2F42/confirmations/j3h4b5.md"] : [],
        readWikiFileInRootsFn: async (_vaultPath, roots) => (roots.some((r) => r.includes("confirmations")) ? confirmationNote("pending") : ""),
        log: (m) => logs.push(m),
      });

      const primer = await buildContextPrimer("google-chat:users/42", deps);

      // The wiki index and the pending confirmations survive; only the recap goes.
      expect(primer).toContain("Wiki index:\n- [[glossary]] — team glossary");
      expect(primer).toContain("Riferimenti aperti:\n- [REQ:j3h4b5]");
      expect(primer).not.toContain("Last session:");
      expect(logs).toEqual(["last session for google-chat:users/42 unavailable, primer built without it: Error: ConnectionRefused"]);
    });
  });
});
