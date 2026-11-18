/**
 * The __TITLE__ plugin: the agent runs the `__BINARY__` command-line program,
 * and only the commands its allowlist (`__BINARY__.json`) names; one marked
 * `confirm` waits for the person's confirmation before it runs. The package's
 * postinstall downloads the binary pinned in `package.json`
 * (`mercury.cliBinary`), and the app's image puts it on PATH. Written by
 * `mfw plugin create`: the allowlist's commands are examples to replace with
 * the program's own.
 */
import { createCliStatusDescriber, createCliTool, parseCliConfig, runCli } from "@mercury-fw/cli-engine";
import type { Plugin } from "@mercury-fw/kit";
import rawConfig from "./__BINARY__.json";

/** The allowlist as written, unchecked: the plugin checks it in `build`, so nothing unchecked reaches the model. */
export const __CAMEL__CliConfig: unknown = rawConfig;

/** The command a `__CAMEL__Command` call ran, for its status line; `undefined` when the input has none. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

/** The plugin. `runCliFn` runs the program; tests give their own. */
export function __EXPORT__(deps: { runCliFn?: typeof runCli } = {}): Plugin {
  const runCliFn = deps.runCliFn ?? runCli;
  return {
    // The contract this plugin is written for, as a literal: importing
    // PLUGIN_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    description: "Lists the items of __TITLE__ and deletes one, through the __BINARY__ program.",
    // The program runs with the login `mfw credentials setup` made, the
    // instance's own, whoever asks: only someone allowed to make the agent act
    // as itself may use it. For a program each person logs in to, see
    // `createCliPersonLogin` in @mercury-fw/cli-engine and `actsAs: "person"`.
    actsAs: "mercury",
    build: (ctx) => {
      const loaded = parseCliConfig(__CAMEL__CliConfig);
      if (!loaded.ok) {
        ctx.log(`__NAME__: the allowlist failed to load, no tool: ${loaded.reason}`);
        return {};
      }
      const configs = { [loaded.binary]: loaded.config };
      const describeCli = createCliStatusDescriber(configs, {});
      return {
        sessionTools: (sctx) => {
          const { runCommand } = createCliTool(runCliFn, configs, { stageConfirmation: sctx.stageConfirmation, t: sctx.t });
          return { __CAMEL__Command: runCommand };
        },
        toolStatusDescribers: {
          __CAMEL__Command: (input, t) => {
            const command = commandOf(input);
            return command !== undefined ? describeCli(command, t) : t("core.status.command-unknown");
          },
        },
      };
    },
  };
}
