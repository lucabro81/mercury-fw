import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import { AUTH_API_VERSION, type Authenticate } from "@mercury-fw/channel-types";
import { createOidcAuth, oidcAuth } from "./index.ts";

const AUDIENCE = "mercury-ui";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let server: ReturnType<typeof Bun.serve>;
let issuer: string;
/** What the fake issuer's discovery document says its issuer is; defaults to its own URL. */
let advertisedIssuer: string | undefined;
/** When true, the discovery endpoint answers 500. */
let discoveryDown = false;
/** When true, the discovery endpoint never answers. */
let discoveryHangs = false;
/** When true, the key set endpoint answers 500. */
let keysDown = false;
let discoveryHits = 0;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = Bun.serve({
    port: 0,
    routes: {
      "/.well-known/openid-configuration": () => {
        discoveryHits++;
        if (discoveryHangs) return new Promise<Response>(() => {});
        if (discoveryDown) return new Response("down", { status: 500 });
        return Response.json({ issuer: advertisedIssuer ?? issuer, jwks_uri: `${issuer}/keys` });
      },
      "/keys": () => (keysDown ? new Response("down", { status: 500 }) : Response.json({ keys: [jwk] })),
    },
  });
  issuer = `http://localhost:${server.port}`;
});

afterAll(() => server.stop());

beforeEach(() => {
  advertisedIssuer = undefined;
  discoveryDown = false;
  discoveryHangs = false;
  keysDown = false;
  discoveryHits = 0;
});

/** A token signed by `key` (the issuer's own by default) with `claims`, the default iss/aud/sub/exp unless overridden. */
async function token(claims: JWTPayload = {}, key: CryptoKey = signingKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: AUDIENCE, sub: "312345", iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(key);
}

function build(env: Record<string, string | undefined> = { OIDC_ISSUER: issuer, OIDC_AUDIENCE: AUDIENCE }, logs: string[] = []): Authenticate {
  return oidcAuth.build({ env, log: (m) => logs.push(m) });
}

function request(authorization?: string): Request {
  return new Request("http://mercury/turn", { headers: authorization === undefined ? {} : { authorization } });
}

describe("oidcAuth", () => {
  it("declares the auth contract it was written for, as a literal", () => {
    expect(oidcAuth.apiVersion).toBe(AUTH_API_VERSION);
    expect(oidcAuth.name).toBe("oidc");
  });

  it("maps a valid token onto a principal: sub as id, the name as display name, the claims kept", async () => {
    const jwt = await token({ name: "Alice Rossi", email: "alice@example.com" });
    const principal = await build()(request(`Bearer ${jwt}`));
    expect(principal).toMatchObject({ id: "312345", provider: "oidc", displayName: "Alice Rossi" });
    expect(principal?.claims).toMatchObject({ iss: issuer, aud: AUDIENCE, sub: "312345", email: "alice@example.com" });
    expect(principal).not.toHaveProperty("roles");
  });

  it("falls back to preferred_username, then email, for the display name, and omits it without either", async () => {
    const authenticate = build();
    expect((await authenticate(request(`Bearer ${await token({ preferred_username: "alice", email: "a@x.it" })}`)))?.displayName).toBe("alice");
    expect((await authenticate(request(`Bearer ${await token({ email: "a@x.it" })}`)))?.displayName).toBe("a@x.it");
    const bare = await authenticate(request(`Bearer ${await token()}`));
    expect(bare).not.toBeNull();
    expect("displayName" in bare!).toBe(false);
  });

  it("refuses a token signed by another key", async () => {
    expect(await build()(request(`Bearer ${await token({}, otherKey)}`))).toBeNull();
  });

  it("refuses a token from another issuer, or for another audience", async () => {
    const authenticate = build();
    expect(await authenticate(request(`Bearer ${await token({ iss: "https://evil.example" })}`))).toBeNull();
    expect(await authenticate(request(`Bearer ${await token({ aud: "another-app" })}`))).toBeNull();
  });

  it("refuses an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await build()(request(`Bearer ${await token({ iat: past - 300, exp: past })}`))).toBeNull();
  });

  // Cold review of #37: jose checks exp only when it's there, so a signed
  // token without one (a misconfigured issuer, a non-expiring service token)
  // authenticated forever.
  it("refuses a token without an expiry", async () => {
    expect(await build()(request(`Bearer ${await token({ exp: undefined })}`))).toBeNull();
  });

  it("refuses a token without a subject", async () => {
    expect(await build()(request(`Bearer ${await token({ sub: undefined })}`))).toBeNull();
  });

  it("refuses an unsigned token (alg none)", async () => {
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "none" })}.${encode({ iss: issuer, aud: AUDIENCE, sub: "1", exp: now + 300 })}.`;
    expect(await build()(request(`Bearer ${unsigned}`))).toBeNull();
  });

  it("refuses a missing header, another scheme, garbage", async () => {
    const authenticate = build();
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request(`Basic ${await token()}`))).toBeNull();
    expect(await authenticate(request("Bearer not-a-jwt"))).toBeNull();
  });

  it("discovers the issuer once and reuses its keys", async () => {
    const authenticate = build();
    await authenticate(request(`Bearer ${await token()}`));
    await authenticate(request(`Bearer ${await token()}`));
    expect(discoveryHits).toBe(1);
  });

  it("refuses while the issuer is unreachable, logs it, and retries discovery on the next request", async () => {
    const logs: string[] = [];
    const authenticate = build(undefined, logs);
    discoveryDown = true;
    expect(await authenticate(request(`Bearer ${await token()}`))).toBeNull();
    expect(logs.some((l) => l.startsWith(`oidc: discovery at ${issuer} failed`))).toBe(true);
    discoveryDown = false;
    expect(await authenticate(request(`Bearer ${await token()}`))).toMatchObject({ id: "312345" });
    expect(discoveryHits).toBe(2);
  });

  // Cold review of #37: discovery had no timeout, so an issuer that accepted
  // the connection and never answered hung every request on the same promise,
  // with no 401, no log, and no retry.
  it("gives up on a discovery that doesn't answer in time: refuses, logs, and tries again next time", async () => {
    const logs: string[] = [];
    const authenticate = createOidcAuth({ discoveryTimeoutMs: 100 }).build({
      env: { OIDC_ISSUER: issuer, OIDC_AUDIENCE: AUDIENCE },
      log: (m) => logs.push(m),
    });
    discoveryHangs = true;
    expect(await authenticate(request(`Bearer ${await token()}`))).toBeNull();
    expect(logs.some((l) => l.startsWith(`oidc: discovery at ${issuer} failed`))).toBe(true);
    discoveryHangs = false;
    expect(await authenticate(request(`Bearer ${await token()}`))).toMatchObject({ id: "312345" });
    expect(discoveryHits).toBe(2);
  });

  it("refuses while the issuer's key set is unreachable, and logs it", async () => {
    const logs: string[] = [];
    keysDown = true;
    expect(await build(undefined, logs)(request(`Bearer ${await token()}`))).toBeNull();
    expect(logs.some((l) => l.startsWith(`oidc: verifying a token against ${issuer} failed`))).toBe(true);
  });

  it("doesn't log a token that is merely invalid", async () => {
    const logs: string[] = [];
    await build(undefined, logs)(request(`Bearer ${await token({ aud: "another-app" })}`));
    expect(logs).toEqual([]);
  });

  it("refuses an issuer whose discovery document names another issuer", async () => {
    const logs: string[] = [];
    advertisedIssuer = "https://someone-else.example";
    expect(await build(undefined, logs)(request(`Bearer ${await token()}`))).toBeNull();
    expect(logs.some((l) => l.includes("names issuer https://someone-else.example"))).toBe(true);
  });

  it("never logs the token", async () => {
    const logs: string[] = [];
    const jwt = await token({}, otherKey);
    await build(undefined, logs)(request(`Bearer ${jwt}`));
    expect(logs.join("\n")).not.toContain(jwt);
  });

  it("throws without an issuer or an audience, or with an issuer that isn't a URL", () => {
    expect(() => build({ OIDC_AUDIENCE: AUDIENCE })).toThrow("OIDC_ISSUER is missing");
    expect(() => build({ OIDC_ISSUER: issuer })).toThrow("OIDC_AUDIENCE is missing");
    expect(() => build({ OIDC_ISSUER: "zitadel", OIDC_AUDIENCE: AUDIENCE })).toThrow("OIDC_ISSUER isn't a URL");
  });
});
