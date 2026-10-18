import { describe, expect, it } from "bun:test";
import type { StepInfo } from "@mercury-fw/plugin-types";
import { createSourcesGuard } from "./sources.ts";

/** A step with one call to `toolName` that returned `output`. */
function step(toolName: string, output: unknown, id = "1"): StepInfo {
  return { toolCalls: [{ toolCallId: id, toolName, input: {} }], toolResults: [{ toolCallId: id, toolName, output }], content: [] };
}

const page = (url: string, title: string) => ({ ok: true, url, title, text: "t", truncated: false, note: "n" });

describe("createSourcesGuard", () => {
  const guard = createSourcesGuard();

  it("runs only when the turn read at least one page", () => {
    expect(guard.shouldRun("answer", [step("web_fetch", page("https://a.test/", "A"))])).toBe(true);
    expect(guard.shouldRun("answer", [step("web_search", { ok: true, results: [] })])).toBe(false);
    expect(guard.shouldRun("answer", [step("web_fetch", { ok: false, error: "the page answered HTTP 404" })])).toBe(false);
    expect(guard.shouldRun("answer", [step("web_fetch", { ok: false, pendingConfirmation: true, token: "T1" })])).toBe(false);
    expect(guard.shouldRun("answer", [])).toBe(false);
    expect(guard.shouldRun("answer")).toBe(false);
  });

  it("never runs on an empty answer or a NO_REPLY", () => {
    const steps = [step("web_fetch", page("https://a.test/", "A"))];
    expect(guard.shouldRun("", steps)).toBe(false);
    expect(guard.shouldRun("NO_REPLY", steps)).toBe(false);
  });

  it("appends the pages read, in order, each once, with title and URL", async () => {
    const steps = [
      step("web_fetch", page("https://a.test/x", "Page A"), "1"),
      step("web_fetch", page("https://b.test/y", "Page B"), "2"),
      step("web_fetch", page("https://a.test/x", "Page A"), "3"),
    ];

    const out = await guard.run("The answer.", steps);

    expect(out).toEqual({ text: "The answer.\n\nFonti:\n- Page A: https://a.test/x\n- Page B: https://b.test/y", outcome: "success" });
  });

  it("names a page without a title by its URL alone", async () => {
    const out = await guard.run("A.", [step("web_fetch", { ...page("https://a.test/", ""), title: "" })]);
    expect(out.text).toBe("A.\n\nFonti:\n- https://a.test/");
  });

  it("keeps a title on one line", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://a.test/", "Two\nlines"))]);
    expect(out.text).toBe("A.\n\nFonti:\n- Two lines: https://a.test/");
  });
});
