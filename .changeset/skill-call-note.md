---
"@mercury-fw/core": minor
---

A skill the model read in an earlier turn of the conversation is no longer taken for loaded: the history keeps the `read_skill` call but not the skill's text, and that call now tells the model to read the skill again before using its tools. With the generic note of the other calls, the model rarely read a skill again in later turns and guessed the commands it names instead.
