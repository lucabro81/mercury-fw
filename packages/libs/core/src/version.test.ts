import { describe, it, expect } from "bun:test";
import pkg from "../package.json";
import { frameworkVersion } from "./version.ts";

describe("frameworkVersion", () => {
  // #310: the version the HTTP surface's /version answers.
  it("is the core's own package version, as major.minor.patch", () => {
    expect(frameworkVersion()).toBe(pkg.version);
    expect(frameworkVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
