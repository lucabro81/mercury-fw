/**
 * The main model's settings for the trainer's runs (#355): read from the
 * environment as a scaffolded app's `mercury.config.ts` reads them, so a run
 * generates as the instance does, and recorded in the run's conditions.
 */
import { envBoolean, envNumber, type MercuryModel } from "@mercury-fw/core";

/** The config's `model` section from `env`, only the entries set. Throws on a value of the wrong kind, naming its variable. */
export function modelSettingsFromEnv(env: Record<string, string | undefined>): MercuryModel {
  const settings: MercuryModel = { think: envBoolean("OLLAMA_THINK", true, env) };
  const temperature = envNumber("OLLAMA_TEMPERATURE", undefined, env);
  const topP = envNumber("OLLAMA_TOP_P", undefined, env);
  const topK = envNumber("OLLAMA_TOP_K", undefined, env);
  if (temperature !== undefined) settings.temperature = temperature;
  if (topP !== undefined) settings.topP = topP;
  if (topK !== undefined) settings.topK = topK;
  return settings;
}
