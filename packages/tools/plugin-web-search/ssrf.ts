/**
 * Keeps `web_fetch` off everything that isn't the public internet: Mercury
 * runs next to services that answer anyone on their network (Qdrant, the
 * model's endpoint, a cloud's metadata address), and a URL the model writes
 * must never reach them. A URL passes only when it's http or https, carries no
 * credentials, and its host resolves only to public addresses; the reader
 * checks again at every redirect. What it can't stop is a host that resolves
 * to a public address here and to an internal one a moment later, when the
 * page is downloaded (DNS rebinding): Bun's `fetch` takes no resolved address.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a host name to its addresses. */
export type Resolve = (host: string) => Promise<string[]>;

/** The system resolver, every address of the host. */
export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** The four octets of a dotted IPv4 address, or null. */
function ipv4Octets(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map(Number);
}

/** Whether a valid IPv4 address is on the public internet. */
function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // unspecified, private, loopback
  if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a! >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** The eight 16-bit groups of a valid IPv6 address (an embedded IPv4 tail included). */
function ipv6Groups(ip: string): number[] {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split(".").map(Number);
    text = `${text.slice(0, tail.index)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = parse(rest);
  const zeros = rest === undefined ? [] : new Array(8 - front.length - back.length).fill(0);
  return [...front, ...zeros, ...back];
}

/** Whether a valid IPv6 address is on the public internet. */
function isPublicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  const [g0, , , , , g5, g6, g7] = g;
  const v4 = [g6! >> 8, g6! & 0xff, g7! >> 8, g7! & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) return isPublicIpv4(v4); // IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return false; // unspecified, loopback, IPv4-compatible
  if (g0 === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIpv4(v4); // NAT64
  if (g0 === 0x2002) return isPublicIpv4([g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, g[2]! & 0xff]); // 6to4
  if (g0 === 0x2001 && g[1] === 0) return false; // Teredo
  if (g0 === 0x100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard
  if ((g0! & 0xffc0) === 0xfec0) return false; // site-local
  if ((g0! & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0! & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0! & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g[1] === 0xdb8) return false; // documentation
  return true;
}

/** Whether `ip` is an address on the public internet; anything that isn't an IP address is not. */
export function isPublicAddress(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (octets) return isPublicIpv4(octets);
  if (isIP(ip) === 6) return isPublicIpv6(ip);
  return false;
}

/** A URL's host as an address or name, without IPv6 brackets. */
const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

/**
 * What can be checked of `raw` without asking DNS: http or https, no
 * credentials, and no internal IP address written in it. Used before the
 * person is asked about a host: looking a name up already tells its DNS
 * server about it, and a host name can carry data.
 */
export function checkSyntax(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `not a URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "only http and https pages can be read" };
  if (url.username !== "" || url.password !== "") return { ok: false, error: "a URL with a user name or password can't be read" };
  const host = bareHost(url);
  if (isIP(host) !== 0 && !isPublicAddress(host)) return { ok: false, error: `${host} is not a public address: internal hosts can't be read` };
  return { ok: true, url };
}

/** Checks that `raw` is a URL `web_fetch` may download (see the module comment). */
export async function checkUrl(raw: string, resolve: Resolve): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  const syntax = checkSyntax(raw);
  if (!syntax.ok) return syntax;
  const url = syntax.url;
  const host = bareHost(url);
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) return { ok: false, error: `${host} doesn't resolve` };
  }
  if (!addresses.every(isPublicAddress)) return { ok: false, error: `${host} is not a public address: internal hosts can't be read` };
  return { ok: true, url };
}
