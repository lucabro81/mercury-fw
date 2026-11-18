---
title: Every day at a set time
description: The conversation digests kept in the plugin's data folder and sent once a day, with ctx.daily.
sidebar:
  order: 2
---

The task: one message a day with the conversations of the day before, instead of one per conversation. The plugin
from [After every turn](../after-every-turn/) keeps each digest in its data folder when the conversation closes, and
`ctx.daily` sends them all at the hour the team chooses.

## The plugin

```ts title="plugins/conversation-digest/index.ts"
/**
 * Sends the team's webhook what happened: every tool call that failed, as
 * soon as the turn ends, and once a day the digests of the conversations
 * closed since the last one.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@mercury-fw/kit";

type Digest = { person: string; asked: string[]; tools: string[] };

/** The person's message without the line Mercury puts before it (`[Wednesday 2026-11-18 16:47 UTC]`). */
const withoutStamp = (text: string) => text.replace(/^\[[^\]\n]*\]\n/, "");

export function conversationDigestPlugin(): Plugin {
  return {
    apiVersion: 7,
    name: "conversation-digest",
    description: "Tells the team's webhook about failed tool calls, and sends a daily digest of the conversations.",
    actsAs: "anyone",
    build: (ctx) => {
      const url = ctx.env.DIGEST_WEBHOOK_URL;
      if (!url || !ctx.dataDir || !ctx.daily) {
        ctx.log("conversation-digest: DIGEST_WEBHOOK_URL is not set, or there's no data folder: nothing is sent");
        return {};
      }
      const send = async (body: unknown) => {
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) ctx.log(`conversation-digest: the webhook answered ${res.status}`);
          return res.ok;
        } catch (err) {
          ctx.log(`conversation-digest: the webhook can't be reached: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      };

      // The day's digests, in the plugin's data folder: they survive a restart.
      const file = join(ctx.dataDir, "pending.json");
      const read = async (): Promise<Digest[]> => JSON.parse(await readFile(file, "utf8").catch(() => "[]")) as Digest[];
      const write = async (digests: Digest[]) => {
        await mkdir(ctx.dataDir!, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(digests));
        await rename(`${file}.tmp`, file);
      };

      ctx.daily("send-digests", { at: ctx.env.DIGEST_AT ?? "08:00" }, async () => {
        const digests = await read();
        if (digests.length > 0 && (await send({ kind: "daily-digest", conversations: digests }))) await write([]);
      });

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
          await write([...(await read()), { person: session.person.key, asked, tools }]);
        },
      };
    },
  };
}
```

What to notice:

- **`ctx.daily(name, { at }, fn)`** runs `fn` every day at `at` (`"HH:MM"`), in the app's `i18n.timeZone` unless it
  names another. Only the running service runs it (`mfw start`), never the REPL; a day the agent wasn't running at
  that minute is skipped, never made up. An `at` that isn't a time stops the agent at startup.
- **`ctx.dataDir`** is the plugin's own folder on the app's volume, so the digests survive a restart. Two
  conversations may close at once: writing a temporary file and renaming it over the old one keeps the file whole.
- **The digests are cleared only when the webhook took them**, so a day the webhook is down they go the next day.
- **A daily job calling a model** wraps the call in `ctx.job`, which runs it when nobody is waiting on the model.

`DIGEST_AT` in `.env` sets the hour (`08:00` unless set).

## What arrives

With two people's conversations closed during the day, at `DIGEST_AT`:

```json
{"kind":"daily-digest","conversations":[{"person":"people:bob","asked":["What's 2+2? Just the number."],"tools":[]},{"person":"people:ada","asked":["Name one planet. Just the name."],"tools":[]}]}
```
