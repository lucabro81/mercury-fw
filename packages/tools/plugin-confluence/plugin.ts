/**
 * The Confluence plugin's module object — the single value the composition
 * config lists and the core's generic loader (`loadPlugins`) processes.
 * Confluence works only through a CLI, so it owns its CLI tool: it depends on
 * `@mercury-fw/cli-engine` and, in `build()`, validates its own allowlist and
 * builds its `confluenceCommand` tool from it.
 *
 * Read-only: the allowlist (`confluence.json`) lets through searching, reading
 * a page, its children, ancestors and comments, and spaces; the CLI's writing
 * commands never run.
 *
 * `build()` contributes:
 *  - `sessionTools`: the `confluenceCommand` tool, built per turn from the
 *    validated allowlist and the session's context, with the post-processor
 *    handed in (its own list extractor, possibly wrapped by a formatter at
 *    composition);
 *  - `postProcess`: the extractor of the `page-list` and `child-pages` lists;
 *  - `login`: the person's login, through the CLI's two-step remote login;
 *  - `toolStatusDescribers`: the status label for `confluenceCommand`.
 *
 * It needs no environment variable: the links in its lists come from the CLI,
 * which knows the site each login belongs to.
 */
import { readFileSync } from "node:fs";
import { PLUGIN_API_VERSION, type Plugin, parseSkill } from "@mercury-fw/plugin-types";
import { runCli, createCliTool, createCliPersonLogin, parseCliConfig, createCliStatusDescriber } from "@mercury-fw/cli-engine";
import rawConfig from "./confluence.json";
import { confluencePageListExtractor } from "./page-list-extractor.ts";

/** The raw, unvalidated allowlist object. The plugin validates it itself
 * through `@mercury-fw/cli-engine`'s loader, so nothing reaches the model's
 * executable surface unvalidated. */
export const confluenceCliConfig: unknown = rawConfig;

/** The Confluence skill (Agent Skills `SKILL.md`), read from the package
 * asset at load: its descriptor stays in the system prompt, its body loads
 * when the model asks for it. */
const confluenceSkill = parseSkill(readFileSync(new URL("./skills/confluence/SKILL.md", import.meta.url), "utf8"));

/** Reads the command string off a `confluenceCommand` call's input for the
 * status label; a missing/non-string command falls back to the generic label. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

/** Builds the plugin. `runCliFn` is injectable for tests; the default spawns
 * the pinned binary. */
export function createConfluencePlugin(deps: { runCliFn?: typeof runCli } = {}): Plugin {
  const runCliFn = deps.runCliFn ?? runCli;
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "confluence",
    description: "Searches and reads Confluence pages, their children and comments, and spaces.",
    // Every command runs as the person the turn is for, logged in to
    // Confluence through Mercury: they see what their own account can.
    actsAs: "person",
    skills: [confluenceSkill],
    build: (ctx) => {
      // Schema-only validation: the pinned binary is co-shipped with this
      // allowlist, so no `--version` check (see `parseCliConfig`). A config
      // that fails schema means no tool, rather than an unvalidated one.
      const loaded = parseCliConfig(confluenceCliConfig);
      if (!loaded.ok) {
        ctx.log(`confluence allowlist failed to load, confluence tool not contributed: ${loaded.reason}`);
        return {};
      }
      const configs = { [loaded.binary]: loaded.config };
      const describeCli = createCliStatusDescriber(configs, {});

      return {
        postProcess: confluencePageListExtractor,
        // The 3LO app people log in through has Mercury's callback among its
        // callbacks, and the login names it.
        login: createCliPersonLogin(runCliFn, loaded.binary, { redirectUri: true }),
        sessionTools: (sctx, decoratedPostProcess) => {
          const { runCommand } = createCliTool(runCliFn, configs, {
            stageConfirmation: sctx.stageConfirmation,
            t: sctx.t,
            stashDisplay: sctx.stashDisplay,
            postProcess: decoratedPostProcess,
            person: sctx.person,
            requireLogin: sctx.requireLogin,
          });
          return { confluenceCommand: runCommand };
        },
        toolStatusDescribers: {
          confluenceCommand: (input, t) => {
            const command = commandOf(input);
            return command !== undefined ? describeCli(command, t) : t("core.status.command-unknown");
          },
        },
      };
    },
  };
}

/** The Confluence plugin wired with the real `runCli`, as the composition
 * config lists it. */
export const confluencePlugin: Plugin = createConfluencePlugin();
