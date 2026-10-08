/**
 * postinstall hook for @mercury-fw/plugin-zitadel: downloads the pinned zitadel
 * CLI binary for the current platform into this package's `bin/`. Identical in
 * shape to the other CLI plugins' — the mechanism lives in `@mercury-fw/utils`;
 * this script only names the pin (its own package.json's `mercury.cliBinary`)
 * and where to write it (`import.meta.url`). The Dockerfile symlinks the
 * downloaded binary onto PATH so `runCommand` can spawn `zitadel` by name.
 */
import { downloadPinnedBinary } from "@mercury-fw/utils";
import pkg from "../package.json";

await downloadPinnedBinary(pkg, import.meta.url);
