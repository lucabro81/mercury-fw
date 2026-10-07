# @mercury-fw/channel-http

Gives a [Mercury](https://github.com/lucabro81/mercury-fw) agent an HTTP surface to build a custom UI on: one conversational turn per request, streamed back as Server-Sent Events, plus confirmation and read-only routes over what the agent holds (conversations, the wiki, memory, its plugins).

```bash
bun add @mercury-fw/channel-http
```

```ts
import { httpChannel } from "@mercury-fw/channel-http";
import { oidcAuth } from "@mercury-fw/auth-oidc";

channels: [httpChannel],
auth: oidcAuth,
```

It needs an auth provider next to it: [`@mercury-fw/auth-oidc`](../../auth/auth-oidc) for real users, [`@mercury-fw/auth-static`](../../auth/auth-static) for the test bed and e2e tests. Without one, or with one that fails to load, the channel doesn't start and the log says why.

| Variable | |
|---|---|
| `HTTP_SURFACE_PORT` | The port (default `4100`). |
| `HTTP_SURFACE_CORS_ORIGIN` | The origin a browser UI calls from (default `*`). |
| `HTTP_SURFACE_PUBLIC_URL` | The address people's browsers reach the surface at (e.g. `https://mercury.example.com`). With it, people log in here to the services plugins act on as them (see [`GET /login/callback`](#get-logincallback)); without it, nobody can. |

## API

It's active whenever it's declared in `mercury.config.ts`'s `channels` with an auth provider; remove it there to turn the surface off. It listens on `HTTP_SURFACE_PORT` (default `4100`). Base URL `http://<host>:<port>`.

**Authentication.** Every route except `GET /openapi.yaml`, `GET /login/callback` and the `OPTIONS` preflights needs `Authorization: Bearer <token>`, and the auth provider decides who the token belongs to. A missing or refused token gets `401` with `WWW-Authenticate: Bearer` before anything runs.

**Conversations belong to whoever opened them.** The session key is `<caller id>:<conversationId>`, so the same `conversationId` sent by someone else is a conversation of their own, and a confirmation token staged in your conversation can't be confirmed from theirs. Each authenticated caller also gets their own episodic memory and wiki area, as on Google Chat.

**CORS** is enabled on every response and every route answers an `OPTIONS` preflight, so a browser UI on another origin can call it. The allowed origin is `HTTP_SURFACE_CORS_ORIGIN` (default `*`: the token travels in a header, never in a cookie the browser would send on its own).

The full contract is described by an **OpenAPI document**, served raw at `GET /openapi.yaml` and published as a rendered docs page on GitHub Pages (see `packages/channels/channel-http/openapi.yaml`, the single source of truth).

All responses are JSON except `POST /turn`, which streams `text/event-stream`. Every JSON response is either `{ "ok": true, ... }` or, on error, `{ "ok": false, "error": "<message>" }` with HTTP `400`/`401`/`500`.

## `POST /turn`

Runs one conversational turn; the reply streams back as Server-Sent Events.

**Request body** (`application/json`):

| field | type | required | description |
|---|---|---|---|
| `text` | string | yes | The user message. A bare confirmation token here confirms a staged action (see the `pending` event) without invoking the model. |
| `conversationId` | string | no | Opaque, client-owned id that continues one of your conversations: letters, digits, `-` and `_`, up to 128 characters (a UUID fits) once surrounding whitespace is trimmed, `400` otherwise. Omitted ⇒ a fresh one-off session. |

**Responses**: `200 text/event-stream` (the events below); `400` if `text` is missing, the body isn't JSON, or `conversationId` has other characters than the ones above.

Reasoning and answer text arrive as **incremental deltas** — never one finished block — so a UI renders them live; treat the `final` event as the authoritative text. **To cancel** a turn (e.g. a generation that's diverging), close the connection: Mercury aborts the in-flight generation.

**SSE events** — each is `event: <name>` followed by `data: <json>`:

| event | data | when |
|---|---|---|
| `reasoning` | `{ chunk, id }` | a model reasoning delta |
| `reasoning_end` | `{ id, failed }` | a reasoning block ends |
| `tool` | `{ label, detail, toolCallId, name }` | a tool call starts; `name` is the tool the model called, absent when Mercury is saving something to memory |
| `tool_finish` | `{ toolCallId, outcome }` | a tool call settles (`outcome`: `success` \| `failed` \| `pending`) |
| `text` | `{ chunk }` | an answer-text delta |
| `pending` | `{ command, token }` | a confirm-required action was staged; send `token` back to confirm it — as a later `/turn` `text`, or via `POST /confirm` |
| `login` | `{ service, url }` | the caller isn't logged in to `service` yet, which a plugin acts on as them: show them `url` to open (the model never gets it) |
| `final` | `{ text }` | the complete answer (also emitted for a token confirmation, with no model turn) |
| `error` | `{ message }` | the turn failed mid-stream |

```bash
curl -N -X POST http://localhost:4100/turn \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"text":"Quante issue nel progetto KAN?","conversationId":"c1"}'
```

## `GET /login/callback`

Where a person comes back after logging in to a service a plugin acts on as them (Jira, Bitbucket): the `login` event's `url` sends them to the service, and the service sends their browser here with `code` and `state`. Mounted only with `HTTP_SURFACE_PUBLIC_URL`, at `<HTTP_SURFACE_PUBLIC_URL>/login/callback`, which is the URL to register as a callback on the service's app (the Atlassian 3LO app, the Bitbucket consumer people log in through). No bearer token: the browser has none here, and the `state` Mercury issued for that person, single-use and valid for ten minutes, is what ties the request to their login. Answers with a plain-text page saying how it went.

Whoever opens the link and accepts decides which account gets linked: a link belongs to the person it was shown to, and someone else accepting it would link their own account to that person's Mercury identity. A UI should say so next to the link. Checking the linked account against the person is [#179](https://github.com/lucabro81/mercury-fw/issues/179).

## `POST /confirm`

Explicit alternative to re-sending a token as `/turn` `text`. Body `{ token, conversationId }`; returns `{ ok: true, resolved: true, text }` when the token was a pending confirmation, `{ ok: true, resolved: false }` otherwise. `400` if `token` or `conversationId` is missing, or the id has other characters than `/turn` accepts. Never invokes the model.

## Read-only introspection

All `GET`, all JSON, all reporting state already held in-process. They need an authenticated caller and show only what belongs to them: their conversations, confirmations, tool calls and memory, and the wiki as they see it (the team's `curated/` plus their own notes as `personal/`). Someone else's data doesn't exist as far as a caller can tell; only `/manifest` and `/health` are the same for everyone.

| endpoint | `data` on success |
|---|---|
| `GET /conversation?id=<conversationId>&limit=<n>&offset=<cursor>` | `{ messages: [{ role, content, timestamp }], nextOffset }` — one of your conversations, its durable transcript in order (empty for an id that isn't yours); `400` if `id` is missing or has other characters than `/turn` accepts |
| `GET /conversations?limit=<n>` | `{ conversations: [{ conversationId, lastTimestamp, preview }] }` — your conversations, most-recently-active first |
| `GET /manifest` | `{ manifest: { coreApiVersion, plugins: [{ name, apiVersion, active, skills, hasBuild, customStatus }], activeClis, skills } }` |
| `GET /confirmations` | `{ pending: [{ sessionKey, summary, expiresAt }] }` — your pending confirmations; tokens are deliberately never included |
| `GET /tool-log` | `{ entries: [...] }` — the tool calls of your recent turns |
| `GET /health` | `{ uptimeSeconds, memory, qdrantReachable, ollamaReachable }` |
| `GET /wiki/list` | `{ files: [...] }` — `curated/...` and `personal/...` paths |
| `GET /wiki/read?path=<path>` | `{ content }` — a path as `/wiki/list` gives it; `400` if `path` is missing, `404` if it isn't among yours |
| `GET /wiki/grep?pattern=<regex>` | `{ matches: [...] }` — `400` if `pattern` is missing |
| `GET /memory/scroll?collection=<name>&limit=<n>&offset=<cursor>` | one page of your points in a collection kept per person (verbatim archive, episodic memory, semantic facts); `400` for any other collection |
| `GET /openapi.yaml` | the OpenAPI document for this surface (`text/yaml`) |

Conversation history and the conversation list are backed by the durable verbatim archive; they degrade to empty when the vector store is unreachable.
