/**
 * The channels, auth providers and tool plugins `mfw create` can put in a new app. Written
 * by hand for now: once the packages are published, each plugin will describe
 * itself (kind, export, env vars) and this list goes away. `catalog.test.ts`
 * checks every entry against the real package until then.
 */

/** One environment variable an entry reads, as it appears in the app's env
 * example: `value` is the example value, empty when the deployer must fill it. */
export type EnvVar = { name: string; comment: string; value?: string };

/** A channel, auth provider or tool plugin the app can include. `id` is the
 * plugin's own `name` (what the logs and `dependsOn` call it), `exportName` the
 * value the app's config imports from `package`. An auth provider goes with the
 * HTTP channel, which doesn't start without one. */
export type CatalogEntry = {
  id: string;
  kind: "channel" | "auth" | "tool";
  package: string;
  exportName: string;
  env: EnvVar[];
  formatter?: FormatterExample;
  /** Dependencies whose install scripts Bun must run for this entry (Bun runs
   * none it isn't told to trust), on top of a tool plugin's own package. */
  trusts?: string[];
};

/** Starting formatter rules for a plugin that hands the user lists: without a
 * rule a kind of list isn't shown, so the scaffolded config wraps the plugin
 * with these. `displaysType` is the type the plugin exports for its kinds,
 * `helpers` the code the rules use (written above the config), `rules` the
 * `kind: rule` lines. Once written, they're the app's to change. */
export type FormatterExample = { displaysType: string; helpers: string; rules: string[] };

export const CATALOG: CatalogEntry[] = [
  {
    id: "google-chat",
    kind: "channel",
    package: "@mercury-fw/channel-google-chat",
    exportName: "googleChatChannel",
    // Pulled in by @google-cloud/pubsub; its postinstall only checks how
    // dependents spell its version range.
    trusts: ["protobufjs"],
    env: [
      {
        name: "GOOGLE_CHAT_PUBSUB_SUBSCRIPTION",
        comment: "Pub/Sub subscription the Chat app's events arrive on (projects/<p>/subscriptions/<s>); empty leaves Google Chat inert",
      },
      { name: "GOOGLE_CHAT_APP_CLIENT_EMAIL", comment: "Service account the Chat app authenticates as" },
      { name: "GOOGLE_CHAT_APP_PRIVATE_KEY", comment: "That service account's private key (PEM)" },
    ],
  },
  {
    id: "http",
    kind: "channel",
    package: "@mercury-fw/channel-http",
    exportName: "httpChannel",
    env: [
      { name: "HTTP_SURFACE_PORT", comment: "Port of the HTTP surface", value: "4100" },
      { name: "HTTP_SURFACE_CORS_ORIGIN", comment: "Origin allowed to call the HTTP surface from a browser, if any" },
      { name: "HTTP_SURFACE_PUBLIC_URL", comment: "Address people's browsers reach the HTTP surface at, for logging in to the services plugins act on as them" },
    ],
  },
  {
    id: "oidc",
    kind: "auth",
    package: "@mercury-fw/auth-oidc",
    exportName: "oidcAuth",
    env: [
      { name: "OIDC_ISSUER", comment: "Required: the OpenID Connect issuer's URL, as tokens carry it in iss (https://<instance>.zitadel.cloud)" },
      { name: "OIDC_AUDIENCE", comment: "Required: the client id the UI calling the HTTP surface is registered with on the issuer (tokens carry it in aud)" },
    ],
  },
  {
    id: "static",
    kind: "auth",
    package: "@mercury-fw/auth-static",
    exportName: "staticAuth",
    env: [
      {
        name: "AUTH_STATIC_TOKENS",
        comment: 'Required: JSON from bearer token to user, test tokens only: {"<token>": {"id": "alice", "displayName": "Alice"}}',
      },
    ],
  },
  {
    id: "jira",
    kind: "tool",
    package: "@mercury-fw/plugin-jira",
    exportName: "jiraPlugin",
    env: [{ name: "JIRA_SITE_URL", comment: "Required: the Jira site the issue links point to (https://<site>.atlassian.net)" }],
    formatter: {
      displaysType: "JiraDisplays",
      helpers: [
        "/** One Jira issue in a search result: key, status in brackets when there is",
        " * one, summary, and the browse link on its own line. A starting point: change",
        " * it to change how Jira lists read. */",
        'const jiraIssueLine = (issue: JiraDisplays["issue-list"]) =>',
        '  `${issue.key} ${issue.status ? `[${issue.status}] ` : ""}${issue.summary}\\n${issue.url}`;',
      ].join("\n"),
      rules: ['"issue-list": { item: jiraIssueLine, empty: "No matching issues." },'],
    },
  },
  {
    id: "bitbucket",
    kind: "tool",
    package: "@mercury-fw/plugin-bitbucket",
    exportName: "bitbucketPlugin",
    env: [],
  },
  {
    id: "atlassian-admin",
    kind: "tool",
    package: "@mercury-fw/plugin-atlassian-admin",
    exportName: "atlassianAdminPlugin",
    env: [],
  },
  {
    id: "zitadel",
    kind: "tool",
    package: "@mercury-fw/plugin-zitadel",
    exportName: "zitadelPlugin",
    env: [],
  },
];

/** The catalog entry of `kind` with `id`, or undefined when there is none. */
export function findEntry(kind: CatalogEntry["kind"], id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.kind === kind && e.id === id);
}
