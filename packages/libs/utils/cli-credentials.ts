/**
 * The CLI login a plugin declares in its own package.json
 * (`mercury.cliCredentials`): where the plugin's CLI keeps its login and reads
 * it back at runtime, either `{ folder }` under `~/.config` (the usual place)
 * or `{ path }` anywhere under the home, and the commands that set it up,
 * check it and log an identity out. `mfw credentials` runs those commands
 * inside the app's container, so the CLI writes its login straight onto the
 * credentials volume, and the core links a `{ path }` login to the volume at
 * startup. Declared by the plugin rather than listed anywhere central, so a
 * plugin from any author gets the same mechanism; read as data, so both `mfw`
 * on the host and the core in the container find it without running the
 * plugin's code.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** What a plugin declares: `name` as it was declared (the folder, or the
 * path), which `mfw credentials` takes; `path` relative to the home; and the
 * commands, each a binary on the container's PATH and its arguments: `setup`
 * sets up the service identity, `check` reports on the login, `logout`
 * removes one identity's login (the service's, or a person's with `--user`). */
export type DeclaredCredentials = {
  name: string;
  path: string;
  setup: string[];
  check?: string[];
  logout?: string[];
};

/** One dependency's declaration. */
export type CliCredentials = DeclaredCredentials & { package: string };

/** What an app's dependencies declare: the usable declarations, and one line
 * per dependency left out (not installed, malformed, clashing with another). */
export type AppCliCredentials = { declared: CliCredentials[]; problems: string[] };

/** A single folder name: no separators, no `.`/`..`, no leading dot. */
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One segment of a home-relative path, never starting with a dash; `.` and
 * `..` are refused apart. */
const SEGMENT = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** A binary found on the PATH: a bare name, never a path or an option. */
const BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The credentials volume is mounted on `~/.config`; a login declared
 * anywhere else in the home lives on it under this folder. */
const ELSEWHERE = ".config/mercury-home";

const INVALID =
  "invalid mercury.cliCredentials in package.json: expected { folder } with a single folder name under ~/.config, or { path } relative to the home and outside ~/.config, with setup (and optionally check, logout) as a binary name followed by its arguments, e.g. [\"jira\", \"init\"]";

/** Whether `path` is a usable home-relative path for a login: inside the
 * home and outside `~/.config`, the volume, where a login is a `folder`. */
function isHomePath(path: string): boolean {
  const segments = path.split("/");
  if (!segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) return false;
  return path !== ".config" && !path.startsWith(".config/");
}

/** Whether `value` is a command: a binary name, then non-empty arguments. */
function isCommand(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((a) => typeof a === "string" && a !== "") &&
    BINARY.test(value[0] as string)
  );
}

/**
 * What `mercury.cliCredentials` of a package.json-shaped object declares, or
 * undefined when the package declares nothing. A malformed declaration throws:
 * a typo must surface, not silently leave the CLI without its login.
 * Hand-validated, like `readPinnedBinary`, to keep this package dependency-free.
 */
export function readCliCredentials(pkg: unknown): DeclaredCredentials | undefined {
  const mercury = (pkg as { mercury?: unknown } | undefined)?.mercury;
  if (mercury === undefined) return undefined;
  if (typeof mercury !== "object" || mercury === null || Array.isArray(mercury)) {
    throw new Error("invalid mercury in package.json: expected an object");
  }
  if (!("cliCredentials" in mercury)) return undefined;
  const declared = (mercury as { cliCredentials?: unknown }).cliCredentials;
  if (typeof declared !== "object" || declared === null) throw new Error(INVALID);
  const { folder, path, setup, check, logout } = declared as Record<string, unknown>;
  if (!isCommand(setup) || (check !== undefined && !isCommand(check)) || (logout !== undefined && !isCommand(logout))) {
    throw new Error(INVALID);
  }
  const commands = { setup, ...(check === undefined ? {} : { check }), ...(logout === undefined ? {} : { logout }) };
  if (folder !== undefined && path === undefined && typeof folder === "string" && FOLDER.test(folder)) {
    return { name: folder, path: `.config/${folder}`, ...commands };
  }
  if (path !== undefined && folder === undefined && typeof path === "string" && isHomePath(path)) {
    return { name: path, path, ...commands };
  }
  throw new Error(INVALID);
}

/** Where a home-relative login lives on the credentials volume, as a path
 * relative to the home: where it is when it's under `~/.config` (the
 * volume's mount, a declared `folder`), under `~/.config/mercury-home`
 * otherwise, with the home path pointing there. */
export function volumePath(path: string): string {
  return path.startsWith(".config/") ? path : `${ELSEWHERE}/${path}`;
}

/** What the CLIs accept as `--user <id>`. */
const CLI_USER_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** A provider name kept readable in front of a hashed id. */
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,30}$/;

/**
 * The id a CLI knows a person by (`--user <id>`), from Mercury's user key
 * (`<provider>:<id>`): the key itself when the CLIs accept it, as they do
 * `static:alice` or an OIDC key with a numeric subject, so a person's folder
 * stays readable; otherwise the provider and the first 32 hex digits of the
 * key's SHA-256, since an id with capitals, `/` or more than 64 characters is
 * refused, and lowering capitals would merge two people.
 */
export function cliUserId(key: string): string {
  if (CLI_USER_ID.test(key)) return key;
  const provider = key.slice(0, Math.max(key.indexOf(":"), 0));
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${PROVIDER.test(provider) ? provider : "user"}:${hash}`;
}

/**
 * The declarations of the app's dependencies (its package.json `dependencies`,
 * read from its `node_modules`), in the manifest's order. A dependency that
 * isn't installed or declares a malformed login is left out with a problem
 * line, and so are all the ones declaring the same login (each would set it up
 * and log it out for the other) or logins one inside the other (one would be
 * linked inside the other's copy on the volume): one bad plugin never costs
 * the others their login. Throws only when the app's own package.json can't be
 * read.
 */
export function appCliCredentials(appDir: string): AppCliCredentials {
  const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
  };
  const found: CliCredentials[] = [];
  const problems: string[] = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const path = join(appDir, "node_modules", name, "package.json");
    if (!existsSync(path)) {
      problems.push(`${name} is not installed (no ${path}): run bun install`);
      continue;
    }
    try {
      const declared = readCliCredentials(JSON.parse(readFileSync(path, "utf-8")));
      if (declared !== undefined) found.push({ package: name, ...declared });
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const excluded = new Set<CliCredentials>();
  for (const c of found) {
    const sharing = found.filter((o) => o.path === c.path);
    if (sharing.length === 1) continue;
    sharing.forEach((o) => excluded.add(o));
    if (sharing[0] === c) {
      problems.push(`${sharing.map((o) => o.package).join(" and ")} declare the same CLI credentials (${c.name}): neither is used`);
    }
  }
  const inside = (outer: string, inner: string) => inner.startsWith(`${outer}/`);
  found.forEach((a, i) => {
    for (const b of found.slice(i + 1)) {
      if (!inside(a.path, b.path) && !inside(b.path, a.path)) continue;
      excluded.add(a);
      excluded.add(b);
      problems.push(`${a.package} and ${b.package} declare CLI credentials (${a.name}, ${b.name}) one inside the other: neither is used`);
    }
  });
  return { declared: found.filter((c) => !excluded.has(c)), problems };
}
