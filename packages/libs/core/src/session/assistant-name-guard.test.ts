/**
 * #222: the persona said "You are Poc", but the core's own tool texts kept
 * calling the assistant "Mercury", and the model took that for its own name.
 * Every tool the core gives the model is built here, as a turn would get it,
 * and none of them may name Mercury: a new text that does fails this test.
 * Plugins guard their own texts in their packages.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { createWikiTools } from "../wiki/wiki-tools.ts";
import { createToolLogRecallTool } from "./tool-log-recall-tool.ts";
import { createReadSkillTool } from "./read-skill-tool.ts";
import { createPresentTool } from "../tools/present-tool.ts";
import { createDisplayStore } from "../tools/display-store.ts";
import { createVerbatimArchiveProvider } from "../memory/memory-provider.ts";
import { actingAsSelf } from "../plugins/act-as-self.ts";
import { toolsWithAssistantName } from "./assistant-name.ts";
import { createProfileTools } from "../identity/profile-tools.ts";

/** Every tool the core builds for a turn, before the core substitutes the name. */
function coreTools(): Record<string, Tool> {
  const vaultPath = mkdtempSync(join(tmpdir(), "assistant-name-guard-"));
  const pluginTool = tool({ description: "Runs a jira command.", inputSchema: z.object({}), execute: async () => "ran" });
  return {
    ...createWikiTools({ vaultPath, key: "static:alice", stageConfirmation: async () => ({ token: "t", summary: "s" }) as never }),
    ...createToolLogRecallTool({ sessionKey: "s", owner: "static:alice" }),
    ...createProfileTools({ store: { nameOf: () => undefined, setName: (_k, n) => n, languageOf: () => undefined, setLanguage: (_k, l) => l }, key: "static:alice" }),
    ...createReadSkillTool([{ name: "jira", description: "Jira.", body: "body" }]),
    ...createPresentTool({ sessionKey: "s", store: createDisplayStore() }),
    ...createVerbatimArchiveProvider({ client: {} as never, collectionName: "c", embed: async () => [] }).sessionTools!({
      sessionKey: "s",
      userId: "static:alice",
    }),
    ...actingAsSelf({ jiraCommand: pluginTool }, { plugin: "jira", personKey: "static:alice", rename: true, log: () => {} }),
  };
}

describe("the core's tools and the assistant's name", () => {
  it("never name Mercury in a description", () => {
    for (const [name, t] of Object.entries(toolsWithAssistantName(coreTools(), "Poc"))) {
      expect({ name, description: t.description ?? "" }).not.toEqual(
        expect.objectContaining({ description: expect.stringContaining("Mercury") }),
      );
    }
  });

  it("never name Mercury in a tool's name", () => {
    for (const name of Object.keys(coreTools())) expect(name).not.toContain("Mercury");
  });
});
