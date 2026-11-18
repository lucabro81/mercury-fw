/**
 * The package's postinstall: downloads the `__BINARY__` binary pinned in
 * `package.json` (`mercury.cliBinary`) for this platform into the package's
 * `bin/`. The app must list the package in `trustedDependencies`, or Bun
 * doesn't run it.
 */
import { downloadPinnedBinary } from "@mercury-fw/utils";
import pkg from "../package.json";

await downloadPinnedBinary(pkg, import.meta.url);
