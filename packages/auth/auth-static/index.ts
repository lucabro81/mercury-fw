/**
 * The static auth provider: a fixed map from bearer token to user, read from
 * `AUTH_STATIC_TOKENS`. Meant for the test bed and e2e tests (two tokens, two
 * users, so isolation between people can be checked), never a default: an app
 * gets it only by declaring `auth: staticAuth` in `mercury.config.ts`.
 *
 * `AUTH_STATIC_TOKENS` is JSON, `{"<token>": {"id": "alice", "displayName"?: "Alice"}}`:
 * who is calling, nothing more (their roles come from the directory).
 * A missing or malformed map throws in `build`, so the channel that needs the
 * provider stays closed. Tokens are compared by their SHA-256 digests in
 * constant time, all of them on every request, and never appear in a message.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthPlugin, Principal } from "@mercury-fw/channel-types";

const ENV = "AUTH_STATIC_TOKENS";

/** One declared token: its digest and the principal it stands for. */
type Entry = { digest: Buffer; principal: Principal };

/** SHA-256 of `token`, so every comparison runs on 32 bytes whatever the token's length. */
function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** The token entries in `raw`, the value of `AUTH_STATIC_TOKENS`; throws naming what's wrong, never a token. */
function parseTokens(raw: string | undefined): Entry[] {
  if (raw === undefined || raw.trim() === "") throw new Error(`${ENV} is missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV} isn't valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${ENV} must be an object from token to user`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new Error(`${ENV} declares no token`);

  return entries.map(([token, value]) => {
    if (token === "") throw new Error(`${ENV} declares an empty token`);
    const user = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if (typeof user.id !== "string" || user.id === "") throw new Error(`${ENV}: the user of a token has no "id"`);
    if (user.displayName !== undefined && typeof user.displayName !== "string") {
      throw new Error(`${ENV}: user "${user.id}" has a "displayName" that isn't a string`);
    }
    if (user.roles !== undefined) {
      throw new Error(
        `${ENV}: user "${user.id}" has "roles", which the auth provider no longer carries: declare them in the directory (e.g. @mercury-fw/directory-static)`,
      );
    }
    const principal: Principal = { id: user.id, provider: "static" };
    if (user.displayName !== undefined) principal.displayName = user.displayName;
    return { digest: digest(token), principal };
  });
}

/** The token in a `Bearer` authorization header, or `null` without one. */
function bearerToken(req: Request): string | null {
  const match = /^Bearer +(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return match ? match[1]! : null;
}

export const staticAuth: AuthPlugin = {
  // The contract this provider is written for, as a literal: importing
  // AUTH_API_VERSION would report whichever contract is installed.
  apiVersion: 1,
  name: "static",
  build: (ctx) => {
    const entries = parseTokens(ctx.env[ENV]);
    return async (req) => {
      const token = bearerToken(req);
      if (token === null) return null;
      const given = digest(token);
      let found: Principal | null = null;
      // Compare against every entry, so the time taken doesn't say which one matched.
      for (const entry of entries) {
        if (timingSafeEqual(entry.digest, given)) found = entry.principal;
      }
      return found === null ? null : { ...found };
    };
  },
};
