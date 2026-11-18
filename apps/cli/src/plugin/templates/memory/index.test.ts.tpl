/**
 * The __TITLE__ memory: it keeps the topic of each turn a person wrote, never
 * the operator's, trims them when a session closes, reads the latest back as
 * a session layer, and does without a data folder.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextRequest, FinishedTurn, PluginRuntimeContext, PluginRuntimeContributions } from "@mercury-fw/kit";
import { __EXPORT__, topicOf } from "./index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "__NAME__-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The context the core builds the plugin with, its data folder in `dir`. */
function ctx(logs: string[] = []): PluginRuntimeContext {
  return { model: {} as never, env: {}, log: (line) => logs.push(line), dataDir: dir };
}

/** A turn `person` wrote, saying `input`. */
function turn(input: string, person = "oidc:ada", operator = false): FinishedTurn {
  return { sessionKey: "s1", person: { key: person }, operator, as: "anyone", input, answer: "ok", calls: [], multiUser: false };
}

/** What the model reads at the start of `person`'s session, `topics` the knob. */
function layer(built: PluginRuntimeContributions, person = "oidc:ada", topics = 5) {
  const req: ContextRequest = { sessionKey: "s2", person: { key: person }, operator: false, as: "anyone", input: "hi", multiUser: false, knobs: { topics }, reopened: false };
  return built.context!.build(req);
}

describe("__NAME__", () => {
  test("reads back the topics of the person's earlier turns", async () => {
    const built = await __EXPORT__().build!(ctx());
    await built.afterTurn!(turn("Where is the printer?\nThe one upstairs"));
    await built.afterTurn!(turn("How do I book a room?"));
    expect(await layer(built)).toEqual(["Earlier, the person asked about:\n- Where is the printer?\n- How do I book a room?"]);
  });

  test("keeps each person's apart", async () => {
    const built = await __EXPORT__().build!(ctx());
    await built.afterTurn!(turn("Where is the printer?"));
    expect(await layer(built, "oidc:bob")).toEqual([]);
  });

  test("keeps nothing of the operator's", async () => {
    const built = await __EXPORT__().build!(ctx());
    await built.afterTurn!(turn("Where is the printer?", "none:terminal", true));
    expect(await layer(built, "none:terminal")).toEqual([]);
  });

  test("reads as many as the knob says", async () => {
    const built = await __EXPORT__().build!(ctx());
    for (const q of ["one", "two", "three"]) await built.afterTurn!(turn(q));
    expect(await layer(built, "oidc:ada", 2)).toEqual(["Earlier, the person asked about:\n- two\n- three"]);
    expect(await layer(built, "oidc:ada", 0)).toEqual([]);
  });

  test("trims the person's topics to the newest when a session closes", async () => {
    const built = await __EXPORT__({ keep: 2 }).build!(ctx());
    for (const q of ["one", "two", "three"]) await built.afterTurn!(turn(q));
    await built.onSessionClose!({ sessionKey: "s1", person: { key: "oidc:ada" }, messages: [] });
    expect(await layer(built, "oidc:ada", 20)).toEqual(["Earlier, the person asked about:\n- two\n- three"]);
  });

  test("without a data folder it contributes nothing, and logs why", async () => {
    const logs: string[] = [];
    expect(await __EXPORT__().build!({ model: {} as never, env: {}, log: (line) => logs.push(line) })).toEqual({});
    expect(logs).toEqual(["__NAME__: no data folder: it remembers nothing"]);
  });
});

describe("topicOf", () => {
  test("is the first line, trimmed", () => {
    expect(topicOf("  Where is it?  \nmore")).toBe("Where is it?");
  });

  test("cuts a long line", () => {
    expect(topicOf("x".repeat(200))).toBe(`${"x".repeat(119)}…`);
  });
});
