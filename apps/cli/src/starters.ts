/**
 * The starters `mfw create` offers: an agent set up for a task, built from
 * the catalog's plugins, a role for the persona, an e2e test checking the
 * agent does the task with the app's real model, and a section of the app's
 * README saying what it does and how to set it up. Written by hand, like the
 * catalog; `starters.test.ts` keeps them in step with it.
 */
import jiraAssistantE2e from "../template/starters/jira-assistant.e2e.ts.tpl" with { type: "text" };
import knowledgeBaseE2e from "../template/starters/knowledge-base.e2e.ts.tpl" with { type: "text" };
import webResearcherE2e from "../template/starters/web-researcher.e2e.ts.tpl" with { type: "text" };

export type Starter = {
  id: string;
  title: string;
  /** One line, for the wizard and `mfw create --help`. */
  summary: string;
  /** Completes "You are <name>, …" in the persona. */
  role: string;
  /** Catalog tool plugin ids. */
  plugins: string[];
  /** `e2e/<id>.e2e.ts` in the app. */
  e2e: string;
  /** A section of the app's README, starting with its title. */
  readme: string;
};

export const STARTERS: Starter[] = [
  {
    id: "knowledge-base",
    title: "Team knowledge base",
    summary: "answers from the team's Confluence and wiki, naming the pages it used",
    role: "the team's knowledge assistant: you answer from the team's Confluence and wiki, and name the pages you used",
    plugins: ["confluence"],
    e2e: knowledgeBaseE2e,
    readme: `## Team knowledge base

The app started as a knowledge assistant: it reads the team's Confluence (read-only) and keeps a wiki of what it learns, which it reviews every night.

- Confluence is reached through the \`confluence\` command-line tool, as each person: set up its login once with \`mfw credentials setup @mercury-fw/plugin-confluence\` (the plugin's page on the documentation site says what it asks for).
- \`mfw e2e e2e/knowledge-base.e2e.ts\` checks that the agent looks things up in Confluence before answering. Add cases with what your Confluence holds.
`,
  },
  {
    id: "jira-assistant",
    title: "Jira assistant",
    summary: "finds, reads and updates the team's Jira issues",
    role: "the team's project assistant: you find, read and update Jira issues for the people you talk to",
    plugins: ["jira"],
    e2e: jiraAssistantE2e,
    readme: `## Jira assistant

The app started as a Jira assistant: it searches and reads issues, creates them, moves them, assigns them and comments on them; deleting one waits for the person's confirmation.

- \`JIRA_SITE_URL\` in \`.env\`: the Jira site the links point to.
- Jira is reached through the \`jira\` command-line tool, as each person: set up its login once with \`mfw credentials setup @mercury-fw/plugin-jira\` (the plugin's page on the documentation site says what it asks for).
- \`mfw e2e e2e/jira-assistant.e2e.ts\` checks that the agent searches Jira the way its skill says. Add cases with what your Jira holds.
`,
  },
  {
    id: "web-researcher",
    title: "Web researcher",
    summary: "searches the web and answers citing its sources",
    role: "a research assistant: you search the web and answer with links to the sources you read",
    plugins: ["web-search"],
    e2e: webResearcherE2e,
    readme: `## Web researcher

The app started as a research assistant: it searches the web through SearXNG, which runs next to it, reads the pages it finds and links them in its answers. A page on a site it hasn't read from before waits for the person's go.

- \`SEARXNG_SECRET\` in \`.env\`: any long random string (\`openssl rand -hex 32\`).
- \`mfw e2e e2e/web-researcher.e2e.ts\` checks that the agent searches before answering and links its source.
`,
  },
];

/** The starter with `id`, or undefined when there's none. */
export function findStarter(id: string): Starter | undefined {
  return STARTERS.find((s) => s.id === id);
}
