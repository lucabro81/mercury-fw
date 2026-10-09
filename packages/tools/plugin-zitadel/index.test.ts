import { describe, it, expect } from "bun:test";
import { PLUGIN_API_VERSION, type SessionToolContext } from "@mercury-fw/plugin-types";
import type { CliResult } from "@mercury-fw/cli-engine";
import { zitadelPlugin, createZitadelPlugin } from "./index.ts";

const sctx = (person: SessionToolContext["person"]): SessionToolContext => ({
  sessionKey: "s",
  stageConfirmation: async () => "tok",
  stashDisplay: () => "d1",
  person,
  requireLogin: async () => ({ ok: false, error: "x" }),
});

const buildCtx = { model: {} as never, env: {}, log: () => {} };

/** A plugin whose CLI runs are recorded instead of spawned. */
function recording(result: CliResult = { ok: true, data: {} }) {
  const calls: { binary: string; args: string[] }[] = [];
  const plugin = createZitadelPlugin({
    runCliFn: async (binary, args) => {
      calls.push({ binary, args });
      return result;
    },
  });
  return { plugin, calls };
}

describe("zitadelPlugin", () => {
  it("declares the compatible apiVersion and the zitadel name", () => {
    expect(zitadelPlugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(zitadelPlugin.name).toBe("zitadel");
  });

  // Without it the model learned the commands and their --select paths through
  // --help and failed calls, about ten tool calls for "who am I" (seen live).
  it("ships a zitadel skill naming the commands and the --select paths they need", () => {
    expect(zitadelPlugin.skills).toHaveLength(1);
    const skill = zitadelPlugin.skills![0]!;
    expect(skill.name).toBe("zitadel");
    expect(skill.description.length).toBeGreaterThan(0);
    for (const text of [
      "zitadelCommand",
      "zitadel auth whoami",
      "zitadel organization list --select result.id,result.name,result.state",
      "zitadel project list --select projects.projectId,projects.name",
      "zitadel user search --email-exact",
      "zitadel user authorizations",
      "zitadel user idp-links",
    ]) {
      expect(skill.body).toContain(text);
    }
  });

  it("acts as the person and contributes only its own tool", () => {
    expect(zitadelPlugin.actsAs).toBe("person");
    expect(zitadelPlugin.systemPromptFragment).toBeUndefined();
    expect(zitadelPlugin.surfaces).toBeUndefined();
    const c = zitadelPlugin.build!(buildCtx);
    expect(c.postProcess).toBeUndefined();
    expect(c.postTurnGuards ?? []).toEqual([]);
    expect(Object.keys(c.sessionTools!(sctx(null), c.postProcess))).toEqual(["zitadelCommand"]);
    expect(c.toolStatusDescribers!.zitadelCommand!({ command: "zitadel user get 1" })).toBe("esecuzione zitadel user get");
  });

  it("runs a command with --user for the person the turn is for", async () => {
    const { plugin, calls } = recording();
    const c = plugin.build!(buildCtx);
    const tool = c.sessionTools!(sctx({ key: "static:alice" }), c.postProcess).zitadelCommand!;
    await tool.execute!({ command: "zitadel user get 123" }, {} as never);
    expect(calls).toEqual([{ binary: "zitadel", args: ["user", "get", "123", "--user", "static:alice"] }]);
  });

  // On the terminal there's no person: the command runs as the service user.
  it("runs a command without --user when there is no person", async () => {
    const { plugin, calls } = recording();
    const c = plugin.build!(buildCtx);
    await c.sessionTools!(sctx(null), c.postProcess).zitadelCommand!.execute!({ command: "zitadel user get 123" }, {} as never);
    expect(calls).toEqual([{ binary: "zitadel", args: ["user", "get", "123"] }]);
  });

  // Mercury decides whose account a command runs as: a --user the model wrote
  // never reaches the CLI.
  it("refuses a --user written by the model, without running anything", async () => {
    const { plugin, calls } = recording();
    const c = plugin.build!(buildCtx);
    const result = await c.sessionTools!(sctx({ key: "static:alice" }), c.postProcess).zitadelCommand!.execute!(
      { command: "zitadel user get 123 --user static:bob" },
      {} as never,
    );
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("--user is not allowed") });
  });

  // The Native app accepts several redirect URIs, so Mercury's callback goes on
  // the command line, as with Jira.
  it("logs the person in remotely with Mercury's callback as the redirect URI", async () => {
    const { plugin, calls } = recording({
      ok: true,
      data: { authorize_url: "https://idp.example.com/oauth/v2/authorize?x=1", state: "st", expires_at: "2026-10-08T10:10:00Z" },
    });
    const login = plugin.build!(buildCtx).login!;
    await login.start("static:alice", "https://mercury.example.com/login/callback");
    expect(calls).toEqual([
      {
        binary: "zitadel",
        args: ["auth", "login", "--user", "static:alice", "--remote", "--redirect-uri", "https://mercury.example.com/login/callback"],
      },
    ]);
  });

  it("finishes the person's login with the code and the state", async () => {
    const { plugin, calls } = recording();
    const result = await plugin.build!(buildCtx).login!.complete("static:alice", "the-code", "st");
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { binary: "zitadel", args: ["auth", "login", "--user", "static:alice", "--code", "the-code", "--state", "st"] },
    ]);
  });
});
