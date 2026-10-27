# @mercury-fw/plugin-confluence

Gives a [Mercury](https://github.com/lucabro81/mercury-fw) agent read access to Confluence, through the `confluence` CLI: searching pages with Confluence CQL, reading a page as Markdown, browsing a space through its pages' children, finding where a page sits, and reading its comments. It's read-only, so the CLI's commands that create, change or delete pages never run. The pinned `confluence` binary downloads when the package installs, so nothing else needs installing. This version is written for version 6 of the plugin contract and needs the framework at 0.55 or later: an older core skips it, and the log says why.

On Mercury's documentation site: [its page](https://lucabro81.github.io/mercury-fw/plugins/plugin-confluence/).

```bash
bun add @mercury-fw/plugin-confluence
```

An app scaffolded with it already has all of this. By hand, list it in `trustedDependencies` in the app's `package.json`, or Bun skips the install script that downloads the binary. There's no environment variable to set: the links in its lists come from the CLI, which knows the site each login belongs to.

The plugin hands two kinds of list over, typed (`ConfluenceDisplays`): a search's pages (`"page-list"`: id, title, space, excerpt, url) and a page's children (`"child-pages"`: id, title, type, url, where type tells a page from a folder or a whiteboard and url is null for anything but a page). The app decides how they read with [`@mercury-fw/formatter`](https://www.npmjs.com/package/@mercury-fw/formatter):

```ts
import { formatterPlugin, formatter } from "@mercury-fw/formatter";
import { confluencePlugin, type ConfluenceDisplays } from "@mercury-fw/plugin-confluence";

const confluencePageLine = (page: ConfluenceDisplays["page-list"]) =>
  `${page.title}${page.space ? ` (${page.space})` : ""}${page.url ? `\n${page.url}` : ""}`;
const confluenceChildLine = (child: ConfluenceDisplays["child-pages"]) =>
  `${child.title}${child.type && child.type !== "page" ? ` [${child.type}]` : ""}${child.url ? `\n${child.url}` : ""}`;

// in mercury.config.ts
plugins: [
  formatterPlugin(confluencePlugin, formatter<ConfluenceDisplays>({
    "page-list": { item: confluencePageLine, empty: (t) => t("app.confluence.no-pages") },
    "child-pages": { item: confluenceChildLine, empty: (t) => t("app.confluence.no-children") },
  })),
],
```

`app.confluence.no-pages` and `app.confluence.no-children` are the app's own texts, in `locales/en.json` (`"No matching pages."` and `"This page has no child pages."` in an app created with Confluence; add them yourself when adding the plugin to an existing app) and translated in its other language files; `empty` can also be a plain string.

## Credentials

The plugin acts as the person: every command runs with the Confluence account of whoever Mercury is talking to, so they see exactly what that account can. On the terminal (`mfw repl`) there's no person, and commands run as the app's Service Account.

The CLI keeps every login under `~/.config/confluence-cli` (one folder per person, next to the Service Account's), and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. Two things are set up once, inside the app's container, pasting each credential's client id and secret when the CLI asks (the [confluence CLI's README](https://github.com/lucabro81/CLI-monorepo/tree/main/crates/confluence#setup) has the steps on Atlassian's side):

- the **Service Account**, created by an org admin in admin.atlassian.com (Directory → Service accounts, an OAuth 2.0 credential for Confluence; Atlassian's guide: [Create OAuth 2.0 credential for service accounts](https://support.atlassian.com/user-management/docs/create-oauth-2-0-credential-for-service-accounts/)): what the terminal runs as;
- the **3LO app** people log in through, from developer.atlassian.com (Resource-level, sharing enabled under Distribution), with `<HTTP_SURFACE_PUBLIC_URL>/login/callback` among its callback URLs; Atlassian's guide: [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/).

Both need the scopes the CLI asks for when it logs in, the same list on either side: `read:confluence-user`, `search:confluence`, `read:confluence-content.summary`, `write:confluence-content` (classic), and `read:page:confluence`, `write:page:confluence`, `read:space:confluence`, `read:hierarchical-content:confluence`, `read:content.metadata:confluence`, `read:comment:confluence` (granular). The two `write:` scopes are there because the CLI can write too; the plugin never runs those commands, but a login that lacks them is refused.

```bash
mfw credentials setup @mercury-fw/plugin-confluence
mfw credentials setup @mercury-fw/plugin-confluence --user-app
mfw credentials check @mercury-fw/plugin-confluence
```

People log in on their own: the first time someone asks for something in Confluence, Mercury answers that they need to log in, and the [HTTP channel](../../channels/channel-http) shows them the link (it needs `HTTP_SURFACE_PUBLIC_URL`). After the consent they're sent back to Mercury and ask again; Mercury never falls back to the Service Account for them.

MIT
