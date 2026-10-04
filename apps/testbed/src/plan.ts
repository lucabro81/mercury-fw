/**
 * The steps `bun run create` takes, worked out from its command line before
 * anything runs: pack this repo's workspaces, then create the app with this
 * repo's `mfw create` on the tarballs (`--local-packages`) when it doesn't
 * exist yet (or anew with `--fresh`), or make an existing one install them
 * again with `mfw local-packages`.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";

export type CreateArgs = { name: string; plugins?: string[]; channels?: string[]; auth?: string; from?: string; fresh: boolean };

export type Step =
  | { step: "warn"; message: string }
  | { step: "pack" }
  | { step: "remove"; dir: string }
  | { step: "run"; argv: string[]; cwd: string };

/** Where the tarballs are, from the test bed's folder and from an app's (`apps/<name>`). */
const PACKS = ".packs";
const PACKS_FROM_APP = "../../.packs";

/** A comma-separated list, trimmed, empty items dropped. */
const list = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** `bun run create`'s arguments. */
export function parseCreateArgs(argv: string[]): CreateArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      plugins: { type: "string" },
      channels: { type: "string" },
      auth: { type: "string" },
      from: { type: "string" },
      fresh: { type: "boolean", default: false },
    },
  });
  const name = positionals[0];
  if (name === undefined || positionals.length > 1) {
    throw new Error("usage: bun run create <name> [--plugins a,b] [--channels c] [--auth static|oidc] [--from <test>] [--fresh]");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`"${name}" isn't a folder name: lowercase letters, digits and dashes`);
  if (values.from !== undefined && (values.plugins !== undefined || values.channels !== undefined)) {
    throw new Error("--from takes the plugins and channels from the test: leave out --plugins and --channels");
  }
  return {
    name,
    ...(values.plugins !== undefined ? { plugins: list(values.plugins) } : {}),
    ...(values.channels !== undefined ? { channels: list(values.channels) } : {}),
    ...(values.auth !== undefined ? { auth: values.auth } : {}),
    ...(values.from !== undefined ? { from: values.from } : {}),
    fresh: values.fresh ?? false,
  };
}

/** The steps for `args`, with the plugins and channels already settled (a
 * `--from` test read by the caller), for the test bed at `root`. */
export function planCreate(args: CreateArgs, { root, exists }: { root: string; exists: boolean }): Step[] {
  const app = join(root, "apps", args.name);
  const steps: Step[] = [];
  const create = !exists || args.fresh;
  // An app that exists keeps its config: plugins, channels or a test given
  // for it change nothing, which is worth saying.
  const given = args.plugins !== undefined || args.channels !== undefined || args.from !== undefined;
  if (exists && !args.fresh && given) {
    steps.push({ step: "warn", message: `${app} exists: its plugins and channels stay as they are (--fresh makes it anew with the ones given)` });
  }
  if (exists && args.fresh) steps.push({ step: "remove", dir: app });
  steps.push({ step: "pack" });
  if (create) {
    // The HTTP channel doesn't start without an auth provider: here the static
    // one, whose test tokens make two users, unless another is given.
    const auth = (args.channels ?? []).includes("http") ? ["--auth", args.auth ?? "static"] : [];
    steps.push({
      step: "run",
      argv: [
        "mfw",
        "create",
        `apps/${args.name}`,
        "--plugins",
        (args.plugins ?? []).join(","),
        "--channels",
        (args.channels ?? []).join(","),
        ...auth,
        "--local-packages",
        PACKS,
        "--yes",
      ],
      cwd: root,
    });
  } else {
    steps.push({ step: "run", argv: ["mfw", "local-packages", PACKS_FROM_APP], cwd: app });
  }
  return steps;
}
