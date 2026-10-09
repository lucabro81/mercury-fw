import { describe, expect, it } from "bun:test";
import { DIRECTORY_API_VERSION } from "@mercury-fw/channel-types";
import { staticDirectory } from "./index.ts";

const PEOPLE = JSON.stringify([
  {
    id: "alice",
    displayName: "Alice Rossi",
    email: "alice@example.com",
    roles: ["mercury.act-as-self"],
    identities: ["static:alice", "google-chat:users/123"],
  },
  { id: "bob", identities: ["static:bob"] },
]);

/** Builds the directory from `people` as the env value. */
function build(people: string | undefined) {
  return staticDirectory.build({ env: { DIRECTORY_STATIC_PEOPLE: people }, log: () => {} });
}

describe("staticDirectory", () => {
  it("declares the directory contract it was written for, as a literal, and its name", () => {
    expect(staticDirectory.apiVersion).toBe(DIRECTORY_API_VERSION);
    expect(staticDirectory.name).toBe("people");
  });

  it("resolves each of a person's identities to them, with their roles", async () => {
    const directory = build(PEOPLE);
    const alice = { id: "alice", displayName: "Alice Rossi", email: "alice@example.com", roles: ["mercury.act-as-self"] };
    expect(await directory.resolve({ id: "alice", provider: "static" })).toEqual(alice);
    expect(await directory.resolve({ id: "users/123", provider: "google-chat" })).toEqual(alice);
    expect(await directory.resolve({ id: "bob", provider: "static" })).toEqual({ id: "bob", roles: [] });
  });

  it("knows nobody else: the same id from another provider, a missing id", async () => {
    const directory = build(PEOPLE);
    expect(await directory.resolve({ id: "alice", provider: "oidc" })).toBeNull();
    expect(await directory.resolve({ id: "carol", provider: "static" })).toBeNull();
    expect(await directory.resolve({ id: "constructor", provider: "static" })).toBeNull();
  });

  it("hands out copies: a caller changing the roles changes nothing in the directory", async () => {
    const directory = build(PEOPLE);
    const first = await directory.resolve({ id: "alice", provider: "static" });
    first!.roles.push("admin");
    expect((await directory.resolve({ id: "alice", provider: "static" }))!.roles).toEqual(["mercury.act-as-self"]);
  });

  it("throws on a missing or malformed list, so the instance stays closed", () => {
    expect(() => build(undefined)).toThrow("DIRECTORY_STATIC_PEOPLE is missing");
    expect(() => build(" ")).toThrow("DIRECTORY_STATIC_PEOPLE is missing");
    expect(() => build("not json")).toThrow("DIRECTORY_STATIC_PEOPLE isn't valid JSON");
    expect(() => build("{}")).toThrow("DIRECTORY_STATIC_PEOPLE must be a list of people");
    expect(() => build("[]")).toThrow("DIRECTORY_STATIC_PEOPLE lists nobody");
  });

  // The id ends up in the person's key (`people:<id>`), their vault area and
  // the CLIs' --user: lowercase and short keeps all three working.
  it("throws on a person whose id isn't a short lowercase slug", () => {
    for (const id of ["", "Alice", "a b", "a:b", "-a", "a".repeat(49), 3]) {
      expect(() => build(JSON.stringify([{ id, identities: ["static:x"] }]))).toThrow(
        "DIRECTORY_STATIC_PEOPLE: every person needs an id of lowercase letters, digits, '.', '_' or '-' (at most 48)",
      );
    }
  });

  it("throws on a malformed field, naming the person", () => {
    const one = (person: object) => () => build(JSON.stringify([{ id: "a", identities: ["static:a"], ...person }]));
    expect(one({ displayName: 3 })).toThrow('DIRECTORY_STATIC_PEOPLE: "a" has a "displayName" that isn\'t a string');
    expect(one({ email: 3 })).toThrow('DIRECTORY_STATIC_PEOPLE: "a" has an "email" that isn\'t a string');
    expect(one({ roles: "admin" })).toThrow('DIRECTORY_STATIC_PEOPLE: "a" has "roles" that aren\'t a list of strings');
    expect(one({ identities: [] })).toThrow('DIRECTORY_STATIC_PEOPLE: "a" needs at least one identity, as "<provider>:<id>"');
    expect(one({ identities: ["alice"] })).toThrow('DIRECTORY_STATIC_PEOPLE: "a" has an identity that isn\'t "<provider>:<id>": alice');
    expect(one({ identities: ["static:"] })).toThrow('DIRECTORY_STATIC_PEOPLE: "a" has an identity that isn\'t "<provider>:<id>": static:');
  });

  // One identity is one person: two people claiming it would make who's
  // talking depend on the list's order.
  it("throws on an identity two people claim, or a person listed twice", () => {
    expect(() =>
      build(JSON.stringify([{ id: "a", identities: ["static:x"] }, { id: "b", identities: ["static:x"] }])),
    ).toThrow('DIRECTORY_STATIC_PEOPLE: "static:x" belongs to both "a" and "b"');
    expect(() => build(JSON.stringify([{ id: "a", identities: ["static:x"] }, { id: "a", identities: ["static:y"] }]))).toThrow(
      'DIRECTORY_STATIC_PEOPLE lists "a" twice',
    );
  });
});
