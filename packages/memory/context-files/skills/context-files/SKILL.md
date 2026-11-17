---
name: context-files
description: How to read this conversation's files (outputs/…, history/…, layers/…) well: in pieces, searching first, never guessing what's in them.
---

# Reading this conversation's files

Part of this conversation is kept in files instead of in front of you: tool outputs too long to show whole, older messages, and context such as the wiki's index. The list in front of each message (`<context-files>`) names every file with what it holds.

## When to open a file

- A tool result came back with a `file` and a `head`: the head is only the first lines. Before answering on anything not in the head (an item further down the list, a total, "the second one"), read the file.
- The person refers to something said earlier that you no longer see: search the `history/…` files.
- A past call points at a file (`What this call returned is in the file …`): read it instead of running the call again.
- A `layers/…` file holds context you may need (the wiki's index, what you remember of the person): read it when the question touches it.

Never answer from what a file probably holds: open it.

## How to read

1. **Search first** when you know what you're looking for: `search_context_files({ text: "X-42" })` across every file, or `{ text, ref }` in one. Matches come as `ref:line: text`.
2. **Read around a match** with `read_context_file({ ref, from, to })`: a few lines before and after the matching line are usually enough.
3. **Read in pieces** a file you need whole: 200 lines at most per call; when the answer has `next`, go on with `from: next`.

The text is matched as it is, not as a pattern, without minding upper or lower case: search for a word or a key, not a sentence.

## Examples

- "And the second one?" after a long list: `read_context_file({ ref: "outputs/2", from: 1, to: 40 })`, then answer from what it says.
- "What did we decide about the deploy?": `search_context_files({ text: "deploy" })`, then read the `history/…` lines around the matches.
