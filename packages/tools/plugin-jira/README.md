# @mercury-fw/plugin-jira

Gives a [Mercury](https://github.com/lucabro81/mercury-fw) agent Jira, through the `jira` CLI: searching with JQL, reading an issue and its transitions, finding people and projects, creating issues, moving and assigning them, commenting (mentions included), and deleting one (only after the user confirms it with the token Mercury hands back). The pinned `jira` binary downloads when the package installs, so nothing else needs installing.

```bash
bun add @mercury-fw/plugin-jira
```

An app scaffolded with it already has all of this. By hand:

- list it in `trustedDependencies` in the app's `package.json`, or Bun skips the install script that downloads the binary;
- set `JIRA_SITE_URL` (`https://<site>.atlassian.net`), which the issue links in search results point to. It's required: without it the plugin doesn't load, and the log says so at startup.

The plugin hands search results over as a typed list (`JiraDisplays["issue-list"]`: key, summary, status, url), and the app decides how it reads with [`@mercury-fw/formatter`](https://www.npmjs.com/package/@mercury-fw/formatter):

```ts
import { formatterPlugin, formatter } from "@mercury-fw/formatter";
import { jiraPlugin, type JiraDisplays } from "@mercury-fw/plugin-jira";

const jiraIssueLine = (issue: JiraDisplays["issue-list"]) =>
  `${issue.key} ${issue.status ? `[${issue.status}] ` : ""}${issue.summary}\n${issue.url}`;

// in mercury.config.ts
plugins: [
  formatterPlugin(jiraPlugin, formatter<JiraDisplays>({
    "issue-list": { item: jiraIssueLine, empty: "No matching issues." },
  })),
],
```

## Credentials

The plugin acts as the person: every command runs with the Jira account of whoever Mercury is talking to, so they see and change exactly what that account can, and `currentUser()` in JQL is them. On the terminal (`mfw repl`) there's no person, and commands run as the app's Service Account.

The CLI keeps every login under `~/.config/jira-cli` (one folder per person, next to the Service Account's), and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. Two things are set up once, inside the app's container, pasting each credential's client id and secret when the CLI asks (the [jira CLI's README](https://github.com/lucabro81/CLI-monorepo/tree/main/crates/jira#setup) has the steps on Atlassian's side):

- the **Service Account**, created by an org admin in admin.atlassian.com (Directory → Service accounts, an OAuth 2.0 credential with the `read:jira-work`, `read:jira-user`, `write:jira-work` scopes): what the terminal runs as;
- the **3LO app** people log in through, from developer.atlassian.com (Resource-level, the same scopes, sharing enabled under Distribution), with `<HTTP_SURFACE_PUBLIC_URL>/login/callback` among its callback URLs.

```bash
mfw credentials setup @mercury-fw/plugin-jira
mfw credentials setup @mercury-fw/plugin-jira --user-app
mfw credentials check @mercury-fw/plugin-jira
```

People log in on their own: the first time someone asks for something in Jira, Mercury answers that they need to log in, and the [HTTP channel](../../channels/channel-http) shows them the link (it needs `HTTP_SURFACE_PUBLIC_URL`). After the consent they're sent back to Mercury and ask again; Mercury never falls back to the Service Account for them.

Coming from a version before 0.5.0: the CLI is now 2.x, which keeps the Service Account and each person apart and refuses the old login folder, so the env file's `JIRA_CLI_CONFIG_TAR_B64` isn't read any more. Remove it, then run the setup above once.

MIT
