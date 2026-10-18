import { describe, expect, it } from "bun:test";
import { WEB_SEARCH_BACKEND_API_VERSION } from "@mercury-fw/plugin-web-search";
import { searxngBackend } from "./index.ts";

/** A fake SearXNG answering every request with `respond`; requests are recorded. */
function engine(respond: () => Response) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    requested.push(String(input));
    return respond();
  }) as unknown as typeof fetch;
  return { fetchFn, requested };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = new AbortController().signal;

describe("searxngBackend", () => {
  it("speaks the plugin's backend interface", () => {
    const backend = searxngBackend({ url: "http://searxng:8080" });
    expect(backend.apiVersion).toBe(WEB_SEARCH_BACKEND_API_VERSION);
    expect(backend.name).toBe("searxng");
  });

  it("asks /search for JSON, with the query encoded", async () => {
    const { fetchFn, requested } = engine(json({ results: [] }));
    await searxngBackend({ url: "http://searxng:8080/" }, { fetch: fetchFn }).search("bun 2 & co", { limit: 5, signal });
    expect(requested).toEqual(["http://searxng:8080/search?q=bun+2+%26+co&format=json"]);
  });

  it("maps results to title, URL and snippet, at most limit of them", async () => {
    const { fetchFn } = engine(
      json({
        results: [
          { title: "Bun 2", url: "https://bun.sh/blog/bun-2", content: "Bun 2 is out", engine: "duckduckgo" },
          { title: "Docs", url: "https://bun.sh/docs" },
          { title: "Third", url: "https://bun.sh/3", content: "c" },
        ],
      }),
    );
    const found = await searxngBackend({ url: "http://s" }, { fetch: fetchFn }).search("bun", { limit: 2, signal });
    expect(found).toEqual({
      ok: true,
      results: [
        { title: "Bun 2", url: "https://bun.sh/blog/bun-2", snippet: "Bun 2 is out" },
        { title: "Docs", url: "https://bun.sh/docs", snippet: "" },
      ],
    });
  });

  it("skips a result without a URL, and one whose URL isn't http or https", async () => {
    const { fetchFn } = engine(json({ results: [{ title: "x" }, { title: "y", url: "javascript:alert(1)" }, { title: "ok", url: "https://a.test/" }] }));
    const found = await searxngBackend({ url: "http://s" }, { fetch: fetchFn }).search("q", { limit: 10, signal });
    expect(found).toEqual({ ok: true, results: [{ title: "ok", url: "https://a.test/", snippet: "" }] });
  });

  it("says what to change when the instance refuses JSON", async () => {
    const { fetchFn } = engine(() => new Response("Forbidden", { status: 403 }));
    expect(await searxngBackend({ url: "http://s" }, { fetch: fetchFn }).search("q", { limit: 5, signal })).toEqual({
      ok: false,
      error: "SearXNG refused the JSON format (HTTP 403): add json to search.formats in its settings.yml",
    });
  });

  it("reports another HTTP error, an unreachable instance and an answer that isn't JSON", async () => {
    expect(await searxngBackend({ url: "http://s" }, { fetch: engine(() => new Response("x", { status: 502 })).fetchFn }).search("q", { limit: 5, signal })).toEqual({
      ok: false,
      error: "SearXNG answered HTTP 502",
    });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await searxngBackend({ url: "http://s" }, { fetch: down }).search("q", { limit: 5, signal })).toEqual({
      ok: false,
      error: "SearXNG at http://s can't be reached: ECONNREFUSED",
    });
    expect(await searxngBackend({ url: "http://s" }, { fetch: engine(() => new Response("<html>")).fetchFn }).search("q", { limit: 5, signal })).toEqual({
      ok: false,
      error: "SearXNG's answer isn't JSON",
    });
  });
});
