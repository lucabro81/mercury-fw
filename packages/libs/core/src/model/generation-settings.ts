/**
 * The main model's generation settings (#355): the config's `model` section
 * (its values usually from the environment, through `envNumber`/`envBoolean`)
 * turned into the settings `ai-sdk-ollama` takes when the model is built, so
 * they apply to every call on it. An entry that isn't set never reaches
 * Ollama, so the model's own values (its Modelfile) apply; `think` stays on
 * unless the config turns it off.
 */
import type { MercuryModel } from "../config/define-config.ts";

/** What the core hands `ai-sdk-ollama` for the main model: `think`, and `options` only when one is set. */
export type OllamaModelSettings = {
  think: boolean;
  options?: { temperature?: number; top_p?: number; top_k?: number };
};

/** Throws, naming the entry, when `value` is set and `ok` refuses it. */
function check(value: number | undefined, entry: string, ok: (v: number) => boolean, expected: string): void {
  if (value !== undefined && !ok(value)) throw new Error(`model.${entry} must be ${expected}, got ${value}`);
}

/** `model` as `ai-sdk-ollama`'s model settings. Throws on a value out of its range. */
export function ollamaSettings(model: MercuryModel | undefined): OllamaModelSettings {
  const { think, temperature, topP, topK } = model ?? {};
  check(temperature, "temperature", (v) => v >= 0, "a number from 0 up");
  check(topP, "topP", (v) => v > 0 && v <= 1, "a number above 0 and at most 1");
  check(topK, "topK", (v) => Number.isInteger(v) && v >= 1, "a whole number from 1 up");
  const options = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(topK === undefined ? {} : { top_k: topK }),
  };
  return { think: think ?? true, ...(Object.keys(options).length === 0 ? {} : { options }) };
}

/** The startup line naming the model and its settings: `[model] <name>: think on, temperature 0.2`. */
export function describeModelSettings(name: string, settings: OllamaModelSettings): string {
  const set = Object.entries(settings.options ?? {}).map(([key, value]) => `${key} ${value}`);
  return `[model] ${name}: think ${settings.think ? "on" : "off"}, ${set.length === 0 ? "server defaults" : set.join(", ")}`;
}
