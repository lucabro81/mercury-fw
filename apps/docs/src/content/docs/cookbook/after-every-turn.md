---
title: After every turn, and when a conversation closes
description: A plugin that tells a webhook about every failed tool call and sends a digest of each conversation once it closes.
sidebar:
  order: 1
---

The task: the team wants to hear about it when one of the agent's tools fails, and to see what people ask it. Two
hooks do it: `afterTurn`, which runs once a turn has ended, and `onSessionClose`, which runs once a conversation has
been quiet long enough to close. [Plugins and skills](../../concepts/plugins/#after-a-turn-and-when-a-conversation-closes)
explains both.

## The plugin

Start from the memory scaffold, the kind built around hooks:

```bash
bunx mfw plugin create memory conversation-digest
```

Then replace its `index.ts` (and drop the example's test):

```ts title="plugins/conversation-digest/index.ts"
/**
 * Sends the team's webhook what happened: every tool call that failed, as
 * soon as the turn ends, and a digest of each conversation once it closes.
 */
import type { Plugin } from "@mercury-fw/kit";

/** The person's message without the line Mercury puts before it (`[Wednesday 2026-11-18 16:47 UTC]`). */
const withoutStamp = (text: string) => text.replace(/^\[[^\]\n]*\]\n/, "");

export function conversationDigestPlugin(): Plugin {
  return {
    apiVersion: 7,
    name: "conversation-digest",
    description: "Tells the team's webhook about failed tool calls, and sends a digest of each conversation.",
    actsAs: "anyone",
    build: (ctx) => {
      const url = ctx.env.DIGEST_WEBHOOK_URL;
      if (!url) {
        ctx.log("conversation-digest: DIGEST_WEBHOOK_URL is not set: nothing is sent");
        return {};
      }
      const send = async (body: unknown) => {
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) ctx.log(`conversation-digest: the webhook answered ${res.status}`);
        } catch (err) {
          ctx.log(`conversation-digest: the webhook can't be reached: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      return {
        afterTurn: async (turn) => {
          const failed = turn.calls.filter((call) => !call.ok);
          if (turn.operator || failed.length === 0) return;
          await send({ kind: "failed-tools", person: turn.person.key, calls: failed.map((call) => ({ tool: call.toolName, error: call.error })) });
        },
        onSessionClose: async (session) => {
          const asked = session.messages.filter((m) => m.role === "user").map((m) => withoutStamp(m.content));
          if (asked.length === 0) return;
          const tools = [...new Set(session.messages.flatMap((m) => m.calls ?? []).map((call) => call.toolName))];
          await send({ kind: "digest", person: session.person.key, asked, tools });
        },
      };
    },
  };
}
```

What to notice:

- **A hook never fails a turn.** Nothing waits for it, and one that throws is only logged. Still, `send` catches its
  own errors, so a webhook that's down leaves a clear line in the log.
- **`turn.operator`** is true on the terminal (`mfw repl`): those turns are yours, not people's, and aren't reported.
- **`turn.calls`** has each tool call's name, input, whether it worked and its error, never what it returned.
- **The messages `onSessionClose` gets** are the person's texts with the line Mercury puts in front of each one for the
  model (when and where it was written), which `withoutStamp` removes.
- **Work that calls a model** (a summary written by the model, say) goes through `ctx.job`, so it runs only when
  nobody is waiting on the model: see [What a plugin can use](../../concepts/primitives/).

`DIGEST_WEBHOOK_URL` goes in `.env` (and, empty, in `.env.example`); any service taking a JSON `POST` will do.

## What arrives

A hook only hears the turns of people the plugin is offered to, on a channel: the terminal's are the operator's, and
the REPL closes no session. On the HTTP channel, once a conversation has been quiet for `SESSION_IDLE_TIMEOUT_MS`
(30 minutes unless set), the webhook gets:

```json
{"kind":"digest","person":"people:ada","asked":["Hi! In one sentence, what's a good name for a team wiki?"],"tools":[]}
```

and, when a tool of the turn failed (here the example tool of `mfw plugin create tool payroll`, its service a stand-in
that didn't answer JSON):

```json
{"kind":"failed-tools","person":"people:ada","calls":[{"tool":"payroll_list","error":"JSON Parse error: Unexpected identifier \"ok\""}]}
```

`person` is the person's key in Mercury (`people:<id>` with the static directory), never their credentials.

## Next

[Every day at a set time](../every-day/) keeps the digests and sends them once a day instead.
