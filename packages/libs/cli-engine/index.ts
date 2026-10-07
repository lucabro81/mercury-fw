/**
 * The CLI-execution plugin's public surface. It owns the whole "run a CLI
 * command written as one free-text string, against a maintainer-authored
 * allowlist" mechanism that used to sit in the core: the command parser, the
 * subprocess executor, the allowlist schema/loader/version-check, the
 * allowlist-matching `runCommand` tool, and the per-command status describer.
 *
 * The core imports what it needs from here; a CLI-based plugin (Jira,
 * Bitbucket) rides on this one. Nothing here imports the app — its only
 * dependencies are `@mercury-fw/plugin-types` (the shared contract),
 * `@mercury-fw/utils` (the id a CLI knows a person by) and the
 * external `ai`/`zod`/`shell-quote` packages — so the mechanism is a self
 * contained unit that an instance with no CLI plugin never pulls in.
 */
export { parseCommand, type ParsedCommand } from "./command-parser.ts";
export { runCli, CLI_NOT_LOGGED_IN_EXIT_CODE, type CliResult } from "./cli-executor.ts";
export { createCliPersonLogin } from "./person-login.ts";
export {
  createCliTool,
  matchCommand,
  stripGlobalFlags,
  formatPrefixes,
  omitDisplayForModel,
  type CliConfig,
  type AllowedCommand,
  type GlobalFlag,
  type CommandMatch,
  type CliPostProcessor,
} from "./cli-tool.ts";
export { CliConfigFileSchema, type CliConfigFile } from "./cli-config-schema.ts";
export {
  toCliConfig,
  loadCliConfigFromObject,
  parseCliConfig,
  type CliConfigFromObjectResult,
} from "./cli-config-loader.ts";
export {
  checkCliVersion,
  parseVersion,
  compareVersions,
  type ParsedVersion,
  type VersionCheckResult,
} from "./cli-version-check.ts";
export { createCliStatusDescriber } from "./cli-status.ts";
