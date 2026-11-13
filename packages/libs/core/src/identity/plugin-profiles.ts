/**
 * People's profiles as plugins get them (`PluginRuntimeContext.profiles`,
 * #393): the same store the core and the channels read (a person's name,
 * language and time zone), with the core's checks, so a plugin offering the
 * model a way to change them keeps what the core keeps.
 *
 * Used by: `compose.ts`, which hands it to the plugin loader.
 */
import type { Profiles } from "@mercury-fw/plugin-types";
import type { ProfileStore } from "./profiles.ts";

/**
 * `store` as plugins see it. `languages` is read when asked: the instance's
 * languages are known only once the plugins have loaded (their texts are part
 * of them).
 */
export function pluginProfiles(store: ProfileStore, languages: () => string[]): Profiles {
  return {
    nameOf: store.nameOf,
    setName: store.setName,
    languageOf: store.languageOf,
    setLanguage: (person, language) => {
      const shipped = languages();
      if (!shipped.includes(language.trim().toLowerCase())) {
        throw new Error(`"${language}" isn't a language this instance ships: ${shipped.join(", ")}`);
      }
      return store.setLanguage(person, language);
    },
    timeZoneOf: store.timeZoneOf,
    setTimeZone: store.setTimeZone,
    get languages() {
      return languages();
    },
  };
}
