---
title: A turn that returns an object
description: An agent another application drives over HTTP, triaging support messages into an object instead of answering in text.
sidebar:
  order: 4
---

The task: the support tool sends each new message to the agent and wants back a category, a priority and a one-line
summary, as data it can file. Nobody chats with this agent: another program drives it. The app's `output` says what a
turn returns; [Turn output](../../concepts/turn-output/) explains the three kinds and how the model is held to them.

## The config

The agent needs the [HTTP channel](../../plugins/channel-http/) (which takes outputs other than text) and `zod` for the
schema (`bun add zod`). In `mercury.config.ts`:

```ts title="mercury.config.ts"
import { z } from "zod";

/** What every turn returns to the support tool: the message, triaged. */
const triage = z.object({
  category: z
    .enum(["bug", "question", "request"])
    .describe("bug: something that should work is broken; question: how to do something; request: something new to have"),
  priority: z.enum(["low", "normal", "urgent"]),
  summary: z.string().max(200).describe("What the person wrote, in one sentence, in English"),
});

// in defineMercuryConfig:
  persona: {
    name,
    identity: `You are ${name}, the support desk's triage: each message is one a person sent the desk, and you classify it. You don't answer it and you don't look anything up.`,
    // …
  },
  output: { schema: triage },
```

- **The schema binds the generation**: the model can only write JSON of that shape, and an answer that doesn't match
  is sent back with the error, to try again (twice unless `retries` says otherwise).
- **`.describe()`** is what the model reads about each field: without the categories' descriptions, a crash came back
  as a `request` as often as a `bug`.
- **The persona says it's the only job.** With the identity a new app gets ("an internal assistant"), the model kept
  acting as a chat assistant: it looked things up in the wiki and told the summary about it.

## Calling it

`POST /turn` streams events; the last one, `final`, carries `output` beside the text:

```bash
curl -sN -X POST http://localhost:4100/turn \
  -H "Authorization: Bearer <the support tool's token>" -H 'content-type: application/json' \
  -d '{"text":"The export to PDF crashes every time since this morning, the whole team is blocked."}'
```

```json
{"mode":"schema","value":{"category":"bug","priority":"urgent","summary":"PDF export is crashing for the entire team since this morning, blocking all work."}}
```

Five messages, on qwen3.8:27b: the two crashes and the broken search came back as `bug`, the dark theme as `request`,
and "How do I change my password?" as `request` instead of `question`; one summary still told what the agent had
looked up. The shape is always right, the judgement is the model's: write the cases that matter to you as an e2e test
(`mfw e2e`, with `expect.output(...)`) and run it several times before trusting a version.

An app that only triages doesn't need the wiki or the long-term memory every new app gets: leave them out of
`plugins` and of the profile, and the model has nothing to look up.
