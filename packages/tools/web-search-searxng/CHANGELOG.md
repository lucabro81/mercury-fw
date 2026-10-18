# @mercury-fw/web-search-searxng

## 0.1.0

### Minor Changes

- 79a232e: - New package `@mercury-fw/web-search-searxng`: a SearXNG instance as the web search plugin's backend, through its JSON format.
  - `mfw create --plugins web-search` adds the web search plugin with the SearXNG backend, a `searxng` service in the compose file (on the compose network only), its `searxng/settings.yml` with the JSON format on, and `SEARXNG_URL` and `SEARXNG_SECRET` in the env example.
