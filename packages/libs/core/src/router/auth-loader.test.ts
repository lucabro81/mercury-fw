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

  // #199: several providers on one instance, tried in the order declared.
  describe("a list of providers", () => {
    /** A provider named `name` that knows only `token`, as `<name>:<id>`. */
    function knowing(name: string, token: string, id: string, calls: string[] = []): AuthPlugin {
      return {
        apiVersion: AUTH_API_VERSION,
        name,
        build: () => async (req) => {
          calls.push(name);
          return req.headers.get("authorization") === `Bearer ${token}` ? { id, provider: name as "static" } : null;
        },
      };
    }
    const request = (token: string) => new Request("http://mercury/turn", { headers: { authorization: `Bearer ${token}` } });

    it("tries them in order and takes the first principal: a later one is reached when the earlier ones refuse", async () => {
      const calls: string[] = [];
      const authenticate = loadAuth([knowing("static", "t1", "alice", calls), knowing("oidc", "t2", "312345", calls)], {
        env: {},
        log: () => {},
      })!;

      expect(await authenticate(request("t1"))).toEqual({ id: "alice", provider: "static" });
      expect(calls).toEqual(["static"]);
      calls.length = 0;
      expect(await authenticate(request("t2"))).toEqual({ id: "312345", provider: "oidc" });
      expect(calls).toEqual(["static", "oidc"]);
      calls.length = 0;
      expect(await authenticate(request("nobody"))).toBeNull();
      expect(calls).toEqual(["static", "oidc"]);
    });

    it("leaves out one that fails to build or is for another contract, and the others still serve", async () => {
      const logs: string[] = [];
      const broken: AuthPlugin = {
        apiVersion: AUTH_API_VERSION,
        name: "oidc-company",
        build: () => {
          throw new Error("OIDC_COMPANY_ISSUER is missing");
        },
      };
      const old = { ...knowing("oidc-old", "t3", "x"), apiVersion: AUTH_API_VERSION + 1 };
      const authenticate = loadAuth([broken, old, knowing("oidc", "t2", "312345")], { env: {}, log: (m) => logs.push(m) })!;

      expect(await authenticate(request("t2"))).toEqual({ id: "312345", provider: "oidc" });
      expect(await authenticate(request("t3"))).toBeNull();
      expect(logs).toEqual([
        `auth provider "oidc-company" failed to load: OIDC_COMPANY_ISSUER is missing`,
        `auth provider "oidc-old" not activated: apiVersion ${AUTH_API_VERSION + 1} incompatible with this core (supports ${AUTH_API_VERSION})`,
      ]);
    });

    it("goes on to the next provider when one throws on a request, and logs it", async () => {
      const logs: string[] = [];
      const throwing: AuthPlugin = {
        apiVersion: AUTH_API_VERSION,
        name: "oidc-company",
        build: () => async () => {
          throw new Error("network down");
        },
      };
      const authenticate = loadAuth([throwing, knowing("oidc", "t2", "312345")], { env: {}, log: (m) => logs.push(m) })!;

      expect(await authenticate(request("t2"))).toEqual({ id: "312345", provider: "oidc" });
      expect(logs).toEqual([`auth provider "oidc-company" failed on a request, trying the next: network down`]);
    });

    it("refuses a second provider with a name already taken, whose people would share keys", async () => {
      const logs: string[] = [];
      const second = mock(() => async () => null);
      const authenticate = loadAuth([knowing("oidc", "t2", "312345"), { apiVersion: AUTH_API_VERSION, name: "oidc", build: second }], {
        env: {},
        log: (m) => logs.push(m),
      })!;

      expect(await authenticate(request("t2"))).toEqual({ id: "312345", provider: "oidc" });
      expect(second).not.toHaveBeenCalled();
      expect(logs).toEqual([`auth provider "oidc" not activated: another provider already has that name`]);
    });

    it("authenticates nothing (closed) when the list is empty or none of it loads", () => {
      const logs: string[] = [];
      const broken = auth(() => {
        throw new Error("AUTH_STATIC_TOKENS is missing");
      });
      expect(loadAuth([], { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
      expect(loadAuth([broken], { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
      expect(logs).toEqual([`auth provider "static" failed to load: AUTH_STATIC_TOKENS is missing`]);
    });
  });
});
