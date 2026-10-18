# @mercury-fw/web-search-searxng

A [SearXNG](https://docs.searxng.org) instance as the search backend of [`@mercury-fw/plugin-web-search`](../plugin-web-search).

SearXNG is a metasearch engine you run yourself: it asks the search engines it's set up for and merges what they answer, so queries need no API key and go nowhere else. The backend calls its `/search` with `format=json` and hands the plugin title, URL and snippet of each result.

```ts
import { webSearchPlugin } from "@mercury-fw/plugin-web-search";
import { searxngBackend } from "@mercury-fw/web-search-searxng";

webSearchPlugin({ backend: searxngBackend({ url: process.env.SEARXNG_URL ?? "http://searxng:8080" }) });
```

## The instance

`mfw create --plugins web-search` sets one up next to the app: a `searxng` service in `docker-compose.yml`, reachable only on the compose network, its settings in `searxng/settings.yml`, and two variables in the env example, `SEARXNG_URL` (already `http://searxng:8080`) and `SEARXNG_SECRET`, which you fill with a long random string (`openssl rand -hex 32`).

An app created before that adds it by hand. The service goes under `services:` in `docker-compose.yml`, with `searxng` in the `mercury` service's `depends_on`:

```yaml
  searxng:
    # SearXNG publishes no major version tags, only latest and dated ones.
    image: searxng/searxng:latest
    restart: unless-stopped
    environment:
      SEARXNG_SECRET: ${SEARXNG_SECRET:-}
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
```

and `searxng/settings.yml` turns the JSON format on (it's off by default, and the backend gets HTTP 403 without it):

```yaml
use_default_settings: true
server:
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
```

The limiter is off because only the app asks, on the compose network. Don't publish the service's port on the host with these settings: anyone reaching it could use it without limits.

An instance of your own somewhere else works the same way, as long as its settings list `json` among the formats: point `SEARXNG_URL` at it.
