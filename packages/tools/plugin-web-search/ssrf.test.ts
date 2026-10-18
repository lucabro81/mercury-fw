import { describe, expect, it } from "bun:test";
import { checkUrl, isPublicAddress } from "./ssrf.ts";

describe("isPublicAddress", () => {
  it("accepts public IPv4 and IPv6 addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
      expect(isPublicAddress(ip)).toBe(true);
    }
  });

  it("refuses loopback, private, link-local, carrier-grade NAT, unspecified, multicast and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.0.1", "198.18.0.1",
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("keeps the edges of the private ranges straight", () => {
    expect(isPublicAddress("172.15.255.255")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("100.63.255.255")).toBe(true);
    expect(isPublicAddress("100.128.0.1")).toBe(true);
  });

  it("refuses loopback, unspecified, unique-local, link-local and multicast IPv6, and IPv4 inside IPv6", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("refuses what isn't an IP address at all", () => {
    expect(isPublicAddress("localhost")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
  });
});

describe("checkUrl", () => {
  const resolveTo = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it("accepts an http or https URL whose host resolves only to public addresses", async () => {
    const resolve = resolveTo({ "bun.sh": ["104.18.0.1", "2606:4700::1"] });
    expect(await checkUrl("https://bun.sh/docs", resolve)).toEqual({ ok: true, url: new URL("https://bun.sh/docs") });
  });

  it("refuses any other scheme", async () => {
    for (const url of ["file:///etc/passwd", "ftp://bun.sh/", "data:text/html,hi", "javascript:alert(1)"]) {
      expect(await checkUrl(url, resolveTo({}))).toEqual({ ok: false, error: "only http and https pages can be read" });
    }
  });

  it("refuses what isn't a URL", async () => {
    expect(await checkUrl("bun.sh/docs", resolveTo({}))).toEqual({ ok: false, error: "not a URL: bun.sh/docs" });
  });

  it("refuses credentials in the URL", async () => {
    expect(await checkUrl("https://user:pw@bun.sh/", resolveTo({ "bun.sh": ["104.18.0.1"] }))).toEqual({
      ok: false,
      error: "a URL with a user name or password can't be read",
    });
  });

  it("refuses a host that resolves to an internal address, even when only one of its addresses is", async () => {
    const resolve = resolveTo({ qdrant: ["172.18.0.3"], mixed: ["104.18.0.1", "10.0.0.5"] });
    expect(await checkUrl("http://qdrant:6333/collections", resolve)).toEqual({
      ok: false,
      error: "qdrant is not a public address: internal hosts can't be read",
    });
    expect((await checkUrl("http://mixed/", resolve)).ok).toBe(false);
  });

  it("refuses an IP literal that is internal, without resolving anything", async () => {
    let resolved = false;
    const resolve = async () => {
      resolved = true;
      return [];
    };
    expect((await checkUrl("http://169.254.169.254/latest/meta-data", resolve)).ok).toBe(false);
    expect((await checkUrl("http://[::1]:8080/", resolve)).ok).toBe(false);
    // The URL parser reads these as 127.0.0.1.
    expect((await checkUrl("http://2130706433/", resolve)).ok).toBe(false);
    expect((await checkUrl("http://0x7f.1/", resolve)).ok).toBe(false);
    expect(resolved).toBe(false);
  });

  it("refuses a host that doesn't resolve, or whose lookup fails", async () => {
    expect(await checkUrl("https://nowhere.example/", resolveTo({}))).toEqual({ ok: false, error: "nowhere.example doesn't resolve" });
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkUrl("https://nowhere.example/", failing)).toEqual({ ok: false, error: "nowhere.example doesn't resolve" });
  });
});
