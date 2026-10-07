/**
 * Makes each plugin-declared CLI login reachable at startup. A plugin whose
 * CLI keeps its login in a folder declares it in its package.json
 * (`mercury.cliCredentials`, read by `@mercury-fw/utils`), and `mfw credentials
 * setup` runs the CLI's own setup inside the container, so the login is
 * written straight onto the credentials volume, mounted on `~/.config`, and
 * what the CLI writes back afterwards (a refreshed token, a person's login)
 * stays there across redeploys. A login declared elsewhere in the home lives
 * on the volume too (`volumePath`), and the home path is made a link to it at
 * every start, since the rest of the home is the image's and starts over each
 * time; a login missing from the volume is reported with the command that
 * sets it up. Called by `composeMercury` before the plugins load, so the
 * service and the REPL both get it. Never throws: a CLI without its login
 * degrades only that plugin's calls.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { appCliCredentials, volumePath, type CliCredentials } from "@mercury-fw/utils";

/** Where to read the declarations and where the logins are. */
export interface MaterializeOptions {
  /** The app's folder (its package.json and node_modules). */
  appDir: string;
  /** The home the CLIs run with; its `.config` is the credentials volume. */
  homeDir: string;
  log: (msg: string) => void;
}

/** Links every declared login kept outside `~/.config` from where its CLI
 * looks, reports one missing from the volume, and logs each dependency it
 * couldn't read. */
export async function materializeCliCredentials({ appDir, homeDir, log }: MaterializeOptions): Promise<void> {
  let declared: CliCredentials[];
  try {
    const read = appCliCredentials(appDir);
    for (const problem of read.problems) log(`CLI credentials: ${problem}`);
    declared = read.declared;
  } catch (err) {
    log(`CLI credentials not checked: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const c of declared) {
    const target = join(homeDir, volumePath(c.path));
    if (!existsSync(target)) {
      log(`${c.package}: its CLI has no login yet: run mfw credentials setup ${c.package}`);
      continue;
    }
    const link = join(homeDir, c.path);
    if (link === target) continue;
    try {
      linkTo(target, link, (msg) => log(`${c.package}: ${msg}`));
    } catch (err) {
      log(`${c.package}: could not link ${link} to the credentials volume: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Makes `link` a symlink to `target` unless it already is one; anything else
 * at `link` is never replaced, only reported. */
function linkTo(target: string, link: string, log: (msg: string) => void): void {
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing === undefined) {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
  } else if (!existing.isSymbolicLink() || readlinkSync(link) !== target) {
    log(`${link} is already there and isn't a link to the credentials volume: the CLI won't find its login`);
  }
}
