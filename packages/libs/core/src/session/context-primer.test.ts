import { describe, it, expect } from "bun:test";
import { buildContextPrimer } from "./context-primer.ts";

describe("buildContextPrimer", () => {
  it("is empty when the person has nothing pending", async () => {
    expect(await buildContextPrimer("google-chat:users/42", { pendingTokens: async () => [] })).toEqual({ current: "" });
  });

  // The model reads only the token, and resolves it with resolve_reference when it needs to.
  it("lists the person's pending confirmations as opaque references, asked for the person's own", async () => {
    const asked: string[] = [];
    const primer = await buildContextPrimer("google-chat:users/42", { pendingTokens: async (key) => (asked.push(key), ["j3h4b5", "k9m2n1"]) });
    expect(primer).toEqual({ current: "Open references:\n- [REQ:j3h4b5]\n- [REQ:k9m2n1]" });
    expect(asked).toEqual(["google-chat:users/42"]);
  });
});
