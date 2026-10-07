/**
 * The atlassian-admin plugin — a minimal read-only CLI plugin (user get,
 * doctor; no mutating or confirm-gated commands, no result post-processing, no
 * post-turn guard, no prompt block of its own). Like Jira/Bitbucket it works
 * only through a CLI, so it owns its tool: in `build()` it validates its own
 * allowlist and builds its `atlassianAdminCommand` tool from it. Its allowlist
 * (`atlassian-admin.json`) and its pinned CLI binary (via the package's
 * postinstall, using `@mercury-fw/utils`) travel with the package.
 */
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { runCli, createCliTool, parseCliConfig, createCliStatusDescriber } from "@mercury-fw/cli-engine";
import rawConfig from "./atlassian-admin.json";

/** The raw, unvalidated allowlist object. The plugin validates it itself through `@mercury-fw/cli-engine`'s loader, so nothing reaches the model's executable surface unvalidated. */
export const atlassianAdminCliConfig: unknown = rawConfig;

/** Reads the command string off an `atlassianAdminCommand` call's input for the status label; a missing/non-string command falls back to the generic label. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

export const atlassianAdminPlugin: Plugin = {
  apiVersion: PLUGIN_API_VERSION,
  name: "atlassian-admin",
  // The organization's API key is Mercury's own: whoever asks, it answers as
  // the organization, so only someone allowed to make Mercury act as itself
  // may use it.
  actsAs: "mercury",
  build: (ctx) => {
    // Schema-only validation — the pinned binary is co-shipped, so no
    // `--version` check (see the Jira/Bitbucket plugins / `parseCliConfig`).
    const loaded = parseCliConfig(atlassianAdminCliConfig);
    if (!loaded.ok) {
      ctx.log(`atlassian-admin allowlist failed to load, tool not contributed: ${loaded.reason}`);
      return {};
    }
    const configs = { [loaded.binary]: loaded.config };
    const describeCli = createCliStatusDescriber(configs, {});

    return {
      sessionTools: (sctx) => {
        const { runCommand } = createCliTool(runCli, configs, {
          stageConfirmation: sctx.stageConfirmation,
          stashDisplay: sctx.stashDisplay,
        });
        return { atlassianAdminCommand: runCommand };
      },
      toolStatusDescribers: {
        atlassianAdminCommand: (input) => {
          const command = commandOf(input);
          return command !== undefined ? describeCli(command) : "esecuzione di un comando";
        },
      },
    };
  },
};
