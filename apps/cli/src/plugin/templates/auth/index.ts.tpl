/**
 * The __TITLE__ auth provider: tells a channel that takes credentials (HTTP)
 * who is calling, from an API key per person in `__CONSTANT___KEYS`
 * (`key=id,key=id`) sent as `Authorization: Bearer <key>`. Written by
 * `mfw plugin create` as a starting point: a provider asking an identity
 * service goes where `authenticate` reads the request. Its people carry its
 * name as their provider, so their keys never clash with another provider's.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthPlugin, Authenticate, Principal } from "@mercury-fw/kit";

/** A key's SHA-256 digest: keys are compared by digest, in constant time. */
function digest(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** The people `value` names, by their key's digest; throws on a value that isn't `key=id,key=id`. */
export function parseKeys(value: string | undefined): Array<{ digest: Buffer; id: string }> {
  if (value === undefined || value.trim() === "") throw new Error("__CONSTANT___KEYS is not set");
  return value.split(",").map((pair) => {
    const [key, id, ...rest] = pair.split("=").map((s) => s.trim());
    if (!key || !id || rest.length > 0) throw new Error(`__CONSTANT___KEYS: "${pair}" isn't key=id`);
    return { digest: digest(key), id };
  });
}

/** Who is calling with `req`, against `people`; `null` for no key, or one nobody has. */
export function authenticateWith(people: Array<{ digest: Buffer; id: string }>, provider: string): Authenticate {
  return async (req) => {
    const match = /^Bearer +(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
    if (!match) return null;
    const given = digest(match[1]!);
    let found: Principal | null = null;
    // Every entry compared, so the time taken doesn't say which matched.
    for (const person of people) {
      if (timingSafeEqual(person.digest, given)) found = { id: person.id, provider };
    }
    return found;
  };
}

/** The provider. Declare it as `auth`. */
export function __EXPORT__(): AuthPlugin {
  return {
    // The contract this provider is written for, as a literal: importing
    // AUTH_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    // A provider set up wrong throws: the core leaves it out, closed, never open.
    build: (ctx) => authenticateWith(parseKeys(ctx.env.__CONSTANT___KEYS), "__NAME__"),
  };
}
