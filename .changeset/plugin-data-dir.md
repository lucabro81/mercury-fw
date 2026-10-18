---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
---

- A plugin gets a folder of its own on the vault's volume, `PluginRuntimeContext.dataDir` (`<vault>/.mercury/plugins/<name>/`), created by the core before `build()`: data it keeps there survives a restart, and never reaches the model or the wiki.
- A plugin whose name isn't a safe folder name, or whose folder can't be created, gets none (the core logs why) and loads anyway.
