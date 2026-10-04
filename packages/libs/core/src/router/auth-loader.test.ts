import { describe, expect, it, mock } from "bun:test";
import { AUTH_API_VERSION, type AuthPlugin, type Authenticate } from "@mercury-fw/channel-types";
import { loadAuth } from "./auth-loader.ts";

function auth(build: AuthPlugin["build"], apiVersion = AUTH_API_VERSION): AuthPlugin {
  return { apiVersion, name: "static", build };
}

describe("loadAuth", () => {
  it("returns undefined, silently, when the app declares no auth provider", () => {
    const logs: string[] = [];
    expect(loadAuth(undefined, { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("builds the declared provider with the env and logger and returns its authenticate", () => {
    const authenticate: Authenticate = async () => ({ id: "alice", provider: "static" });
    const env = { AUTH_STATIC_TOKENS: "{}" };
    const log = () => {};
    const build = mock((ctx: Parameters<AuthPlugin["build"]>[0]) => {
      expect(ctx.env).toBe(env);
      expect(ctx.log).toBe(log);
      return authenticate;
    });
    expect(loadAuth(auth(build), { env, log })).toBe(authenticate);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("refuses a provider written for another contract, without building it", () => {
    const logs: string[] = [];
    const build = mock(() => async () => null);
    expect(loadAuth(auth(build, AUTH_API_VERSION + 1), { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    expect(logs).toEqual([
      `auth provider "static" not activated: apiVersion ${AUTH_API_VERSION + 1} incompatible with this core (supports ${AUTH_API_VERSION})`,
    ]);
  });

  it("logs a build that throws and returns undefined, so nothing authenticates (closed, not open)", () => {
    const logs: string[] = [];
    const failing = auth(() => {
      throw new Error("AUTH_STATIC_TOKENS is missing");
    });
    expect(loadAuth(failing, { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([`auth provider "static" failed to load: AUTH_STATIC_TOKENS is missing`]);
  });
});
