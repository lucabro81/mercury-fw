/**
 * Lints the HTTP channel's `openapi.yaml` with Redocly (its `redocly.yaml`
 * rules), then builds the HTTP API reference from it,
 * `public/reference/http-api/index.html`. A spec that fails the lint stops
 * the build, and with it the site.
 *
 * Redocly is pinned to 2.69.0: 2.70.0 writes the page's internal links as
 * root-relative paths (`/paths/~1turn/post`) instead of fragments
 * (`#/paths/~1turn/post`), and the site's link test fails on every one of
 * them (#307). Lift the pin once a later release builds fragment links
 * again.
 */
import { join } from "node:path";

const REDOCLY = "@redocly/cli@2.69.0";
const CHANNEL_HTTP = join(import.meta.dir, "..", "..", "..", "packages", "channels", "channel-http");
const OUT = join(import.meta.dir, "..", "public", "reference", "http-api", "index.html");

/** Runs Redocly with `args` in the HTTP channel's folder, returning its exit code. */
const redocly = (...args: string[]) =>
  Bun.spawnSync(["bunx", "--bun", REDOCLY, ...args], { cwd: CHANNEL_HTTP, stdout: "inherit", stderr: "inherit" }).exitCode;

const lint = redocly("lint", "openapi.yaml");
process.exit(lint !== 0 ? lint : redocly("build-docs", "openapi.yaml", "-o", OUT));
