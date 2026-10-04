/**
 * The version each package of a new app is written against. The framework
 * packages move in lockstep with this CLI, so they take its own version; a
 * plugin or channel is versioned on its own, so it takes the registry's
 * `latest` (asked only for the ones chosen).
 */
import pkg from "../package.json";

/** The framework packages a new app can depend on: always at the CLI's version. */
export const FRAMEWORK_PACKAGES = ["@mercury-fw/cli", "@mercury-fw/core", "@mercury-fw/formatter"];

/** The registry asked when `MFW_REGISTRY` doesn't name another. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** The registry to ask: `value` (from `MFW_REGISTRY`) unless it's unset or
 * blank, the default otherwise. */
export function registryFrom(value: string | undefined): string {
  return value?.trim() ? value.trim() : DEFAULT_REGISTRY;
}

/** This CLI's version, which is the framework's. */
export function cliVersion(): string {
  return pkg.version;
}

/** The registry's `latest` version of `name`. Rejects naming the package the
 * registry doesn't have, or saying the registry can't be reached (also when
 * it hasn't answered within `timeoutMs`, if given). */
async function latestVersion(
  name: string,
  opts: { registry: string; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<string> {
  const registry = opts.registry.replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    const signal = opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs);
    res = await fetchFn(`${registry}/${name.replace("/", "%2F")}/latest`, { signal });
  } catch {
    throw new Error(`Can't reach ${registry} to look up ${name}`);
  }
  if (!res.ok) {
    throw new Error(`${name} is not on ${registry}`);
  }
  const body = (await res.json().catch(() => undefined)) as { version?: unknown } | undefined;
  if (typeof body?.version !== "string") {
    throw new Error(`${registry} gave no version for ${name}`);
  }
  return body.version;
}

/** Maps the framework packages to the CLI's version and each of `packages`
 * (plugins, channels, auth providers) to the registry's `latest`. A package
 * in `local` (packed tarballs, `--local-packages`) takes that version instead,
 * a framework one included, and the registry isn't asked for it. Rejects
 * naming the package the registry doesn't have, or saying the registry can't
 * be reached. */
export async function appVersions(
  packages: string[],
  opts: { registry: string; fetchFn?: typeof fetch; local?: Record<string, string> },
): Promise<Record<string, string>> {
  const local = opts.local ?? {};
  const versions: Record<string, string> = Object.fromEntries(FRAMEWORK_PACKAGES.map((p) => [p, local[p] ?? cliVersion()]));
  for (const name of packages) {
    if (local[name] !== undefined) versions[name] = local[name];
  }
  const remote = packages.filter((name) => local[name] === undefined);
  const latest = await Promise.all(remote.map(async (name) => [name, await latestVersion(name, opts)] as const));
  for (const [name, version] of latest) {
    versions[name] = version;
  }
  return versions;
}

/** The registry's `latest` `@mercury-fw/cli` when it's newer than `current`
 * (this CLI's version by default), nothing otherwise: a CLI run from Bun's
 * bunx cache can be behind the release it was meant to be. Rejects like
 * `appVersions` when the registry can't answer, within `timeoutMs` (5s by
 * default: this check runs on every create, also one needing no network). */
export async function newerCli(opts: {
  registry: string;
  fetchFn?: typeof fetch;
  current?: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const latest = await latestVersion("@mercury-fw/cli", { ...opts, timeoutMs: opts.timeoutMs ?? 5000 });
  return Bun.semver.order(latest, opts.current ?? cliVersion()) === 1 ? latest : undefined;
}
