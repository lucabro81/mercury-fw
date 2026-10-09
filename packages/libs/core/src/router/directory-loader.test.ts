import { describe, expect, it, mock } from "bun:test";
import { DIRECTORY_API_VERSION, type Directory, type DirectoryPlugin } from "@mercury-fw/channel-types";
import { loadDirectory } from "./directory-loader.ts";

const directoryValue: Directory = { resolve: async () => null };

function plugin(build: DirectoryPlugin["build"], { apiVersion = DIRECTORY_API_VERSION, name = "people" } = {}): DirectoryPlugin {
  return { apiVersion, name, build };
}

describe("loadDirectory", () => {
  it("is none, silently, when the app declares no directory", () => {
    const logs: string[] = [];
    expect(loadDirectory(undefined, { env: {}, log: (m) => logs.push(m) })).toBe("none");
    expect(logs).toEqual([]);
  });

  it("builds the declared directory with the env and logger, under its name", () => {
    const env = { X: "1" };
    const log = () => {};
    const build = mock((ctx: Parameters<DirectoryPlugin["build"]>[0]) => {
      expect(ctx.env).toBe(env);
      expect(ctx.log).toBe(log);
      return directoryValue;
    });
    expect(loadDirectory(plugin(build), { env, log })).toEqual({ name: "people", directory: directoryValue });
  });

  // A declared directory that doesn't load must close the instance, not open
  // it: "failed" is what makes the core refuse everyone but the terminal.
  it("is failed for a directory written for another contract, without building it", () => {
    const logs: string[] = [];
    const build = mock(() => directoryValue);
    expect(loadDirectory(plugin(build, { apiVersion: DIRECTORY_API_VERSION + 1 }), { env: {}, log: (m) => logs.push(m) })).toBe("failed");
    expect(build).not.toHaveBeenCalled();
    expect(logs).toEqual([
      `directory "people" not activated: apiVersion ${DIRECTORY_API_VERSION + 1} incompatible with this core (supports ${DIRECTORY_API_VERSION}); nobody but the terminal is let in`,
    ]);
  });

  it("is failed when the build throws", () => {
    const logs: string[] = [];
    const result = loadDirectory(
      plugin(() => {
        throw new Error("DIRECTORY_STATIC_PEOPLE is not set");
      }),
      { env: {}, log: (m) => logs.push(m) },
    );
    expect(result).toBe("failed");
    expect(logs).toEqual([`directory "people" failed to load: DIRECTORY_STATIC_PEOPLE is not set; nobody but the terminal is let in`]);
  });

  // The person's key is `<directory name>:<id>`: a directory named like a
  // principal provider could hand out keys that belong to someone nobody resolved.
  it("refuses a directory named like a principal provider", () => {
    for (const name of ["static", "oidc", "google-chat", "none"]) {
      const logs: string[] = [];
      const build = mock(() => directoryValue);
      expect(loadDirectory(plugin(build, { name }), { env: {}, log: (m) => logs.push(m) })).toBe("failed");
      expect(build).not.toHaveBeenCalled();
      expect(logs[0]).toContain(`directory "${name}" not activated: its name is a channel identity's provider`);
    }
  });
});
