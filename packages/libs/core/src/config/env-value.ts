/**
 * Helpers a `mercury.config.ts` reads a setting's value from the environment
 * with (#355): the config declares the setting, the deployment's env gives its
 * value, and the config's own fallback applies when the variable is unset or
 * empty. A value of the wrong kind throws, naming the variable, so a typo in
 * `.env` stops the start instead of being silently ignored. Whether the value
 * is in range is the setting's to check, where it's used.
 */

/** A decimal number as `.env` writes it: no exponent, hex, `Infinity` or comma. */
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** The variable's value, trimmed; undefined when unset or blank. */
function valueOf(name: string, env: Record<string, string | undefined>): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** The number in `name`, or `fallback` when it's unset or empty. Throws on text that isn't a number. */
export function envNumber(
  name: string,
  fallback?: number,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const value = valueOf(name, env);
  if (value === undefined) return fallback;
  if (!NUMBER.test(value)) throw new Error(`${name} must be a number, got "${value}"`);
  return Number(value);
}

/** `true` or `false` in `name`, or `fallback` when it's unset or empty. Throws on anything else. */
export function envBoolean(name: string, fallback: boolean, env: Record<string, string | undefined> = process.env): boolean {
  const value = valueOf(name, env);
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false, got "${value}"`);
  return value === "true";
}
