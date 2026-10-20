/**
 * Builds the `runCommand` status describer the composition root injects into
 * the core's tool-start hook. It parses the command, computes whether it
 * mutates from the same allowlist that gates execution (via `matchCommand`, so
 * the label can never drift from what actually runs), and hands that to the
 * command's plugin describer — or `defaultStatusLabel` when the plugin doesn't
 * override it (and for file-based CLIs, which aren't plugins). The core no
 * longer classifies read vs write itself; it only transports whatever the
 * describer returns. This is CLI-specific, so it lives with the CLI mechanism,
 * not in the core session layer. Every label is worded in the turn's
 * language (`t`).
 */
import { defaultStatusLabel, type StatusDescriber, type Translate } from "@mercury-fw/plugin-types";
import { parseCommand } from "./command-parser.ts";
import { matchCommand, type CliConfig } from "./cli-tool.ts";

export function createCliStatusDescriber(
  configs: Record<string, CliConfig>,
  describers: Record<string, StatusDescriber>,
): (command: string, t: Translate) => string {
  return (command, t) => {
    const parsed = parseCommand(command);
    if (!parsed.ok) return t("core.status.command-unknown");
    const config = configs[parsed.binary];
    const match = config ? matchCommand(parsed.args, config) : undefined;
    const mutating = match !== undefined && match.kind !== "not-allowed" ? match.mutating : false;
    const describe = describers[parsed.binary] ?? defaultStatusLabel;
    return describe({ binary: parsed.binary, args: parsed.args, mutating }, t);
  };
}
