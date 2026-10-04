/**
 * Builds the auth provider an app declares as `auth` in `mercury.config.ts`
 * into the `authenticate` the channels get on their runtime context — the
 * auth-side sibling of `channel-loader.ts`. It knows no provider: OIDC,
 * static tokens and the rest live in their own packages.
 *
 * Fail-soft like the other loaders, and closed when it fails: an `apiVersion`
 * mismatch or a `build()` that throws is logged and yields no `authenticate`,
 * so a channel that needs one (HTTP) refuses to start instead of running open.
 */
import { AUTH_API_VERSION, type AuthPlugin, type Authenticate } from "@mercury-fw/channel-types";

/** Builds `auth` with `ctx`, or returns `undefined` when none is declared, it's incompatible, or its build throws. */
export function loadAuth(
  auth: AuthPlugin | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
): Authenticate | undefined {
  if (auth === undefined) return undefined;
  if (auth.apiVersion !== AUTH_API_VERSION) {
    ctx.log(
      `auth provider "${auth.name}" not activated: apiVersion ${auth.apiVersion} ` +
        `incompatible with this core (supports ${AUTH_API_VERSION})`,
    );
    return undefined;
  }
  try {
    return auth.build(ctx);
  } catch (err) {
    ctx.log(`auth provider "${auth.name}" failed to load: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
