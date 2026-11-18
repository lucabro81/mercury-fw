---
name: __NAME__
description: How to list the items of __TITLE__ and delete one. Load it before using the __SNAKE___list and __SNAKE___delete tools.
---

# __TITLE__

- Find an item with `__SNAKE___list`: it gives each item's id and title. Never guess an id.
- Delete one with `__SNAKE___delete`, passing the id from the list. The deletion waits for the person's confirmation: tell them it's staged, and never mention the token.
- When a tool answers `ok: false`, tell the person what failed in plain words, and don't call it again the same way.

## Examples

- "What's on the list?": call `__SNAKE___list`, answer with the titles.
- "Delete the one about the printer": call `__SNAKE___list`, take the item whose title says so, call `__SNAKE___delete` with its id.
