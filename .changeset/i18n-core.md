---
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
"@mercury-fw/channel-http": minor
---

The texts a person sees can be in their language. The core's own fixed texts (the refusal of someone the agent doesn't know, the account-linking replies, the login errors, the tool status lines, the terminal's own lines) are English, each under a key (`core.access.unknown`, …), and an app adds a language with a file of its own: `i18n: { defaultLocale, locales: { it } }` in `mercury.config.ts`, each file mapping keys to texts. A person picks their language by asking the agent, which saves it with `set_preferred_language` (only the languages the app ships; not offered when it ships English alone) and answers in it from then on. Whoever hasn't picked one gets `defaultLocale`, then English. A key a language's file lacks shows as the key itself, and the log names the missing keys at startup. `GET /me` on the HTTP channel also says the caller's language.

The texts that were in Italian (tool status lines, the terminal's lines) are now English by default, and the language is no longer one of the facts inferred from conversations.

An existing app keeps working, with these changes:

1. `access.unknownMessage` is gone. To keep a custom refusal, put it in `locales/en.json` as `{ "core.access.unknown": "…" }`, and in `mercury.config.ts` import it (`import en from "./locales/en.json";`) and set `i18n: { locales: { en } }`.
2. To keep the status and terminal lines in Italian, add `locales/it.json` with the `core.` keys translated (start it as `{}`: the log lists the missing keys at startup), and in `mercury.config.ts` import it (`import it from "./locales/it.json";`) and set `i18n: { defaultLocale: "it", locales: { it } }`.
3. When the app has a `locales/` folder, add `COPY --chown=mercury:mercury locales ./locales` after the `mercury.config.ts` line of the `Dockerfile`.
4. In `src/repl.ts`, add `texts: app.texts,` to `createTerminalProvider({ … })` for the terminal's lines to follow the language too.
