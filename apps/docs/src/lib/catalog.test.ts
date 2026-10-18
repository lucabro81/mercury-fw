import { describe, expect, test } from "bun:test";
import { catalogIndex, type CatalogSource } from "./catalog.ts";

const entries: CatalogSource[] = [
  {
    id: "http",
    kind: "channel",
    package: "@mercury-fw/channel-http",
    env: [
      { name: "HTTP_SURFACE_PORT", comment: "Port of the HTTP surface", value: "4100" },
      { name: "HTTP_SURFACE_CORS_ORIGIN", comment: "Origin allowed to call the HTTP surface from a browser, if any" },
    ],
  },
  {
    id: "zitadel",
    kind: "tool",
    package: "@mercury-fw/plugin-zitadel",
    env: [{ name: "ZITADEL_URL", comment: "Required: the ZITADEL instance" }],
  },
  {
    id: "zitadel",
    kind: "directory",
    package: "@mercury-fw/plugin-zitadel",
    env: [
      { name: "ZITADEL_URL", comment: "Required: the ZITADEL instance" },
      { name: "ZITADEL_PROJECT_ID", comment: "Required: the project whose roles count" },
    ],
  },
  {
    id: "web-search",
    kind: "tool",
    package: "@mercury-fw/plugin-web-search",
    env: [],
  },
];

const versions = {
  "@mercury-fw/channel-http": "0.10.1",
  "@mercury-fw/plugin-zitadel": "0.3.2",
  "@mercury-fw/plugin-web-search": "0.0.0",
};

describe("catalogIndex", () => {
  test("one row per package, ordered by kind then name, with its page slug", () => {
    const rows = catalogIndex(entries, versions);
    expect(rows.map((r) => [r.package, r.slug])).toEqual([
      ["@mercury-fw/channel-http", "channel-http"],
      ["@mercury-fw/plugin-web-search", "plugin-web-search"],
      ["@mercury-fw/plugin-zitadel", "plugin-zitadel"],
    ]);
  });

  test("a package offered in two roles lists both kinds and each variable once", () => {
    const zitadel = catalogIndex(entries, versions).find((r) => r.slug === "plugin-zitadel");
    expect(zitadel?.kinds).toEqual(["tool", "directory"]);
    expect(zitadel?.env.map((e) => e.name)).toEqual(["ZITADEL_URL", "ZITADEL_PROJECT_ID"]);
  });

  test("a 'Required:' comment marks the variable required and is stripped from its text", () => {
    const zitadel = catalogIndex(entries, versions).find((r) => r.slug === "plugin-zitadel");
    expect(zitadel?.env[0]).toEqual({ name: "ZITADEL_URL", description: "the ZITADEL instance", required: true });
    const http = catalogIndex(entries, versions).find((r) => r.slug === "channel-http");
    expect(http?.env[0]).toEqual({ name: "HTTP_SURFACE_PORT", description: "Port of the HTTP surface", required: false, example: "4100" });
  });

  test("a package never published shows no version", () => {
    const rows = catalogIndex(entries, versions);
    expect(rows.find((r) => r.slug === "plugin-web-search")?.version).toBeNull();
    expect(rows.find((r) => r.slug === "channel-http")?.version).toBe("0.10.1");
  });

  test("a package missing from the versions map fails loudly instead of showing a wrong page", () => {
    expect(() => catalogIndex(entries, { "@mercury-fw/channel-http": "0.10.1" })).toThrow("@mercury-fw/plugin-zitadel");
  });
});
