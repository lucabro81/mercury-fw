---
name: confluence
description: Search and read Confluence via the confluenceCommand tool — Confluence CQL searches, reading a page as Markdown, browsing a space through its pages' children, a page's place in the tree, its comments. Load this before running any confluence command.
---

You have access to the confluenceCommand tool, which runs the `confluence` CLI, read-only: searching pages, reading a page, its children, its ancestors and its comments, and spaces. It can't create, change or delete anything.

HOW THE CLI PRINTS (read this first):
- Every command but `space get` REQUIRES `--select`: without it the CLI refuses to print and reports the response's top-level fields instead.
- `--select` takes comma-separated dot-notation paths from the root of the response; arrays are projected element by element, so `results.content.title` gives every result's title.
- A search — always start from exactly this:
  `confluence page search --cql 'type = page AND text ~ "deploy"' --select results.content.id,results.content.title,results.content.type,results.resultGlobalContainer.title,results.excerpt,results.link,totalSize`
- One page, its body as Markdown: `confluence page get 123456 --select title,body.markdown.value,link`
- A page's children: `confluence page children 123456 --select results.id,results.title,results.type,results.link,nextCursor`
- Where a page sits, from the space's root down to its parent: `confluence page ancestors 123456 --select results.id,results.title,results.link`
- A page's comments: `confluence page comments 123456 --select results.version.authorId,results.version.createdAt,results.body.markdown.value,nextCursor`
- A space from its key, with the id of its root page (`homepageId`): `confluence space get ENG`
- The spaces there are: `confluence space list --select results.key,results.name,results.homepageId,nextCursor`
- Paging: a search returns `totalSize`, the number of matches; for the next page repeat it with `--start <previous start + limit>` (`--limit`, 25 by default). Children, comments and spaces return `nextCursor` while there's more: repeat with `--cursor <that value>`. A search result carries `pageCount`, the pages listed in this page of results: use it, never count them yourself.

WRITING Confluence CQL (the query language of page search):
- `type = page` for pages only; without it a search also returns attachments and other content.
- `text ~ "words"` searches the content, `title ~ "words"` the title only.
- Always quote a space key: `space = "ENG"`. Some keys are reserved words of Confluence CQL (`IN`, `AND`, `OR`…) and fail unquoted.
- `ancestor = 123456` limits a search to the pages under that page.
- Dates: `lastmodified >= now("-7d")`; use the language's own functions, don't compute dates yourself.
- Combine with `AND`, `OR`, `NOT` and parentheses; quote every value that has spaces.

DO:
- Call confluenceCommand with `command` set to the exact command line you would type in a terminal, quoting values that contain spaces, exactly like a real shell.
- Use confluenceCommand to get real data — never invent page content, titles or links.
- Use --help on a subcommand if you're unsure of its other flags.
- Every confluenceCommand runs as the person you're talking to, with their own Confluence account: they see exactly what that account can.
- If a result says the user isn't logged in to Confluence yet, tell them to log in with the link shown to them and ask again afterwards. Never write a login link yourself, and don't retry the command until they're back.
- To answer from documentation: search, read the most relevant page or two with page get, and answer from what they say, giving the page's `link` (in the search result and in page get).
- To explore a space: `space get <KEY>` for its `homepageId`, then `page children` from there, one level at a time.
- When a search or a page's children succeed with the selects above, the result carries a `displayRef` — a handle to the formatted list the system built for you. To show that list to the user, call the `present` tool with that ref; the system then appends the list to your reply. Don't write the pages out yourself, in any form.
- Only call `present` when the user actually wants to SEE the list. If they asked something about the results, answer in plain text and DON'T call present.
- If the user wants to see a list again in a later turn, present its ref from "Lists already shown" when it's there; for up-to-date data, or when it isn't, run the same command again and present the new displayRef. Never retype a list from memory.
- If a search's or children's result has a formattedListNote instead of a displayRef, your `--select` left out a path the list needs: if the user wants the list, rerun the same command with the select above.
- If a search comes back empty, retry at least once with other likely words (a synonym, the other language the team writes in, a shorter phrase) before concluding there's nothing.
- If a call is rejected or errors, call confluenceCommand again, in this same turn, with a corrected command before giving your final answer.

DON'T:
- DON'T just say you'll search and stop there — call confluenceCommand in this same turn before replying.
- DON'T treat a bare `{}` as "nothing found": it means a `--select` path doesn't exist in the response. Nothing found looks like `{"results": []}`.
- DON'T paste a whole page into your reply: answer the question, quoting only what's needed, and give the link.
- DON'T hand-format a list of pages yourself from raw JSON — call present with the displayRef instead.
