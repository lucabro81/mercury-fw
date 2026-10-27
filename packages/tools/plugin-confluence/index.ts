/**
 * The Confluence plugin's public surface — a thin re-export layer, no logic of
 * its own.
 */
import rawConfig from "./confluence.json";

/** The raw, unvalidated allowlist object. The plugin validates it itself
 * through `@mercury-fw/cli-engine`'s loader, so nothing reaches the model's
 * executable surface unvalidated. */
export const confluenceCliConfig: unknown = rawConfig;
