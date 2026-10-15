/**
 * Builds the auth providers an app declares as `auth` in `mercury.config.ts`
 * (one, or a list) into the one `authenticate` the channels get on their
 * runtime context — the auth-side sibling of `channel-loader.ts`. It knows no
 * provider: OIDC, static tokens and the rest live in their own packages.
 *
 * Several providers are tried in the order declared, and the first that
 * recognizes the caller decides who they are. Each provider's people keep its
 * own name as their provider, so a name can't be taken twice.
 *
 * Fail-soft like the other loaders, and closed when it fails: an `apiVersion`
 * mismatch, a name already taken or a `build()` that throws is logged and that
 * provider left out; when none is left there's no `authenticate`, so a channel
 * that needs one (HTTP) refuses to start instead of running open.
 */
import { AUTH_API_VERSION, type AuthPlugin, type Authenticate } from "@mercury-fw/channel-types";

/** Builds `auth` with `ctx`, or logs why it can't be used and returns `undefined`. */
function buildOne(
  auth: AuthPlugin,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
): Authenticate | undefined {
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

/**
 * The `authenticate` for `auth`: the provider's own when there's one, one
 * trying each in order when there are several; `undefined` when none is
 * declared or none of them can be used.
 */
export function loadAuth(
  auth: AuthPlugin | AuthPlugin[] | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
): Authenticate | undefined {
  if (auth === undefined) return undefined;
  const built: Array<{ name: string; authenticate: Authenticate }> = [];
  const names = new Set<string>();
  for (const provider of Array.isArray(auth) ? auth : [auth]) {
    if (names.has(provider.name)) {
      ctx.log(`auth provider "${provider.name}" not activated: another provider already has that name`);
      continue;
    }
    names.add(provider.name);
    const authenticate = buildOne(provider, ctx);
    if (authenticate !== undefined) built.push({ name: provider.name, authenticate });
  }
  if (built.length === 0) return undefined;
  if (built.length === 1) return built[0]!.authenticate;
  return async (req) => {
    for (const { name, authenticate } of built) {
      // One provider failing (its issuer down) mustn't keep the others' people out.
      try {
        const principal = await authenticate(req);
        if (principal !== null) return principal;
      } catch (err) {
        ctx.log(`auth provider "${name}" failed on a request, trying the next: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  };
}
