---
"@mercury-fw/core": minor
---

The conversation history keeps the tool calls each answer was written from: for each call, what it ran and how it went (whether it worked, how many items it found, the list it built, the error), never the data it returned. On later turns the model gets them back as its own tool calls, so it no longer reads its past answers as written from memory, and it's told to run the tool again for the data. With only the answers' text, the model called tools less and less as a conversation went on, and answered with invented data instead.
A conversation reopened over HTTP brings the calls back too, from the archive; the reads that show a conversation leave them out (the raw reads of the verbatim archive show them, as a `calls` field next to `displays`), and messages archived before this version come back as text, as they did.
