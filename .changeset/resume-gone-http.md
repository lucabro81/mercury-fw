---
"@mercury-fw/channel-http": patch
---

- `POST /turn { resume: true }` with nothing left to resume streams a single `final` whose text says the answer is no longer available, instead of an empty one, which a UI shows like any answer; an empty `final` now always means the model had nothing to add.
- Needs the framework at 0.61 or later (peer range raised).
