---
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/store-qdrant": minor
"@mercury-fw/cli": minor
---

- vector-index contract: `VectorIndexPlugin`, `VectorIndex`, `VectorPoint`, `VectorSpaceSpec`, `VectorWhere`, `VECTOR_INDEX_API_VERSION`
- `vectorIndex` in `mercury.config.ts`: where episodes, semantic facts, procedural corrections and `recall_verbatim`'s search are kept
- **Breaking:** without `vectorIndex` there is no long-term memory: no conversation summaries, no corrections, no `recall_verbatim` (tool and prompt), idle conversations closed without a summary
- new package `@mercury-fw/store-qdrant`: `qdrantIndex()`, Qdrant at `QDRANT_URL`, each space the collection of the same name or the one its `QDRANT_*_COLLECTION` names
- the memory's vector length comes from the embedding model at startup; `QDRANT_*_VECTOR_SIZE` no longer read
- `GET /memory/scroll` (HTTP) takes the index's space name (`episodic_memory`, `semantic_facts`, `verbatim_archive`), not the `QDRANT_*_COLLECTION` name; without `vectorIndex` it answers `400`
- `system.start` trace event: `vectorIndex` (`declared`, `active`)
- `mfw memory` runs the memory CLI of `@mercury-fw/store-qdrant`
- `mfw create`: new apps declare `vectorIndex: qdrantIndex()` and depend on `@mercury-fw/store-qdrant`
- **Migration:** add `@mercury-fw/store-qdrant` to the app's dependencies, at the framework's version; in `mercury.config.ts`, `import { qdrantIndex } from "@mercury-fw/store-qdrant";` and `vectorIndex: qdrantIndex(),`; `QDRANT_*_VECTOR_SIZE` can go from `.env`
