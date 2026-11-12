# @mercury-fw/trace-jsonl

## 0.73.0

### Patch Changes

- 4a00b0c: - **Breaking:** new required `MERCURY_DATA_PATH`, the folder for Mercury's own state (account links, profiles, plugins' `dataDir`, traces, `trace-secret`), no longer in the vault's `.mercury/`; the start stops without it
  - first start with an empty data folder copies the vault's `.mercury/` into it, leaving the original in place; a failed copy is undone and stops the start
  - `system.migrated` trace event when that copy happens
  - `mfw identity` reads the links from `MERCURY_DATA_PATH`
  - `mfw reset wiki` no longer deletes links, profiles and traces
  - `mfw reset data` deletes the `mercury-data` volume
  - `mfw create`: new apps get a `mercury-data` volume mounted at `/app/data` and `MERCURY_DATA_PATH=/app/data`
  - **Migration:** in `Dockerfile`, add `/app/data` to the `mkdir -p` and the `chown mercury:mercury` of the volumes' mount points; in `docker-compose.yml`, add `- mercury-data:/app/data` to the `mercury` service's `volumes` and `mercury-data:` with `name: <app>_mercury-data` under the top-level `volumes`; in `.env`, add `MERCURY_DATA_PATH=/app/data`; then `mfw start`
- Updated dependencies [fb1f30a]
- Updated dependencies [b634bd1]
  - @mercury-fw/channel-types@0.73.0

## 0.72.0

### Minor Changes

- 468cb12: - new package: `jsonlTraces({ keepDays? })`, a trace sink writing a JSONL file per day in `.mercury/traces/`, keeping the last `keepDays` days with activity (7 by default)

### Patch Changes

- Updated dependencies [468cb12]
  - @mercury-fw/channel-types@0.72.0
