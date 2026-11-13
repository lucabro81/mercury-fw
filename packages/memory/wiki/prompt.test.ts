import { describe, expect, it } from "bun:test";
import { WIKI_PROMPT_FRAGMENT } from "./index.ts";

// #112: the wiki block told the model to prefer a new file over updating an
// existing one, and to write down command patterns; every failed search left
// a new note under a slightly different name in curated/.
describe("the wiki writing rules", () => {
  const prompt = WIKI_PROMPT_FRAGMENT;

  it("asks to look for an existing document and update it before creating a new one", () => {
    expect(prompt).toContain(
      "- If you learn something worth remembering (a correction from the user, a new convention, how this team uses a tool), " +
        "first grep the wiki for a note on the same topic in personal/notes/: if there is one, read it and update it with write_file; " +
        "create a new, clearly-named file under personal/notes/ only when nothing covers it.",
    );
    expect(prompt).not.toContain("prefer creating a new, clearly-named file");
  });

  it("tells the model curated/ is shared and read-only, personal/ is the person's own", () => {
    expect(prompt).toContain(
      "curated/ is the team's common knowledge (conventions, docs, project status), shared by everyone: you can read it, not write it. " +
        "personal/ belongs to the person you're talking to and nobody else sees it: personal/notes/ is where you write for them, " +
        "personal/inferred/ is what you learned about them, kept by a separate process.",
    );
  });

  it("reaches the common area only through promote_note, when the person asks", () => {
    expect(prompt).toContain(
      "- If the person asks to share one of their notes with the team, call promote_note: it copies the note into curated/ once they confirm, and it's the only way to write there.",
    );
    expect(prompt).toContain("- DON'T call promote_note unless the person asked to share that note.");
  });

  it("forbids notes that restate a CLI's syntax", () => {
    expect(prompt).toContain(
      "- DON'T write a wiki document restating a CLI's syntax or flags — a plugin's skill and --help are the source for those, " +
        "and a note written after a failed attempt ends up contradicting them.",
    );
    expect(prompt).not.toContain("a useful command pattern");
  });
});
