# @mercury-fw/channel-http

Gives a [Mercury](https://github.com/lucabro81/mercury-fw) agent an HTTP surface to build a custom UI on: one conversational turn per request, streamed back as Server-Sent Events, plus confirmation and read-only routes over what the agent holds (conversations, the wiki, memory, its plugins).

This version is written for version 6 of the channel contract, the one that brings the channels' texts in the person's language, and needs the framework at 0.54 or later: a core with an older contract skips it, and the log says why.

```bash
bun add @mercury-fw/channel-http
```

```ts
import { httpChannel } from "@mercury-fw/channel-http";
import { oidcAuth } from "@mercury-fw/auth-oidc";

channels: [httpChannel],
auth: oidcAuth,
```

It needs an auth provider next to it, or several (`auth: [a, b]`, tried in order): [`@mercury-fw/auth-oidc`](../../auth/auth-oidc) for real users, [`@mercury-fw/auth-static`](../../auth/auth-static) for the test bed and e2e tests. Without one, or when none of them loads, the channel doesn't start and the log says why.

| Variable | |
|---|---|
| `HTTP_SURFACE_PORT` | The port (default `4100`). |
| `HTTP_SURFACE_CORS_ORIGIN` | The origin a browser UI calls from (default `*`). |
| `HTTP_SURFACE_PUBLIC_URL` | The address people's browsers reach the surface at (e.g. `https://mercury.example.com`). With it, people log in here to the services plugins act on as them (see [`GET /login/callback`](#get-logincallback)); without it, nobody can. |
| `HTTP_SURFACE_RESUME_MAX_CHARS` | How many characters of a reopened conversation come back to the model once Mercury has freed its history (default: the core's `SESSION_RESUME_MAX_CHARS`; `0` turns resuming off on this surface). See [how Mercury remembers a conversation](../../libs/core/README.md#how-mercury-remembers-a-conversation). |

## API

It's active whenever it's declared in `mercury.config.ts`'s `channels` with an auth provider; remove it there to turn the surface off. It listens on `HTTP_SURFACE_PORT` (default `4100`). Base URL `http://<host>:<port>`.

**Authentication.** Every route except `GET /openapi.yaml`, `GET /login/callback` and the `OPTIONS` preflights needs `Authorization: Bearer <token>`, and the auth providers decide who the token belongs to: the first that recognizes it. A missing or refused token gets `401` with `WWW-Authenticate: Bearer` before anything runs. Then the core decides whether it talks to that person at all: someone the app's directory doesn't know gets `403` (unless the app lets unknown people in), and `503` when the directory can't be reached, both with `{ ok: false, error, reason }`, where `error` is what to tell them.

**Conversations belong to whoever opened them.** The session key is `<caller id>:<conversationId>`, so the same `conversationId` sent by someone else is a conversation of their own, and a confirmation token staged in your conversation can't be confirmed from theirs. Each authenticated caller also gets their own episodic memory and wiki area, as on Google Chat.

**CORS** is enabled on every response and every route answers an `OPTIONS` preflight, so a browser UI on another origin can call it. The allowed origin is `HTTP_SURFACE_CORS_ORIGIN` (default `*`: the token travels in a header, never in a cookie the browser would send on its own).

The full contract is described by an **OpenAPI document**, served raw at `GET /openapi.yaml` and published as a rendered docs page on GitHub Pages (see `packages/channels/channel-http/openapi.yaml`, the single source of truth).

All responses are JSON except `POST /turn`, which streams `text/event-stream`. Every JSON response is either `{ "ok": true, ... }` or, on error, `{ "ok": false, "error": "<message>" }` with HTTP `400`/`401`/`500`.

## `POST /turn`

Runs one conversational turn; the reply streams back as Server-Sent Events.

**Request body** (`application/json`):

| field | type | required | description |
|---|---|---|---|
| `text` | string | yes, unless `opening` or `resume` | The user message. A bare confirmation token here confirms a staged action (see the `pending` event) without invoking the model; when the action hands its result back to the model, the model's answer streams on this same request. |
| `opening` | `true` | no | The assistant speaks first, before the person writes anything: what a UI asks right after someone signs in, when `GET /me` says the assistant doesn't know their name. It introduces itself and asks how to call them, and saves the answer once they give it. For someone it already knows, the stream is a single `final` with an empty text. Needs `conversationId`; `text` is ignored. |
| `resume` | `true` | no | The turn a `POST /confirm` answered `resume: true` for: the model answers on what the confirmed action handed back. Needs `conversationId`; `text` is ignored. With nothing to resume, the stream is a single `final` with an empty text. |
| `conversationId` | string | no | Opaque, client-owned id that continues one of your conversations: letters, digits, `-` and `_`, up to 128 characters (a UUID fits) once surrounding whitespace is trimmed, `400` otherwise. Sent again, however long after, it continues that conversation, rebuilt from the archive if Mercury had freed it (see `HTTP_SURFACE_RESUME_MAX_CHARS`). Omitted ⇒ a fresh one-off session that can't be continued. |

**Responses**: `200 text/event-stream` (the events below); `400` if `text` is missing, an opening has no `conversationId`, the body isn't JSON, or `conversationId` has other characters than the ones above.

**Languages.** Every text a person reads that isn't the model's (a refusal, a tool's status line, a choice's label, a confirmation's reply, the login page) is in their language: the one they asked the assistant for, else the one the request's `Accept-Language` header asks for (what browsers send on their own), else the app's default. The responses of `POST /turn` and `POST /confirm`, a refusal and the login page say which with `Content-Language` (as it stood when the response started: a language picked during a turn counts from the next one).

Reasoning and answer text arrive as **incremental deltas** — never one finished block — so a UI renders them live; treat the `final` event as the authoritative text. **To cancel** a turn (e.g. a generation that's diverging), close the connection: Mercury aborts the in-flight generation.

**SSE events** — each is `event: <name>` followed by `data: <json>`:

| event | data | when |
|---|---|---|
| `reasoning` | `{ chunk, id }` | a model reasoning delta |
| `reasoning_end` | `{ id, failed }` | a reasoning block ends |
| `tool` | `{ label, detail, toolCallId, name }` | a tool call starts; `name` is the tool the model called, absent when Mercury is saving something to memory |
| `tool_finish` | `{ toolCallId, outcome }` | a tool call settles (`outcome`: `success` \| `failed` \| `pending`) |
| `text` | `{ chunk }` | an answer-text delta |
| `pending` | `{ command, token, choices }` | a confirm-required action was staged; send a token back to confirm it — as a later `/turn` `text`, or via `POST /confirm`. `choices` is every way to answer (`{ token, label }`, in order, each label in the caller's language; one with an empty `label` for a plain staging, which the UI words itself, a "Confirm" button): the others die with the one sent |
| `login` | `{ service, url }` | the caller isn't logged in to `service` yet, which a plugin acts on as them: show them `url` to open (the model never gets it) |
| `final` | `{ text, pendingNote? }` | the complete answer (also emitted for a token confirmation, with no model turn). `pendingNote` is there when the model wrote nothing because the turn staged an action: the core's stand-in sentence `text` begins with (then any list the turn surfaced). A UI showing its own confirmation hides it; the conversation's transcript keeps it |
| `error` | `{ message }` | the turn failed mid-stream |

```bash
curl -N -X POST http://localhost:4100/turn \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"text":"Quante issue nel progetto KAN?","conversationId":"c1"}'
```

## `GET /login/callback`

Where a person comes back after logging in to a service a plugin acts on as them (Jira, Bitbucket): the `login` event's `url` sends them to the service, and the service sends their browser here with `code` and `state`. Mounted only with `HTTP_SURFACE_PUBLIC_URL`, at `<HTTP_SURFACE_PUBLIC_URL>/login/callback`, which is the URL to register as a callback on the service's app (the Atlassian 3LO app, the Bitbucket consumer people log in through). No bearer token: the browser has none here, and the `state` Mercury issued for that person, single-use and valid for ten minutes, is what ties the request to their login. Answers with a plain-text page saying how it went, in the language the browser asks for (`Accept-Language`), else the app's default; a login that failed reads in the language of the person who started it.

Whoever opens the link and accepts decides which account gets linked: a link belongs to the person it was shown to, and someone else accepting it would link their own account to that person's Mercury identity. A UI should say so next to the link. Checking the linked account against the person is [#179](https://github.com/lucabro81/mercury-fw/issues/179).

## `POST /link`

A code for linking another of the caller's accounts to them, for the UI to show: `{ ok: true, code, expiresAt }`, or `400` with the reason when there's none. The person sends the code from the other account, on any channel, twice: the first time Mercury says whom the account would be linked to, the second time it links it, and from then on both accounts are one person (one private area, the same roles). The code lasts ten minutes, works once, and only the caller sees it; the model never does. It belongs to the first account that sends it, so it should be sent in a one-to-one conversation, never in a shared space where someone else could send it first. Over HTTP only an account the instance already admits can send it (anyone else is refused before the turn), so an account a closed instance doesn't know links from a chat.

## `POST /confirm`

Explicit alternative to re-sending a token as `/turn` `text`. Body `{ token, conversationId }`; returns `{ ok: true, resolved: true, text }` when the token was a pending confirmation (`text`: the core's reply in the caller's language, "Confirmed and done." or the failure, never the action's raw result), `{ ok: true, resolved: false }` otherwise. When the confirmed action hands its result back to the model, it returns `{ ok: true, resolved: true, resume: true }` instead: open `POST /turn { resume: true, conversationId }` to hear the model's answer. `400` if `token` or `conversationId` is missing, or the id has other characters than `/turn` accepts. Never invokes the model.

## Read-only introspection

All `GET`, all JSON, all reporting state already held in-process. They need an authenticated caller and show only what belongs to them: their conversations, confirmations, tool calls and memory, and the wiki as they see it (the team's `curated/` plus their own notes as `personal/`). Someone else's data doesn't exist as far as a caller can tell. `/manifest` lists what the caller is offered (a plugin acting as Mercury only for someone allowed to use it), and only `/health` is the same for everyone.

| endpoint | `data` on success |
|---|---|
| `GET /conversation?id=<conversationId>&limit=<n>&offset=<cursor>` | `{ messages: [{ role, content, timestamp }], nextOffset }` — one of your conversations, its durable transcript in order, each answer as you saw it with the lists it showed (empty for an id that isn't yours); `400` if `id` is missing or has other characters than `/turn` accepts |
| `GET /conversations?limit=<n>` | `{ conversations: [{ conversationId, lastTimestamp, preview }] }` — your conversations, most-recently-active first |
| `GET /manifest` | `{ manifest: { coreApiVersion, plugins: [{ name, apiVersion, active, skills, hasBuild, customStatus }], activeClis, skills } }` |
| `GET /confirmations` | `{ pending: [{ sessionKey, summary, expiresAt }] }` — your pending confirmations; tokens are deliberately never included |
| `GET /me` | `{ name, language }` — how you asked the assistant to call you and the language you asked it to use, `null` when you never said; `language` is missing on a core that doesn't know languages, and the route isn't there on a core older than this channel |
| `GET /tool-log` | `{ entries: [...] }` — the tool calls of your recent turns |
| `GET /health` | `{ uptimeSeconds, memory, qdrantReachable, ollamaReachable }` |
| `GET /wiki/list` | `{ files: [...] }` — `curated/...` and `personal/...` paths |
| `GET /wiki/read?path=<path>` | `{ content }` — a path as `/wiki/list` gives it; `400` if `path` is missing, `404` if it isn't among yours |
| `GET /wiki/grep?pattern=<regex>` | `{ matches: [...] }` — `400` if `pattern` is missing |
| `GET /memory/scroll?collection=<name>&limit=<n>&offset=<cursor>` | one page of your points in a collection kept per person (verbatim archive, episodic memory, semantic facts); `400` for any other collection |
| `GET /openapi.yaml` | the OpenAPI document for this surface (`text/yaml`) |

Conversation history and the conversation list are backed by the durable verbatim archive; they degrade to empty when the vector store is unreachable.
