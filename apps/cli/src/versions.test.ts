/**
 * The versions a new app's dependency ranges are written against. The
 * framework moves in lockstep, so its packages take the CLI's own version; a
 * plugin or channel is versioned on its own, so its version is the registry's
 * `latest`, asked for only the ones chosen.
 */
import { describe, expect, test } from "bun:test";
import { appVersions, cliVersion, DEFAULT_REGISTRY, FRAMEWORK_PACKAGES, newerCli, registryFrom } from "./versions.ts";
import pkg from "../package.json";

/** A fake registry answering `latest` from `versions`, recording what was asked. */
function fakeRegistry(versions: Record<string, string>) {
  const asked: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    const name = decodeURIComponent(url.replace("https://registry.test/", "").replace(/\/latest$/, ""));
    const version = versions[name];
    return version === undefined ? new Response("not found", { status: 404 }) : Response.json({ name, version });
  };
  return { asked, fetchFn: fetchFn as typeof fetch };
}

describe("cliVersion", () => {
  test("is the CLI's own manifest version", () => {
    expect(cliVersion()).toBe(pkg.version);
  });
});

describe("appVersions", () => {
  test("framework packages take the CLI's version, the chosen plugins and channels the registry's latest", async () => {
    const { asked, fetchFn } = fakeRegistry({
      "@mercury-fw/plugin-jira": "0.3.2",
      "@mercury-fw/channel-http": "0.1.4",
    });
    const versions = await appVersions(["@mercury-fw/plugin-jira", "@mercury-fw/channel-http"], {
      registry: "https://registry.test",
      fetchFn,
    });
    expect(versions).toEqual({
      "@mercury-fw/cli": pkg.version,
      "@mercury-fw/core": pkg.version,
      "@mercury-fw/formatter": pkg.version,
      "@mercury-fw/plugin-jira": "0.3.2",
      "@mercury-fw/channel-http": "0.1.4",
    });
    expect(asked.sort()).toEqual([
      "https://registry.test/@mercury-fw%2Fchannel-http/latest",
      "https://registry.test/@mercury-fw%2Fplugin-jira/latest",
    ]);
  });

  // A package packed locally (`--local-packages`) takes its tarball's version,
  // without asking the registry: a brand-new one isn't there yet.
  test("a package with a local version takes it, framework included, and the registry isn't asked for it", async () => {
    const { asked, fetchFn } = fakeRegistry({ "@mercury-fw/plugin-jira": "0.3.2" });
    const versions = await appVersions(["@mercury-fw/plugin-jira", "@mercury-fw/auth-static"], {
      registry: "https://registry.test",
      fetchFn,
      local: { "@mercury-fw/auth-static": "0.0.0", "@mercury-fw/core": "0.35.0-dev", "@mercury-fw/plugin-bitbucket": "9.9.9" },
    });
    expect(versions).toEqual({
      "@mercury-fw/cli": pkg.version,
      "@mercury-fw/core": "0.35.0-dev",
      "@mercury-fw/formatter": pkg.version,
      "@mercury-fw/plugin-jira": "0.3.2",
      "@mercury-fw/auth-static": "0.0.0",
    });
    expect(asked).toEqual(["https://registry.test/@mercury-fw%2Fplugin-jira/latest"]);
  });

  test("nothing chosen: no request, framework only", async () => {
    const { asked, fetchFn } = fakeRegistry({});
    expect(await appVersions([], { registry: "https://registry.test", fetchFn })).toEqual(
      Object.fromEntries(FRAMEWORK_PACKAGES.map((p) => [p, pkg.version])),
    );
    expect(asked).toEqual([]);
  });

  test("a trailing slash on the registry is fine", async () => {
    const { asked, fetchFn } = fakeRegistry({ "@mercury-fw/plugin-jira": "1.0.0" });
    await appVersions(["@mercury-fw/plugin-jira"], { registry: "https://registry.test/", fetchFn });
    expect(asked).toEqual(["https://registry.test/@mercury-fw%2Fplugin-jira/latest"]);
  });

  test("a package the registry doesn't have is an error naming it and the registry", async () => {
    const { fetchFn } = fakeRegistry({});
    await expect(
      appVersions(["@mercury-fw/plugin-jira"], { registry: "https://registry.test", fetchFn }),
    ).rejects.toThrow("@mercury-fw/plugin-jira is not on https://registry.test");
  });

  // Regression: a 200 without a usable version wrote "^undefined" into the app.
  test("an answer without a version is an error naming the package", async () => {
    const fetchFn = (async () => Response.json({ name: "x" })) as unknown as typeof fetch;
    await expect(
      appVersions(["@mercury-fw/plugin-jira"], { registry: "https://registry.test", fetchFn }),
    ).rejects.toThrow("@mercury-fw/plugin-jira");
    const notJson = (async () => new Response("<html>")) as unknown as typeof fetch;
    await expect(
      appVersions(["@mercury-fw/plugin-jira"], { registry: "https://registry.test", fetchFn: notJson }),
    ).rejects.toThrow("@mercury-fw/plugin-jira");
  });

  // Regression: an empty MFW_REGISTRY was taken as a registry and every lookup
  // failed; empty means the default.
  test("registryFrom: empty or unset is the default registry", () => {
    expect(registryFrom(undefined)).toBe(DEFAULT_REGISTRY);
    expect(registryFrom("")).toBe(DEFAULT_REGISTRY);
    expect(registryFrom("  ")).toBe(DEFAULT_REGISTRY);
    expect(registryFrom("http://localhost:4873")).toBe("http://localhost:4873");
  });

  test("an unreachable registry is an error that says so", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      appVersions(["@mercury-fw/plugin-jira"], { registry: "https://registry.test", fetchFn }),
    ).rejects.toThrow("Can't reach https://registry.test");
  });
});

// #96: `bun create mercury-agent` can run a stale CLI out of Bun's bunx
// cache; the CLI asks the registry whether it's behind before creating.
describe("newerCli", () => {
  const opts = (versions: Record<string, string>) => ({ registry: "https://registry.test", ...fakeRegistry(versions) });

  test("the registry's latest @mercury-fw/cli, when it's newer than this CLI", async () => {
    const o = opts({ "@mercury-fw/cli": "999.0.0" });
    expect(await newerCli(o)).toBe("999.0.0");
    expect(o.asked).toEqual(["https://registry.test/@mercury-fw%2Fcli/latest"]);
  });

  test("nothing when the registry has this CLI's version", async () => {
    expect(await newerCli(opts({ "@mercury-fw/cli": pkg.version }))).toBeUndefined();
  });

  test("nothing when the registry is behind this CLI (run from source, or unreleased)", async () => {
    expect(await newerCli(opts({ "@mercury-fw/cli": "0.0.1" }))).toBeUndefined();
  });

  test("compares as versions, not as text: 0.10.0 is newer than 0.9.9", async () => {
    // Guards against a string comparison, where "0.10.0" < "0.9.9".
    const { fetchFn } = fakeRegistry({ "@mercury-fw/cli": "0.10.0" });
    expect(await newerCli({ registry: "https://registry.test", fetchFn, current: "0.9.9" })).toBe("0.10.0");
  });

  test("a registry that doesn't answer in time is an error too, instead of a hung create", async () => {
    // Guards against a blackholed network hanging `create` before its warning.
    const silent = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await expect(newerCli({ registry: "https://registry.test", fetchFn: silent, timeoutMs: 50 })).rejects.toThrow(
      "Can't reach https://registry.test",
    );
  });

  test("an answer without a version is an error naming the package", async () => {
    const fetchFn = (async () => Response.json({ name: "@mercury-fw/cli" })) as unknown as typeof fetch;
    await expect(newerCli({ registry: "https://registry.test", fetchFn })).rejects.toThrow("gave no version for @mercury-fw/cli");
  });

  test("an unreachable registry or an unusable answer is an error, for the caller to turn into a warning", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(newerCli({ registry: "https://registry.test", fetchFn: down })).rejects.toThrow("Can't reach https://registry.test");
    await expect(newerCli(opts({}))).rejects.toThrow("@mercury-fw/cli is not on https://registry.test");
  });
});
