/**
 * The registered Chat app's own transport — Chat REST API + Pub/Sub pull,
 * called directly over HTTPS from this process. Channel transport
 * (reading/sending the messages that carry a conversation) is never something
 * the model drives, unlike a tool such as `notify-user.ts`, which it does invoke.
 *
 * Auth: a service-account JWT-bearer flow (RFC 7523), signed with Node's
 * built-in `crypto` — no new OAuth/Google API client dependency needed for
 * this. Scoped to `chat.bot` only — event delivery now goes through
 * `google-chat-pubsub-stream.ts` (`@google-cloud/pubsub`'s StreamingPull),
 * which mints its own token internally from the same credentials, not
 * through this token source. Re-minted lazily once it's within a minute of
 * expiring. Verified live against the real APIs earlier in this project's
 * history (a throwaway service account, JWT-bearer flow, `chat.bot` scope,
 * `spaces.messages.create` → HTTP 200, delivered as the app's own `BOT`
 * identity) before this file was written — this is that same pattern,
 * generalized and made persistent instead of a one-off script.
 */
import { createSign } from "node:crypto";

export type ServiceAccountCredentials = { clientEmail: string; privateKey: string };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const SCOPES = "https://www.googleapis.com/auth/chat.bot";
/** Re-mint this long before real expiry — a token that expires mid-request is worse than one wasted early. */
const REFRESH_MARGIN_SECONDS = 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Builds and signs the JWT assertion for the OAuth2 JWT-bearer grant. Pure function, no I/O — testable without a real key. */
export function buildSignedAssertion(creds: ServiceAccountCredentials, scope: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope,
      aud: TOKEN_URL,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(creds.privateKey));
  return `${unsigned}.${signature}`;
}

export type FetchFn = typeof fetch;

/** Exchanges a signed JWT assertion for an access token. Throws with the response body on failure — no fallback identity to authenticate as instead. */
async function exchangeAssertionForToken(
  assertion: string,
  fetchFn: FetchFn,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
}

export type TokenSource = { getToken(): Promise<string> };

/** A lazily-refreshing token source: mints once, reuses until close to expiry, re-mints after. */
export function createTokenSource(
  creds: ServiceAccountCredentials,
  deps: { fetchFn?: FetchFn; nowSeconds?: () => number } = {},
): TokenSource {
  const fetchFn = deps.fetchFn ?? fetch;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let cached: { accessToken: string; expiresAt: number } | null = null;

  return {
    async getToken(): Promise<string> {
      const now = nowSeconds();
      if (cached && cached.expiresAt - REFRESH_MARGIN_SECONDS > now) {
        return cached.accessToken;
      }
      const assertion = buildSignedAssertion(creds, SCOPES, now);
      const { accessToken, expiresInSeconds } = await exchangeAssertionForToken(assertion, fetchFn);
      cached = { accessToken, expiresAt: now + expiresInSeconds };
      return accessToken;
    },
  };
}

/** Throws with the response body on a non-2xx result — there's no fallback the caller can take instead of knowing the real call failed. */
async function callChatApi(
  path: string,
  init: { method: string; body?: unknown },
  deps: { tokenSource: TokenSource; fetchFn?: FetchFn },
): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const token = await deps.tokenSource.getToken();
  const response = await fetchFn(`${CHAT_API_BASE}/${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Chat API ${init.method} ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Finds or creates a DIRECT_MESSAGE space with `userId` (`users/<id>`).
 * Checks `spaces.findDirectMessage` first and reuses an existing DM if one
 * exists; falls back to `spaces.setup` (creates a space **and** adds the
 * given member in one call — the closest single-call equivalent of the
 * retired `gchat-cli`'s `spaces create --user`, which the CLI's own docs
 * described as wrapping `spaces.setup`) when none is found.
 */
export async function getOrCreateDmSpace(
  userId: string,
  deps: { tokenSource: TokenSource; fetchFn?: FetchFn },
): Promise<{ name: string }> {
  const found = (await callChatApi(
    `spaces:findDirectMessage?name=${encodeURIComponent(userId)}`,
    { method: "GET" },
    deps,
  ).catch(() => null)) as { name?: string } | null;
  if (found?.name) {
    return { name: found.name };
  }
  const created = (await callChatApi(
    "spaces:setup",
    { method: "POST", body: { space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: userId, type: "HUMAN" } }] } },
    deps,
  )) as { name: string };
  return { name: created.name };
}

/** Sends a plain-text message to `space`. Returns the created message's `name` (used for loop-prevention, same as the retired impersonation-era transport). */
export async function sendMessage(
  space: string,
  text: string,
  deps: { tokenSource: TokenSource; fetchFn?: FetchFn },
): Promise<{ name: string }> {
  const data = (await callChatApi(`${space}/messages`, { method: "POST", body: { text } }, deps)) as { name: string };
  return { name: data.name };
}

/**
 * A single Cards v2 message — one call, `cardsV2` is an array because the
 * API supports multiple cards per message, but every caller here sends
 * exactly one. A section's `header` (distinct from the card-level
 * `header.title`) plus `collapsible`/`uncollapsibleWidgetsCount` is Google
 * Chat's own native accordion primitive: `header` stays visible regardless
 * of collapse state, and widgets beyond `uncollapsibleWidgetsCount` fold
 * behind a "Show more" toggle.
 */
export type ChatCardSection = {
  widgets: unknown[];
  header?: string;
  collapsible?: boolean;
  uncollapsibleWidgetsCount?: number;
};
export type ChatCard = { header?: { title: string }; sections: ChatCardSection[] };

/**
 * Posts `card` as a Cards v2 message to `space`. Returns the created message's
 * `name`, same shape as `sendMessage`. With `privateViewer` (`users/<id>`) only
 * that user and the app see it, in a space anyone else is in too.
 */
export async function sendCard(
  space: string,
  card: ChatCard,
  deps: { tokenSource: TokenSource; fetchFn?: FetchFn },
  options: { privateViewer?: string } = {},
): Promise<{ name: string }> {
  const body = {
    cardsV2: [{ cardId: "card", card }],
    ...(options.privateViewer === undefined ? {} : { privateMessageViewer: { name: options.privateViewer } }),
  };
  const data = (await callChatApi(`${space}/messages`, { method: "POST", body }, deps)) as { name: string };
  return { name: data.name };
}

/** Edits an already-sent card message's `cardsV2` in place (PATCH, `updateMask=cardsV2`) — used to patch a tool-call status card from loading to its final outcome without sending a new message. */
export async function updateCard(
  name: string,
  card: ChatCard,
  deps: { tokenSource: TokenSource; fetchFn?: FetchFn },
): Promise<{ name: string }> {
  const data = (await callChatApi(
    `${name}?updateMask=cardsV2`,
    { method: "PATCH", body: { cardsV2: [{ cardId: "card", card }] } },
    deps,
  )) as { name: string };
  return { name: data.name };
}
