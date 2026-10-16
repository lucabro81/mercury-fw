---
"@mercury-fw/core": patch
---

- A new conversation on a channel where the person opens and reopens conversations (the HTTP surface) no longer starts with a recap of their last one: nothing from another conversation comes in unless they ask.
- On a channel with one running stream (Google Chat), the recap of the last conversation reaches the model as background in its prompt, framed as possibly out of date. It used to arrive as the model's own message, which made it pick that thread back up, and the next summary saved it again.
- Episodic summaries keep what was asked and decided, not the data a tool returned.
