/**
 * The OIDC auth provider: verifies the bearer token a caller sends against an
 * OpenID Connect issuer (Zitadel, Google, Keycloak, any of them, by
 * configuration) and maps its claims onto a principal.
 *
 * `OIDC_ISSUER` is the issuer's URL, the token's `iss`; `OIDC_AUDIENCE` is the
 * client id the UI calling Mercury is registered with, the token's `aud`, so a
 * token the same issuer minted for another application doesn't get in.
 *
 * The issuer's keys are found through its discovery document
 * (`/.well-known/openid-configuration`), fetched on the first request and kept
 * once it succeeds; a failed discovery (or one that doesn't answer within 5 s)
 * refuses that request, is logged, and is tried again on the next one. `jose` verifies the signature against the
 * issuer's JWKS (caching it and following key rotation), plus `iss`, `aud` and
 * expiry, which a token must carry: one without `exp` would never expire. Roles aren't read here: which claim carries them depends on the
 * issuer, and that's the user directory's job.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthPlugin, Principal } from "@mercury-fw/channel-types";

/** The token in a `Bearer` authorization header, or `null` without one. */
function bearerToken(req: Request): string | null {
  const match = /^Bearer +(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return match ? match[1]! : null;
}

/** `name`, then `preferred_username`, then `email`: the first that's a non-empty string. */
function displayNameOf(claims: Record<string, unknown>): string | undefined {
  for (const key of ["name", "preferred_username", "email"]) {
    const value = claims[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** How long discovery may take before the request it serves is refused. */
const DISCOVERY_TIMEOUT_MS = 5000;

/** The issuer's key set, from its discovery document; throws when the document is unreachable, too slow, malformed, or names another issuer. */
async function discoverKeys(issuer: string, timeoutMs: number): Promise<JWTVerifyGetKey> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (doc.issuer !== issuer) throw new Error(`the document names issuer ${String(doc.issuer)}`);
  if (typeof doc.jwks_uri !== "string") throw new Error("the document has no jwks_uri");
  return createRemoteJWKSet(new URL(doc.jwks_uri));
}

/** The OIDC provider with its discovery timeout, which only a test changes. */
export function createOidcAuth({ discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS }: { discoveryTimeoutMs?: number } = {}): AuthPlugin {
  return {
    // The contract this provider is written for, as a literal: importing
    // AUTH_API_VERSION would report whichever contract is installed.
    apiVersion: 1,
    name: "oidc",
    build: (ctx) => {
      const issuer = ctx.env.OIDC_ISSUER?.trim();
      const audience = ctx.env.OIDC_AUDIENCE?.trim();
      if (!issuer) throw new Error("OIDC_ISSUER is missing");
      if (!audience) throw new Error("OIDC_AUDIENCE is missing");
      if (!URL.canParse(issuer)) throw new Error("OIDC_ISSUER isn't a URL");

      let keys: Promise<JWTVerifyGetKey> | undefined;
      /** The issuer's keys, discovering them on first use; a failure is forgotten so the next request tries again. */
      const getKeys = (): Promise<JWTVerifyGetKey> => {
        keys ??= discoverKeys(issuer, discoveryTimeoutMs).catch((err: unknown) => {
          keys = undefined;
          throw err;
        });
        return keys;
      };

      return async (req) => {
        const token = bearerToken(req);
        if (token === null) return null;

        let jwks: JWTVerifyGetKey;
        try {
          jwks = await getKeys();
        } catch (err) {
          ctx.log(`oidc: discovery at ${issuer} failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }

        try {
          const { payload } = await jwtVerify(token, jwks, { issuer, audience, requiredClaims: ["exp"] });
          if (typeof payload.sub !== "string" || payload.sub === "") return null;
          const principal: Principal = { id: payload.sub, provider: "oidc", claims: { ...payload } };
          const displayName = displayNameOf(payload);
          if (displayName !== undefined) principal.displayName = displayName;
          return principal;
        } catch (err) {
          // A bad signature, a wrong iss/aud, an expired or malformed token is a
          // refused caller, answered with a 401, not an error of ours. Anything
          // else (the key set unreachable: jose's generic error or its timeout)
          // is ours, and worth a log line.
          if (!(err instanceof errors.JOSEError) || err.code === "ERR_JOSE_GENERIC" || err instanceof errors.JWKSTimeout) {
            ctx.log(`oidc: verifying a token against ${issuer} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return null;
        }
      };
    },
  };
}

export const oidcAuth: AuthPlugin = createOidcAuth();
