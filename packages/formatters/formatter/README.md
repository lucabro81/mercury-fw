# @mercury-fw/formatter

Turns the lists a [Mercury](https://github.com/lucabro81/mercury-fw) plugin hands the user into text, applying rules the app writes in its own config. It holds no format of its own: without a rule, a kind of list isn't shown (the model still gets the data, and the log says which rule is missing).

```ts
import { formatterPlugin, formatter } from "@mercury-fw/formatter";
import { jiraPlugin, type JiraDisplays } from "@mercury-fw/plugin-jira";

const jiraIssueLine = (issue: JiraDisplays["issue-list"]) =>
  `${issue.key} ${issue.status ? `[${issue.status}] ` : ""}${issue.summary}\n${issue.url}`;

export default defineMercuryConfig({
  plugins: [
    formatterPlugin(
      jiraPlugin,
      formatter<JiraDisplays>({
        "issue-list": { item: jiraIssueLine, empty: "No matching issues." },
      }),
    ),
  ],
});
```

- `formatter<D>(rules)` takes one rule per kind of list, keyed by the kinds the plugin declares (`D`, e.g. `JiraDisplays`), so a kind it doesn't emit or a rule for the wrong item shape fails the typecheck. A rule is the line for each item, or `{ item, empty }` when an empty list needs a text of its own. Items are joined with a blank line. A rule also gets `t`, the texts of the person the turn is for, as its second argument (`(issue, t) => …`), and `empty` can be a function of it (`(t) => t("app.jira.no-issues")`, the key in the app's `locales/en.json` and its other language files), so an app that speaks several languages writes its lists in each person's.
- `formatterPlugin(plugin, handler)` wraps a plugin so every list it hands over goes through the rules; everything else the plugin contributes passes through untouched.

MIT
