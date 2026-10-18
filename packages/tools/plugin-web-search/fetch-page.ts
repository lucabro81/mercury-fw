/**
 * Downloads one page for `web_fetch`. Redirects are followed by hand, so every
 * hop goes through the same checks as the first URL: a public address only
 * (`ssrf.ts`) and a host the caller allows, so a page on an allowed host can't
 * bounce the reader somewhere it wasn't let. Only HTML and plain text are
 * read; the download stops at `maxBytes` and gives up after `timeoutMs`.
 */
import { checkUrl, type Resolve } from "./ssrf.ts";
import { extractText } from "./extract.ts";

export type ReadPageDeps = {
  fetch: typeof fetch;
  resolve: Resolve;
  /** Whether a host may be read: checked for the first URL and every redirect. */
  allowed: (host: string) => boolean;
  maxBytes: number;
  maxChars: number;
  timeoutMs: number;
  maxRedirects: number;
};

export type ReadPageResult =
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; error: string };

const PAGE_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

/** Reads `response`'s body up to `maxBytes`, and whether it had more. */
async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      cut = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, cut };
}

/** The charset a content type names, if the decoder knows it; UTF-8 otherwise. */
function decoderFor(contentType: string): TextDecoder {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim();
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]);
  } catch {
    return new TextDecoder("utf-8");
  }
}

/** Downloads `rawUrl` (see the module comment) and returns its title and text. */
export async function readPage(rawUrl: string, deps: ReadPageDeps): Promise<ReadPageResult> {
  let current = rawUrl;
  for (let hop = 0; hop <= deps.maxRedirects; hop++) {
    const checked = await checkUrl(current, deps.resolve);
    if (!checked.ok) return checked;
    const host = checked.url.hostname;
    if (!deps.allowed(host)) {
      return { ok: false, error: hop === 0 ? `${host} isn't allowed` : `the page redirects to ${host}, which isn't allowed` };
    }

    let response: Response;
    try {
      response = await deps.fetch(checked.url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(deps.timeoutMs),
        headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
      });
    } catch (err) {
      return { ok: false, error: `the page couldn't be downloaded: ${err instanceof Error ? err.message : String(err)}` };
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, checked.url).href;
      continue;
    }
    if (!response.ok) return { ok: false, error: `the page answered HTTP ${response.status}` };

    const contentType = response.headers.get("content-type") ?? "";
    if (!PAGE_TYPES.test(contentType)) return { ok: false, error: `not a page: ${contentType.split(";")[0] || "unknown type"}` };

    let body: { bytes: Uint8Array; cut: boolean };
    try {
      body = await readCapped(response, deps.maxBytes);
    } catch (err) {
      return { ok: false, error: `the page couldn't be downloaded: ${err instanceof Error ? err.message : String(err)}` };
    }
    const page = extractText(decoderFor(contentType).decode(body.bytes), contentType, checked.url.href, deps.maxChars);
    return { ok: true, url: checked.url.href, title: page.title, text: page.text, truncated: page.truncated || body.cut };
  }
  return { ok: false, error: "too many redirects" };
}
