---
title: Languages
description: The texts a person reads in their own language, how an app adds a language, and the time zone a person is in.
sidebar:
  order: 7
---

Two kinds of text reach a person. One is what the model writes: it answers in the language it's spoken to, or in
the one the person asked for. The other is the **fixed texts** that Mercury, its plugins and its channels write themselves, the
same every time: the refusal someone the agent doesn't know gets, the reply to an account-linking code, the line
saying a tool is running. Those come from **language files**.

## English, and the languages the app adds

Every fixed text exists in English, written by the package that shows it. An app adds a language with a file of its
own, one per language, in the `locales/` folder. The file maps each text's **key** to its translation:

```json title="locales/it.json"
{
  "core.access.unknown": "Questo assistente parla solo con le persone che conosce. Chiedi l'accesso a un amministratore.",
  "core.link.done": "Fatto: questo account ora è {owner}."
}
```

A key starts with the package the text belongs to: `core.` is Mercury's own texts, `web-search.` the web search
plugin's, `google-chat.` and `http.` the channels', and so on, each under its own name. A word in braces, like `{owner}`,
is filled in when the text is shown: keep it as it is, wherever it fits the sentence.

`locales/en.json` works the same way over the English texts: a key written there replaces the package's English, and
the rest stay as the packages wrote them.

The app's own texts, such as what a [formatter rule](../../reference/config/#plugins) shows for an empty list, go
under `app.`: written in English in `locales/en.json`, they're declared there, and every other language's file
translates them like the packages' keys. A new app with the Jira plugin already has one, `app.jira.no-issues`.

## Which language a person gets

1. **The language they asked for.** Someone who tells the agent "talk to me in Italian" gets Italian from then on, in
   every conversation: the agent saves it as one of their settings, like the name they want to be called by, and its
   own answers follow it too. Only the languages the app has can be picked; an app with English alone offers no choice.
2. **Otherwise, the one their app asks for**, when the channel says: a web UI sends its browser's languages over the
   HTTP channel (the `Accept-Language` header browsers send), Google Chat the language of the person's Chat
   client. A language the app doesn't have is passed over.
3. **Otherwise, the app's default language** (`defaultLocale`).
4. **Otherwise, English.**

Someone the agent doesn't know yet, such as a person it refuses, gets the language their app asks for, else the
default.

## A missing translation

A key a language's file lacks shows as the key itself, `core.link.done`, not as the English text: English there
would look intended, and the gap would go unnoticed. When the agent starts, the log names the keys each file is
missing, and the keys no package declares (a typo, or a text a package no longer has):

```
[i18n] it: 2 keys missing, shown as the key: core.link.invalid, core.link.done
```

That's also the quickest way to write a new file: start it empty, `{}`, start the agent, and translate what the log
lists.

## Setting it up

The languages go in the app's [`mercury.config.ts`](../../reference/config/#i18n), each file imported:

```ts title="mercury.config.ts"
import en from "./locales/en.json";
import it from "./locales/it.json";

export default defineMercuryConfig({
  // …
  i18n: { defaultLocale: "it", locales: { en, it } },
});
```

A language is named by its tag, `it` or `pt-br`. `defaultLocale` must be `en` or one of the languages listed, or the
agent doesn't start. An app made with `mfw create` already has a `locales/en.json`, listed in the config: empty, or with the starting
formatter rules' own texts (`app.jira.no-issues` with Jira).

Every fixed text goes through the language files: Mercury's own, the plugins' and the channels' (a Google Chat card's
title, the HTTP channel's login page, `google-chat.` and `http.` keys). What the model writes isn't one of them: it
answers in the person's language on its own.

## The time where the person is

A model doesn't know what day it is. Mercury tells it: every message reaches the model after a line saying when and
where it was written, `[Wednesday 2026-10-21 14:32 Europe/Rome]`, so "today", "next Monday" or "is it still open?"
mean something. The line goes only to the model: the conversation's archive, and what a web UI shows of it, keep the
message as it was written.

The time is the person's, in their **time zone**, named as the official list of time zones (the IANA list) names it:
`Europe/Rome`, `America/New_York`. A fixed offset like `+02:00` isn't one, because it's wrong for half the year. The
zone is picked like the language:

1. **The one the person saved.** Someone who tells the agent "I'm in Tokyo" gets Tokyo's time from then on, in every
   conversation: the agent saves it as one of their settings. A web UI can offer it in its own settings too.
2. **Otherwise, the one their app says**, when the channel passes it on: a web UI sends its browser's over the HTTP
   channel (the `X-Time-Zone` header), Google Chat the one of the person's Chat client, when Google includes it.
3. **Otherwise, the app's own**, `timeZone` next to the languages in the config:

   ```ts title="mercury.config.ts"
   i18n: { defaultLocale: "it", locales: { en, it }, timeZone: "Europe/Rome" },
   ```

4. **Otherwise, the one of the machine the agent runs on**, often UTC inside a container.

A `timeZone` that isn't a zone's name stops the agent at startup.
