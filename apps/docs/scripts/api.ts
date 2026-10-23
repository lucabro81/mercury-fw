/**
 * Builds the HTTP API reference, `public/reference/http-api/index.html`, from
 * the HTTP channel's `openapi.yaml` with Redocly.
 *
 * Redocly is pinned to 2.69.0: 2.70.0 writes the page's internal links as
 * root-relative paths (`/paths/~1turn/post`) instead of fragments
 * (`#/paths/~1turn/post`), and the site's link test fails on every one of
 * them (#307). Lift the pin once a later release builds fragment links again.
 */
import { join } from "node:path";

const REDOCLY = "@redocly/cli@2.69.0";
const CHANNEL_HTTP = join(import.meta.dir, "..", "..", "..", "packages", "channels", "channel-http");
const OUT = join(import.meta.dir, "..", "public", "reference", "http-api", "index.html");

const result = Bun.spawnSync(["bunx", "--bun", REDOCLY, "build-docs", "openapi.yaml", "-o", OUT], {
  cwd: CHANNEL_HTTP,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode);
