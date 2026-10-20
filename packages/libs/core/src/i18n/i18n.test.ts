import { describe, expect, test } from "bun:test";
import { CORE_MESSAGES } from "./core-messages.ts";
import { createI18n, createTexts, englishTexts, instanceI18n, interpolate, namespaceErrors, negotiate, requestTexts } from "./i18n.ts";

describe("interpolate", () => {
  test("fills every {param}, numbers included", () => {
    expect(interpolate("Linked: {name} has {n} accounts, {name}.", { name: "Ada", n: 2 })).toBe(
      "Linked: Ada has 2 accounts, Ada.",
    );
  });

  test("leaves a param it isn't given as it is, so the gap shows", () => {
    expect(interpolate("Log in to {service}", {})).toBe("Log in to {service}");
    expect(interpolate("Log in to {service}")).toBe("Log in to {service}");
  });

  test("doesn't read params from the object's prototype", () => {
    expect(interpolate("{toString}", {})).toBe("{toString}");
  });
});

describe("namespaceErrors", () => {
  test("accepts keys under the package's namespace", () => {
    expect(namespaceErrors("web-search", { "web-search.choice.once": "Only this time" })).toEqual([]);
  });

  test("names every key outside it, the bare namespace and a lookalike prefix included", () => {
    expect(
      namespaceErrors("web-search", {
        "core.access.unknown": "x",
        "web-search": "x",
        "web-searchx.a": "x",
        "web-search.ok": "x",
      }),
    ).toEqual([
      'key "core.access.unknown" is outside the "web-search." namespace',
      'key "web-search" is outside the "web-search." namespace',
      'key "web-searchx.a" is outside the "web-search." namespace',
    ]);
  });

  test("names a value that isn't text", () => {
    expect(namespaceErrors("core", { "core.a": 1 as unknown as string })).toEqual(['key "core.a" isn\'t a string']);
  });
});

describe("negotiate", () => {
  const supported = ["en", "it"];

  test("nothing to go on without a hint", () => {
    expect(negotiate(undefined, supported)).toBeUndefined();
    expect(negotiate("", supported)).toBeUndefined();
  });

  test("takes the first supported language, by quality and then order", () => {
    expect(negotiate("it", supported)).toBe("it");
    expect(negotiate("fr, it;q=0.8, en;q=0.9", supported)).toBe("en");
    expect(negotiate("it, en", supported)).toBe("it");
  });

  test("matches a regional tag by its language, and case doesn't matter", () => {
    expect(negotiate("it-IT,it;q=0.9,en-US;q=0.8", supported)).toBe("it");
    expect(negotiate("EN-gb", supported)).toBe("en");
  });

  test("an exact regional match wins over its language", () => {
    expect(negotiate("pt-BR", ["pt", "pt-br"])).toBe("pt-br");
  });

  test("ignores a language refused with q=0, a wildcard and a malformed quality", () => {
    expect(negotiate("it;q=0, en;q=0.1", supported)).toBe("en");
    expect(negotiate("*", supported)).toBeUndefined();
    expect(negotiate("it;q=abc", supported)).toBeUndefined();
  });

  test("nothing when no language asked for is supported", () => {
    expect(negotiate("fr, de", supported)).toBeUndefined();
  });
});

describe("createI18n", () => {
  const english = { "core.hello": "Hello, {name}.", "core.bye": "Bye." };

  test("English only: supported is en, the default en, texts from the packages", () => {
    const i18n = createI18n({ english });
    expect(i18n.supported).toEqual(["en"]);
    expect(i18n.defaultLocale).toBe("en");
    expect(i18n.translator("en")("core.hello", { name: "Ada" })).toBe("Hello, Ada.");
  });

  test("an instance language takes its texts from the instance's file only", () => {
    const i18n = createI18n({ english, locales: { it: { "core.hello": "Ciao, {name}." } }, defaultLocale: "it" });
    expect(i18n.supported).toEqual(["en", "it"]);
    expect(i18n.defaultLocale).toBe("it");
    expect(i18n.translator("it")("core.hello", { name: "Ada" })).toBe("Ciao, Ada.");
  });

  // A translation missing from a supported language must show where it is
  // missing: English there would read as a choice, not as a gap.
  test("a key missing from an instance language shows the key, not English", () => {
    const t = createI18n({ english, locales: { it: {} } }).translator("it");
    expect(t("core.bye")).toBe("core.bye");
  });

  test("the instance can override English, the packages filling what it doesn't", () => {
    const t = createI18n({ english, locales: { en: { "core.bye": "See you." } } }).translator("en");
    expect(t("core.bye")).toBe("See you.");
    expect(t("core.hello", { name: "Ada" })).toBe("Hello, Ada.");
  });

  test("a key nobody declares shows the key, in English too", () => {
    expect(createI18n({ english }).translator("en")("core.nope")).toBe("core.nope");
  });

  test("language tags are matched without regard to case", () => {
    const i18n = createI18n({ english, locales: { IT: { "core.bye": "Ciao." } }, defaultLocale: "It" });
    expect(i18n.supported).toEqual(["en", "it"]);
    expect(i18n.defaultLocale).toBe("it");
    expect(i18n.translator("IT")("core.bye")).toBe("Ciao.");
  });

  test("a default language the instance doesn't ship stops the start", () => {
    expect(() => createI18n({ english, defaultLocale: "it" })).toThrow(
      'i18n.defaultLocale "it" isn\'t a supported language: add locales.it or pick one of en',
    );
  });

  test("a locale file with a value that isn't text stops the start", () => {
    expect(() => createI18n({ english, locales: { it: { "core.bye": 3 as unknown as string } } })).toThrow(
      'i18n.locales.it: key "core.bye" isn\'t a string',
    );
  });

  describe("languageFor", () => {
    const i18n = createI18n({ english, locales: { it: {}, de: {} }, defaultLocale: "de" });

    test("the person's saved language first", () => {
      expect(i18n.languageFor("it", "en")).toBe("it");
    });

    test("then the channel's hint", () => {
      expect(i18n.languageFor(undefined, "it-IT, en;q=0.5")).toBe("it");
    });

    test("then the instance's default", () => {
      expect(i18n.languageFor(undefined, "fr")).toBe("de");
      expect(i18n.languageFor(undefined, undefined)).toBe("de");
    });

    test("a saved language the instance no longer ships is passed over", () => {
      expect(i18n.languageFor("fr", "it")).toBe("it");
    });
  });

  describe("report", () => {
    test("nothing to say when every language has every key", () => {
      expect(createI18n({ english, locales: { it: { "core.hello": "Ciao", "core.bye": "Ciao" } } }).report()).toEqual([]);
    });

    test("per language: the keys its file lacks and the keys no package declares", () => {
      const i18n = createI18n({
        english,
        locales: { it: { "core.hello": "Ciao", "core.typo": "x" }, en: { "core.old": "x" } },
      });
      expect(i18n.report()).toEqual([
        "[i18n] it: 1 key missing, shown as the key: core.bye",
        "[i18n] it: 1 key no package declares: core.typo",
        "[i18n] en: 1 key no package declares: core.old",
      ]);
    });

    // Review of #280: an app's own texts (a formatter rule's) were reported
    // at every start as keys no package declares. They live under `app.`, and
    // the app's English file declares them.
    test("an app's own keys, under app. in its English file, are declared, and expected in every other language", () => {
      const i18n = createI18n({
        english,
        locales: {
          en: { "app.none": "Nothing." },
          it: { "core.hello": "Ciao", "core.bye": "Ciao", "app.other": "x" },
        },
      });
      expect(i18n.report()).toEqual([
        "[i18n] it: 1 key missing, shown as the key: app.none",
        "[i18n] it: 1 key no package declares: app.other",
      ]);
      expect(i18n.translator("en")("app.none")).toBe("Nothing.");
      expect(i18n.translator("it")("app.none")).toBe("app.none");
    });
  });
});

describe("createTexts", () => {
  const english = { "core.bye": "Bye." };
  const i18n = createI18n({ english, locales: { it: { "core.bye": "Ciao." } } });
  const saved: Record<string, string> = { "static:alice": "it" };
  const texts = createTexts(i18n, (key) => saved[key]);

  test("a known person gets the language they saved", () => {
    const { locale, t } = texts.forPerson("static:alice");
    expect(locale).toBe("it");
    expect(t("core.bye")).toBe("Ciao.");
  });

  test("someone with no saved language, or nobody known, gets the hint's, then the default", () => {
    expect(texts.forPerson("static:bob").locale).toBe("en");
    expect(texts.forPerson(undefined, "it-IT").t("core.bye")).toBe("Ciao.");
    expect(texts.forPerson(undefined).t("core.bye")).toBe("Bye.");
  });

  test("the saved language beats the hint", () => {
    expect(texts.forPerson("static:alice", "en").locale).toBe("it");
  });

  // Review of #279: a language a person saved and the instance no longer
  // ships still reached the prompt, while the fixed texts fell back to the
  // default: the answers and the texts disagreed.
  test("savedLanguage is the person's language only while the instance ships it", () => {
    const stale = createTexts(i18n, (key) => ({ "static:alice": "it", "static:bob": "fr" })[key]);
    expect(stale.savedLanguage("static:alice")).toBe("it");
    expect(stale.savedLanguage("static:bob")).toBeUndefined();
    expect(stale.savedLanguage("static:carol")).toBeUndefined();
  });
});

describe("englishTexts", () => {
  test("the core's own texts in English, for whoever isn't given an instance's", () => {
    expect(englishTexts().forPerson("anyone").t("core.access.unknown")).toBe(CORE_MESSAGES["core.access.unknown"]!);
  });
});

describe("CORE_MESSAGES", () => {
  test("every key is in the core's namespace", () => {
    expect(Object.keys(CORE_MESSAGES).filter((key) => !key.startsWith("core."))).toEqual([]);
  });
});

// Review of #280: the plugins' texts reach the instance's languages only
// through the composition; nothing checked that they do.
describe("instanceI18n", () => {
  test("the core's and the loaded plugins' English, the instance's files over it, the report covering both", () => {
    const i18n = instanceI18n({ "web-search.choice.once": "Only this time" }, {
      defaultLocale: "it",
      locales: { it: { "web-search.choice.once": "Solo questa volta" } },
    });
    expect(i18n.defaultLocale).toBe("it");
    expect(i18n.translator("it")("web-search.choice.once")).toBe("Solo questa volta");
    expect(i18n.translator("en")("web-search.choice.once")).toBe("Only this time");
    expect(i18n.translator("en")("core.access.unknown")).toBe(CORE_MESSAGES["core.access.unknown"]!);
    const [missing] = i18n.report();
    expect(missing).toStartWith("[i18n] it: ");
    expect(missing).toContain("core.access.unknown");
    expect(missing).not.toContain("web-search.choice.once");
  });

  test("English alone without an i18n config", () => {
    const i18n = instanceI18n({}, undefined);
    expect(i18n.supported).toEqual(["en"]);
    expect(i18n.report()).toEqual([]);
  });
});

// Review of #281: the texts a channel shows a request were wired inline in
// the composition, with nothing checking whose language they follow.
describe("requestTexts", () => {
  const i18n = createI18n({ english: { "core.bye": "Bye." }, locales: { it: { "core.bye": "Ciao." }, de: { "core.bye": "Tschüss." } }, defaultLocale: "de" });
  const texts = createTexts(i18n, (key) => (key === "people:alice" ? "it" : undefined));
  const known = { id: "alice", provider: "static" as const };
  const stranger = { id: "bob", provider: "static" as const };
  const channelI18n = requestTexts(texts, async (principal) =>
    principal.id === "alice"
      ? { ok: true, operator: false, person: { key: "people:alice", roles: [] } }
      : { ok: false, reason: "unknown", message: "no" },
  );

  test("the person's saved language first, whatever the hint", async () => {
    expect(await channelI18n.forRequest(known, "en")).toMatchObject({ locale: "it" });
  });

  test("someone the core refuses gets the hint's, then the default", async () => {
    expect((await channelI18n.forRequest(stranger, "en-US")).locale).toBe("en");
    expect((await channelI18n.forRequest(stranger)).locale).toBe("de");
  });

  test("a request with nobody behind it gets the hint's, then the default", async () => {
    const { locale, t } = await channelI18n.forRequest(null, "it");
    expect(locale).toBe("it");
    expect(t("core.bye")).toBe("Ciao.");
    expect((await channelI18n.forRequest(null)).locale).toBe("de");
  });
});
