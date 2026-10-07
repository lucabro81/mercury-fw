/**
 * `@mercury-fw/utils` — shared, plugin-agnostic helpers used across the monorepo.
 * Currently the CLI-binary provisioning used by each plugin's postinstall and
 * the plugin-declared CLI credentials folder; more shared utilities land here
 * as they're factored out.
 */
export {
  downloadPinnedBinary,
  resolvePlatform,
  binaryAssetUrl,
  readPinnedBinary,
  type Platform,
  type PinnedBinary,
} from "./cli-binary.ts";
export {
  readCliCredentials,
  appCliCredentials,
  volumePath,
  cliUserId,
  type DeclaredCredentials,
  type CliCredentials,
  type AppCliCredentials,
} from "./cli-credentials.ts";
