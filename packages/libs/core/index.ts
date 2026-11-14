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
 *   `MercuryI18n` its `i18n` field, `MercuryModels` its `models` field (the
 *   models it runs on, by role), `MercuryModel` a model's settings, and
 *   `Messages` a language file's texts.
 *   `Texts`/`Translate` type the texts the app hands the terminal (`app.texts`).
 * - `ollamaModel`/`ollamaEmbedding` — a model on the instance's Ollama, as the
 *   config declares it in `models` (or hands it to a plugin that needs one).
 * - `envNumber`/`envBoolean` — a config entry's value from an environment
 *   variable, or the config's fallback when it's unset or empty.
 * - `toolOf` — names the tool that ends a turn in the config's `output`
 *   (`{ tool: toolOf(plugin, name) }`); `TurnOutputConfig` types that field,
 *   `Validate`/`OutputVerdict` the validator a plugin exports for it.
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
export { defineMercuryConfig, type ContextProfile, type MercuryConfig, type MercuryAccess, type MercuryContext, type MercuryI18n, type MercuryModel, type MercuryTraces } from "./src/config/define-config.ts";
export { pseudonymOf, type TraceLevel, type Tracer } from "./src/traces/tracer.ts";
export { envBoolean, envNumber } from "./src/config/env-value.ts";
export { toolOf, type OutputVerdict, type ToolRef, type TurnOutputConfig, type Validate } from "./src/session/turn-output.ts";
export { ollamaEmbedding, ollamaModel, type MercuryModels } from "./src/model/models.ts";
export type { Messages, Texts, Translate } from "./src/i18n/i18n.ts";
export { DEFAULT_PERSONA_IDENTITY, DEFAULT_PERSONA_TONE, type Persona } from "./src/session/system-prompt.ts";
export { assistantNameOf } from "./src/session/assistant-name.ts";
export { OPERATOR_PRINCIPAL } from "./src/identity/people.ts";
