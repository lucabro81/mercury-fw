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

  // Cold review of #194: a title is the site's text, shown to the person outside
  // the model; it must not bring links or formatting of its own, nor go on forever.
  it("strips links and formatting from a title and cuts a long one", async () => {
    const out = await guard.run("A.", [
      step("web_fetch", page("https://a.test/1", "Notice: **call** now [here](https://evil.example) <b>x</b>"), "1"),
      step("web_fetch", page("https://a.test/2", "t".repeat(300)), "2"),
    ]);
    expect(out.text).toBe(`A.\n\nFonti:\n- Notice: call now here bx/b: https://a.test/1\n- ${"t".repeat(120)}…: https://a.test/2`);
  });

  it("strips an address with a path even without a scheme, keeping words with a dot", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://a.test/", "Pay at evil.com/pay now, Node.js docs"))]);
    expect(out.text).toBe("A.\n\nFonti:\n- Pay at now, Node.js docs: https://a.test/");
  });

  it("turns a | between parts of a title into a separator, not a glued word", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://bun.sh/docs", "Welcome to Bun | Bun Docs"))]);
    expect(out.text).toBe("A.\n\nFonti:\n- Welcome to Bun · Bun Docs: https://bun.sh/docs");
  });

  it("keeps a title on one line", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://a.test/", "Two\nlines"))]);
    expect(out.text).toBe("A.\n\nFonti:\n- Two lines: https://a.test/");
  });
});
