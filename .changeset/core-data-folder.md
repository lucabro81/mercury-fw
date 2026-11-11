---
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
"@mercury-fw/plugin-types": patch
"@mercury-fw/trace-jsonl": patch
"@mercury-fw/plugin-web-search": patch
---

- **Breaking:** new required `MERCURY_DATA_PATH`, the folder for Mercury's own state (account links, profiles, plugins' `dataDir`, traces, `trace-secret`), no longer in the vault's `.mercury/`; the start stops without it
- first start with an empty data folder copies the vault's `.mercury/` into it, leaving the original in place; a failed copy is undone and stops the start
- `system.migrated` trace event when that copy happens
- `mfw identity` reads the links from `MERCURY_DATA_PATH`
- `mfw reset wiki` no longer deletes links, profiles and traces
- `mfw reset data` deletes the `mercury-data` volume
- `mfw create`: new apps get a `mercury-data` volume mounted at `/app/data` and `MERCURY_DATA_PATH=/app/data`
- **Migration:** in `Dockerfile`, add `/app/data` to the `mkdir -p` and the `chown mercury:mercury` of the volumes' mount points; in `docker-compose.yml`, add `- mercury-data:/app/data` to the `mercury` service's `volumes` and `mercury-data:` with `name: <app>_mercury-data` under the top-level `volumes`; in `.env`, add `MERCURY_DATA_PATH=/app/data`; then `mfw start`
