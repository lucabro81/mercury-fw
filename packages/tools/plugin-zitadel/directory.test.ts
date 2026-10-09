import { describe, expect, it } from "bun:test";
import { DIRECTORY_API_VERSION } from "@mercury-fw/channel-types";
import type { CliResult } from "@mercury-fw/cli-engine";
import { createZitadelDirectory } from "./directory.ts";

const SUB = "373053913395385459";
const person = { id: SUB, provider: "oidc" as const };

const activeUser: CliResult = {
  ok: true,
  data: {
    user: {
      state: "USER_STATE_ACTIVE",
      username: "jane.doe",
      human: { profile: { displayName: "Jane Doe" }, email: { email: "jane@example.com", isVerified: true } },
    },
  },
};

/** A directory over a fake CLI answering `user get` and `user authorizations`, recording each call. */
function directoryWith(answers: { get?: CliResult; authorizations?: CliResult }, env: Record<string, string | undefined> = { ZITADEL_PROJECT_ID: "p1" }) {
  const calls: string[][] = [];
  const plugin = createZitadelDirectory({
    runCliFn: async (binary, args) => {
      calls.push([binary, ...args]);
      if (args[1] === "get") return answers.get ?? activeUser;
      return answers.authorizations ?? { ok: true, data: {} };
    },
  });
  return { directory: plugin.build({ env, log: () => {} }), plugin, calls };
}

const roles = (...sets: Array<{ keys?: string[]; state?: string }>): CliResult => ({
  ok: true,
  data: {
    authorizations: sets.map((s) => ({
      state: s.state ?? "STATE_ACTIVE",
      ...(s.keys === undefined ? {} : { roles: s.keys.map((key) => ({ key })) }),
    })),
  },
});

describe("zitadelDirectory", () => {
  it("declares the directory contract it was written for, as a literal, and its name", () => {
    const { plugin } = directoryWith({});
    expect(plugin.apiVersion).toBe(DIRECTORY_API_VERSION);
    expect(plugin.name).toBe("zitadel");
  });

  it("resolves an OIDC subject to the ZITADEL user, with the project's active roles", async () => {
    const { directory, calls } = directoryWith({ authorizations: roles({ keys: ["mercury.act-as-self", "dev"] }) });
    expect(await directory.resolve(person)).toEqual({
      id: SUB,
      displayName: "Jane Doe",
      email: "jane@example.com",
      roles: ["mercury.act-as-self", "dev"],
    });
    // As the service user (no --user), for this project only, active grants only.
    expect(calls).toEqual([
      ["zitadel", "user", "get", SUB, "--select", "user.state,user.username,user.human.profile.displayName,user.human.email.email,user.human.email.isVerified"],
      ["zitadel", "user", "authorizations", SUB, "--project-id", "p1", "--state", "active", "--select", "authorizations.roles.key,authorizations.state"],
    ]);
  });

  it("is a person with no roles when the user has no authorization on the project, or one without roles", async () => {
    expect(await directoryWith({}).directory.resolve(person)).toMatchObject({ roles: [] });
    expect(await directoryWith({ authorizations: roles({}) }).directory.resolve(person)).toMatchObject({ roles: [] });
  });

  // The CLI is asked for active grants only; an inactive one that comes back
  // anyway still grants nothing.
  it("counts only active authorizations, each role once", async () => {
    const { directory } = directoryWith({
      authorizations: roles({ keys: ["a", "b"] }, { keys: ["c"], state: "STATE_INACTIVE" }, { keys: ["a"] }),
    });
    expect(await directory.resolve(person)).toMatchObject({ roles: ["a", "b"] });
  });

  it("passes the email on only when ZITADEL verified it, and falls back to the username for the name", async () => {
    const unverified: CliResult = {
      ok: true,
      data: { user: { state: "USER_STATE_ACTIVE", username: "jane.doe", human: { email: { email: "jane@example.com", isVerified: false } } } },
    };
    expect(await directoryWith({ get: unverified }).directory.resolve(person)).toEqual({ id: SUB, displayName: "jane.doe", roles: [] });
  });

  it("doesn't know a user ZITADEL doesn't find, or one that isn't active, and reads no roles for them", async () => {
    const notFound: CliResult = { ok: false, error: "ZITADEL found no such resource (404): User could not be found", exitCode: 1 };
    const missing = directoryWith({ get: notFound });
    expect(await missing.directory.resolve(person)).toBeNull();
    expect(missing.calls).toHaveLength(1);
    for (const state of ["USER_STATE_INACTIVE", "USER_STATE_LOCKED", "USER_STATE_DELETED", "USER_STATE_INITIAL"]) {
      const inactive = directoryWith({ get: { ok: true, data: { user: { state, username: "x" } } } });
      expect(await inactive.directory.resolve(person)).toBeNull();
      expect(inactive.calls).toHaveLength(1);
    }
  });

  // Joining chat identities to ZITADEL users comes later: until then only an
  // OIDC subject is someone, and nothing asks ZITADEL about anyone else.
  it("doesn't know an identity from any other provider, and asks nothing", async () => {
    const { directory, calls } = directoryWith({});
    expect(await directory.resolve({ id: "users/1", provider: "google-chat" })).toBeNull();
    expect(await directory.resolve({ id: SUB, provider: "static" })).toBeNull();
    expect(calls).toEqual([]);
  });

  // Any other failure means it couldn't tell: the core refuses as unavailable,
  // it never takes that as "unknown".
  it("throws when the CLI fails for any other reason", async () => {
    const down: CliResult = { ok: false, error: "ZITADEL rejected the access token (401)", exitCode: 1 };
    await expect(directoryWith({ get: down }).directory.resolve(person)).rejects.toThrow("zitadel user get failed: ZITADEL rejected the access token (401)");
    await expect(directoryWith({ authorizations: down }).directory.resolve(person)).rejects.toThrow(
      "zitadel user authorizations failed: ZITADEL rejected the access token (401)",
    );
    await expect(directoryWith({ get: { ok: true, data: "not json" } }).directory.resolve(person)).rejects.toThrow("zitadel user get printed no user");
    // Not "no roles": something it can't read is a failure, not an answer.
    await expect(directoryWith({ authorizations: { ok: true, data: "not json" } }).directory.resolve(person)).rejects.toThrow(
      "zitadel user authorizations printed no JSON",
    );
  });

  // Only ZITADEL saying the user doesn't exist is "unknown": a 404 from
  // anything else (a wrong instance URL behind a proxy) is a failure.
  it("takes only the CLI's own not-found as unknown", async () => {
    const proxy404: CliResult = { ok: false, error: "the API answered (404): <html>Not Found</html>", exitCode: 1 };
    await expect(directoryWith({ get: proxy404 }).directory.resolve(person)).rejects.toThrow("zitadel user get failed");
  });

  it("throws without the project whose roles count, so the instance stays closed", () => {
    for (const env of [{}, { ZITADEL_PROJECT_ID: " " }]) {
      expect(() => directoryWith({}, env)).toThrow("ZITADEL_PROJECT_ID is not set: the ZITADEL project whose roles count");
    }
  });

  // The subject goes on the command line: it must be one argument that can't
  // read as a flag.
  it("doesn't know a subject that isn't a ZITADEL user id, and asks nothing", async () => {
    const { directory, calls } = directoryWith({});
    for (const id of ["--help", "1 2", "", "abc"]) expect(await directory.resolve({ id, provider: "oidc" })).toBeNull();
    expect(calls).toEqual([]);
  });
});
