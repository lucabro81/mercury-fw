import { describe, expect, it } from "bun:test";
import { userArea, userKey } from "./user-key.ts";

describe("userKey", () => {
  it("is the provider and the id, so two providers issuing the same id stay two people", () => {
    expect(userKey({ id: "alice", provider: "static" })).toBe("static:alice");
    expect(userKey({ id: "alice", provider: "oidc" })).toBe("oidc:alice");
    expect(userKey({ id: "users/42", provider: "google-chat" })).toBe("google-chat:users/42");
    expect(userKey({ id: "terminal", provider: "none" })).toBe("none:terminal");
  });

  it("keeps the id raw: encoding is userArea's job, done once", () => {
    expect(userKey({ id: "auth0|x@y", provider: "oidc" })).toBe("oidc:auth0|x@y");
  });

  it("ignores everything but provider and id", () => {
    expect(userKey({ id: "alice", provider: "static", displayName: "Alice", roles: ["admin"] })).toBe("static:alice");
  });

  it("replaces a lone surrogate, so encoding it later can't throw", () => {
    expect(userKey({ id: "a\uD800", provider: "static" })).toBe("static:a�");
  });
});

describe("userArea", () => {
  it("is one vault segment under users/, the key encoded once", () => {
    expect(userArea("static:alice")).toBe("users/static%3Aalice");
    expect(userArea("google-chat:users/42")).toBe("users/google-chat%3Ausers%2F42");
    expect(userArea("oidc:auth0|x@y")).toBe("users/oidc%3Aauth0%7Cx%40y");
  });

  it("can't be . or .. or carry a separator, whatever the id", () => {
    expect(userArea(userKey({ id: "..", provider: "static" }))).toBe("users/static%3A..");
    expect(userArea(userKey({ id: "../../etc", provider: "static" }))).toBe("users/static%3A..%2F..%2Fetc");
    expect(userArea(userKey({ id: "a\\b", provider: "static" }))).toBe("users/static%3Aa%5Cb");
  });
});
