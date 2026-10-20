/**
 * The public surface of `@mercury-fw/core` — the framework runtime a Mercury
 * instance consumes. Everything else under `src/` is internal: an app depends on
 * this barrel, never on a deep path.
 *
 * What's exported, and who uses it:
 * - `composeMercury` builds the instance from a config it is *given* (the
 *   config is never imported by the core — that's what keeps it app-agnostic).
 *   `ComposedApp`/`ConfirmDeps` are its result and confirm-binding types.
 * - `loadChannels`/`LoadedChannel` — the service entrypoint starts the declared
 *   channels with these.
 * - `createTerminalProvider` — the dev REPL entrypoint opens the terminal with it.
 * - `defineMercuryConfig`/`MercuryConfig` — the app's `mercury.config.ts` declares
 *   its composition through these; `Persona` types its `persona` field,
 *   `MercuryI18n` its `i18n` field, and `Messages` a language file's texts.
 *   `Texts`/`Translate` type the texts the app hands the terminal (`app.texts`).
 * - `DEFAULT_PERSONA_IDENTITY`/`DEFAULT_PERSONA_TONE` — the persona an instance
 *   gets when its config sets none; the scaffolder writes them as a new app's
 *   starting persona.
 * - `assistantNameOf` — the assistant's name from a persona, refusing one that
 *   can't stand in a prompt; the scaffolder checks a new app's name with it.
 * - `OPERATOR_PRINCIPAL` — the terminal's principal: a caller driving
 *   `handleTurn` itself as the operator (the skill trainer) sends its turns as it.
 */
export { composeMercury, type ComposedApp, type ConfirmDeps } from "./src/compose.ts";
export { loadChannels, type LoadedChannel } from "./src/router/channel-loader.ts";
export { createTerminalProvider } from "./src/router/terminal-provider.ts";
export { defineMercuryConfig, type MercuryConfig, type MercuryAccess, type MercuryI18n } from "./src/config/define-config.ts";
export type { Messages, Texts, Translate } from "./src/i18n/i18n.ts";
export { DEFAULT_PERSONA_IDENTITY, DEFAULT_PERSONA_TONE, type Persona } from "./src/session/system-prompt.ts";
export { assistantNameOf } from "./src/session/assistant-name.ts";
export { OPERATOR_PRINCIPAL } from "./src/identity/people.ts";
