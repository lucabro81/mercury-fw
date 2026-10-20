/**
 * The texts a person sees, in their language. Every package declares its
 * texts in English under its own namespace (`core.`, `<plugin>.`,
 * `<channel>.`); the instance ships one file per other language it supports,
 * and may override English too. Which language a text comes out in is decided
 * per person: the language they saved, then the channel's hint (an
 * `Accept-Language`-style list), then the instance's default, then English.
 *
 * A key a supported language's file lacks comes out as the key itself, never
 * as English: a missing translation is a gap to fix, and English in its place
 * would read as intended. At startup `report` names, per language, the keys
 * missing and the keys no package declares.
 */

/** A catalog: key → text, `{param}` marking where a value goes. */
export type Messages = Record<string, string>;

export type Params = Record<string, string | number>;

/** A text in one language, by key, with its params filled in. */
export type Translate = (key: string, params?: Params) => string;

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
      return { tag: tag.trim().toLowerCase(), quality, index };
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
      for (const [tag, messages] of files) {
        if (tag !== "en") {
          const missing = Object.keys(english).filter((key) => !Object.hasOwn(messages, key));
          if (missing.length > 0) {
            lines.push(`[i18n] ${tag}: ${count(missing.length, "key")} missing, shown as the key: ${missing.join(", ")}`);
          }
        }
        const unknown = Object.keys(messages).filter((key) => !Object.hasOwn(english, key));
        if (unknown.length > 0) {
          lines.push(`[i18n] ${tag}: ${count(unknown.length, "key")} no package declares: ${unknown.join(", ")}`);
        }
      }
      return lines;
    },
  };
}

/** `1 key`, `3 keys`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
