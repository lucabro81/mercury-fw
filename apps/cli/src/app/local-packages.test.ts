/**
 * `mfw local-packages`: an app installs the `@mercury-fw/*` packages from local
 * tarballs (`bun pm pack`) instead of the registry, through `overrides` in its
 * `package.json`, so transitive dependencies resolve to the tarballs too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PACKS_DIR, packageOf, readPacks, withLocalOverrides, withoutLocalOverrides } from "./local-packages.ts";

describe("withLocalOverrides", () => {
  test("points every packed package at its tarball in .packs/", () => {
    const pkg = { name: "demo", dependencies: { "@mercury-fw/core": "^0.30.0" } };
    expect(
      withLocalOverrides(pkg, [
        { name: "@mercury-fw/core", file: "mercury-fw-core-0.30.0.tgz" },
        { name: "@mercury-fw/plugin-types", file: "mercury-fw-plugin-types-0.30.0.tgz" },
      ]),
    ).toEqual({
      name: "demo",
      dependencies: { "@mercury-fw/core": "^0.30.0" },
      overrides: {
        "@mercury-fw/core": "file:./.packs/mercury-fw-core-0.30.0.tgz",
        "@mercury-fw/plugin-types": "file:./.packs/mercury-fw-plugin-types-0.30.0.tgz",
      },
    });
  });

  test("replaces the local overrides of an earlier run, keeps the user's own", () => {
    const pkg = {
      overrides: {
        "@mercury-fw/core": "file:./.packs/mercury-fw-core-0.29.0.tgz",
        "@mercury-fw/kit": "file:./.packs/mercury-fw-kit-0.29.0.tgz",
        "some-lib": "1.2.3",
      },
    };
    expect(withLocalOverrides(pkg, [{ name: "@mercury-fw/core", file: "mercury-fw-core-0.30.0.tgz" }])).toEqual({
      overrides: { "some-lib": "1.2.3", "@mercury-fw/core": "file:./.packs/mercury-fw-core-0.30.0.tgz" },
    });
  });

  test("leaves the input alone", () => {
    const pkg = { overrides: { "some-lib": "1.2.3" } };
    withLocalOverrides(pkg, [{ name: "@mercury-fw/core", file: "x.tgz" }]);
    expect(pkg).toEqual({ overrides: { "some-lib": "1.2.3" } });
  });
});

describe("withoutLocalOverrides", () => {
  test("drops the local overrides, and overrides itself when nothing else is left", () => {
    expect(withoutLocalOverrides({ name: "demo", overrides: { "@mercury-fw/core": "file:./.packs/c.tgz" } })).toEqual({ name: "demo" });
  });

  test("keeps the user's own overrides", () => {
    expect(
      withoutLocalOverrides({ overrides: { "@mercury-fw/core": "file:./.packs/c.tgz", "some-lib": "1.2.3" } }),
    ).toEqual({ overrides: { "some-lib": "1.2.3" } });
  });

  test("a package without overrides stays as it is", () => {
    expect(withoutLocalOverrides({ name: "demo" })).toEqual({ name: "demo" });
  });
});

describe("packageOf", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mfw-local-packages-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A tarball shaped like `bun pm pack`'s: `package/package.json` inside. */
  async function tarball(manifest: string): Promise<string> {
    mkdirSync(join(dir, "package"));
    writeFileSync(join(dir, "package", "package.json"), manifest);
    const file = join(dir, "p.tgz");
    const proc = Bun.spawn(["tar", "czf", file, "-C", dir, "package"]);
    expect(await proc.exited).toBe(0);
    return file;
  }

  test("reads the name and version from the tarball's package.json, not from its file name", async () => {
    expect(await packageOf(await tarball('{ "name": "@mercury-fw/plugin-jira", "version": "0.4.0" }'))).toEqual({
      name: "@mercury-fw/plugin-jira",
      version: "0.4.0",
    });
  });

  test("a package.json without a version is an error naming the tarball", async () => {
    await expect(packageOf(await tarball('{ "name": "@mercury-fw/plugin-jira" }'))).rejects.toThrow("p.tgz isn't a package tarball: no version in its package.json");
  });

  test("a file that isn't a package tarball is an error naming it", async () => {
    const file = join(dir, "broken.tgz");
    writeFileSync(file, "not a tarball");
    await expect(packageOf(file)).rejects.toThrow("broken.tgz");
  });
});

describe("readPacks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mfw-read-packs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A tarball named `file` in `dir/packs`, holding `name` at `version`. */
  async function pack(file: string, name: string, version: string): Promise<void> {
    const work = mkdtempSync(join(dir, "w-"));
    mkdirSync(join(work, "package"));
    writeFileSync(join(work, "package", "package.json"), JSON.stringify({ name, version }));
    mkdirSync(join(dir, "packs"), { recursive: true });
    expect(await Bun.spawn(["tar", "czf", join(dir, "packs", file), "-C", work, "package"]).exited).toBe(0);
  }

  test("every tarball in the folder, by file name, with the package it holds", async () => {
    await pack("b.tgz", "@mercury-fw/core", "0.35.0");
    await pack("a.tgz", "@mercury-fw/auth-static", "0.0.0");
    writeFileSync(join(dir, "packs", "notes.txt"), "not a tarball");
    expect(await readPacks(join(dir, "packs"), join(dir, "app"))).toEqual([
      { file: "a.tgz", name: "@mercury-fw/auth-static", version: "0.0.0" },
      { file: "b.tgz", name: "@mercury-fw/core", version: "0.35.0" },
    ]);
  });

  test("a folder that doesn't exist, holds no tarball, or is the app's own .packs/ is an error", async () => {
    await expect(readPacks(join(dir, "nope"), join(dir, "app"))).rejects.toThrow(`${join(dir, "nope")} doesn't exist.`);
    mkdirSync(join(dir, "empty"));
    await expect(readPacks(join(dir, "empty"), join(dir, "app"))).rejects.toThrow(`No .tgz in ${join(dir, "empty")}`);
    await expect(readPacks(join(dir, "app", ".packs"), join(dir, "app"))).rejects.toThrow("is the app's own .packs/");
  });
});

test("the tarballs' folder inside the app", () => {
  expect(LOCAL_PACKS_DIR).toBe(".packs");
});
