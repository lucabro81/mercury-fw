---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/cli": minor
"@mercury-fw/channel-http": minor
---

- A conversation reopened on the HTTP surface after Mercury freed its history comes back to the model: the summaries of its older part plus its newest messages from the archive, within a budget.
- What a resumed conversation brings back isn't captured to long-term memory again, only the new messages are.
- `SESSION_RESUME_MAX_CHARS` sets how much comes back (default 30000, `0` turns it off); `HTTP_SURFACE_RESUME_MAX_CHARS` sets it for the HTTP surface only.
- `InboundTurn.resume` lets a channel mark a conversation its client reopens.
- The episodic collection gets a `sessionKey` index.
- `mfw create` lists `HTTP_SURFACE_RESUME_MAX_CHARS` for the HTTP channel.
- Core's README explains how Mercury remembers a conversation.
