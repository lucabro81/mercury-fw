/**
 * The Bitbucket plugin — the minimal CLI-based plugin. Read-only (pr list/get,
 * doctor, auth whoami — no mutating or confirm-gated commands), no result
 * post-processing, no post-turn guard, no prompt block of its own (the
 * `--help`-driven discovery in the system prompt covers it).
 *
 * Like Jira, it works only through a CLI, so it owns its tool: it depends on
 * `@mercury-fw/cli-engine` and, in `build()`, validates its own allowlist and
 * builds its `bitbucketCommand` tool from it. Its allowlist (`bitbucket.json`)
 * and its pinned CLI binary (via the package's postinstall, using
 * `@mercury-fw/utils`) travel with the package.
 */
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { runCli, createCliTool, createCliPersonLogin, parseCliConfig, createCliStatusDescriber } from "@mercury-fw/cli-engine";
import rawConfig from "./bitbucket.json";

/** The raw, unvalidated allowlist object. The plugin validates it itself through
 * `@mercury-fw/cli-engine`'s loader, so nothing reaches the model's executable
 * surface unvalidated. */
export const bitbucketCliConfig: unknown = rawConfig;

/** Reads the command string off a `bitbucketCommand` call's input for the status
 * label; a missing/non-string command falls back to the generic label. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

export const bitbucketPlugin: Plugin = {
  apiVersion: PLUGIN_API_VERSION,
  name: "bitbucket",
  // Every command runs as the person the turn is for, logged in to Bitbucket
  // through Mercury: they see what their own account can.
  actsAs: "person",
  build: (ctx) => {
    // Schema-only validation — the pinned binary is co-shipped, so no
    // `--version` check (see the Jira plugin / `parseCliConfig`).
    const loaded = parseCliConfig(bitbucketCliConfig);
    if (!loaded.ok) {
      ctx.log(`bitbucket allowlist failed to load, bitbucket tool not contributed: ${loaded.reason}`);
      return {};
    }
    const configs = { [loaded.binary]: loaded.config };
    const describeCli = createCliStatusDescriber(configs, {});

    return {
      // Bitbucket takes no redirect URI: the consumer people log in through
      // has Mercury's callback as its own.
      login: createCliPersonLogin(runCli, loaded.binary, { redirectUri: false }),
      sessionTools: (sctx) => {
        const { runCommand } = createCliTool(runCli, configs, {
          stageConfirmation: sctx.stageConfirmation,
          stashDisplay: sctx.stashDisplay,
          person: sctx.person,
          requireLogin: sctx.requireLogin,
        });
        return { bitbucketCommand: runCommand };
      },
      toolStatusDescribers: {
        bitbucketCommand: (input) => {
          const command = commandOf(input);
          return command !== undefined ? describeCli(command) : "esecuzione di un comando";
        },
      },
    };
  },
};
