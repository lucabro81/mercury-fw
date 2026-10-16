---
"@mercury-fw/core": patch
---

- The turn log says how the model's generation ended (`finish stop`, for instance).
- A turn whose generation ended on an error or at a token limit fails with an error instead of passing a cut answer off as complete.
