import { describe, expect, it } from "bun:test";
import type { ContextChangeEntry, ContextProfileChange, Principal } from "@mercury-fw/channel-types";
import type { People } from "../identity/people.ts";
import { CONTEXT_ADMIN, createChannelContextAdmin } from "./context-admin.ts";
import type { ContextSettings } from "./context-settings.ts";

const alice: Principal = { id: "alice", provider: "static" };

/** Identifies everyone as `key` with `roles`, from a channel (`operator` false unless asked). */
function as(key: string, roles: string[], operator = false): People["identify"] {
  return async () => ({ ok: true, operator, person: { key, roles } });
}

/** Settings that record what they're asked and answer with fixed values. */
function recorded() {
  const updates: Array<[string, string, ContextProfileChange]> = [];
  const limits: number[] = [];
  const entry: ContextChangeEntry = { at: "2026-11-12T10:00:00.000Z", by: "static:alice", profile: "default", before: { maxChars: 1 }, after: { maxChars: 2 } };
  const settings: ContextSettings = {
    view: () => ({ profiles: [] }),
    update: (by, profile, change) => {
      updates.push([by, profile, change]);
      return { ok: true, value: { name: profile, assignedTo: [], maxChars: 2, layers: [] } };
    },
    changes: (limit) => (limits.push(limit), [entry]),
  };
  return { settings, updates, limits, entry };
}

describe("createChannelContextAdmin", () => {
  it("is the role mercury.context-admin", () => {
    expect(CONTEXT_ADMIN).toBe("mercury.context-admin");
  });

  it("lets someone holding mercury.context-admin read, change and list the changes, as the person the core identifies", async () => {
    const r = recorded();
    const admin = createChannelContextAdmin({ identify: as("static:bob", ["staff", CONTEXT_ADMIN]), settings: r.settings });
    expect(await admin.read(alice)).toEqual({ ok: true, value: { profiles: [] } });
    expect(await admin.update(alice, "default", { maxChars: 2 })).toEqual({ ok: true, value: { name: "default", assignedTo: [], maxChars: 2, layers: [] } });
    expect(await admin.changes(alice, 20)).toEqual({ ok: true, value: [r.entry] });
    expect(r.updates).toEqual([["static:bob", "default", { maxChars: 2 }]]);
    expect(r.limits).toEqual([20]);
  });

  it("lets the operator in without the role", async () => {
    const r = recorded();
    const admin = createChannelContextAdmin({ identify: as("none:terminal", [], true), settings: r.settings });
    expect((await admin.update(alice, "default", { maxChars: 2 })).ok).toBe(true);
    expect(r.updates).toEqual([["none:terminal", "default", { maxChars: 2 }]]);
  });

  it("refuses, as forbidden, someone without the role, and changes nothing", async () => {
    const r = recorded();
    const admin = createChannelContextAdmin({ identify: as("static:alice", ["staff", "mercury.act-as-self"]), settings: r.settings });
    const forbidden = { ok: false, status: "forbidden", error: "changing the context needs the role mercury.context-admin" } as const;
    expect(await admin.read(alice)).toEqual(forbidden);
    expect(await admin.update(alice, "default", { maxChars: 2 })).toEqual(forbidden);
    expect(await admin.changes(alice, 5)).toEqual(forbidden);
    expect([r.updates, r.limits]).toEqual([[], []]);
  });

  it("refuses, as forbidden, someone the core doesn't admit, with the core's message", async () => {
    const r = recorded();
    const admin = createChannelContextAdmin({ identify: async () => ({ ok: false, reason: "unknown", message: "who are you?" }), settings: r.settings });
    expect(await admin.update(alice, "default", { maxChars: 2 })).toEqual({ ok: false, status: "forbidden", error: "who are you?" });
    expect(r.updates).toEqual([]);
  });
});
