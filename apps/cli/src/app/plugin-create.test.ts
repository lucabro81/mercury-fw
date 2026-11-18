/**
 * `mfw plugin create` in an app's folder: the package written under
 * `plugins/<name>` at the app's framework version (`ai` and `zod` at the
 * ranges its core is built with), declared in `package.json` and in
 * `mercury.config.ts`, then `bun install`; and what it refuses before writing
 * anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDeps } from "./commands.ts";
import { pluginCreate } from "./plugin-create.ts";
import { cliVersion } from "../versions.ts";

const NEW_APP_CONFIG = readFileSync(new URL("../__fixtures__/render/empty.mercury.config.ts.golden", import.meta.url), "utf-8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mfw-plugin-create-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "my-agent", dependencies: { "@mercury-fw/core": "^0.79.2" } }, null, 2)}\n`);
  writeFileSync(join(dir, "mercury.config.ts"), NEW_APP_CONFIG);
  mkdirSync(join(dir, "node_modules/@mercury-fw/core"), { recursive: true });
  writeFileSync(join(dir, "node_modules/@mercury-fw/core/package.json"), JSON.stringify({ dependencies: { ai: "^7.0.126", zod: "^4.6.5" } }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Deps recording what ran and what was printed; `code` is `bun install`'s exit code. */
function fake(code = 0) {
  const runs: Array<{ argv: string[]; cwd: string }> = [];
  const printed: string[] = [];
  const deps: AppDeps = {
    run: async (argv, { cwd }) => {
      runs.push({ argv, cwd });
      return code;
    },
    capture: async () => "",
    ask: async () => "",
    print: (line) => void printed.push(line),
    home: "/nonexistent-home",
  };
  return { deps, runs, printed };
}

const app = () => ({ dir, name: "my-agent" });
const read = (path: string) => readFileSync(join(dir, path), "utf-8");

describe("pluginCreate", () => {
  test("writes the package, declares it, installs it", async () => {
    const f = fake();
    expect(await pluginCreate(app(), f.deps, { kind: "tool", name: "guest-wifi" })).toBe(0);

    expect(JSON.parse(read("plugins/guest-wifi/package.json"))).toMatchObject({
      name: "@my-agent/plugin-guest-wifi",
      dependencies: { "@mercury-fw/kit": `^${cliVersion()}`, ai: "^7.0.126", zod: "^4.6.5" },
    });
    expect(existsSync(join(dir, "plugins/guest-wifi/skills/guest-wifi/SKILL.md"))).toBe(true);
    expect(JSON.parse(read("package.json")).dependencies["@my-agent/plugin-guest-wifi"]).toBe("workspace:*");
    expect(read("mercury.config.ts")).toContain('import { guestWifiPlugin } from "@my-agent/plugin-guest-wifi";');
    expect(read("mercury.config.ts")).toContain("corrections({ wiki: teamWiki }), guestWifiPlugin()],");
    expect(f.runs).toEqual([{ argv: ["bun", "install"], cwd: dir }]);
    expect(f.printed).toEqual([
      "Wrote plugins/guest-wifi (@my-agent/plugin-guest-wifi), a tool plugin.",
      "Declared it in package.json and in mercury.config.ts.",
      "Next: its settings (plugins/guest-wifi/README.md), bun run test, then mfw restart.",
    ]);
  });

  test("a CLI plugin is trusted to run its postinstall", async () => {
    await pluginCreate(app(), fake().deps, { kind: "cli", name: "acme", cli: { binary: "acme", repo: "acme/acme-cli", version: "1.2.3" } });
    expect(JSON.parse(read("package.json")).trustedDependencies).toEqual(["@my-agent/plugin-acme"]);
  });

  test("prints the lines to add when the config can't take it as it is", async () => {
    const f = fake();
    await pluginCreate(app(), f.deps, { kind: "context-strategy", name: "short-window" });
    expect(read("mercury.config.ts")).toBe(NEW_APP_CONFIG);
    expect(f.printed).toEqual([
      "Wrote plugins/short-window (@my-agent/short-window), a context strategy.",
      "Declared it in package.json. Add it to mercury.config.ts:",
      '  import { shortWindowStrategy } from "@my-agent/short-window";',
      "  const conversation = shortWindowStrategy();  // in place of the conversation there, in plugins and in the profile",
      "Next: its settings (plugins/short-window/README.md), bun run test, then mfw restart.",
    ]);
  });

  test("tells a memory it reaches the model through a profile's layers", async () => {
    const f = fake();
    await pluginCreate(app(), f.deps, { kind: "memory", name: "topics" });
    expect(f.printed).toContain("The model reads it once a context profile lists it in its layers (plugins/topics/README.md).");
  });

  test("returns bun install's exit code when it fails", async () => {
    expect(await pluginCreate(app(), fake(1).deps, { kind: "tool", name: "guest-wifi" })).toBe(1);
  });

  test("scopes the package by an app name that is itself scoped", async () => {
    await pluginCreate({ dir, name: "@acme/agent" }, fake().deps, { kind: "tool", name: "guest-wifi" });
    expect(JSON.parse(read("plugins/guest-wifi/package.json")).name).toBe("@acme-agent/plugin-guest-wifi");
  });

  test("refuses a plugin whose folder is there already, writing nothing", async () => {
    mkdirSync(join(dir, "plugins/guest-wifi"), { recursive: true });
    await expect(pluginCreate(app(), fake().deps, { kind: "tool", name: "guest-wifi" })).rejects.toThrow("plugins/guest-wifi is there already");
    expect(JSON.parse(read("package.json")).dependencies).toEqual({ "@mercury-fw/core": "^0.79.2" });
  });

  test("refuses before writing when the app isn't installed", async () => {
    rmSync(join(dir, "node_modules"), { recursive: true });
    await expect(pluginCreate(app(), fake().deps, { kind: "tool", name: "guest-wifi" })).rejects.toThrow("The app's packages aren't installed: run bun install first");
    expect(existsSync(join(dir, "plugins"))).toBe(false);
  });

  test("refuses a name or a kind that isn't one, and a CLI plugin without its binary", async () => {
    await expect(pluginCreate(app(), fake().deps, { kind: "tool", name: "Guest" })).rejects.toThrow("a plugin's name is lowercase words");
    await expect(pluginCreate(app(), fake().deps, { kind: "widget", name: "guest" })).rejects.toThrow('"widget" is not a kind of plugin');
    await expect(pluginCreate(app(), fake().deps, { kind: "cli", name: "acme" })).rejects.toThrow("a cli plugin needs its binary's name");
    expect(existsSync(join(dir, "plugins"))).toBe(false);
  });
});
