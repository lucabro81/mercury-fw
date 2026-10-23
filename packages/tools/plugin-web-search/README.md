# @mercury-fw/plugin-web-search

Lets the assistant search the web and read the pages it finds, reading a page only on a host someone allowed.

On Mercury's documentation site: [its page](https://lucabro81.github.io/mercury-fw/plugins/plugin-web-search/).

## Using it

The plugin doesn't search by itself: it takes a backend, a package of its own that turns a query into results ([`@mercury-fw/web-search-searxng`](../web-search-searxng) for a SearXNG instance, the one `mfw create` sets up next to the app).

```ts
import { webSearchPlugin } from "@mercury-fw/plugin-web-search";
import { searxngBackend } from "@mercury-fw/web-search-searxng";

export default defineMercuryConfig({
  plugins: [
    webSearchPlugin({
      backend: searxngBackend({ url: process.env.SEARXNG_URL || "http://searxng:8080" }),
      allowedHosts: ["bun.sh", "developer.mozilla.org"],
    }),
  ],
});
```

The model gets two tools. `web_search` returns title, URL and snippet of each result, and `web_fetch` reads a page and returns its title and text (the main content, found by Readability; menus, footers and scripts are left out). An answer built on pages ends with a `Sources:` list of what was read, written by the plugin and not by the model, so it can't be left out or made up; a list the model writes at the end of its answer anyway is replaced by it (a title is the site's text, so it shows up cut at 120 characters and stripped of links and formatting).

The model is told to search when the question shows it needs to, not when it feels unsure: something that changes over time (news, versions, prices, who holds a role), something recent compared with the date on the message (the core stamps every turn with it, framework 0.56 or later), a precise detail it would otherwise guess, a name it doesn't recognize, or a request to look something up; lasting facts, reasoning and writing need no search.

The plugin acts as no one (`actsAs: "anyone"`): there's no login, everyone gets it, and `access.plugins` in the config restricts it to some roles like any other plugin. This version is written for version 6 of the plugin contract, the one that asks every plugin for a description of what it does, and needs the framework at 0.55 or later: an older core skips it, and the log says why.

What the person reads in the plugin's own words comes out in their language: the two choices ("Only this time", "Always for \<host\>"), the `Sources:` heading and the status lines while a tool runs ("Searching the web", "Reading \<host\>"). They're English in the plugin, under `web-search.` keys an app translates in its language files (see the core's [languages](https://github.com/lucabro81/mercury-fw/blob/main/apps/docs/src/content/docs/concepts/languages.md)):

| Key | English |
|---|---|
| `web-search.status.search` | `Searching the web: "{query}"` |
| `web-search.status.read` | `Reading {host}` |
| `web-search.status.read-page` | `Reading a page` |
| `web-search.choice.once` | `Only this time` |
| `web-search.choice.always` | `Always for {host}` |
| `web-search.sources.status` | `Adding the sources…` |
| `web-search.sources.heading` | `Sources` |

A list of sources the model writes under the heading in the person's language, or under the English one, is replaced by the plugin's.

## Which pages it reads

A page is read right away only when its host is allowed, by the instance (`allowedHosts`) or by the person asking. An entry is a host name and covers its subdomains, so `bun.sh` covers `docs.bun.sh` but neither `python.org` nor `evilbun.sh`. An entry that is an IP address, a URL or a public suffix (`com`, `co.uk`, `github.io`, which would let in every site under it) is dropped when the plugin loads, and the log says why. The suffixes it knows are the common ones, not the whole Public Suffix List, so don't put a hosting provider's shared domain in `allowedHosts`.

For any other host the plugin asks the person, through the same confirmation Mercury uses for irreversible actions (a button per choice on Google Chat, a token per choice on the terminal and over HTTP):

- **Only this time** reads that page and nothing else;
- **Always for \<host\>** adds the host to the person's own list, then reads the page (the host stays on the list even if that read fails: the person allowed the host, not the page).

Either way the page goes back to the model, which answers on it in the same conversation. A person's list is theirs alone (nobody else's reads change), and it lives in the plugin's folder on the vault's volume, so it survives a restart; with a core that gives the plugin no folder, only the first choice is offered.

The list is one JSON file per person, `<vault>/.mercury/plugins/web-search/allowlist/<user key>.json`, the user key URL-encoded (`google-chat:users/42` becomes `google-chat%3Ausers%2F42.json`), holding `{ "hosts": [...] }`. No command lists or edits it yet ([#259](https://github.com/lucabro81/mercury-fw/issues/259)): to take a host back, open a shell in the container (`mfw shell`) and edit the file, whose folder is under `WIKI_VAULT_PATH`. A file the plugin can't read as a list is copied aside (`<file>.corrupt-<time>-<id>`) before the next host replaces it, so a hand edit gone wrong loses nothing.

Why not let the model read anything it finds? Because Mercury also reads private data (Jira, the wiki), and a page can carry instructions for the model: an open `web_fetch` would let a hostile page make it send that data out inside a URL. Asking the person for every new host closes that, and the allowlist keeps it from getting in the way on the sites a team actually uses.

A host nobody allowed isn't even looked up in DNS before the person answers: a host name can carry data, and its DNS server would hear it. Some addresses are never read, allowlist or not: anything that isn't http or https, a URL with credentials in it, and every host that resolves to a loopback, private, link-local or otherwise internal address (the app's own Qdrant, the model's endpoint, a cloud's metadata address). The check runs on the first URL and again on every redirect, and a redirect to a host that isn't allowed stops the read. It can't catch a host that resolves to a public address at the check and to an internal one a moment later, when the page downloads (DNS rebinding), since Bun's `fetch` takes no resolved address. A proxy set for the container (`HTTP_PROXY`, `HTTPS_PROXY`) resolves names itself, past this check, so don't give the app one unless it enforces the same rules. Allowing a host, even for one page, means trusting whoever runs it: when the app's network holds something that must stay unreachable whatever happens, block the container's outgoing traffic to it at the network level as well.

## Limits

A read downloads at most 2 MB and gives up after 15 seconds, redirects included; extracting the text runs in a worker of its own and gives up after 5 seconds, so a page built to make the parser crawl never holds up the rest of Mercury (it bounds time, not memory, though: the worker shares the process's heap), and the model gets at most 20,000 characters of text (the result says when it was cut). Only HTML and plain text are read. No JavaScript runs, so a page that builds its content in the browser comes back nearly empty.

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
