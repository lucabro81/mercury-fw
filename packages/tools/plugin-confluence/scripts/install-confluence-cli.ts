/**
 * postinstall hook for @mercury-fw/plugin-confluence: downloads the pinned
 * confluence CLI binary for the current platform into this package's `bin/`.
 * Runs automatically on `bun install` — on the host during development and
 * inside the Docker build (linux). The Dockerfile then symlinks each plugin's
 * downloaded bin contents onto PATH so `runCommand` can spawn `confluence` by
 * name.
 *
 * The mechanism (pinned version, Bun `fetch`) is shared across plugins in
 * `@mercury-fw/utils`; this script only names the pin (its own package.json's
 * `mercury.cliBinary`) and where to write it (`import.meta.url`).
 */
import { downloadPinnedBinary } from "@mercury-fw/utils";
import pkg from "../package.json";

await downloadPinnedBinary(pkg, import.meta.url);
