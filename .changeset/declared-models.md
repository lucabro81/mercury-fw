---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/kit": minor
"@mercury-fw/cli": minor
---

- `ollamaModel(name, settings?)` and `ollamaEmbedding(name, { capacity }?)` declare a model; `capacity`, how many requests its server answers at once, 1 when left out
- `models` in `mercury.config.ts`: `turn` (required), `background` (titles, memory captures, corrections, nightly review; the turn's when left out), `embedding`
- a `vectorIndex` without `models.embedding` stops the start
- `ctx.modelFor(handle)` in a plugin's `build()`: the model of a handle the plugin was given in its configuration
- `system.start` carries `models` (each role's name and capacity) instead of `model` and `modelSettings`
- the startup log names each role's model
- `mfw create`: the config declares `main` from `OLLAMA_MODEL` and its settings, and `models` with `turn` and `embedding`; `OLLAMA_CAPACITY` in the env example
- **Breaking:** `model` is gone from `mercury.config.ts`, and the core no longer reads `OLLAMA_MODEL` or `OLLAMA_EMBEDDING_MODEL`: declare the models in `models`
- **Migration:** in `mercury.config.ts`, import `ollamaEmbedding` and `ollamaModel` from `@mercury-fw/core`, add above the config `const main = ollamaModel(process.env.OLLAMA_MODEL, { think: envBoolean("OLLAMA_THINK", true), temperature: envNumber("OLLAMA_TEMPERATURE"), topP: envNumber("OLLAMA_TOP_P"), topK: envNumber("OLLAMA_TOP_K"), capacity: envNumber("OLLAMA_CAPACITY") });`, and replace the `model: { ... }` section with `models: { turn: main, embedding: ollamaEmbedding(process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text") },`; `OLLAMA_CAPACITY` is optional
