# @mercury-fw/web-search-searxng

## 0.1.1

### Patch Changes

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.

## 0.1.0

### Minor Changes

- 79a232e: - New package `@mercury-fw/web-search-searxng`: a SearXNG instance as the web search plugin's backend, through its JSON format.
  - `mfw create --plugins web-search` adds the web search plugin with the SearXNG backend, a `searxng` service in the compose file (on the compose network only), its `searxng/settings.yml` with the JSON format on, and `SEARXNG_URL` and `SEARXNG_SECRET` in the env example.
