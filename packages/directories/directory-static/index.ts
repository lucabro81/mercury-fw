/**
 * The static directory: a fixed list of people, read from
 * `DIRECTORY_STATIC_PEOPLE`, each with the identities the channels know them by
 * and their roles. For an instance whose admin lists the people by hand, and
 * for the test bed; an app gets it only by declaring `directory: staticDirectory`
 * in `mercury.config.ts`.
 *
 * `DIRECTORY_STATIC_PEOPLE` is JSON, a list of
 * `{"id": "alice", "displayName"?: "…", "email"?: "…", "roles"?: ["…"], "identities": ["static:alice", "google-chat:users/123"]}`.
 * An identity is `<provider>:<id>` as a channel or auth provider vouches for it,
 * and belongs to one person only. A missing or malformed list throws in `build`,
 * so the instance stays closed to everyone but the terminal.
 */
import type { DirectoryPerson, DirectoryPlugin } from "@mercury-fw/channel-types";

const ENV = "DIRECTORY_STATIC_PEOPLE";

/** A person's id: part of their key (`people:<id>`), their vault area and the CLIs' `--user`. */
const ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** `<provider>:<id>`, both non-empty. */
const IDENTITY = /^[^:]+:.+$/;

/** The people in `raw`, the value of `DIRECTORY_STATIC_PEOPLE`, by identity; throws naming what's wrong. */
function parsePeople(raw: string | undefined): Map<string, DirectoryPerson> {
  if (raw === undefined || raw.trim() === "") throw new Error(`${ENV} is missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV} isn't valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${ENV} must be a list of people`);
  if (parsed.length === 0) throw new Error(`${ENV} lists nobody`);

  const byIdentity = new Map<string, DirectoryPerson>();
  const owners = new Map<string, string>();
  const ids = new Set<string>();
  for (const value of parsed) {
    const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const { id } = entry;
    if (typeof id !== "string" || !ID.test(id)) {
      throw new Error(`${ENV}: every person needs an id of lowercase letters, digits, '.', '_' or '-' (at most 48)`);
    }
    if (ids.has(id)) throw new Error(`${ENV} lists "${id}" twice`);
    ids.add(id);
    if (entry.displayName !== undefined && typeof entry.displayName !== "string") {
      throw new Error(`${ENV}: "${id}" has a "displayName" that isn't a string`);
    }
    if (entry.email !== undefined && typeof entry.email !== "string") throw new Error(`${ENV}: "${id}" has an "email" that isn't a string`);
    const { roles } = entry;
    if (roles !== undefined && !(Array.isArray(roles) && roles.every((r) => typeof r === "string"))) {
      throw new Error(`${ENV}: "${id}" has "roles" that aren't a list of strings`);
    }
    const { identities } = entry;
    if (!Array.isArray(identities) || identities.length === 0) {
      throw new Error(`${ENV}: "${id}" needs at least one identity, as "<provider>:<id>"`);
    }
    const person: DirectoryPerson = {
      id,
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName as string }),
      ...(entry.email === undefined ? {} : { email: entry.email as string }),
      roles: (roles as string[] | undefined) ?? [],
    };
    for (const identity of identities) {
      if (typeof identity !== "string" || !IDENTITY.test(identity)) {
        throw new Error(`${ENV}: "${id}" has an identity that isn't "<provider>:<id>": ${String(identity)}`);
      }
      const owner = owners.get(identity);
      if (owner !== undefined) throw new Error(`${ENV}: "${identity}" belongs to both "${owner}" and "${id}"`);
      owners.set(identity, id);
      byIdentity.set(identity, person);
    }
  }
  return byIdentity;
}

export const staticDirectory: DirectoryPlugin = {
  // The contract this directory is written for, as a literal: importing
  // DIRECTORY_API_VERSION would report whichever contract is installed.
  apiVersion: 1,
  name: "people",
  build: (ctx) => {
    const people = parsePeople(ctx.env[ENV]);
    return {
      resolve: async (principal) => {
        const person = people.get(`${principal.provider}:${principal.id}`);
        return person === undefined ? null : { ...person, roles: [...person.roles] };
      },
    };
  },
};
