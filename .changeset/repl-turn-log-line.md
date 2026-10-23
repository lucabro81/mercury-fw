---
"@mercury-fw/core": patch
---

`mfw repl`: the turn's log line (`[turn] done …`) starts on a line of its own instead of landing glued to the end of the answer. The terminal ends the answer's line once the answer is final, and doesn't end it a second time before the prompt, a display or an error. A turn that fails or stalls halfway through an answer still logs right after the partial text.
