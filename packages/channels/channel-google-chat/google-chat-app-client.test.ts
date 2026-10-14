import { describe, expect, test } from "bun:test";
import {
  buildSignedAssertion,
  createTokenSource,
  sendMessage,
  sendCard,
  updateCard,
  getOrCreateDmSpace,
  type FetchFn,
} from "./google-chat-app-client.ts";
import { generateKeyPairSync, createVerify } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const creds = { clientEmail: "bot@test.iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) as string };

function decodeJwt(jwt: string): { header: any; claims: any; signedPart: string; signature: string } {
  const [headerB64, claimsB64, sigB64] = jwt.split(".");
  const pad = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return {
    header: JSON.parse(Buffer.from(pad(headerB64!), "base64").toString("utf-8")),
    claims: JSON.parse(Buffer.from(pad(claimsB64!), "base64").toString("utf-8")),
    signedPart: `${headerB64}.${claimsB64}`,
    signature: sigB64!,
  };
}

describe("buildSignedAssertion", () => {
  test("produces a JWT with the expected header/claims and a signature verifiable against the public key", () => {
    const jwt = buildSignedAssertion(creds, "scope-a scope-b", 1_000_000);
    const { header, claims, signedPart, signature } = decodeJwt(jwt);

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({
      iss: "bot@test.iam.gserviceaccount.com",
      scope: "scope-a scope-b",
      aud: "https://oauth2.googleapis.com/token",
      exp: 1_000_000 + 3600,
      iat: 1_000_000,
    });

    const pad = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signedPart);
    verifier.end();
    expect(verifier.verify(publicKey.export({ type: "spki", format: "pem" }), Buffer.from(pad(signature), "base64"))).toBe(true);
  });
});

describe("createTokenSource", () => {
  test("mints once and reuses the cached token while it's still fresh", async () => {
    let mintCount = 0;
    const fetchFn: FetchFn = (async () => {
      mintCount++;
      return new Response(JSON.stringify({ access_token: `token-${mintCount}`, expires_in: 3600 }), { status: 200 });
    }) as any;

    const source = createTokenSource(creds, { fetchFn, nowSeconds: () => 1000 });
    const t1 = await source.getToken();
    const t2 = await source.getToken();

    expect(t1).toBe("token-1");
    expect(t2).toBe("token-1");
    expect(mintCount).toBe(1);
  });

  test("re-mints once the cached token is within the refresh margin of expiry", async () => {
    let mintCount = 0;
    let now = 1000;
    const fetchFn: FetchFn = (async () => {
      mintCount++;
      return new Response(JSON.stringify({ access_token: `token-${mintCount}`, expires_in: 100 }), { status: 200 });
    }) as any;

    const source = createTokenSource(creds, { fetchFn, nowSeconds: () => now });
    const t1 = await source.getToken();
    now += 45; // within 60s of the 100s expiry
    const t2 = await source.getToken();

    expect(t1).toBe("token-1");
    expect(t2).toBe("token-2");
    expect(mintCount).toBe(2);
  });

  test("throws with the response body when the token endpoint rejects the request", async () => {
    const fetchFn: FetchFn = (async () => new Response("invalid_grant", { status: 400 })) as any;
    const source = createTokenSource(creds, { fetchFn, nowSeconds: () => 1000 });
    await expect(source.getToken()).rejects.toThrow(/HTTP 400/);
  });
});

function fakeTokenSource(token = "fake-token") {
  return { getToken: async () => token };
}

describe("sendMessage", () => {
  test("POSTs to spaces/{id}/messages with the text and Bearer token, returns the created message name", async () => {
    let capturedUrl = "";
    let capturedInit: any;
    const fetchFn: FetchFn = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ name: "spaces/X/messages/1" }), { status: 200 });
    }) as any;

    const result = await sendMessage("spaces/X", "hello", { tokenSource: fakeTokenSource(), fetchFn });

    expect(result).toEqual({ name: "spaces/X/messages/1" });
    expect(capturedUrl).toBe("https://chat.googleapis.com/v1/spaces/X/messages");
    expect(capturedInit.method).toBe("POST");
    expect(capturedInit.headers.Authorization).toBe("Bearer fake-token");
    expect(JSON.parse(capturedInit.body)).toEqual({ text: "hello" });
  });

  test("throws with the response body on a non-2xx response", async () => {
    const fetchFn: FetchFn = (async () => new Response("permission denied", { status: 403 })) as any;
    await expect(sendMessage("spaces/X", "hello", { tokenSource: fakeTokenSource(), fetchFn })).rejects.toThrow(/HTTP 403/);
  });
});

describe("sendCard", () => {
  test("POSTs cardsV2 with the given card", async () => {
    let capturedBody: any;
    const fetchFn: FetchFn = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ name: "spaces/X/messages/2" }), { status: 200 });
    }) as any;

    const card = { header: { title: "Chi intendi?" }, sections: [{ widgets: [] }] };
    const result = await sendCard("spaces/X", card, { tokenSource: fakeTokenSource(), fetchFn });

    expect(result).toEqual({ name: "spaces/X/messages/2" });
    expect(capturedBody).toEqual({ cardsV2: [{ cardId: "card", card }] });
  });

  test("with a private viewer, the message is visible to that user only", async () => {
    let capturedBody: any;
    const fetchFn: FetchFn = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ name: "spaces/X/messages/3" }), { status: 200 });
    }) as any;

    const card = { sections: [{ widgets: [{ textParagraph: { text: "x" } }] }] };
    const result = await sendCard("spaces/X", card, { tokenSource: fakeTokenSource(), fetchFn }, { privateViewer: "users/42" });

    expect(result).toEqual({ name: "spaces/X/messages/3" });
    expect(capturedBody).toEqual({ cardsV2: [{ cardId: "card", card }], privateMessageViewer: { name: "users/42" } });
  });
});

describe("updateCard", () => {
  test("PATCHes the given message name with updateMask=cardsV2 and the card body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any;
    const fetchFn: FetchFn = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedMethod = init.method;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ name: "spaces/X/messages/1" }), { status: 200 });
    }) as any;

    const card = { sections: [{ header: "Sto usando jira…", collapsible: true, uncollapsibleWidgetsCount: 0, widgets: [] }] };
    const result = await updateCard("spaces/X/messages/1", card, { tokenSource: fakeTokenSource(), fetchFn });

    expect(result).toEqual({ name: "spaces/X/messages/1" });
    expect(capturedMethod).toBe("PATCH");
    expect(capturedUrl).toBe("https://chat.googleapis.com/v1/spaces/X/messages/1?updateMask=cardsV2");
    expect(capturedBody).toEqual({ cardsV2: [{ cardId: "card", card }] });
  });

  test("throws with the response body on a non-2xx response", async () => {
    const fetchFn: FetchFn = (async () => new Response("permission denied", { status: 403 })) as any;
    const card = { sections: [{ widgets: [] }] };
    await expect(updateCard("spaces/X/messages/1", card, { tokenSource: fakeTokenSource(), fetchFn })).rejects.toThrow(
      /HTTP 403/,
    );
  });
});

describe("getOrCreateDmSpace", () => {
  test("returns the existing DM space's name when findDirectMessage finds one", async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = (async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "spaces/existing-dm" }), { status: 200 });
    }) as any;

    const result = await getOrCreateDmSpace("users/42", { tokenSource: fakeTokenSource(), fetchFn });

    expect(result).toEqual({ name: "spaces/existing-dm" });
    expect(urls).toEqual(["https://chat.googleapis.com/v1/spaces:findDirectMessage?name=users%2F42"]);
  });

  test("falls back to spaces:setup when no existing DM is found", async () => {
    let call = 0;
    const bodies: any[] = [];
    const fetchFn: FetchFn = (async (_url: any, init: any) => {
      call++;
      if (call === 1) {
        return new Response("not found", { status: 404 });
      }
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ name: "spaces/new-dm" }), { status: 200 });
    }) as any;

    const result = await getOrCreateDmSpace("users/42", { tokenSource: fakeTokenSource(), fetchFn });

    expect(result).toEqual({ name: "spaces/new-dm" });
    expect(bodies).toEqual([
      { space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: "users/42", type: "HUMAN" } }] },
    ]);
  });
});
