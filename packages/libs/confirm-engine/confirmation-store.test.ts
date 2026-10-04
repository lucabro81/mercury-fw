import { describe, it, expect } from "bun:test";
import { createConfirmationStore, isTokenShaped, type StagedAction } from "./confirmation-store.ts";

const OWNER = "google-chat:users/42";

// A staged action is an opaque thunk (`run`) plus a human-readable `describe`;
// this builds one for the tests.
function action(describe: string): StagedAction {
  return { run: async () => ({ ok: true, data: {} }), describe };
}

describe("createConfirmationStore", () => {
  it("stages an action and returns it on a matching take, one-shot", () => {
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });
    const a = action("jira issue delete KAN-1 --confirm");
    const token = store.stage("terminal", OWNER, a);
    expect(token).toBe("TOK1");

    const first = store.take("terminal", OWNER, "TOK1");
    expect(first?.run).toBe(a.run);
    expect(first?.describe).toBe("jira issue delete KAN-1 --confirm");

    // one-shot: the same token can't be taken twice
    const second = store.take("terminal", OWNER, "TOK1");
    expect(second).toBeNull();
  });

  it("does not return a staged action for the wrong sessionKey, and doesn't consume it", () => {
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });
    const a = action("jira issue delete KAN-1 --confirm");
    store.stage("terminal", OWNER, a);

    expect(store.take("spaces/X:users/42", OWNER, "TOK1")).toBeNull();
    // proves the wrong-session attempt didn't consume the token
    expect(store.take("terminal", OWNER, "TOK1")?.run).toBe(a.run);
  });

  it("does not return a staged action to another person on the same session, and doesn't consume it", () => {
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });
    const a = action("jira issue delete KAN-1 --confirm");
    store.stage("shared", OWNER, a);

    expect(store.take("shared", "static:bob", "TOK1")).toBeNull();
    expect(store.take("shared", OWNER, "TOK1")?.run).toBe(a.run);
  });

  it("returns null for an unknown token", () => {
    const store = createConfirmationStore();
    expect(store.take("terminal", OWNER, "NOPE")).toBeNull();
  });

  it("returns null for a token past its expiry, and cleans it up", () => {
    let now = 0;
    const store = createConfirmationStore({ now: () => now, ttlMs: 1000, tokenFn: () => "TOK1" });
    store.stage("terminal", OWNER, action("jira doctor"));

    now = 1001;
    expect(store.take("terminal", OWNER, "TOK1")).toBeNull();

    // cleaned up, not just "expired but still there": moving time back
    // doesn't resurrect it (proves it was actually deleted, not just
    // failing the expiry check every time).
    now = 0;
    expect(store.take("terminal", OWNER, "TOK1")).toBeNull();
  });

  it("stages independent tokens per session without collision", () => {
    let counter = 0;
    const store = createConfirmationStore({ tokenFn: () => `TOK${++counter}` });
    store.stage("terminal", OWNER, action("jira issue delete KAN-1 --confirm"));
    const a2 = action("jira issue delete KAN-2 --confirm");
    store.stage("spaces/X:users/42", OWNER, a2);

    expect(store.take("terminal", OWNER, "TOK2")).toBeNull();
    expect(store.take("spaces/X:users/42", OWNER, "TOK2")?.run).toBe(a2.run);
  });

  it("defaults to a real random token when tokenFn isn't injected", () => {
    const store = createConfirmationStore();
    const a = action("jira doctor");
    const token = store.stage("terminal", OWNER, a);
    expect(token.length).toBeGreaterThan(0);
    expect(store.take("terminal", OWNER, token)?.run).toBe(a.run);
  });
});

describe("pending", () => {
  it("lists staged actions as their describe summary, redacted of token and thunk, excluding expired and taken ones", () => {
    let clock = 1000;
    const store = createConfirmationStore({ now: () => clock, ttlMs: 100, tokenFn: () => `t${clock}` });
    const tokenA = store.stage("s1", OWNER, action("jira issue delete KAN-1"));
    clock = 1050;
    store.stage("s2", OWNER, action("jira issue delete KAN-2"));

    const pending = store.pending(OWNER);
    expect(pending).toHaveLength(2);
    // neither the token nor the executable thunk leaks out — only sessionKey,
    // a human-readable summary, and the expiry
    expect(pending.every((p) => !("token" in p) && !("run" in p))).toBe(true);
    expect(pending).toContainEqual({ sessionKey: "s1", summary: "jira issue delete KAN-1", expiresAt: 1100 });

    // taking one removes it from pending
    store.take("s1", OWNER, tokenA);
    expect(store.pending(OWNER).map((p) => p.sessionKey)).toEqual(["s2"]);

    // once the first entry's TTL passes, the second is the only non-expired one
    clock = 1200; // s2 staged at 1050, ttl 100 → expires 1150
    expect(store.pending(OWNER)).toEqual([]);
  });

  it("lists only the given person's staged actions", () => {
    let counter = 0;
    const store = createConfirmationStore({ now: () => 0, ttlMs: 100, tokenFn: () => `t${++counter}` });
    store.stage("s1", OWNER, action("jira issue delete KAN-1"));
    store.stage("s2", "static:bob", action("jira issue delete KAN-2"));

    expect(store.pending(OWNER)).toEqual([{ sessionKey: "s1", summary: "jira issue delete KAN-1", expiresAt: 100 }]);
    expect(store.pending("static:bob")).toEqual([{ sessionKey: "s2", summary: "jira issue delete KAN-2", expiresAt: 100 }]);
    expect(store.pending("static:carol")).toEqual([]);
  });
});

// Replaces parseConfirmCommand's "conferma <token>" keyword parsing: the
// real safety gate was always store.take() (must exist, right session, not
// expired) — the "conferma " prefix added no security, just ceremony left
// over from the pre-card text-only confirmation flow. isTokenShaped only
// needs to tell apart "this looks like a token attempt" from "this is an
// ordinary message", so tryConfirm (confirm-flow.ts) knows whether to
// intercept at all — not a security boundary itself.
//
// The token's shape (two 4-char alphanumeric groups joined by a fixed
// hyphen, e.g. "k9m2-x7q4") is deliberately not just "6 alphanumeric
// characters": a bare N-character run collides with ordinary short
// messages a human might actually send (found live — "second", used as
// plain conversational text in an unrelated test, was indistinguishable
// from a real token under the old 6-char-alphanumeric shape). A token is
// always copy-pasted, never read or typed from memory, so legibility
// (avoiding 0/O/1/l/I) was never the point — the hyphen at a fixed
// position is: an ordinary single-word message essentially never has that
// exact "word-word" shape with nothing else around it.
describe("isTokenShaped", () => {
  it("is true for two 4-char alphanumeric groups joined by a hyphen", () => {
    expect(isTokenShaped("k9m2-x7q4")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isTokenShaped("  k9m2-x7q4  ")).toBe(true);
  });

  it("is false without the hyphen, even at the right total length", () => {
    expect(isTokenShaped("k9m2x7q4")).toBe(false);
  });

  it("is false for the wrong group length", () => {
    expect(isTokenShaped("k9m-x7q4")).toBe(false);
    expect(isTokenShaped("k9m2x-x7q4x")).toBe(false);
  });

  it("is false for an ordinary conversational message, including ones that happen to be a single 6-character word", () => {
    expect(isTokenShaped("crea un bug su KAN")).toBe(false);
    expect(isTokenShaped("second")).toBe(false);
    expect(isTokenShaped("grazie")).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isTokenShaped("")).toBe(false);
  });
});
