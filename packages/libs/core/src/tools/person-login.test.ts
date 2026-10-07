import { describe, it, expect } from "bun:test";
import { createCliPersonLogin, type CliResult } from "@mercury-fw/cli-engine";

/**
 * A person's login through their CLI's two-step remote login: step 1 prints
 * the link and the state, step 2 takes the code back. Run as the person's
 * CLI id, never the raw user key.
 */
describe("createCliPersonLogin", () => {
  /** A runCli that records each run and answers with the next of `results`. */
  function fake(...results: CliResult[]) {
    const runs: { binary: string; args: string[] }[] = [];
    const runCliFn = async (binary: string, args: string[]): Promise<CliResult> => {
      runs.push({ binary, args });
      return results.shift() ?? { ok: true, data: {} };
    };
    return { runs, runCliFn };
  }

  it("starts the remote login with the callback as the redirect URI, and returns the link and the state", async () => {
    const f = fake({ ok: true, data: { authorize_url: "https://auth/x", state: "st-1", expires_at: "2026-10-07T20:00:00Z" } });
    const login = createCliPersonLogin(f.runCliFn, "jira", { redirectUri: true });
    expect(await login.start("static:alice", "https://mercury.example/login/callback")).toEqual({
      ok: true,
      authorizeUrl: "https://auth/x",
      state: "st-1",
    });
    expect(f.runs).toEqual([
      {
        binary: "jira",
        args: ["auth", "login", "--user", "static:alice", "--remote", "--redirect-uri", "https://mercury.example/login/callback"],
      },
    ]);
  });

  it("leaves the redirect URI out for a CLI whose provider takes it from the app (bitbucket)", async () => {
    const f = fake({ ok: true, data: { authorize_url: "https://auth/x", state: "st-1" } });
    await createCliPersonLogin(f.runCliFn, "bitbucket", { redirectUri: false }).start("static:alice", "https://cb");
    expect(f.runs[0]?.args).toEqual(["auth", "login", "--user", "static:alice", "--remote"]);
  });

  it("runs as the id the CLI knows the person by", async () => {
    const f = fake({ ok: true, data: { authorize_url: "https://auth/x", state: "st-1" } });
    await createCliPersonLogin(f.runCliFn, "jira", { redirectUri: false }).start("oidc:Alice", "https://cb");
    expect(f.runs[0]?.args[3]).toMatch(/^oidc:[0-9a-f]{32}$/);
  });

  it("reports a failed start, and output that isn't a link and a state", async () => {
    const failed = fake({ ok: false, error: "jira exited with code 1: no user app", exitCode: 1 });
    expect(await createCliPersonLogin(failed.runCliFn, "jira", { redirectUri: true }).start("static:alice", "https://cb")).toEqual({
      ok: false,
      error: "jira exited with code 1: no user app",
    });
    for (const data of [{}, { authorize_url: "https://x" }, { state: "s" }, "text", { authorize_url: 3, state: "s" }]) {
      const odd = fake({ ok: true, data });
      expect(await createCliPersonLogin(odd.runCliFn, "jira", { redirectUri: true }).start("static:alice", "https://cb")).toEqual({
        ok: false,
        error: "jira auth login --remote didn't print an authorize_url and a state",
      });
    }
  });

  it("completes with the code and the state, as the same person", async () => {
    const f = fake({ ok: true, data: { accountId: "a1" } });
    const login = createCliPersonLogin(f.runCliFn, "jira", { redirectUri: true });
    expect(await login.complete("static:alice", "code-1", "st-1")).toEqual({ ok: true });
    expect(f.runs[0]?.args).toEqual(["auth", "login", "--user", "static:alice", "--code", "code-1", "--state", "st-1"]);
  });

  it("reports a failed completion", async () => {
    const f = fake({ ok: false, error: "jira exited with code 1: state expired", exitCode: 1 });
    expect(await createCliPersonLogin(f.runCliFn, "jira", { redirectUri: true }).complete("static:alice", "c", "s")).toEqual({
      ok: false,
      error: "jira exited with code 1: state expired",
    });
  });
});
