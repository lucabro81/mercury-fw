import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeCliCredentials } from "./materialize.ts";

/**
 * What the core does at startup with each plugin-declared CLI login, which
 * `mfw credentials setup` writes straight onto the credentials volume: a login
 * declared outside `~/.config` is linked from where its CLI looks, and a login
 * missing from the volume is reported with the command that sets it up. Never
 * throws.
 */
describe("materializeCliCredentials", () => {
  let root: string;
  let app: string;
  let home: string;
  let configDir: string;
  let logs: string[];

  /** The app declares `deps`, each installed with the given credentials folder
   * under ~/.config, or the given declaration, or none. */
  function appWith(deps: Record<string, string | { path: string } | undefined>): void {
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ dependencies: Object.fromEntries(Object.keys(deps).map((d) => [d, "^1.0.0"])) }),
    );
    for (const [name, folder] of Object.entries(deps)) {
      const dir = join(app, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      const declaration = typeof folder === "string" ? { folder } : folder;
      const manifest =
        declaration === undefined ? { name } : { name, mercury: { cliCredentials: { ...declaration, setup: ["tool", "init"] } } };
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    }
  }

  /** A login already on the volume, at `volumeRelative` under ~/.config. */
  function onVolume(volumeRelative: string, content = "token"): void {
    mkdirSync(join(configDir, volumeRelative), { recursive: true });
    writeFileSync(join(configDir, volumeRelative, "token"), content);
  }

  async function run(): Promise<void> {
    await materializeCliCredentials({ appDir: app, homeDir: home, log: (m) => logs.push(m) });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "materialize-"));
    app = join(root, "app");
    mkdirSync(app);
    home = join(root, "home");
    configDir = join(home, ".config");
    logs = [];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves a login under ~/.config alone: the CLI finds it on the volume where it is", async () => {
    appWith({ "plugin-a": "a-cli", "plain-lib": undefined });
    onVolume("a-cli", "refreshed");
    await run();
    expect(readFileSync(join(configDir, "a-cli", "token"), "utf-8")).toBe("refreshed");
    expect(logs).toEqual([]);
  });

  it("reports a login missing from the volume, with the command that sets it up", async () => {
    appWith({ "@scope/plugin-a": "a-cli" });
    await run();
    expect(existsSync(join(configDir, "a-cli"))).toBe(false);
    expect(logs).toEqual(["@scope/plugin-a: its CLI has no login yet: run mfw credentials setup @scope/plugin-a"]);
  });

  // #144: a CLI may keep its login outside ~/.config. The volume is mounted on
  // ~/.config, so the login lives there, under mercury-home, and the home path
  // points to it: what the CLI writes back survives a redeploy too.
  it("a login declared elsewhere in the home is linked from where the CLI looks", async () => {
    appWith({ "plugin-aws": { path: ".aws" }, "plugin-deep": { path: ".local/share/tool" } });
    onVolume("mercury-home/.aws", "aws-secret");
    onVolume("mercury-home/.local/share/tool", "deep-secret");
    await run();
    expect(readlinkSync(join(home, ".aws"))).toBe(join(configDir, "mercury-home", ".aws"));
    expect(readFileSync(join(home, ".aws", "token"), "utf-8")).toBe("aws-secret");
    expect(readFileSync(join(home, ".local", "share", "tool", "token"), "utf-8")).toBe("deep-secret");
    expect(lstatSync(join(home, ".local", "share", "tool")).isSymbolicLink()).toBe(true);
    expect(logs).toEqual([]);
  });

  it("a link already in place is left as it is", async () => {
    appWith({ "plugin-aws": { path: ".aws" } });
    onVolume("mercury-home/.aws");
    symlinkSync(join(configDir, "mercury-home", ".aws"), join(home, ".aws"));
    const before = lstatSync(join(home, ".aws")).ino;
    await run();
    // The same link, not one removed and made again.
    expect(lstatSync(join(home, ".aws")).ino).toBe(before);
    expect(readlinkSync(join(home, ".aws"))).toBe(join(configDir, "mercury-home", ".aws"));
    expect(logs).toEqual([]);
  });

  it("a link pointing elsewhere is never replaced: logged", async () => {
    appWith({ "plugin-aws": { path: ".aws" } });
    onVolume("mercury-home/.aws");
    symlinkSync(join(root, "somewhere-else"), join(home, ".aws"));
    await run();
    expect(readlinkSync(join(home, ".aws"))).toBe(join(root, "somewhere-else"));
    expect(logs).toEqual([
      `plugin-aws: ${join(home, ".aws")} is already there and isn't a link to the credentials volume: the CLI won't find its login`,
    ]);
  });

  // Review of #144: a link that couldn't be made threw out of the startup and
  // took the whole app down with it.
  it("a link that can't be made is logged, and the next plugin is still handled", async () => {
    appWith({ "plugin-deep": { path: ".local/share/tool" }, "plugin-b": "b-cli" });
    onVolume("mercury-home/.local/share/tool");
    writeFileSync(join(home, ".local"), "a file where a folder should be");
    await run();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toStartWith(`plugin-deep: could not link ${join(home, ".local", "share", "tool")} to the credentials volume:`);
    expect(logs[1]).toBe("plugin-b: its CLI has no login yet: run mfw credentials setup plugin-b");
  });

  it("something else at the home path is never replaced: logged, the login stays on the volume", async () => {
    appWith({ "plugin-aws": { path: ".aws" } });
    onVolume("mercury-home/.aws", "aws-secret");
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(home, ".aws", "mine"), "x");
    await run();
    expect(readFileSync(join(home, ".aws", "mine"), "utf-8")).toBe("x");
    expect(readFileSync(join(configDir, "mercury-home", ".aws", "token"), "utf-8")).toBe("aws-secret");
    expect(logs).toEqual([
      `plugin-aws: ${join(home, ".aws")} is already there and isn't a link to the credentials volume: the CLI won't find its login`,
    ]);
  });

  it("no link without a login on the volume, just the report", async () => {
    appWith({ "plugin-aws": { path: ".aws" } });
    await run();
    expect(lstatSync(join(home, ".aws"), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs).toEqual(["plugin-aws: its CLI has no login yet: run mfw credentials setup plugin-aws"]);
  });

  // Review of #144: one dependency that couldn't be read stopped every
  // plugin's login from being handled.
  it("logs a dependency it can't read and still handles the others", async () => {
    appWith({ "plugin-aws": { path: ".aws" } });
    onVolume("mercury-home/.aws");
    const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf-8"));
    manifest.dependencies.missing = "^1.0.0";
    writeFileSync(join(app, "package.json"), JSON.stringify(manifest));
    await run();
    expect(readlinkSync(join(home, ".aws"))).toBe(join(configDir, "mercury-home", ".aws"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith("CLI credentials: missing is not installed");
  });

  it("logs, without throwing, when the app has no readable package.json", async () => {
    await run();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith("CLI credentials not checked: ");
  });
});
