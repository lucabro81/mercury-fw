---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
---

A turn resumed after a confirmation with nothing left to resume says so instead of ending with an empty answer.

- The core keeps a confirmed action's result for its resumed turn five minutes, and once: later, after a restart, or a second time, the turn now answers "The action was confirmed, but its answer is no longer available: ask me about it again." (`core.resume.gone`), in the person's language, on every channel. The model isn't called and nothing goes into the history.
- An empty answer to a resumed turn now always comes from the model.

An app with language files other than English adds `core.resume.gone` to them (the log lists it as missing at startup).
