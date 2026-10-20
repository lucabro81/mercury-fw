import { describe, it, expect } from "bun:test";
import { PLUGIN_API_VERSION, type SessionToolContext, type Translate } from "@mercury-fw/plugin-types";
import { bitbucketPlugin, createBitbucketPlugin } from "./index.ts";

/**
 * Bitbucket is the second plugin and the validation that the `Plugin` contract
 * isn't Jira-shaped: it's the minimal CLI-based case — it owns its tool via the
 * engine, with no post-processors, no guard, and no prompt fragment of its own.
 * This test pins that minimality: a `build()` that contributes exactly the
 * `bitbucketCommand` tool and its status describer, nothing else.
 */
/** The turn's texts: the key and its params, so a test sees what was asked for. */
const echo: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

const sctx: SessionToolContext = {
  sessionKey: "s",
  t: echo,
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

  it("acts as the person", () => {
    expect(bitbucketPlugin.actsAs).toBe("person");
  });

  // #205: a consumer with several callbacks refuses a link without
  // redirect_uri, so the login names Mercury's callback.
  it("starts the person's login with Mercury's callback as the redirect URI, and finishes it with the code and the state", async () => {
    const calls: { binary: string; args: string[] }[] = [];
    const plugin = createBitbucketPlugin({
      runCliFn: async (binary, args) => {
        calls.push({ binary, args });
        return args.includes("--remote")
          ? { ok: true, data: { authorize_url: "https://bitbucket.org/site/oauth2/authorize?x", state: "st" } }
          : { ok: true, data: {} };
      },
    });
    const login = plugin.build!({ model: {} as never, env: {}, log: () => {} }).login!;
    expect(await login.start("static:alice", "https://mercury.example.com/login/callback")).toEqual({
      ok: true,
      authorizeUrl: "https://bitbucket.org/site/oauth2/authorize?x",
      state: "st",
    });
    expect(await login.complete("static:alice", "the-code", "st")).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        binary: "bitbucket",
        args: ["auth", "login", "--user", "static:alice", "--remote", "--redirect-uri", "https://mercury.example.com/login/callback"],
      },
      { binary: "bitbucket", args: ["auth", "login", "--user", "static:alice", "--code", "the-code", "--state", "st"] },
    ]);
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
    expect(c.toolStatusDescribers!.bitbucketCommand!({ command: "bitbucket pr list" }, echo)).toBe(
      'core.status.command {"binary":"bitbucket","command":"pr list"}',
    );
    expect(c.toolStatusDescribers!.bitbucketCommand!({}, echo)).toBe("core.status.command-unknown");
  });
});

// #222: the model took "Mercury" for its own name because the texts it read used
// it; the assistant's name is the app's, and the system is "the system".
describe("bitbucketPlugin's texts for the model", () => {
  it("never name Mercury", () => {
    const c = bitbucketPlugin.build!({ model: {} as never, env: {}, log: () => {} });
    const texts = [
      bitbucketPlugin.systemPromptFragment ?? "",
      ...(bitbucketPlugin.skills ?? []).flatMap((s) => [s.description, s.body]),
      ...Object.values(c.sessionTools!(sctx, c.postProcess)).map((t) => (typeof t.description === "string" ? t.description : "")),
    ];
    for (const text of texts) expect(text).not.toContain("Mercury");
  });
});
