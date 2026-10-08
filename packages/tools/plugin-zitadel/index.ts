/**
 * The ZITADEL plugin: reads users, their project roles and identity provider
 * links, organizations and projects through the `zitadel` CLI, as the person
 * Mercury is talking to. ZITADEL enforces what each person may read; nothing
 * mutating is allowlisted yet.
 *
 * Shaped like the Bitbucket plugin: it owns its tool through
 * `@mercury-fw/cli-engine`, validating its own allowlist (`zitadel.json`) in
 * `build()`, and its pinned CLI binary downloads with the package's postinstall.
 */
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { runCli, createCliTool, createCliPersonLogin, parseCliConfig, createCliStatusDescriber } from "@mercury-fw/cli-engine";
import rawConfig from "./zitadel.json";

/** The raw, unvalidated allowlist object. The plugin validates it itself through
 * `@mercury-fw/cli-engine`'s loader, so nothing reaches the model's executable
 * surface unvalidated. */
export const zitadelCliConfig: unknown = rawConfig;

/** Reads the command string off a `zitadelCommand` call's input for the status
 * label; a missing/non-string command falls back to the generic label. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

/** Builds the plugin. `runCliFn` is injectable for tests; the default spawns the
 * real binary. */
export function createZitadelPlugin(deps: { runCliFn?: typeof runCli } = {}): Plugin {
  const runCliFn = deps.runCliFn ?? runCli;
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "zitadel",
    // Every command runs as the person the turn is for, logged in to ZITADEL
    // through Mercury: they read what their own account can.
    actsAs: "person",
    build: (ctx) => {
      // Schema-only validation: the pinned binary is co-shipped, so no
      // `--version` check (see `parseCliConfig`).
      const loaded = parseCliConfig(zitadelCliConfig);
      if (!loaded.ok) {
        ctx.log(`zitadel allowlist failed to load, zitadel tool not contributed: ${loaded.reason}`);
        return {};
      }
      const configs = { [loaded.binary]: loaded.config };
      const describeCli = createCliStatusDescriber(configs, {});

      return {
        // The Native app people log in through accepts several redirect URIs,
        // Mercury's callback among them.
        login: createCliPersonLogin(runCliFn, loaded.binary, { redirectUri: true }),
        sessionTools: (sctx) => {
          const { runCommand } = createCliTool(runCliFn, configs, {
            stageConfirmation: sctx.stageConfirmation,
            stashDisplay: sctx.stashDisplay,
            person: sctx.person,
            requireLogin: sctx.requireLogin,
          });
          return { zitadelCommand: runCommand };
        },
        toolStatusDescribers: {
          zitadelCommand: (input) => {
            const command = commandOf(input);
            return command !== undefined ? describeCli(command) : "esecuzione di un comando";
          },
        },
      };
    },
  };
}

export const zitadelPlugin: Plugin = createZitadelPlugin();
