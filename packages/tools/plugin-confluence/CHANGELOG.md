# @mercury-fw/plugin-confluence

## 0.2.0

### Minor Changes

- bf7b7f3: - Written for plugin contract 7: needs the framework at 0.75.0 or later, the peer range on `@mercury-fw/plugin-types` starts there
  - **Migration:** upgrade the framework to 0.75.0 or later together with these plugins: an older core skips them, and the log says why

## 0.1.0

### Minor Changes

- 96eb1a8: First release: Confluence, read-only, through the pinned `confluence` CLI.

  - Searches pages with Confluence CQL, reads a page as Markdown, lists a page's children and ancestors, reads its comments, and reads spaces; the CLI's commands that create, change or delete pages never run.
  - Acts as the person, logged in through Mercury; on the terminal, as the app's Service Account.
  - Hands search results and a page's children over as typed lists (`ConfluenceDisplays`: `page-list`, `child-pages`) for the app's formatter, with links to the pages.
  - Needs no environment variable: the links come from the CLI.
