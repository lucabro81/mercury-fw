/**
 * The __TITLE__ directory: who people are and their roles, from
 * `__CONSTANT___PEOPLE`, a JSON list of people with the channel identities
 * that are theirs. Written by `mfw plugin create` as a starting point: a
 * directory asking an identity service goes in `resolve`. When it can't tell
 * (the service is down), it throws: the core then refuses, it never guesses.
 */
import type { DirectoryPerson, DirectoryPlugin, Principal } from "@mercury-fw/kit";

/** A person as the setting lists them: who they are, their roles, the identities channels know them by. */
export type ListedPerson = DirectoryPerson & { identities: Array<{ provider: string; id: string }> };

/** The people `value` lists; throws on a value that isn't such a list. */
export function parsePeople(value: string | undefined): ListedPerson[] {
  if (value === undefined || value.trim() === "") throw new Error("__CONSTANT___PEOPLE is not set");
  let people: unknown;
  try {
    people = JSON.parse(value);
  } catch {
    throw new Error("__CONSTANT___PEOPLE isn't JSON");
  }
  const valid = (p: unknown): p is ListedPerson => {
    const person = p as Partial<ListedPerson> | null;
    return (
      typeof person?.id === "string" &&
      Array.isArray(person.roles) &&
      person.roles.every((r) => typeof r === "string") &&
      Array.isArray(person.identities) &&
      person.identities.every((i) => typeof i?.provider === "string" && typeof i?.id === "string")
    );
  };
  if (!Array.isArray(people) || !people.every(valid)) {
    throw new Error("__CONSTANT___PEOPLE is a list of { id, roles: [], identities: [{ provider, id }] }");
  }
  return people;
}

/** The person whose identities include `principal`, or `null` when nobody's do. */
export function resolveIn(people: ListedPerson[], principal: Principal): DirectoryPerson | null {
  const person = people.find((p) => p.identities.some((i) => i.provider === principal.provider && i.id === principal.id));
  if (person === undefined) return null;
  const { identities: _, ...known } = person;
  return known;
}

/** The directory. Declare it as `directory`. */
export function __EXPORT__(): DirectoryPlugin {
  return {
    // The contract this directory is written for, as a literal: importing
    // DIRECTORY_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    // A directory set up wrong throws: the core then lets in nobody but the terminal.
    build: (ctx) => {
      const people = parsePeople(ctx.env.__CONSTANT___PEOPLE);
      return { resolve: async (principal) => resolveIn(people, principal) };
    },
  };
}
