/**
 * The Jira plugin's module object — the single value the composition config
 * lists and the core's generic loader (`loadPlugins`) processes. Jira works only
 * through a CLI, so it owns its CLI tool outright: it depends on the
 * `@mercury-fw/cli-engine` library and, in `build()`, validates its own allowlist
 * and builds its own `jiraCommand` tool from it. The core composes nothing
 * CLI-specific for it.
 *
 * `build()` contributes:
 *  - `sessionTools`: the `jiraCommand` tool, built per turn from the validated
 *    allowlist, the session's confirm-staging/display-stashing, and the
 *    post-processor handed in (its own issue-list extractor, possibly wrapped
 *    by a formatter decorator at composition);
 *  - `postProcess`: the `issue search` result extractor;
 *  - `toolStatusDescribers`: the status label for `jiraCommand`.
 *
 * JIRA_SITE_URL is required: without it `build()` throws, and the loader skips
 * the plugin saying why, so a Jira instance always has its extractor.
 *
 * The object is a plain literal, not typed against a core interface — a plugin
 * package must not import the app it plugs into. Structural compatibility with
 * `Plugin` is what the composition config's typing checks.
 */
import { readFileSync } from "node:fs";
import { PLUGIN_API_VERSION, type Plugin, type CliPostProcessor, parseSkill } from "@mercury-fw/plugin-types";
import { runCli, createCliTool, createCliPersonLogin, parseCliConfig, createCliStatusDescriber } from "@mercury-fw/cli-engine";
import rawConfig from "./jira.json";
import { createJiraIssueListExtractor } from "./issue-list-extractor.ts";

/** The raw, unvalidated allowlist object. The plugin validates it itself through
 * `@mercury-fw/cli-engine`'s loader (the same `.strict()` Zod + version-check
 * barrier), so nothing reaches the model's executable surface unvalidated. */
export const jiraCliConfig: unknown = rawConfig;

/** The Jira skill (Agent Skills `SKILL.md`), read from the package asset at
 * load. Its descriptor stays in the system prompt; its body — the DO/DON'T that
 * used to be an always-on prompt fragment — loads only when the model asks for
 * it (see the core's read_skill tool). */
const jiraSkill = parseSkill(readFileSync(new URL("./skills/jira/SKILL.md", import.meta.url), "utf8"));

/** Reads the command string off a `jiraCommand` tool call's input for the status
 * label; a missing/non-string command falls back to the generic label. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

/**
 * Builds the Jira plugin. `runCliFn` is injectable so a test can drive the tool
 * without spawning the real jira binary (the invariance oracle does this);
 * production uses the engine's real `runCli`.
 */
export function createJiraPlugin(deps: { runCliFn?: typeof runCli } = {}): Plugin {
  const runCliFn = deps.runCliFn ?? runCli;
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "jira",
    // Every command runs as the person the turn is for, logged in to Jira
    // through Mercury: they see and change what their own account can.
    actsAs: "person",
    skills: [jiraSkill],
    build: (ctx) => {
      // The browse links the issue lists point to: not derivable from any CLI
      // output (the API talks to api.atlassian.com/ex/jira/<cloud-id>/…,
      // unrelated to the human-facing hostname), so it's the deployment's to set.
      const siteUrl = ctx.env.JIRA_SITE_URL;
      if (!siteUrl) {
        throw new Error("JIRA_SITE_URL is not set: set it in .env to your Jira site (https://<site>.atlassian.net)");
      }
      // Validate the allowlist here — the plugin owns this now, not the core.
      // Schema only, no `--version` check: the pinned binary is co-shipped with
      // this allowlist, so they're co-versioned by construction (the check stays
      // for file-based configs, where they can drift). A config that fails schema
      // means no tool — contribute nothing rather than expose an unvalidated one.
      const loaded = parseCliConfig(jiraCliConfig);
      if (!loaded.ok) {
        ctx.log(`jira allowlist failed to load, jira tool not contributed: ${loaded.reason}`);
        return {};
      }
      const configs = { [loaded.binary]: loaded.config };

      // Rendering config (itemTemplate) lives in the render handler wired at
      // composition, so `siteUrl` is the extractor's only input.
      const postProcess: CliPostProcessor = createJiraIssueListExtractor({ siteUrl });

      // Status label for jiraCommand, from the same allowlist that gates
      // execution (so the label can't drift from what runs). No per-command
      // override, so the contract default applies.
      const describeCli = createCliStatusDescriber(configs, {});

      return {
        postProcess,
        login: createCliPersonLogin(runCliFn, loaded.binary, { redirectUri: true }),
        sessionTools: (sctx, decoratedPostProcess) => {
          const { runCommand } = createCliTool(runCliFn, configs, {
            stageConfirmation: sctx.stageConfirmation,
            stashDisplay: sctx.stashDisplay,
            postProcess: decoratedPostProcess,
            person: sctx.person,
            requireLogin: sctx.requireLogin,
          });
          return { jiraCommand: runCommand };
        },
        toolStatusDescribers: {
          jiraCommand: (input) => {
            const command = commandOf(input);
            return command !== undefined ? describeCli(command) : "esecuzione di un comando";
          },
        },
      };
    },
  };
}

/** The Jira plugin wired with the real `runCli`, as the composition config lists it. */
export const jiraPlugin: Plugin = createJiraPlugin();
