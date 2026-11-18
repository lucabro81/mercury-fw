/**
 * The __TITLE__ directory: the person a channel identity belongs to, with
 * their roles; nobody for an identity nobody has; no directory when its
 * setting is missing or malformed.
 */
import { describe, expect, test } from "bun:test";
import { __EXPORT__ } from "./index.ts";

const PEOPLE = JSON.stringify([
  { id: "ada", displayName: "Ada", roles: ["admin"], identities: [{ provider: "static", id: "ada" }, { provider: "google-chat", id: "users/1" }] },
  { id: "bob", roles: [], identities: [{ provider: "static", id: "bob" }] },
]);

/** The directory built with `people` as its setting. */
function build(people: string | undefined) {
  return __EXPORT__().build({ env: { __CONSTANT___PEOPLE: people }, log: () => {} });
}

describe("__NAME__", () => {
  test("knows a person by any of their identities, with their roles", async () => {
    const directory = build(PEOPLE);
    const ada = { id: "ada", displayName: "Ada", roles: ["admin"] };
    expect(await directory.resolve({ provider: "static", id: "ada" })).toEqual(ada);
    expect(await directory.resolve({ provider: "google-chat", id: "users/1" })).toEqual(ada);
  });

  test("knows nobody by an identity nobody has", async () => {
    expect(await build(PEOPLE).resolve({ provider: "static", id: "eve" })).toBeNull();
    expect(await build(PEOPLE).resolve({ provider: "oidc", id: "ada" })).toBeNull();
  });

  test("doesn't build without its setting, or with a malformed one", () => {
    expect(() => build(undefined)).toThrow("__CONSTANT___PEOPLE is not set");
    expect(() => build("[")).toThrow("__CONSTANT___PEOPLE isn't JSON");
    expect(() => build('[{"id":"ada"}]')).toThrow("__CONSTANT___PEOPLE is a list of { id, roles: [], identities: [{ provider, id }] }");
  });
});
