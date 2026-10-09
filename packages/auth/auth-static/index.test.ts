import { describe, expect, it } from "bun:test";
import { AUTH_API_VERSION } from "@mercury-fw/channel-types";
import { staticAuth } from "./index.ts";

const TOKENS = JSON.stringify({
  "alice-token": { id: "alice", displayName: "Alice" },
  "bob-token": { id: "bob" },
});

/** Builds the provider from `tokens` as the env value. */
function build(tokens: string | undefined) {
  return staticAuth.build({ env: { AUTH_STATIC_TOKENS: tokens }, log: () => {} });
}

/** A request carrying `authorization`, when given. */
function request(authorization?: string): Request {
  return new Request("http://mercury/turn", { headers: authorization === undefined ? {} : { authorization } });
}

describe("staticAuth", () => {
  it("declares the auth contract it was written for, as a literal", () => {
    expect(staticAuth.apiVersion).toBe(AUTH_API_VERSION);
    expect(staticAuth.name).toBe("static");
  });

  it("maps a known bearer token onto its principal, vouched for by static", async () => {
    const authenticate = build(TOKENS);
    expect(await authenticate(request("Bearer alice-token"))).toEqual({
      id: "alice",
      provider: "static",
      displayName: "Alice",
    });
    expect(await authenticate(request("Bearer bob-token"))).toEqual({ id: "bob", provider: "static" });
  });

  it("accepts the scheme in any case, as HTTP auth schemes are case-insensitive", async () => {
    expect(await build(TOKENS)(request("bearer bob-token"))).toEqual({ id: "bob", provider: "static" });
  });

  it("refuses an unknown token, a missing header, another scheme, an empty token", async () => {
    const authenticate = build(TOKENS);
    expect(await authenticate(request("Bearer carol-token"))).toBeNull();
    expect(await authenticate(request("Bearer alice-toke"))).toBeNull();
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request("Basic alice-token"))).toBeNull();
    expect(await authenticate(request("Bearer "))).toBeNull();
    expect(await authenticate(request("alice-token"))).toBeNull();
  });

  it("doesn't let a token match an inherited object key", async () => {
    expect(await build(TOKENS)(request("Bearer constructor"))).toBeNull();
  });

  it("throws on a missing, malformed or empty token map, so the channel stays closed", () => {
    expect(() => build(undefined)).toThrow("AUTH_STATIC_TOKENS is missing");
    expect(() => build("")).toThrow("AUTH_STATIC_TOKENS is missing");
    expect(() => build("not json")).toThrow("AUTH_STATIC_TOKENS isn't valid JSON");
    expect(() => build("[]")).toThrow("AUTH_STATIC_TOKENS must be an object from token to user");
    expect(() => build("{}")).toThrow("AUTH_STATIC_TOKENS declares no token");
  });

  it("throws on an entry without an id, or with a malformed field", () => {
    expect(() => build(JSON.stringify({ t: {} }))).toThrow('AUTH_STATIC_TOKENS: the user of a token has no "id"');
    expect(() => build(JSON.stringify({ t: { id: "" } }))).toThrow('AUTH_STATIC_TOKENS: the user of a token has no "id"');
    expect(() => build(JSON.stringify({ t: { id: "a", displayName: 3 } }))).toThrow(
      'AUTH_STATIC_TOKENS: user "a" has a "displayName" that isn\'t a string',
    );

    expect(() => build(JSON.stringify({ "": { id: "a" } }))).toThrow("AUTH_STATIC_TOKENS declares an empty token");
  });

  // #150: roles come from the directory now. A token map still carrying them
  // would otherwise look like it grants something it no longer does.
  it("refuses roles on a token's user, pointing at the directory", () => {
    expect(() => build(JSON.stringify({ t: { id: "a", roles: ["admin"] } }))).toThrow(
      'AUTH_STATIC_TOKENS: user "a" has "roles", which the auth provider no longer carries: declare them in the directory (e.g. @mercury-fw/directory-static)',
    );
  });

  it("never puts a token in an error message", () => {
    let message = "";
    try {
      build(JSON.stringify({ "secret-token": { id: "" } }));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('no "id"');
    expect(message).not.toContain("secret-token");
  });
});
