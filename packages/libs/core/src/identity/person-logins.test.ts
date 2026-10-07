import { describe, it, expect } from "bun:test";
import type { PersonLogin } from "@mercury-fw/plugin-types";
import { createPersonLogins } from "./person-logins.ts";

/**
 * People's logins to the plugins' services: started by a tool for the turn's
 * person, finished by the channel that receives the provider's redirect. The
 * `state` is what ties the redirect to the person who started, once.
 */
describe("createPersonLogins", () => {
  /** A login whose `start` hands out st-1, st-2, … and records every call. */
  function fakeLogin(opts: { startError?: string; completeError?: string } = {}) {
    const calls: string[] = [];
    let n = 0;
    const login: PersonLogin = {
      start: async (personKey, callbackUrl) => {
        calls.push(`start ${personKey} ${callbackUrl}`);
        if (opts.startError) return { ok: false, error: opts.startError };
        n++;
        return { ok: true, authorizeUrl: `https://auth/${n}`, state: `st-${n}` };
      },
      complete: async (personKey, code, state) => {
        calls.push(`complete ${personKey} ${code} ${state}`);
        return opts.completeError ? { ok: false, error: opts.completeError } : { ok: true };
      },
    };
    return { login, calls };
  }

  const NEEDS_LOGIN =
    "The user isn't logged in to jira yet: tell them to log in with the link shown to them and then ask again. Never write a link yourself.";

  it("starts the login with the callback a channel offered, and returns the link for the channel", async () => {
    const logins = createPersonLogins();
    logins.accept("https://m.example/login/callback");
    const f = fakeLogin();
    expect(await logins.require("jira", f.login, "static:alice")).toEqual({
      ok: false,
      loginRequired: true,
      service: "jira",
      authorizeUrl: "https://auth/1",
      error: NEEDS_LOGIN,
    });
    expect(f.calls).toEqual(["start static:alice https://m.example/login/callback"]);
  });

  it("without a channel that takes logins, says so and starts nothing", async () => {
    const logins = createPersonLogins();
    const f = fakeLogin();
    expect(await logins.require("jira", f.login, "static:alice")).toEqual({
      ok: false,
      error:
        "The user isn't logged in to jira, and nothing on this Mercury instance can take a login (the HTTP channel does once HTTP_SURFACE_PUBLIC_URL is set). Tell the user.",
    });
    expect(f.calls).toEqual([]);
  });

  it("a login that can't start is an error for the model, with the reason", async () => {
    const logins = createPersonLogins();
    logins.accept("https://cb");
    const f = fakeLogin({ startError: "jira exited with code 1: no user app" });
    expect(await logins.require("jira", f.login, "static:alice")).toEqual({
      ok: false,
      error: "The user isn't logged in to jira, and their login couldn't start: jira exited with code 1: no user app",
    });
  });

  it("completes the login the state was issued for, as the person who started it, once", async () => {
    const logins = createPersonLogins();
    logins.accept("https://cb");
    const f = fakeLogin();
    await logins.require("jira", f.login, "static:alice");
    expect(await logins.complete("st-1", "code-1")).toEqual({ ok: true, service: "jira" });
    expect(f.calls.at(-1)).toBe("complete static:alice code-1 st-1");
    expect(await logins.complete("st-1", "code-1")).toEqual({
      ok: false,
      error: "This login link has expired or was already used: ask Mercury again for a new one.",
    });
  });

  it("an unknown state completes nothing", async () => {
    const logins = createPersonLogins();
    const f = fakeLogin();
    expect((await logins.complete("forged", "code")).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("a state older than the login's lifetime is refused", async () => {
    let now = 1_000;
    const logins = createPersonLogins({ now: () => now, ttlMs: 600_000 });
    logins.accept("https://cb");
    const f = fakeLogin();
    await logins.require("jira", f.login, "static:alice");
    now += 600_001;
    expect((await logins.complete("st-1", "code")).ok).toBe(false);
    expect(f.calls.filter((c) => c.startsWith("complete"))).toEqual([]);
  });

  // Review of #176: the CLI keeps one pending login per person, so starting
  // another would void the link already shown. While it's valid, it's reused.
  it("a login still pending for the same person and service is reused, link and state", async () => {
    const logins = createPersonLogins();
    logins.accept("https://cb");
    const f = fakeLogin();
    const first = await logins.require("jira", f.login, "static:alice");
    expect(await logins.require("jira", f.login, "static:alice")).toEqual(first);
    expect(f.calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
    expect(await logins.complete("st-1", "c")).toEqual({ ok: true, service: "jira" });
  });

  it("two tool calls asking at once start one login", async () => {
    const logins = createPersonLogins();
    logins.accept("https://cb");
    const f = fakeLogin();
    const [a, b] = await Promise.all([logins.require("jira", f.login, "static:alice"), logins.require("jira", f.login, "static:alice")]);
    expect(a).toEqual(b);
    expect(f.calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
  });

  it("once the pending login expires, asking again starts a new one", async () => {
    let now = 0;
    const logins = createPersonLogins({ now: () => now, ttlMs: 1000 });
    logins.accept("https://cb");
    const f = fakeLogin();
    await logins.require("jira", f.login, "static:alice");
    now = 1001;
    await logins.require("jira", f.login, "static:alice");
    expect(f.calls.filter((c) => c.startsWith("start"))).toHaveLength(2);
    expect((await logins.complete("st-1", "c")).ok).toBe(false);
    expect((await logins.complete("st-2", "c")).ok).toBe(true);
  });

  it("two people logging in at once each finish their own", async () => {
    const logins = createPersonLogins();
    logins.accept("https://cb");
    const f = fakeLogin();
    await logins.require("jira", f.login, "static:alice");
    await logins.require("jira", f.login, "static:bob");
    await logins.complete("st-2", "cb");
    await logins.complete("st-1", "ca");
    expect(f.calls.filter((c) => c.startsWith("complete"))).toEqual(["complete static:bob cb st-2", "complete static:alice ca st-1"]);
  });

  // Review of #176: the outcome goes to an unauthenticated browser, so the
  // CLI's own error stays in the log.
  it("a login the service refuses is reported without the CLI's error, which goes to the log", async () => {
    const logs: string[] = [];
    const logins = createPersonLogins({ log: (m) => logs.push(m) });
    logins.accept("https://cb");
    const f = fakeLogin({ completeError: "jira exited with code 1: code expired" });
    await logins.require("jira", f.login, "static:alice");
    expect(await logins.complete("st-1", "c")).toEqual({
      ok: false,
      error: "The jira login didn't go through. Ask Mercury again for a new link.",
    });
    expect(logs).toEqual(["[login] jira login of static:alice failed: jira exited with code 1: code expired"]);
  });
});
