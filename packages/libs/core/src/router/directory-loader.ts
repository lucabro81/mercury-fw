/**
 * Builds the user directory an app declares as `directory` in
 * `mercury.config.ts` — the identity-side sibling of `auth-loader.ts`. It knows
 * no directory: the static list, ZITADEL and the rest live in their own packages.
 *
 * Closed when it fails: an `apiVersion` mismatch, a name that would clash with
 * the keys of people nobody resolved, or a `build()` that throws is logged and
 * yields `"failed"`, which makes the core refuse everyone but the terminal.
 */
import { DIRECTORY_API_VERSION, type Directory, type DirectoryPlugin, type PrincipalProvider } from "@mercury-fw/channel-types";

/** The principal providers whose `<provider>:<id>` keys a directory's `<name>:<id>` must never collide with.
 * A record over the union, so a provider added to the contract fails the typecheck until it's listed here. */
const PRINCIPAL_PROVIDERS: Record<PrincipalProvider, true> = { "google-chat": true, oidc: true, static: true, none: true };

/** The built directory under its name, `"none"` when none is declared, `"failed"` when the declared one can't be used. */
export function loadDirectory(
  plugin: DirectoryPlugin | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
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
  if (Object.hasOwn(PRINCIPAL_PROVIDERS, plugin.name)) {
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
