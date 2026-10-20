import { describe, expect, it } from "bun:test";
import type { StepInfo, Translate } from "@mercury-fw/plugin-types";
import { createSourcesGuard } from "./sources.ts";
import { WEB_SEARCH_MESSAGES } from "./messages.ts";

/** The plugin's texts in English, as a turn with no other language gets them. */
const english: Translate = (key, params) =>
  (WEB_SEARCH_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : whole,
  );


/** A step with one call to `toolName` that returned `output`. */
function step(toolName: string, output: unknown, id = "1"): StepInfo {
  return { toolCalls: [{ toolCallId: id, toolName, input: {} }], toolResults: [{ toolCallId: id, toolName, output }], content: [] };
}

const page = (url: string, title: string) => ({ ok: true, url, title, text: "t", truncated: false, note: "n" });

describe("createSourcesGuard", () => {
  const guard = createSourcesGuard();

  it("says what it's doing in the turn's language", () => {
    expect(guard.statusLabel(english)).toBe("Adding the sources…");
  });

  // #280: the sources heading is a text the person reads: in Italian it's the
  // instance's word, and a list the model wrote under it, or under the English
  // one, still goes, so only the guard's list is left.
  it("writes the heading in the turn's language and strips the model's list under it or the English one", async () => {
    const italian: Translate = (key, params) =>
      key === "web-search.sources.heading" ? "Fonti" : english(key, params);
    const steps = [step("web_fetch", page("https://a.test/", "A"))];
    expect((await guard.run("Risposta.", steps, italian)).text).toBe("Risposta.\n\nFonti:\n- A: https://a.test/");
    expect((await guard.run("Risposta.\n\n**Fonti:**\n- https://a.test/", steps, italian)).text).toBe(
      "Risposta.\n\nFonti:\n- A: https://a.test/",
    );
    expect((await guard.run("Risposta.\n\nSources:\n- https://a.test/", steps, italian)).text).toBe(
      "Risposta.\n\nFonti:\n- A: https://a.test/",
    );
  });

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

    const out = await guard.run("The answer.", steps, english);

    expect(out).toEqual({ text: "The answer.\n\nSources:\n- Page A: https://a.test/x\n- Page B: https://b.test/y", outcome: "success" });
  });

  it("names a page without a title by its URL alone", async () => {
    const out = await guard.run("A.", [step("web_fetch", { ...page("https://a.test/", ""), title: "" })], english);
    expect(out.text).toBe("A.\n\nSources:\n- https://a.test/");
  });

  // Cold review of #194: a title is the site's text, shown to the person outside
  // the model; it must not bring links or formatting of its own, nor go on forever.
  it("strips links and formatting from a title and cuts a long one", async () => {
    const out = await guard.run("A.", [
      step("web_fetch", page("https://a.test/1", "Notice: **call** now [here](https://evil.example) <b>x</b>"), "1"),
      step("web_fetch", page("https://a.test/2", "t".repeat(300)), "2"),
    ], english);
    expect(out.text).toBe(`A.\n\nSources:\n- Notice: call now here bx/b: https://a.test/1\n- ${"t".repeat(120)}…: https://a.test/2`);
  });

  it("strips an address with a path even without a scheme, keeping words with a dot", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://a.test/", "Pay at evil.com/pay now, Node.js docs"))], english);
    expect(out.text).toBe("A.\n\nSources:\n- Pay at now, Node.js docs: https://a.test/");
  });

  it("turns a | between parts of a title into a separator, not a glued word", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://bun.sh/docs", "Welcome to Bun | Bun Docs"))], english);
    expect(out.text).toBe("A.\n\nSources:\n- Welcome to Bun · Bun Docs: https://bun.sh/docs");
  });

  it("keeps a title on one line", async () => {
    const out = await guard.run("A.", [step("web_fetch", page("https://a.test/", "Two\nlines"))], english);
    expect(out.text).toBe("A.\n\nSources:\n- Two lines: https://a.test/");
  });

  // #269: the model sometimes lists the sources itself, and the answer ended
  // with two "Sources:" blocks (seen live on Google Chat). The guard's list is the
  // only one: a trailing list the model wrote goes.
  describe("a list of sources the model wrote itself", () => {
    const steps = [step("web_fetch", page("https://bun.com/docs/test", "Test runner"))];
    const ours = "Sources:\n- Test runner: https://bun.com/docs/test";

    it("is replaced by the guard's, as seen live", async () => {
      const out = await guard.run("The answer.\n\nSources:\n- Test runner · Bun Docs: https://bun.com/docs/test", steps, english);
      expect(out.text).toBe(`The answer.\n\n${ours}`);
    });

    it.each([
      ["bold", "**Sources:**\n- https://bun.com/docs/test"],
      ["bold, colon outside", "**Sources**:\n- https://bun.com/docs/test"],
      ["a Markdown heading", "## Sources\n\n- [Test runner](https://bun.com/docs/test)"],
      ["in English", "Sources:\n* https://bun.com/docs/test"],
      ["lower case, no colon", "sources\n1. https://bun.com/docs/test\n2. https://bun.com/docs"],
      ["bare URLs and trailing blank lines", "Sources:\nhttps://bun.com/docs/test\n\n  \n"],
      ["bullets with •", "Sources:\n• Test runner — https://bun.com/docs/test"],
    ])("is replaced when %s", async (_, block) => {
      const out = await guard.run(`The answer.\n\n${block}`, steps, english);
      expect(out.text).toBe(`The answer.\n\n${ours}`);
    });

    it("leaves only the guard's list when the answer was nothing else", async () => {
      const out = await guard.run("Sources:\n- https://bun.com/docs/test", steps, english);
      expect(out.text).toBe(ours);
    });

    it("stays when prose follows it", async () => {
      const text = "The answer.\n\nSources:\n- https://bun.com/docs/test\n\nSpero ti sia utile.";
      const out = await guard.run(text, steps, english);
      expect(out.text).toBe(`${text}\n\n${ours}`);
    });

    it("stays when the heading opens a sentence, not a list", async () => {
      const text = "Sources: the official docs say the runner is compatible with Jest.";
      const out = await guard.run(text, steps, english);
      expect(out.text).toBe(`${text}\n\n${ours}`);
    });

    it("stays when it's a heading with nothing under it", async () => {
      const out = await guard.run("The answer.\n\nSources:", steps, english);
      expect(out.text).toBe(`The answer.\n\nSources:\n\n${ours}`);
    });
  });
});
