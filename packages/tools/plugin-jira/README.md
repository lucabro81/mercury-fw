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

The CLI keeps its login under `~/.config/jira-cli`, and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. Mercury runs as an Atlassian Service Account, created by an org admin in admin.atlassian.com (Directory → Service accounts, an OAuth 2.0 credential with the `read:jira-work`, `read:jira-user`, `write:jira-work` scopes; the [jira CLI's README](https://github.com/lucabro81/CLI-monorepo/tree/main/crates/jira#setup) has the steps). Set it up inside the app's container, pasting the credential's client id and secret when the CLI asks:

```bash
mfw credentials setup @mercury-fw/plugin-jira
mfw credentials check @mercury-fw/plugin-jira
```

Coming from a version before 0.5.0: the CLI is now 2.x, which keeps the Service Account and each person apart and refuses the old login folder, so the env file's `JIRA_CLI_CONFIG_TAR_B64` isn't read any more. Remove it, then run the setup above once.

MIT
