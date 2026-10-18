# @mercury-fw/plugin-web-search

Lets the assistant search the web and read the pages it finds, reading a page only on a host someone allowed.

## Using it

The plugin doesn't search by itself: it takes a backend, a package of its own that turns a query into results ([`@mercury-fw/web-search-searxng`](../web-search-searxng) for a SearXNG instance, the one `mfw create` sets up next to the app).

```ts
import { webSearchPlugin } from "@mercury-fw/plugin-web-search";
import { searxngBackend } from "@mercury-fw/web-search-searxng";

export default defineMercuryConfig({
  plugins: [
    webSearchPlugin({
      backend: searxngBackend({ url: process.env.SEARXNG_URL! }),
      allowedHosts: ["bun.sh", "developer.mozilla.org"],
    }),
  ],
});
```

The model gets two tools. `web_search` returns title, URL and snippet of each result, and `web_fetch` reads a page and returns its title and text (the main content, found by Readability; menus, footers and scripts are left out). An answer built on pages ends with a `Fonti:` list of what was read, written by the plugin and not by the model, so it can't be left out or made up.

The plugin acts as no one (`actsAs: "anyone"`): there's no login, everyone gets it, and `access.plugins` in the config restricts it to some roles like any other plugin.

## Which pages it reads

A page is read right away only when its host is allowed, by the instance (`allowedHosts`) or by the person asking. An entry is a host name and covers its subdomains, so `bun.sh` covers `docs.bun.sh` but neither `python.org` nor `evilbun.sh`. An entry that is an IP address, a URL or a public suffix (`com`, `co.uk`, `github.io`, which would let in every site under it) is dropped when the plugin loads, and the log says why.

For any other host the plugin asks the person, through the same confirmation Mercury uses for irreversible actions (a button per choice on Google Chat, a token per choice on the terminal and over HTTP):

- **Solo questa volta** reads that page and nothing else;
- **Sempre per \<host\>** adds the host to the person's own list, then reads the page.

Either way the page goes back to the model, which answers on it in the same conversation. A person's list is theirs alone (nobody else's reads change), and it lives in the plugin's folder on the vault's volume, so it survives a restart; with a core that gives the plugin no folder, only the first choice is offered.

Why not let the model read anything it finds? Because Mercury also reads private data (Jira, the wiki), and a page can carry instructions for the model: an open `web_fetch` would let a hostile page make it send that data out inside a URL. Asking the person for every new host closes that, and the allowlist keeps it from getting in the way on the sites a team actually uses.

Some addresses are never read, allowlist or not: anything that isn't http or https, a URL with credentials in it, and every host that resolves to a loopback, private, link-local or otherwise internal address (the app's own Qdrant, the model's endpoint, a cloud's metadata address). The check runs on the first URL and again on every redirect, and a redirect to a host that isn't allowed stops the read. It can't catch a host that resolves to a public address at the check and to an internal one a moment later, when the page downloads (DNS rebinding), since Bun's `fetch` takes no resolved address.

## Limits

A read downloads at most 2 MB and gives up after 15 seconds, and the model gets at most 20,000 characters of text (the result says when it was cut). Only HTML and plain text are read. No JavaScript runs, so a page that builds its content in the browser comes back nearly empty.

## Writing a backend

A backend implements `WebSearchBackend` and nothing else:

```ts
import { WEB_SEARCH_BACKEND_API_VERSION, type WebSearchBackend } from "@mercury-fw/plugin-web-search";

export const myBackend = (apiKey: string): WebSearchBackend => ({
  apiVersion: WEB_SEARCH_BACKEND_API_VERSION,
  name: "my-engine",
  async search(query, { limit, signal }) {
    // call the engine, honoring limit and signal
    return { ok: true, results: [{ title, url, snippet }] };
  },
});
```

It never reads pages, even when its engine could return their content: reading goes through `web_fetch`, which is where the allowlist holds. The plugin checks `apiVersion` when it loads, and refuses a backend written for another version of the interface (no tools, a line in the log).
