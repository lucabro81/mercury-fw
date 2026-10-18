/**
 * A SearXNG instance as the web search plugin's backend: `GET /search` with
 * `format=json`, each result turned into title, URL and snippet. SearXNG is a
 * metasearch engine you run yourself (`mfw create` puts one next to the app),
 * so queries go to the engines it asks and nowhere else, with no API key.
 * Its JSON format is off by default: the instance's `settings.yml` has to list
 * `json` under `search.formats`.
 *
 * ```ts
 * webSearchPlugin({ backend: searxngBackend({ url: process.env.SEARXNG_URL! }) })
 * ```
 */
import { WEB_SEARCH_BACKEND_API_VERSION, type SearchResult, type WebSearchBackend } from "@mercury-fw/plugin-web-search";

/** One result as SearXNG's JSON has it; only what the plugin uses. */
type RawResult = { title?: unknown; url?: unknown; content?: unknown };

/** The backend for the SearXNG at `url`; `deps.fetch` replaces `fetch`, for tests. */
export function searxngBackend(options: { url: string }, deps: { fetch?: typeof fetch } = {}): WebSearchBackend {
  const fetchFn = deps.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  return {
    apiVersion: WEB_SEARCH_BACKEND_API_VERSION,
    name: "searxng",
    async search(query, { limit, signal }) {
      const params = new URLSearchParams({ q: query, format: "json" });
      let response: Response;
      try {
        response = await fetchFn(`${base}/search?${params}`, { signal, headers: { accept: "application/json" } });
      } catch (err) {
        return { ok: false, error: `SearXNG at ${base} can't be reached: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (response.status === 403) {
        return { ok: false, error: "SearXNG refused the JSON format (HTTP 403): add json to search.formats in its settings.yml" };
      }
      if (!response.ok) return { ok: false, error: `SearXNG answered HTTP ${response.status}` };
      let body: { results?: unknown };
      try {
        body = (await response.json()) as { results?: unknown };
      } catch {
        return { ok: false, error: "SearXNG's answer isn't JSON" };
      }
      const raw = Array.isArray(body.results) ? (body.results as RawResult[]) : [];
      const results: SearchResult[] = raw
        .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
        .slice(0, limit)
        .map((r) => ({
          title: typeof r.title === "string" ? r.title : "",
          url: r.url as string,
          snippet: typeof r.content === "string" ? r.content : "",
        }));
      return { ok: true, results };
    },
  };
}
