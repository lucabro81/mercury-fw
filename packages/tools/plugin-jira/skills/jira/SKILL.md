---
name: jira
description: Query and act on Jira issues via the jiraCommand tool — JQL searches, single issues, create/transition/assign/comment, finding users and projects, and the delete-confirmation contract. Load this before running any jira command.
---

You have access to the jiraCommand tool, which runs the `jira` CLI: reading issues, users and projects, and writing via issue create/transition/assign/comment.

HOW THE CLI PRINTS (read this first):
- `issue search`, `issue get`, `issue transitions`, `user search` and `project search` REQUIRE `--select`: without it the CLI refuses to print and reports the response's top-level fields instead. `--fields` does not replace it.
- `--select` takes comma-separated dot-notation paths from the root of the response; arrays are projected element by element, so `issues.key` gives every issue's key.
- A list of issues — always start from exactly this, adding paths only for fields the question needs:
  `jira issue search --jql "project = KAN AND statusCategory != Done" --select issues.key,issues.fields.summary,issues.fields.status.name,nextPageToken`
  Extra fields go under `issues.fields.` (e.g. `issues.fields.assignee.displayName`, `issues.fields.duedate`, `issues.fields.priority.name`).
- One issue: `jira issue get KAN-4 --select key,fields.summary,fields.status.name,fields.assignee.displayName,browse_url`
- Transitions available for an issue: `jira issue transitions KAN-4 --select transitions.id,transitions.name`
- A person: `jira user search --query "Jane Doe" --select accountId,displayName` (the result is a top-level array, so paths start inside its elements; a wrong path prints `[{}]`). The `accountId` is what assigning and mentioning need. Filtering in JQL doesn't: the display name works there (`assignee = "Jane Doe"`).
- A project: `jira project search --query support --select values.key,values.name` (a fragment of its name or key).
- Counting: `--max-results 100 --select issues.key,nextPageToken`. When the result carries `issueCount`, that is the number of issues on this page: use it, never count the keys yourself. If `nextPageToken` is present, there are more: repeat with `--page-token <that value>` and add up each page's `issueCount`.
- `--select-all` prints everything and is refused above a size cap: use it only for a single small response, never for a search.

DO:
- Call jiraCommand with `command` set to the exact command line you would type in a terminal — quote values containing spaces, exactly like a real shell.
- Use jiraCommand to get real data — never invent ticket data.
- Use --help on a subcommand if you're unsure of its other flags.
- Use native JQL syntax for relative dates (e.g. now()) — don't compute dates yourself.
- Every jiraCommand runs as the person you're talking to, with their own Jira account: they see and change exactly what that account can, and `currentUser()` in JQL is them (`assignee = currentUser()` for "my issues"). For anyone else, use their name (e.g. `assignee = 'Jane Doe'`).
- If a result says the user isn't logged in to Jira yet, tell them to log in with the link shown to them and ask again afterwards. Never write a login link yourself, and don't retry the command until they're back.
- When issue search succeeds with the list select above, its result carries a `displayRef` — a handle to the deterministic formatted list Mercury built for you. To show that list to the user, call the `present` tool with that ref; Mercury then appends the list to your reply. Don't write the issues out yourself, in any form.
- Only call `present` when the user actually wants to SEE the list. If they only asked something about the results (how many are open, whether a given ticket exists, a single field), just answer in plain text and DON'T call present. If you have something worth adding alongside the list, keep it short and reference issues by key.
- If issue search's result has a formattedListNote instead of a displayRef, your `--select` left out a path the list needs: if the user wants the list, rerun the same search with the list select above.
- If the user refers to a project by an informal name (e.g. "the monorepo") rather than its JQL project key, grep the wiki for that name first: a note may map it to a key. If nothing comes up, use project search with a fragment of the name. When you learn a key this way (from the search or from the user), add it to the wiki note that already maps project names, or write one if there is none, so it's there next time.
- To assign an issue: find the person's accountId with user search, then `jira issue assign KAN-4 --assignee <accountId>` (`--unassign` clears it). If the search returns more than one person, ask the user which one.
- To mention someone in a comment, with their accountId: `--mention <accountId>` tags them at the start, `{{mention:<accountId>}}` inside `--body` tags them at that point of the text.
- If a call is rejected, errors, or returns an empty result that seems suspicious given the question, call jiraCommand again, in this same turn, with a corrected command before giving your final answer.
- If the user's free-text value (e.g. a status name) comes back with no results, retry with at least one likely real wording (e.g. "todo" → "To Do") before concluding there's no data.
- For a follow-up that needs the data again, decide between recall and re-query:
  - RECALL (recall_tool_calls) when the question is about the answer you already gave in THIS conversation — "what were those tickets?", "the link of the first one", "what did you search?".
  - RE-QUERY (run issue search again) when the answer must reflect the CURRENT state, or the earlier snapshot lacks the fields/scope now needed (more select paths, a narrower filter). Filter by re-querying, never by manipulating an old result.
  - When in doubt, RE-QUERY — it's a sub-second call and always fresh.
- issue create/transition/assign/comment run immediately, no confirmation needed — tell the user what you did (e.g. the new issue's key) after it succeeds.
- issue delete is irreversible: jiraCommand won't execute it directly. Instead you'll get back a `token` and a `pendingConfirmation` result — you have no role in confirming it: the channel shows the user its own confirmation UI and handles the token entirely on its own. Just tell the user the action is staged and awaiting their confirmation. Never mention the token value in your reply, in any form.

DON'T:
- DON'T just say you'll retry and stop there — an empty/rejected/suspicious result means retry for real, not just talk about it.
- DON'T describe a command you're about to run as your entire response — call jiraCommand in this same turn before replying.
- DON'T treat a bare `{}` (or `[{}]` from user search) as "no matching issues": it means a `--select` path doesn't exist in the response. No matches looks like `{"issues": []}`. On `{}`, rerun with the list select above (or, for issue get, with paths from the top-level fields the CLI reported).
- DON'T hand-format a list of Jira issues yourself from raw JSON — call present with the displayRef instead.
- DON'T add analysis, commentary, or recommendations on top of a plain list the user asked for — only if they explicitly asked for it.
