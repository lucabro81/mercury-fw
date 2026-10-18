/**
 * Which hosts `web_fetch` may read without asking. An entry is a host name,
 * and it covers itself and its subdomains (`bun.sh` covers `docs.bun.sh`),
 * never a parent or a sibling. No wildcards, no IP addresses, and never a
 * public suffix: `github.io` would let in every site anyone publishes there.
 * The suffixes refused are a short list of the common ones, not the whole
 * Public Suffix List.
 */

/** Suffixes under which anyone can have a site of their own. Every single-label name (`com`, `it`) is one too. */
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "co.jp", "ne.jp", "or.jp",
  "co.in", "co.kr", "com.br", "com.cn", "com.mx", "com.ar", "com.tr", "com.tw", "com.hk", "com.sg",
  "github.io", "gitlab.io", "githubusercontent.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "herokuapp.com", "blogspot.com", "wordpress.com", "web.app", "firebaseapp.com", "appspot.com",
  "glitch.me", "fly.dev", "onrender.com", "ngrok.io", "ngrok-free.app", "azurewebsites.net",
  "cloudfront.net", "s3.amazonaws.com", "neocities.org", "surge.sh", "readthedocs.io",
]);

/** A host name as compared: lowercase, without the trailing dot. */
function normalize(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/** A dotted IPv4 address, or anything with a colon (IPv6, bracketed or not). */
function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/** Reads one allowlist entry: the normalized host, or why it can't be one. */
export function parseHostEntry(entry: string): { ok: true; host: string } | { ok: false; reason: string } {
  const host = normalize(entry.trim());
  if (isIpAddress(host)) return { ok: false, reason: `${host} is an IP address, not a host name` };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return { ok: false, reason: `"${entry}" is not a host name` };
  if (!host.includes(".") || PUBLIC_SUFFIXES.has(host)) {
    return { ok: false, reason: `${host} is a public suffix: it would allow every site under it` };
  }
  return { ok: true, host };
}

/** Whether `host` is one of `entries` or a subdomain of one. */
export function hostAllowed(host: string, entries: readonly string[]): boolean {
  const h = normalize(host);
  return entries.some((e) => h === e || h.endsWith(`.${e}`));
}
