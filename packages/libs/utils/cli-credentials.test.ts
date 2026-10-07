import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliCredentials, appCliCredentials, volumePath, cliUserId } from "./index.ts";

/** A declaration of `where` with the one command every declaration needs. */
const decl = (where: Record<string, unknown>) => ({ mercury: { cliCredentials: { ...where, setup: ["tool", "init"] } } });

/**
 * The plugin-declared CLI credentials folder (`mercury.cliCredentials` in a
 * plugin's package.json): what `mfw credentials` on the host and the core in
 * the container both read, so a plugin outside the CLI's catalog gets the same
 * mechanism as a first-party one.
 */
describe("readCliCredentials", () => {
  it("a folder is under ~/.config, the default", () => {
    expect(readCliCredentials(decl({ folder: "jira-cli" }))).toEqual({
      name: "jira-cli",
      path: ".config/jira-cli",
      setup: ["tool", "init"],
    });
  });

  // #144: a CLI may keep its login outside ~/.config.
  it("a path is anywhere under the home", () => {
    expect(readCliCredentials(decl({ path: ".aws" }))).toEqual({ name: ".aws", path: ".aws", setup: ["tool", "init"] });
    expect(readCliCredentials(decl({ path: ".local/share/tool" }))).toEqual({
      name: ".local/share/tool",
      path: ".local/share/tool",
      setup: ["tool", "init"],
    });
  });

  // #174: the login is set up inside the container by the CLI itself, with the
  // commands the plugin declares, so `mfw` needs no knowledge of the CLI.
  it("carries the declared setup, check and logout commands", () => {
    expect(
      readCliCredentials({
        mercury: {
          cliCredentials: {
            folder: "jira-cli",
            setup: ["jira", "init"],
            check: ["jira", "doctor"],
            logout: ["jira", "auth", "logout"],
          },
        },
      }),
    ).toEqual({
      name: "jira-cli",
      path: ".config/jira-cli",
      setup: ["jira", "init"],
      check: ["jira", "doctor"],
      logout: ["jira", "auth", "logout"],
    });
  });

  // #176: the app people log in through is set up apart, logging nobody in.
  it("carries the declared setup of the people's app", () => {
    expect(
      readCliCredentials({ mercury: { cliCredentials: { folder: "x-cli", setup: ["x", "init"], userSetup: ["x", "init", "--user-app"] } } }),
    ).toEqual({ name: "x-cli", path: ".config/x-cli", setup: ["x", "init"], userSetup: ["x", "init", "--user-app"] });
  });

  it("rejects a declaration without setup, or with a command that isn't a binary and its arguments", () => {
    const bad: unknown[] = [undefined, [], "jira init", ["jira", 3], ["jira", ""], ["", "init"], ["/usr/bin/jira"], ["../jira"], ["-x"]];
    for (const setup of bad) {
      expect(() => readCliCredentials({ mercury: { cliCredentials: { folder: "x", setup } } }), String(setup)).toThrow(
        /mercury\.cliCredentials/,
      );
    }
    for (const field of ["userSetup", "check", "logout"]) {
      for (const command of bad.slice(1)) {
        expect(
          () => readCliCredentials({ mercury: { cliCredentials: { folder: "x", setup: ["x", "init"], [field]: command } } }),
          `${field} ${String(command)}`,
        ).toThrow(/mercury\.cliCredentials/);
      }
    }
  });

  it("returns undefined for a package that declares nothing", () => {
    expect(readCliCredentials({ name: "x" })).toBeUndefined();
    expect(readCliCredentials({ mercury: { cliBinary: { repo: "a", crate: "b", version: "1" } } })).toBeUndefined();
    expect(readCliCredentials(undefined)).toBeUndefined();
  });

  // Review of #144: a non-object `mercury` threw a bare TypeError from `in`.
  it("rejects a `mercury` field that isn't an object, with the same clear error", () => {
    for (const mercury of [null, "x", 3, []]) {
      expect(() => readCliCredentials({ mercury })).toThrow(/invalid mercury in package\.json/);
    }
  });

  it("rejects a malformed declaration instead of ignoring it", () => {
    for (const cliCredentials of [null, "jira-cli", {}, { folder: "" }, { folder: 3 }, { path: 3 }, { folder: "a", path: ".a" }]) {
      expect(() => readCliCredentials({ mercury: { cliCredentials } })).toThrow(/mercury\.cliCredentials/);
      if (typeof cliCredentials === "object" && cliCredentials !== null) {
        expect(() => readCliCredentials(decl(cliCredentials))).toThrow(/mercury\.cliCredentials/);
      }
    }
  });

  it("rejects a folder that isn't a single name under ~/.config", () => {
    for (const folder of ["a/b", "../x", "..", ".", "/abs", "with space", ".hidden"]) {
      expect(() => readCliCredentials(decl({ folder }))).toThrow(/mercury\.cliCredentials/);
    }
  });

  // Review of #144: under ~/.config a path would duplicate a folder; that's
  // what `folder` is for.
  it("rejects a path under ~/.config: that's a folder", () => {
    for (const path of [".config/x", ".config/x/y"]) {
      expect(() => readCliCredentials(decl({ path })), path).toThrow(/mercury\.cliCredentials/);
    }
  });

  it("rejects a path that leaves the home, or covers the whole volume or Mercury's part of it", () => {
    for (const path of ["", "/abs", "../x", "a/../../x", "./a", "a//b", "a/", "with space", "-x", "a/-x", ".config", ".config/mercury-home", ".config/mercury-home/x"]) {
      expect(() => readCliCredentials(decl({ path })), path).toThrow(/mercury\.cliCredentials/);
    }
  });
});

describe("volumePath", () => {
  it("a folder under ~/.config is on the volume where it is", () => {
    expect(volumePath(".config/jira-cli")).toBe(".config/jira-cli");
    expect(volumePath(".config/tool/sub")).toBe(".config/tool/sub");
  });

  it("anything else goes under ~/.config/mercury-home, the volume being ~/.config", () => {
    expect(volumePath(".aws")).toBe(".config/mercury-home/.aws");
    expect(volumePath(".local/share/tool")).toBe(".config/mercury-home/.local/share/tool");
  });
});

describe("appCliCredentials", () => {
  let app: string;

  /** Writes `node_modules/<name>/package.json` in the fake app. */
  function installed(name: string, manifest: Record<string, unknown>): void {
    const dir = join(app, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
  }

  /** Installs `name` declaring its login at `where`, with a setup command. */
  function declaring(name: string, where: Record<string, unknown>): void {
    installed(name, decl(where));
  }

  beforeEach(() => {
    app = mkdtempSync(join(tmpdir(), "cli-credentials-"));
  });
  afterEach(() => {
    rmSync(app, { recursive: true, force: true });
  });

  it("collects the declarations of the app's dependencies, in the manifest's order", () => {
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({
        dependencies: { "@scope/plugin-a": "^1.0.0", "plain-lib": "^2.0.0", "third-party-plugin": "^0.1.0" },
        devDependencies: { "@scope/dev-tool": "^1.0.0" },
      }),
    );
    declaring("@scope/plugin-a", { folder: "a-cli" });
    installed("plain-lib", {});
    declaring("third-party-plugin", { path: ".tp" });
    // A devDependency isn't part of what the app runs: not collected.
    declaring("@scope/dev-tool", { folder: "dev" });

    expect(appCliCredentials(app)).toEqual({
      declared: [
        { package: "@scope/plugin-a", name: "a-cli", path: ".config/a-cli", setup: ["tool", "init"] },
        { package: "third-party-plugin", name: ".tp", path: ".tp", setup: ["tool", "init"] },
      ],
      problems: [],
    });
  });

  it("returns nothing for an app without dependencies", () => {
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "x" }));
    expect(appCliCredentials(app)).toEqual({ declared: [], problems: [] });
  });

  // Review of #144: one bad dependency used to make the whole read throw, so
  // the good plugins lost their login too. Each problem now drops only its own.
  it("reports a dependency that isn't installed, and keeps the others", () => {
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "missing-plugin": "^1.0.0", good: "^1.0.0" } }));
    declaring("good", { folder: "good-cli" });
    const { declared, problems } = appCliCredentials(app);
    expect(declared).toEqual([{ package: "good", name: "good-cli", path: ".config/good-cli", setup: ["tool", "init"] }]);
    expect(problems).toEqual([
      `missing-plugin is not installed (no ${join(app, "node_modules", "missing-plugin", "package.json")}): run bun install`,
    ]);
  });

  it("reports a malformed declaration, and keeps the others", () => {
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "bad-plugin": "^1.0.0", good: "^1.0.0" } }));
    declaring("bad-plugin", { folder: "../escape" });
    declaring("good", { folder: "good-cli" });
    const { declared, problems } = appCliCredentials(app);
    expect(declared.map((c) => c.package)).toEqual(["good"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("bad-plugin: invalid mercury.cliCredentials");
  });

  // Review of #144: a login inside another's would be linked inside that
  // one's copy on the volume.
  it("drops both dependencies whose paths are one inside the other, and keeps the others", () => {
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ dependencies: { outer: "^1.0.0", good: "^1.0.0", inner: "^1.0.0", sibling: "^1.0.0" } }),
    );
    declaring("outer", { path: ".aws" });
    declaring("good", { folder: "good-cli" });
    declaring("inner", { path: ".aws/sso" });
    // Same prefix as a string, not as a path: no overlap.
    declaring("sibling", { path: ".aws-other" });
    const { declared, problems } = appCliCredentials(app);
    expect(declared.map((c) => c.package)).toEqual(["good", "sibling"]);
    expect(problems).toEqual(["outer and inner declare CLI credentials (.aws, .aws/sso) one inside the other: neither is used"]);
  });

  // Two plugins declaring one login would set it up, and log it out, for each other.
  it.each([
    [{ folder: "same" }, { folder: "same" }, "same"],
    [{ path: ".aws" }, { path: ".aws" }, ".aws"],
  ])("drops both dependencies declaring the same login %p, and keeps the others", (da, db, name) => {
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ dependencies: { one: "^1.0.0", good: "^1.0.0", two: "^1.0.0" } }),
    );
    declaring("one", da);
    declaring("good", { folder: "good-cli" });
    declaring("two", db);
    const { declared, problems } = appCliCredentials(app);
    expect(declared.map((c) => c.package)).toEqual(["good"]);
    expect(problems).toEqual([`one and two declare the same CLI credentials (${name}): neither is used`]);
  });
});

describe("cliUserId", () => {
  const hashed = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

  it("passes a key the CLIs accept as an id unchanged", () => {
    expect(cliUserId("static:alice")).toBe("static:alice");
    expect(cliUserId("oidc:312345678901234567")).toBe("oidc:312345678901234567");
    expect(cliUserId(`static:${"a".repeat(57)}`)).toBe(`static:${"a".repeat(57)}`);
  });

  it("hashes a key the CLIs would refuse, keeping its provider readable", () => {
    for (const key of ["oidc:Alice", "oidc:auth0|123", "google-chat:users/123", "static:jane doe", `static:${"a".repeat(58)}`]) {
      expect(cliUserId(key), key).toBe(`${key.slice(0, key.indexOf(":"))}:${hashed(key)}`);
    }
  });

  it("is deterministic and keeps two refused keys apart", () => {
    expect(cliUserId("oidc:Alice")).toBe(cliUserId("oidc:Alice"));
    expect(cliUserId("oidc:Alice")).not.toBe(cliUserId("oidc:ALICE"));
  });

  it("always produces an id the CLIs accept", () => {
    for (const key of ["oidc:Alice", "static:alice", "google-chat:users/1", `oidc:${"x".repeat(200)}`, "Weird Provider:x"]) {
      expect(cliUserId(key), key).toMatch(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
    }
  });
});
