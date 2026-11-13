import { describe, expect, it } from "bun:test";
import { userArea } from "./user-area.ts";

describe("userArea", () => {
  it("is users/<key>, the key encoded into one folder name", () => {
    expect(userArea("static:alice")).toBe("users/static%3Aalice");
    expect(userArea("google-chat:users/42")).toBe("users/google-chat%3Ausers%2F42");
  });
});
