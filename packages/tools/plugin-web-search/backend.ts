/**
 * What a search backend does for the plugin, and nothing else: turn a query
 * into results. Each backend is a package of its own (`web-search-searxng`,
 * …) implementing this interface, chosen in the app's config. A backend never
 * reads pages: that's `web_fetch`, which is where the allowlist is enforced.
 * `apiVersion` is checked when the plugin builds: a backend written for
 * another version of this interface is refused, and the plugin contributes
 * nothing.
 */

/** Version of this interface; bumped only on a breaking change to it. */
export const WEB_SEARCH_BACKEND_API_VERSION = 1;

/** One result: what it is, where it is, and the excerpt the engine shows. */
export type SearchResult = { title: string; url: string; snippet: string };

export type WebSearchBackend = {
  apiVersion: number;
  /** What the logs and errors call it (e.g. "searxng"). */
  name: string;
  /** At most `limit` results for `query`; aborts when `signal` does. */
  search(query: string, opts: { limit: number; signal: AbortSignal }): Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }>;
};
