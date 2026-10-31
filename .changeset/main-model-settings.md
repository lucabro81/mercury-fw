---
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
---

- add `model` to `mercury.config.ts`: `think`, `temperature`, `topP`, `topK` for the main model, every call on it; a field left out uses the model's own value
- export `envNumber` and `envBoolean`: a config field's value from an environment variable, with a fallback
- the startup log names the model and its settings (`[model] <name>: think on, temperature 0.2`)
- `mfw create`: new apps declare `model` from `OLLAMA_THINK`, `OLLAMA_TEMPERATURE`, `OLLAMA_TOP_P`, `OLLAMA_TOP_K`, listed empty in the env example
- **Breaking:** the core no longer reads `OLLAMA_THINK`: set `model.think` in the config
- **Migration:** add to `mercury.config.ts` `import { envBoolean, envNumber } from "@mercury-fw/core";` and `model: { think: envBoolean("OLLAMA_THINK", true), temperature: envNumber("OLLAMA_TEMPERATURE"), topP: envNumber("OLLAMA_TOP_P"), topK: envNumber("OLLAMA_TOP_K") },`; add `OLLAMA_TEMPERATURE=`, `OLLAMA_TOP_P=`, `OLLAMA_TOP_K=` to the env example
