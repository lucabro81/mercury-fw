# @mercury-fw/profile

What a person tells a [Mercury](https://github.com/lucabro81/mercury-fw) agent about themselves, saved by the model: how they want to be called, the time zone they're in, the language they want. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#what-each-person-said-about-themselves).

```ts
import { profile } from "@mercury-fw/profile";

export default defineMercuryConfig({
  plugins: [profile()],
  // …
});
```

It takes no options and needs nothing the app declares.

| Tool | |
|---|---|
| `set_preferred_name` | How the person wants to be called, whenever they say it, or when they answer the agent asking. |
| `set_time_zone` | The time zone they're in, as its IANA name (`Europe/Rome`). |
| `set_preferred_language` | The language they want, among those the app ships; there only when it ships more than one. |

Each writes only for the person the turn is for, into the core's profiles (`ctx.profiles`), which keeps them in its data folder (`profiles.json`), out of the model's reach, and refuses what it can't keep (an empty name, a zone that doesn't exist, a language the app doesn't ship): the model gets the reason back. The core reads them on every turn, the name in the model's instructions, the time zone on each message's stamp, the language in the answers and in the core's own texts, and the channels read them too. The system prompt tells the model to save the name whenever the person says it.

Without the plugin, nothing saves them in conversation: a chat interface can still save the time zone (`PATCH /me` over HTTP), and an agent speaking first to someone it doesn't know still asks their name, without being told to save it.
