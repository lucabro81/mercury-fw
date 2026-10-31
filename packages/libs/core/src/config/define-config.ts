/**
 * The instance composition config contract and its `defineMercuryConfig`
 * helper. A Mercury instance is composed by declaring, in one place, which
 * plugins it runs — the way a Nuxt/Vite project declares its config through a
 * `defineConfig` call in a `*.config.ts` file. `defineMercuryConfig` adds no
 * runtime behavior; it exists purely so the app-root `mercury.config.ts` gets
 * editor/compiler support (the argument is checked against `MercuryConfig`) and
 * so there is a single, stable seam the composition root reads from.
 *
 * This is the minimal foundational slice of a broader composition rethink: for
 * now the config carries only the plugin list. Per-plugin configuration and the
 * eventual retirement of the file-based cli-configs are deliberately not here.
 */
import type { Plugin } from "@mercury-fw/plugin-types";
import type { AuthPlugin, ChannelPlugin, DirectoryPlugin } from "@mercury-fw/channel-types";
import type { Persona } from "../session/system-prompt.ts";
import type { Messages } from "../i18n/i18n.ts";

/** Who may talk to the instance and what they may use, on top of the directory. */
export type MercuryAccess = {
  /** What to do with someone the directory doesn't know: `refuse` (the default) or `allow`, taking them as the channel says, with no roles. Without a directory everyone is known. */
  unknown?: "refuse" | "allow";
  /** The installer's restriction: a plugin, by name, only for people holding one of these roles. The terminal is exempt. */
  plugins?: Record<string, { roles: string[] }>;
};

/**
 * The languages the instance speaks. Every text a person sees is in English
 * unless the instance ships a language file: `locales` maps a language tag
 * (`it`, `pt-br`) to that file's texts, keyed as the packages declare them
 * (`core.access.unknown`, …); an `en` file overrides English. Each person
 * gets the language they saved, then the one their client asks for when the
 * channel passes it on (`InboundTurn.languageHint`), then `defaultLocale`
 * (English when left out). A key a language's file lacks shows as the key
 * itself. `timeZone` is where the instance's people are, for the stamp on
 * each turn (#293): it applies to whoever saved none and whose channel says
 * none.
 */
export type MercuryI18n = {
  /** The language of whoever hasn't picked one and whose client asks for none the instance ships; `en` or a key of `locales`. */
  defaultLocale?: string;
  /** The instance's language files, by language tag. */
  locales?: Record<string, Messages>;
  /** The time zone of whoever saved none and whose channel says none, as its IANA name (`Europe/Rome`); the process's when left out. */
  timeZone?: string;
};

/**
 * How the main model (the one in `OLLAMA_MODEL`) generates (#355), for every
 * call on it: the turn, the summaries, the plugins' guards. Every entry is
 * optional: one left out (or `undefined`, an empty variable read with
 * `envNumber`) isn't sent, so the model's own value (its Modelfile) applies.
 * A value out of its range stops the start.
 */
export type MercuryModel = {
  /** Whether the model reasons before answering; on when left out. `false` for a model that doesn't support it, which Ollama otherwise refuses. */
  think?: boolean;
  /** How much room the less likely words get: lower is more predictable. From 0 up. */
  temperature?: number;
  /** Only the most likely words whose probabilities add up to this are kept. Above 0, at most 1. */
  topP?: number;
  /** Only this many of the most likely words are kept. A whole number from 1 up. */
  topK?: number;
};

/** The shape of a Mercury instance's composition config: the tool plugins
 * and the channel plugins (each enabled by being declared here: declared =
 * active), each loaded by its own loader, the auth providers that tell a
 * channel like HTTP who is calling (one, or several tried in order; that
 * channel won't start without one),
 * the directory that tells the core who that is and their roles, who may
 * use what (`access`), the languages it speaks (`i18n`), the assistant's
 * persona (its identity and tone; the defaults when left out), how the main
 * model generates (`model`), plus the app's own version (`version`). */
export type MercuryConfig = {
  plugins: Plugin[];
  model?: MercuryModel;
  channels?: ChannelPlugin[];
  auth?: AuthPlugin | AuthPlugin[];
  directory?: DirectoryPlugin;
  access?: MercuryAccess;
  i18n?: MercuryI18n;
  persona?: Persona;
  /** The app's version, as its `package.json` has it (`version: pkg.version`), shown next to the framework's on the HTTP channel's `GET /version`. Shown as is, never changed by Mercury. Left out (or empty), nothing is shown. */
  version?: string;
};

/**
 * Identity + typing helper for `mercury.config.ts`. Returns its argument
 * unchanged; its only job is to type the config literal against `MercuryConfig`
 * at the call site, exactly like `defineConfig` in the Vite/Nuxt ecosystem.
 */
export function defineMercuryConfig(config: MercuryConfig): MercuryConfig {
  return config;
}
