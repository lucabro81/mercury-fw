/**
 * Runs `extractText` off the main thread: parsing a hostile page can take
 * as long as it likes here, and `fetch-page.ts` terminates this worker when
 * it does, so Mercury's other turns never wait on it.
 */
import { extractText } from "./extract.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ body: string; contentType: string; url: string; maxChars: number }>) => {
  const { body, contentType, url, maxChars } = event.data;
  try {
    self.postMessage({ ok: true, page: extractText(body, contentType, url, maxChars) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
