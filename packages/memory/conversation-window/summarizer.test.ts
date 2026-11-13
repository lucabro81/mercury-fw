import { describe, expect, it } from "bun:test";
import { SUMMARY_INSTRUCTIONS } from "./summarizer.ts";

describe("the Layer 1 summarizer's instructions", () => {
  it("keeps names, ticket keys and decisions", () => {
    expect(SUMMARY_INSTRUCTIONS).toContain("Summarize this conversation concisely, preserving names, ticket keys, and decisions");
  });

  // #293: the model reads each message after when it was written; a
  // compressed history would otherwise lose it.
  it("keeps when things were said or decided, from the messages' stamps", () => {
    expect(SUMMARY_INSTRUCTIONS).toContain(
      "Each message from the user starts with when it was written, in brackets: keep when things were said or decided, as written there.",
    );
  });
});
