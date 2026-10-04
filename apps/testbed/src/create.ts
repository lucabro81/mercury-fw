/**
 * `bun run create <name>`: a test bed app in `apps/<name>`, scaffolded with
 * this repo's `mfw create` and installing this repo's packages from their
 * tarballs (`mfw local-packages`). Run again on an app that exists, it only
 * packs and installs anew, keeping its config, persona and `.env`; `--fresh`
 * removes the app and makes it again (its Docker volumes stay).
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { packAll } from "./pack.ts";
import { parseCreateArgs, planCreate, type CreateArgs } from "./plan.ts";

const ROOT = join(import.meta.dir, "..");

/** `args` with the plugins and channels a `--from` test declares, the HTTP
 * channel included when one of its cases talks to it. */
async function settle(args: CreateArgs): Promise<CreateArgs> {
  if (args.from === undefined) return args;
  const test = (
    (await import(resolve(args.from))) as { default?: { plugins?: string[]; channels?: string[]; cases?: Array<{ channel?: string }> } }
  ).default;
  if (test === undefined) throw new Error(`${args.from} has no default export: not an e2e test`);
  const http = (test.cases ?? []).some((c) => c.channel === "http") ? ["http"] : [];
  return { ...args, plugins: test.plugins ?? [], channels: [...new Set([...(test.channels ?? []), ...http])] };
}

try {
  const args = await settle(parseCreateArgs(process.argv.slice(2)));
  const app = join(ROOT, "apps", args.name);
  const existed = existsSync(app) && !args.fresh;
  for (const step of planCreate(args, { root: ROOT, exists: existsSync(app) })) {
    if (step.step === "warn") {
      console.warn(step.message);
    } else if (step.step === "remove") {
      rmSync(step.dir, { recursive: true, force: true });
    } else if (step.step === "pack") {
      console.log(`packed ${packAll({ types: true })} packages`);
    } else {
      const code = await Bun.spawn(step.argv, { cwd: step.cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
      if (code !== 0) throw new Error(`${step.argv.join(" ")} exited with ${code}`);
    }
  }
  console.log(
    existed
      ? `\n${app} has the new packages: bunx mfw start from there rebuilds its image with them.`
      : `\n${app} is ready. Next: its env file (see README.md), then from there: bunx mfw start, bunx mfw e2e.`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
