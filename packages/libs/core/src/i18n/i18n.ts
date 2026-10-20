/**
 * The texts a person sees, in their language. Every package declares its
 * texts in English under its own namespace (`core.`, `<plugin>.`,
 * `<channel>.`); the instance ships one file per other language it supports,
 * and may override English too. Which language a text comes out in is decided
 * per person: the language they saved, then the channel's hint (an
 * `Accept-Language`-style list) when the caller passes one, then the
 * instance's default, then English. No channel passes a hint yet.
 *
 * An app's own texts (a formatter rule's) go under `app.`: its English file
 * declares them, and every other language's file translates them.
 *
 * A key a supported language's file lacks comes out as the key itself, never
 * as English: a missing translation is a gap to fix, and English in its place
 * would read as intended. At startup `report` names, per language, the keys
 * missing and the keys no package declares.
 */
import { CORE_MESSAGES } from "./core-messages.ts";

import type { Messages, Params, Translate } from "@mercury-fw/plugin-types";
import type { ChannelI18n, Principal } from "@mercury-fw/channel-types";

export type { Messages, Params, Translate };

/** `text` with every `{param}` it's given filled in; one it isn't given stays as it is, so the gap shows. */
export function interpolate(text: string, params?: Params): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** What's wrong with a package's catalog: keys outside `<namespace>.`, values that aren't text. Empty when nothing is. */
export function namespaceErrors(namespace: string, messages: Messages): string[] {
  const prefix = `${namespace}.`;
  const errors: string[] = [];
  for (const [key, text] of Object.entries(messages)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) {
      errors.push(`key "${key}" is outside the "${prefix}" namespace`);
    } else if (typeof text !== "string") {
      errors.push(`key "${key}" isn't a string`);
    }
  }
  return errors;
}

/** Names no package may take: their keys are the core's and the app's texts. */
const RESERVED_NAMES: Record<string, string> = { core: "the core's own texts", app: "the app's own texts" };

/**
 * What's wrong with the texts a plugin or a channel named `name` declares: a
 * reserved name (`core`, `app`), keys outside `<name>.`, values that aren't
 * text. Empty when nothing is.
 */
export function catalogErrors(name: string, messages: Messages): string[] {
  if (Object.hasOwn(RESERVED_NAMES, name)) return [`"${name}" is reserved for ${RESERVED_NAMES[name]}`];
  return namespaceErrors(name, messages);
}

/**
 * The supported language a hint asks for (`it-IT,it;q=0.9,en;q=0.8`), or
 * undefined when it asks for none of them. Ranked by quality, then order; a
 * tag matches exactly first, then by its language (`it-IT` → `it`). `*`, a
 * refused language (`q=0`) and a malformed quality are passed over.
 */
export function negotiate(hint: string | undefined, supported: readonly string[]): string | undefined {
  if (!hint) return undefined;
  const ranked = hint
    .split(",")
    .map((part, index) => {
      const [tag = "", ...attrs] = part.trim().split(";");
      const q = attrs.map((a) => a.trim()).find((a) => a.startsWith("q="));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim().toLowerCase().replaceAll("_", "-"), quality, index };
    })
    .filter((r) => r.tag !== "" && r.tag !== "*" && Number.isFinite(r.quality) && r.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranked) {
    if (supported.includes(tag)) return tag;
    const language = tag.split("-")[0]!;
    if (supported.includes(language)) return language;
  }
  return undefined;
}

export type I18n = {
  /** The languages texts can come out in: `en` first, then the instance's, lowercase. */
  supported: string[];
  /** The language when neither the person nor the channel says. */
  defaultLocale: string;
  /** The language for someone: `saved` when still supported, then the hint's, then the default. */
  languageFor: (saved: string | undefined, hint: string | undefined) => string;
  /** The texts in `locale` (a supported language). */
  translator: (locale: string) => Translate;
  /** The startup lines about the instance's files: missing keys, keys no package declares. */
  report: () => string[];
};

/**
 * The instance's languages over the packages' English. `english` is every
 * package's catalog merged; `locales` the instance's files by language. A
 * file with a value that isn't text, or a `defaultLocale` the instance
 * doesn't ship, stops the start.
 */
export function createI18n(opts: {
  english: Messages;
  locales?: Record<string, Messages>;
  defaultLocale?: string;
}): I18n {
  const { english } = opts;
  const files = new Map<string, Messages>();
  for (const [tag, messages] of Object.entries(opts.locales ?? {})) {
    const bad = Object.entries(messages).find(([, text]) => typeof text !== "string");
    if (bad) throw new Error(`i18n.locales.${tag}: key "${bad[0]}" isn't a string`);
    files.set(tag.toLowerCase(), messages);
  }
  const supported = ["en", ...[...files.keys()].filter((tag) => tag !== "en")];
  const defaultLocale = (opts.defaultLocale ?? "en").toLowerCase();
  if (!supported.includes(defaultLocale)) {
    throw new Error(
      `i18n.defaultLocale "${opts.defaultLocale}" isn't a supported language: add locales.${opts.defaultLocale} or pick one of ${supported.join(", ")}`,
    );
  }

  /** The text for `key` in `locale`, before params: the instance's, then (English only) the packages'. */
  function lookup(locale: string, key: string): string | undefined {
    const own = files.get(locale);
    if (own !== undefined && Object.hasOwn(own, key)) return own[key];
    if (locale === "en" && Object.hasOwn(english, key)) return english[key];
    return undefined;
  }

  return {
    supported,
    defaultLocale,
    languageFor: (saved, hint) => {
      const kept = saved?.toLowerCase();
      if (kept !== undefined && supported.includes(kept)) return kept;
      return negotiate(hint, supported) ?? defaultLocale;
    },
    translator: (locale) => {
      const tag = locale.toLowerCase();
      return (key, params) => interpolate(lookup(tag, key) ?? key, params);
    },
    report: () => {
      const lines: string[] = [];
      // An app's own texts (`app.…`) are declared by its English file.
      const appKeys = Object.keys(files.get("en") ?? {}).filter((key) => key.startsWith(APP_PREFIX));
      const declared = new Set([...Object.keys(english), ...appKeys]);
      for (const [tag, messages] of files) {
        if (tag !== "en") {
          const missing = [...declared].filter((key) => !Object.hasOwn(messages, key));
          if (missing.length > 0) {
            lines.push(`[i18n] ${tag}: ${count(missing.length, "key")} missing, shown as the key: ${missing.join(", ")}`);
          }
        }
        const unknown = Object.keys(messages).filter((key) => !declared.has(key));
        if (unknown.length > 0) {
          lines.push(`[i18n] ${tag}: ${count(unknown.length, "key")} no package declares: ${unknown.join(", ")}`);
        }
      }
      return lines;
    },
  };
}

/**
 * The instance's languages: the core's English and the loaded plugins'
 * (`pluginMessages`, already checked against their namespaces), with the
 * instance's language files (`i18n`, the config's) over them.
 */
export function instanceI18n(
  pluginMessages: Messages,
  i18n: { defaultLocale?: string; locales?: Record<string, Messages> } | undefined,
): I18n {
  return createI18n({
    english: { ...CORE_MESSAGES, ...pluginMessages },
    ...(i18n?.locales === undefined ? {} : { locales: i18n.locales }),
    ...(i18n?.defaultLocale === undefined ? {} : { defaultLocale: i18n.defaultLocale }),
  });
}

/** The namespace of an app's own texts (a formatter rule's), declared in its `locales/en.json`. */
const APP_PREFIX = "app.";

/** `1 key`, `3 keys`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The texts for a person: their language (see `I18n.languageFor`) and its translator. */
export type Texts = {
  /** For the person with `key` (undefined when nobody is known yet) on a channel hinting `hint`. */
  forPerson: (key: string | undefined, hint?: string) => { locale: string; t: Translate };
  /** The language the person with `key` saved, while the instance ships it; undefined otherwise. */
  savedLanguage: (key: string) => string | undefined;
};

/** `i18n`'s texts, each person's language read through `languageOf` (their profile). */
export function createTexts(i18n: I18n, languageOf: (key: string) => string | undefined): Texts {
  return {
    forPerson: (key, hint) => {
      const locale = i18n.languageFor(key === undefined ? undefined : languageOf(key), hint);
      return { locale, t: i18n.translator(locale) };
    },
    savedLanguage: (key) => {
      const saved = languageOf(key)?.toLowerCase();
      return saved !== undefined && i18n.supported.includes(saved) ? saved : undefined;
    },
  };
}

/** The core's texts in English and nothing else: what a part of the core uses when it isn't handed the instance's. */
export function englishTexts(): Texts {
  return createTexts(createI18n({ english: CORE_MESSAGES }), () => undefined);
}

/**
 * The texts a channel shows a request itself (`ChannelRuntimeContext.i18n`):
 * the language of the person `principal` is, when the core knows them and
 * they saved one, else the channel's `hint`, else the default. A request
 * with nobody behind it (`null`, a login page) goes by the hint alone.
 */
export function requestTexts(
  texts: Texts,
  identify: (principal: Principal, hint?: string) => Promise<{ ok: true; person: { key: string } } | { ok: false }>,
): ChannelI18n {
  return {
    forRequest: async (principal, hint) => {
      if (principal === null) return texts.forPerson(undefined, hint);
      const identified = await identify(principal, hint);
      return texts.forPerson(identified.ok ? identified.person.key : undefined, hint);
    },
  };
}
