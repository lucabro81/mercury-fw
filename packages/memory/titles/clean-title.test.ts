import { describe, it, expect } from "bun:test";
import { cleanGeneratedTitle, MAX_TITLE_LENGTH } from "./clean-title.ts";

describe("cleanGeneratedTitle", () => {
  it("keeps a plain title as it is", () => {
    expect(cleanGeneratedTitle("Issue aperte su KAN")).toBe("Issue aperte su KAN");
  });

  it("trims whitespace around the title", () => {
    expect(cleanGeneratedTitle("  \n Issue aperte  \n")).toBe("Issue aperte");
  });

  it("keeps only the first non-empty line", () => {
    expect(cleanGeneratedTitle("\n\nIssue aperte\nThis title sums up the request")).toBe("Issue aperte");
  });

  it("strips quotes wrapped around the title, nested too", () => {
    expect(cleanGeneratedTitle('"Issue aperte"')).toBe("Issue aperte");
    expect(cleanGeneratedTitle("'Issue aperte'")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("“Issue aperte”")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("«Issue aperte»")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("\"'Issue aperte'\"")).toBe("Issue aperte");
  });

  it("keeps quotes inside the title", () => {
    expect(cleanGeneratedTitle('La pagina "Onboarding"')).toBe('La pagina "Onboarding"');
  });

  it("strips Markdown: a heading mark, emphasis and code marks", () => {
    expect(cleanGeneratedTitle("## Issue aperte")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("**Issue aperte**")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("Il comando `jira issue list`")).toBe("Il comando jira issue list");
  });

  it("keeps a # that isn't a heading mark", () => {
    expect(cleanGeneratedTitle("Note su C#")).toBe("Note su C#");
  });

  it("drops a trailing period or colon", () => {
    expect(cleanGeneratedTitle("Issue aperte.")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("Issue aperte:")).toBe("Issue aperte");
  });

  it("keeps a trailing question mark", () => {
    expect(cleanGeneratedTitle("Chi è di turno?")).toBe("Chi è di turno?");
  });

  it("drops a label the model puts before the title", () => {
    expect(cleanGeneratedTitle("Title: Issue aperte")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("Titolo: Issue aperte")).toBe("Issue aperte");
  });

  it("cuts a long title on a word boundary, with an ellipsis, within the limit", () => {
    const words = Array.from({ length: 40 }, (_, i) => `parola${i}`).join(" ");
    const cut = cleanGeneratedTitle(words);
    expect(cut.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(cut.endsWith("…")).toBe(true);
    expect(words.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1).endsWith(" ")).toBe(false);
    // The word before the ellipsis is whole.
    expect(words.split(" ")).toContain(cut.slice(0, -1).split(" ").at(-1) ?? "");
  });

  it("cuts a single word longer than the limit on the limit", () => {
    const cut = cleanGeneratedTitle("x".repeat(300));
    expect(cut).toBe(`${"x".repeat(MAX_TITLE_LENGTH - 1)}…`);
  });

  it("keeps a title exactly at the limit whole", () => {
    const exact = "a".repeat(MAX_TITLE_LENGTH);
    expect(cleanGeneratedTitle(exact)).toBe(exact);
  });

  it("drops control characters", () => {
    expect(cleanGeneratedTitle("Issue\u0007 aperte")).toBe("Issue aperte");
  });

  it("gives an empty string when nothing is left", () => {
    expect(cleanGeneratedTitle("")).toBe("");
    expect(cleanGeneratedTitle("   \n  ")).toBe("");
    expect(cleanGeneratedTitle('""')).toBe("");
    expect(cleanGeneratedTitle("**")).toBe("");
  });
});

