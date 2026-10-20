---
title: Languages
description: The texts a person reads in their own language, and how an app adds a language.
sidebar:
  order: 7
---

Two kinds of text reach a person. One is what the model writes: it answers in the language it's spoken to, or in
the one the person asked for. The other is the **fixed texts** that Mercury and its plugins write themselves, the
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

A key starts with the package the text belongs to: `core.` is Mercury's own texts. A word in braces, like `{owner}`,
is filled in when the text is shown: keep it as it is, wherever it fits the sentence.

`locales/en.json` works the same way over the English texts: a key written there replaces the package's English, and
the rest stay as the packages wrote them.

## Which language a person gets

1. **The language they asked for.** Someone who tells the agent "talk to me in Italian" gets Italian from then on, in
   every conversation: the agent saves it as one of their settings, like the name they want to be called by, and its
   own answers follow it too. Only the languages the app has can be picked; an app with English alone offers no choice.
2. **Otherwise, the app's default language** (`defaultLocale`).
3. **Otherwise, English.**

Someone the agent doesn't know yet, such as a person it refuses, gets the default language.

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
agent doesn't start. An app made with `mfw create` already has an empty `locales/en.json`, listed in the config.

Not every fixed text goes through the language files yet: Mercury's own do (the `core.` keys), while the plugins' and
the channels' texts are still written in their code.
