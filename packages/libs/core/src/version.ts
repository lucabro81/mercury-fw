/**
 * The framework's version: the core's own package version, which the
 * framework packages share (they move in lockstep). Channels get it on their
 * runtime context, for the HTTP surface's `/version`.
 */
import pkg from "../package.json";

/** The framework's version, `major.minor.patch`. */
export function frameworkVersion(): string {
  return pkg.version;
}
