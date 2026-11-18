/**
 * Builds the user directory an app declares as `directory` in
 * `mercury.config.ts` — the identity-side sibling of `auth-loader.ts`. It knows
 * no directory: the static list, ZITADEL and the rest live in their own packages.
 *
 * Closed when it fails: an `apiVersion` mismatch, a name that would clash with
 * the keys of people nobody resolved, or a `build()` that throws is logged and
 * yields `"failed"`, which makes the core refuse everyone but the terminal.
 */
import { DIRECTORY_API_VERSION, type Directory, type DirectoryPlugin } from "@mercury-fw/channel-types";

/** The first-party principal providers whose `<provider>:<id>` keys a directory's `<name>:<id>` must never collide with. */
const PRINCIPAL_PROVIDERS = new Set(["google-chat", "oidc", "static", "none"]);

/** Whether `name` is a principal provider's: a first-party one, a named OIDC provider's `oidc-<name>`, or one of `providers`. */
function isPrincipalProvider(name: string, providers: readonly string[]): boolean {
  return PRINCIPAL_PROVIDERS.has(name) || name.startsWith("oidc-") || providers.includes(name);
}

/** The built directory under its name, `"none"` when none is declared, `"failed"` when the declared one can't be used.
 * `providers` are the names of the instance's own auth providers and channels, whose people may carry them as their provider. */
export function loadDirectory(
  plugin: DirectoryPlugin | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
  providers: readonly string[] = [],
): { name: string; directory: Directory } | "none" | "failed" {
  if (plugin === undefined) return "none";
  const closed = "nobody but the terminal is let in";
  if (plugin.apiVersion !== DIRECTORY_API_VERSION) {
    ctx.log(
      `directory "${plugin.name}" not activated: apiVersion ${plugin.apiVersion} ` +
        `incompatible with this core (supports ${DIRECTORY_API_VERSION}); ${closed}`,
    );
    return "failed";
  }
  if (isPrincipalProvider(plugin.name, providers)) {
    ctx.log(`directory "${plugin.name}" not activated: its name is a channel identity's provider, so its people's keys could clash; ${closed}`);
    return "failed";
  }
  try {
    return { name: plugin.name, directory: plugin.build(ctx) };
  } catch (err) {
    ctx.log(`directory "${plugin.name}" failed to load: ${err instanceof Error ? err.message : String(err)}; ${closed}`);
    return "failed";
  }
}
