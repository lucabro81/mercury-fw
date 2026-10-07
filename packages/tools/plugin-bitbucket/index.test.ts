import { describe, it, expect } from "bun:test";
import { PLUGIN_API_VERSION, type SessionToolContext } from "@mercury-fw/plugin-types";
import { bitbucketPlugin } from "./index.ts";

/**
 * Bitbucket is the second plugin and the validation that the `Plugin` contract
 * isn't Jira-shaped: it's the minimal CLI-based case — it owns its tool via the
 * engine, with no post-processors, no guard, and no prompt fragment of its own.
 * This test pins that minimality: a `build()` that contributes exactly the
 * `bitbucketCommand` tool and its status describer, nothing else.
 */
const sctx: SessionToolContext = {
  sessionKey: "s",
  stageConfirmation: async () => "tok",
  stashDisplay: () => "d1",
  person: null,
  requireLogin: async () => ({ ok: false, error: "x" }),
};

describe("bitbucketPlugin", () => {
  it("declares the compatible apiVersion and the bitbucket name", () => {
    expect(bitbucketPlugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(bitbucketPlugin.name).toBe("bitbucket");
  });

  // #176: Bitbucket acts as the person, who logs in through the consumer whose
  // callback is Mercury's, so no redirect URI goes on the command line.
  it("acts as the person and logs them in without a redirect URI", () => {
    expect(bitbucketPlugin.actsAs).toBe("person");
    expect(typeof bitbucketPlugin.build!({ model: {} as never, env: {}, log: () => {} }).login?.start).toBe("function");
  });

  it("contributes only its own tool — no prompt fragment, no surfaces, no post-processors, no guard", () => {
    expect(bitbucketPlugin.systemPromptFragment).toBeUndefined();
    expect(bitbucketPlugin.surfaces).toBeUndefined();
    const c = bitbucketPlugin.build!({ model: {} as never, env: {}, log: () => {} });
    expect(c.postProcess).toBeUndefined();
    expect(c.postTurnGuards ?? []).toEqual([]);
  });

  it("builds a bitbucketCommand tool and a status describer for it", () => {
    const c = bitbucketPlugin.build!({ model: {} as never, env: {}, log: () => {} });
    const tools = c.sessionTools!(sctx, c.postProcess);
    expect(Object.keys(tools)).toEqual(["bitbucketCommand"]);
    expect(Object.keys(c.toolStatusDescribers ?? {})).toEqual(["bitbucketCommand"]);
    expect(c.toolStatusDescribers!.bitbucketCommand!({ command: "bitbucket pr list" })).toBe("esecuzione bitbucket pr list");
  });
});
