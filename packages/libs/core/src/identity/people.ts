/**
 * Who a principal is to Mercury, decided in one place. A channel says who is
 * talking (`Principal`); this turns it into the person every per-person store
 * keys on, with the roles that decide what they may make Mercury do.
 *
 * - The terminal (`none`) is the operator: whoever has the container's shell.
 * - Without a directory, the person is whoever the channel says, with no roles.
 * - With one, the directory decides: a person it knows is keyed on
 *   `<directory name>:<id>`; someone it doesn't is refused (a closed instance,
 *   the default) or taken as the channel says (an open one). A directory that
 *   can't answer refuses everyone: identity fails closed.
 *
 * Answers are cached per principal for `ttlMs`, so a role revoked in the
 * directory stops counting within that time; failures aren't cached.
 */
import type { Admission, Directory, Principal } from "@mercury-fw/channel-types";
import { userKey } from "./user-key.ts";

/** A person as the core keeps them: the key every per-person store uses, and their roles. */
export type Person = { key: string; displayName?: string; email?: string; roles: string[] };

/** Who a turn or a read is for, once identified: the person, and whether they're the operator (the terminal). */
export type TurnWho = { person: Person; operator: boolean };

/** A principal identified: the person and whether they're the operator, or why the core won't talk to them. */
export type Identified =
  | { ok: true; person: Person; operator: boolean }
  | { ok: false; reason: "unknown" | "unavailable"; message: string };

export const UNKNOWN_MESSAGE = "This assistant only talks to the people it knows. Ask an administrator for access.";
export const UNAVAILABLE_MESSAGE = "I can't check who you are right now. Try again in a few minutes.";

/** The ttl of a directory answer: a revoked role stops counting within it. */
export const DEFAULT_IDENTITY_TTL_MS = 5 * 60_000;

export type PeopleOptions = {
  /** The declared directory, built; `"none"` when the app declares none, `"failed"` when it declares one that didn't load. */
  directory: { name: string; directory: Directory } | "none" | "failed";
  /** What to do with someone the directory doesn't know (default `refuse`). */
  unknown?: "refuse" | "allow";
  unknownMessage?: string;
  ttlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
};

/** Builds `identify` (and its `admit` view) over the declared directory. */
export function createPeople(opts: PeopleOptions) {
  const ttlMs = opts.ttlMs ?? DEFAULT_IDENTITY_TTL_MS;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const unknownMessage = opts.unknownMessage ?? UNKNOWN_MESSAGE;
  const cache = new Map<string, { value: Identified; expiresAt: number }>();
  const inFlight = new Map<string, Promise<Identified>>();

  /** The person as the channel says, for an instance with no directory or an open one. */
  const asTheChannelSays = (principal: Principal): Identified => ({
    ok: true,
    operator: false,
    person: { key: userKey(principal), ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }), roles: [] },
  });

  const unavailable: Identified = { ok: false, reason: "unavailable", message: UNAVAILABLE_MESSAGE };

  /** Asks the directory, mapping its answer; throws only when it does. */
  async function lookUp(principal: Principal, name: string, directory: Directory): Promise<Identified> {
    const found = await directory.resolve(principal);
    if (found === null) {
      return opts.unknown === "allow" ? asTheChannelSays(principal) : { ok: false, reason: "unknown", message: unknownMessage };
    }
    return {
      ok: true,
      operator: false,
      person: {
        key: `${name}:${found.id}`,
        ...(found.displayName === undefined ? {} : { displayName: found.displayName }),
        ...(found.email === undefined ? {} : { email: found.email }),
        roles: [...found.roles],
      },
    };
  }

  async function identify(principal: Principal): Promise<Identified> {
    if (principal.provider === "none") return { ok: true, operator: true, person: { key: userKey(principal), roles: [] } };
    const { directory } = opts;
    if (directory === "none") return asTheChannelSays(principal);
    if (directory === "failed") return unavailable;

    const key = userKey(principal);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const pending = inFlight.get(key);
    if (pending) return pending;

    const lookup = lookUp(principal, directory.name, directory.directory)
      .then((value) => {
        cache.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .catch((err: unknown) => {
        log(`[identity] directory "${directory.name}" couldn't identify ${key}, refused: ${err instanceof Error ? err.message : String(err)}`);
        return unavailable;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, lookup);
    return lookup;
  }

  return {
    identify,
    /** Whether the core talks to `principal` at all: `identify` without the person. */
    admit: async (principal: Principal): Promise<Admission> => {
      const identified = await identify(principal);
      return identified.ok ? { ok: true } : identified;
    },
  };
}

export type People = ReturnType<typeof createPeople>;
