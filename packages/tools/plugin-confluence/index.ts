/**
 * The Confluence plugin's public surface — a thin re-export layer, no logic of
 * its own. The plugin's contributions are assembled into a single module
 * object in `plugin.ts` (`confluencePlugin`), which the core's generic loader
 * consumes; the pieces stay exported too, for the tests that exercise them in
 * isolation.
 */
export { confluencePlugin, createConfluencePlugin, confluenceCliConfig } from "./plugin.ts";

export {
  confluencePageListExtractor,
  CONFLUENCE_PAGE_LIST_SELECT,
  CONFLUENCE_CHILD_PAGES_SELECT,
  type ConfluencePageListItem,
  type ConfluenceChildPage,
} from "./page-list-extractor.ts";

import type { ConfluenceChildPage, ConfluencePageListItem } from "./page-list-extractor.ts";

/** Every kind of list this plugin hands to the user on the `display` channel,
 * mapped to the shape of its items — what an instance's formatter rules are
 * keyed and typed by, so a wrong kind in the config doesn't compile. */
export type ConfluenceDisplays = {
  "page-list": ConfluencePageListItem;
  "child-pages": ConfluenceChildPage;
};
