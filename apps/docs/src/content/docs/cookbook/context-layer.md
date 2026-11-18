---
title: Something the model reads in every conversation
description: A context layer with the team's notices, and a knob an admin changes while the agent runs.
sidebar:
  order: 3
---

The task: the agent should know the team's current notices (the office closed on Friday, a new VPN from Monday)
without anyone asking a tool for them. A **context layer** is text the model reads besides the conversation;
[Context](../../concepts/context/) explains the session and turn layers and the profile's budget.

## The plugin

```bash
bunx mfw plugin create memory team-notices
```

```ts title="plugins/team-notices/index.ts"
/**
 * The team's notices, which the model reads at the start of every
 * conversation: `TEAM_NOTICES`, the notices separated by `|`, the newest first.
 * An admin changes how many it reads with the `max` knob, while the agent runs.
 */
import type { Plugin } from "@mercury-fw/kit";

export function teamNoticesPlugin(): Plugin {
  return {
    apiVersion: 7,
    name: "team-notices",
    description: "Knows the team's current notices.",
    actsAs: "anyone",
    build: (ctx) => {
      const notices = (ctx.env.TEAM_NOTICES ?? "").split("|").map((line) => line.trim()).filter(Boolean);
      return {
        context: {
          scope: "session",
          knobs: { max: { type: "integer", default: 3, min: 0, max: 20, description: "How many notices the model reads, from the first" } },
          build: async (req) => {
            const shown = notices.slice(0, Number(req.knobs.max));
            return shown.length === 0 ? [] : [`The team's notices, newest first:\n${shown.map((n) => `- ${n}`).join("\n")}`];
          },
        },
      };
    },
  };
}
```

- **`scope: "session"`**: built once, at a person's first turn in a conversation, and kept in the system prompt for
  the rest of it. `"turn"` is built every turn and goes in front of the message, for what changes while people talk.
- **`knobs`** are settings an admin changes per profile while the agent runs; `req.knobs` always has every knob, with
  the profile's value or the default.
- **A layer runs only when a profile lists it.** `mfw plugin create` put the plugin in `plugins`; add it to the
  profile's `layers` too, using the same value:

```ts title="mercury.config.ts"
const notices = teamNoticesPlugin();

// in defineMercuryConfig:
  plugins: [conversation, teamWiki, longTermMemory, /* … */ notices],
  context: { profiles: { default: { conversation, layers: [teamWiki, longTermMemory, notices], budget: { maxChars: 8000 } } } },
```

## Trying it

With two notices in `.env`, the newest first:

```bash title=".env"
TEAM_NOTICES=The office is closed on Friday 21 November.|The new VPN is mandatory from Monday.
```

a new conversation on the HTTP channel:

```text
> Is there anything I should know this week? Answer briefly.
From the team's current notices: the office is closed on Friday 21 November, and the new VPN becomes mandatory from Monday (23 November). Nothing else in the wiki for this week.
```

Someone holding `mercury.context-admin` changes the knob for the `default` profile, with the HTTP channel's
`PATCH /context/profiles/{name}`:

```bash
curl -X PATCH http://localhost:4100/context/profiles/default \
  -H "Authorization: Bearer <an admin's token>" -H 'content-type: application/json' \
  -d '{"knobs":{"team-notices":{"max":0}}}'
```

Anyone else gets `403`. From the next conversation on, the model reads no notice: asked the same question, it answered
that there were no team notices. The change is kept in the data folder, with a log of who changed what
(`GET /context/changes`).
