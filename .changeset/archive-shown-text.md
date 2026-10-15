---
"@mercury-fw/core": patch
"@mercury-fw/channel-http": patch
---

- A reopened conversation shows the lists a turn showed: the verbatim archive keeps them next to the model's answer, and `GET /conversation` and the conversation list serve each answer as the person saw it.
- A turn whose answer is only a shown list is archived too.
- What goes back to the model (resuming a conversation, `recall_verbatim`) is still the model's own answer only.
