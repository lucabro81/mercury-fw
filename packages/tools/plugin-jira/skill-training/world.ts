/**
 * The made-up Jira the skill is trained on, and the fixtures answering the
 * jira CLI from it. Every task gets a fresh world (`makeWorld`), so what one
 * task writes (a transition, an assignment, a new issue) a later turn of that
 * task sees and no other task does. Names, keys and texts are invented.
 *
 * What the answers are modelled on, command by command. Recorded means the
 * real CLI (2.3.2) printed that shape against a real Jira:
 *
 * - recorded: a search (`isLast`, `issues`, `nextPageToken` only while more
 *   follow, an empty result as `{isLast: true, issues: []}`), its `--select`
 *   projection and both refusals (see jira-cli.ts); `issue get` with
 *   `browse_url` and nulls kept; `issue transitions` (its fields; that every
 *   status is a transition from every other is this world's workflow);
 *   `issue transition`, its success and its "not found … Available
 *   transitions" failure; `issue assign`, assigned and unassigned; `issue
 *   comment add` (the author is the account the CLI acts as, Mercury here);
 *   `issue create`; `user search` (a top-level array, `[{}]` for a path that
 *   isn't there); `project search`; the help texts, trimmed; a 403 as
 *   `Jira API returned status 403: …`;
 * - reconstructed: the 404 and 400 texts (Jira's usual wording, including
 *   "cannot be assigned issues" for a deactivated person, and `issue create`
 *   refusing a type this world's issues don't have, a priority outside Jira's
 *   default five, an assignee who doesn't exist or is inactive), the usage
 *   errors (clap's format: a missing `<KEY>`, a `--max-results` that isn't a
 *   whole number), `--max-results` above 100 giving 100, an inline
 *   `{{mention:ID}}` in a comment's body coming back as a mention node where
 *   it was written, the page token (opaque, here base64 of an offset), user
 *   search matching every word of the query at the start of one of the name's
 *   (and inactive people included) and project search any part of the key or
 *   name, `--fields` accepted with no effect on the answer;
 * - simplified: a garbled page token reads as the first page (Jira would
 *   refuse it), `--max-results 0` as the default 50, and a transition to the
 *   status an issue is already in succeeds.
 *
 * `currentUser()` is Sam, the person talking: in Mercury the CLI runs with
 * `--user` for them, which is what the skill teaches. The CLI's own help says
 * the opposite (that it's the account the CLI acts as, the service account
 * without `--user`), and it's kept as recorded: a model reading it meets the
 * same two statements it would in production.
 */
import type { CliResult } from "@mercury-fw/plugin-types";
import type { Fixture, FixtureCall } from "../../../../apps/skill-trainer/src/contract.ts";
import { failure, page, printed } from "./jira-cli.ts";
import { filterJql, type JqlContext, type JqlIssue } from "./jql.ts";

/** "Now" for every date in the world and every `now()` in JQL. */
export const NOW = new Date("2026-10-20T09:00:00Z");
const SITE = "https://example.atlassian.net";
const API = "https://api.atlassian.com/ex/jira/00000000-0000-4000-8000-000000000000/rest/api/3";

/** The people's account ids, for tasks' checks. */
export const ACCOUNTS = {
  sam: "5f1a2b3c4d5e6f708192a3b4",
  adaMoretti: "60a1b2c3d4e5f60718293a4b",
  adaConti: "61b2c3d4e5f6071829304b5c",
  marco: "62c3d4e5f607182930415c6d",
  giulia: "63d4e5f60718293041526d7e",
  lena: "64e5f6071829304152637e8f",
} as const;

/** The service account the CLI acts as when Mercury acts as itself. */
const MERCURY = { accountId: "712020:00000000-0000-4000-8000-0000000000aa", displayName: "Mercury", accountType: "app" };

type User = { accountId: string; displayName: string; emailAddress: string; active: boolean };
type Project = { key: string; name: string };
type Comment = { id: string; body: string; mention?: string };
export type WorldIssue = JqlIssue & { id: string; priority: string; issuetype: string; comments: Comment[] };
export type World = { me: string; users: User[]; projects: Project[]; issues: WorldIssue[] };

/** The workflow every project shares, each status with its category; every status is a transition from every other. */
const WORKFLOW: Array<{ id: string; name: string; category: JqlIssue["statusCategory"]; categoryKey: string }> = [
  { id: "11", name: "To Do", category: "To Do", categoryKey: "new" },
  { id: "21", name: "In Progress", category: "In Progress", categoryKey: "indeterminate" },
  { id: "31", name: "In Review", category: "In Progress", categoryKey: "indeterminate" },
  { id: "41", name: "Done", category: "Done", categoryKey: "done" },
];
const categoryOf = (status: string) => WORKFLOW.find((s) => s.name === status)!.category;

const USERS: User[] = [
  { accountId: ACCOUNTS.sam, displayName: "Sam Rivera", emailAddress: "sam.rivera@example.com", active: true },
  { accountId: ACCOUNTS.adaMoretti, displayName: "Ada Moretti", emailAddress: "ada.moretti@example.com", active: true },
  { accountId: ACCOUNTS.adaConti, displayName: "Ada Conti", emailAddress: "ada.conti@example.com", active: true },
  { accountId: ACCOUNTS.marco, displayName: "Marco Bianchi", emailAddress: "marco.bianchi@example.com", active: true },
  { accountId: ACCOUNTS.giulia, displayName: "Giulia Ferri", emailAddress: "giulia.ferri@example.com", active: true },
  { accountId: ACCOUNTS.lena, displayName: "Lena Hoffmann", emailAddress: "lena.hoffmann@example.com", active: false },
];

const PROJECTS: Project[] = [
  { key: "WEB", name: "Storefront" },
  { key: "OPS", name: "Platform Operations" },
  { key: "MRT", name: "Build Tooling" },
  { key: "DSK", name: "Customer Desk" },
  { key: "LOG", name: "Log Archive" },
];

/** [key, summary, status, assignee, duedate, priority, type, created (days before now)] */
type Seed = [string, string, string, keyof typeof ACCOUNTS | null, string | null, string, string, number];
const SEEDS: Seed[] = [
  ["WEB-1", "Product images load slowly on mobile", "Done", "marco", null, "Medium", "Bug", 60],
  ["WEB-2", "Add Apple Pay to checkout", "To Do", "giulia", "2026-11-15", "High", "Story", 40],
  ["WEB-3", "Checkout button unresponsive on Safari", "In Progress", "sam", "2026-10-24", "Highest", "Bug", 12],
  ["WEB-4", "Translate the size guide into German", "To Do", null, null, "Low", "Task", 30],
  ["WEB-5", "Cart total ignores discount codes", "In Review", "adaMoretti", "2026-10-18", "High", "Bug", 9],
  ["WEB-6", "Newsletter signup form", "Done", "giulia", null, "Low", "Story", 90],
  ["WEB-7", "Wishlist shared links expire too early", "To Do", "sam", "2026-10-15", "Medium", "Bug", 20],
  ["WEB-8", "Filter products by colour", "In Progress", "marco", "2026-10-31", "Medium", "Story", 18],
  ["WEB-9", "Footer links point to the old blog", "To Do", null, null, "Low", "Task", 3],
  ["WEB-10", "Search suggestions show sold-out items", "To Do", "adaConti", "2026-10-22", "Medium", "Bug", 5],
  ["OPS-1", "Rotate the database credentials", "Done", "lena", null, "High", "Task", 70],
  ["OPS-2", "Disk usage alert on the build server", "To Do", "sam", "2026-10-19", "High", "Bug", 4],
  ["OPS-3", "Upgrade the load balancer firmware", "In Progress", "marco", "2026-10-28", "Medium", "Task", 15],
  ["OPS-4", "Nightly backup takes over six hours", "To Do", null, null, "Medium", "Bug", 11],
  ["OPS-5", "Document the incident runbook", "In Review", "giulia", "2026-10-21", "Low", "Task", 25],
  ["OPS-6", "Move staging to the new cluster", "To Do", "adaMoretti", "2026-12-01", "Medium", "Story", 2],
  ["OPS-7", "Renew the wildcard certificate", "Done", "sam", null, "Highest", "Task", 35],
  ["OPS-8", "Login page returns 502 under load", "In Progress", "adaConti", "2026-10-20", "Highest", "Bug", 1],
  ["MRT-1", "Cache the dependency install in CI", "In Progress", "sam", "2026-10-26", "Medium", "Task", 14],
  ["MRT-2", "Lint step fails on Windows paths", "To Do", "marco", null, "Low", "Bug", 8],
  ["MRT-3", "Publish packages from a dry run first", "Done", "giulia", null, "Medium", "Story", 45],
  ["MRT-4", "Speed up the type check", "To Do", null, "2026-11-05", "Medium", "Task", 6],
  ["DSK-1", "Customer cannot reset their password", "To Do", "adaConti", "2026-10-20", "High", "Bug", 2],
  ["DSK-2", "Refund request stuck in review", "In Progress", "giulia", "2026-10-23", "Medium", "Task", 7],
  ["DSK-3", "Order confirmation email missing", "Done", "marco", null, "High", "Bug", 16],
];

/** LOG's issues: enough open ones (120) to take more than a page of 100. */
function logIssues(): Seed[] {
  return Array.from({ length: 137 }, (_, i): Seed => [`LOG-${i + 1}`, `Archive the logs of shard ${i + 1}`, i < 120 ? "To Do" : "Done", null, null, "Low", "Task", 50]);
}

/** A fresh world: its own copy of every issue, nothing written yet. */
export function makeWorld(): World {
  const issues = [...SEEDS, ...logIssues()].map(([key, summary, status, who, duedate, priority, issuetype, daysAgo], n): WorldIssue => {
    const user = who === null ? null : USERS.find((u) => u.accountId === ACCOUNTS[who])!;
    return {
      key,
      id: String(10000 + n),
      project: key.split("-")[0]!,
      summary,
      status,
      statusCategory: categoryOf(status),
      assignee: user && { accountId: user.accountId, displayName: user.displayName },
      duedate,
      created: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      priority,
      issuetype,
      comments: [],
    };
  });
  return { me: ACCOUNTS.sam, users: structuredClone(USERS), projects: structuredClone(PROJECTS), issues };
}

/** What a JQL query runs against in `world`: now, who's asking, and the values each field has. */
export function jqlContext(world: World): JqlContext {
  return {
    now: NOW,
    currentUser: world.me,
    projects: world.projects.map((p) => p.key),
    statuses: WORKFLOW.map((s) => s.name),
    users: world.users,
    issuetypes: ["Bug", "Task", "Story", "Epic", "Subtask"],
    priorities: ["Highest", "High", "Medium", "Low", "Lowest"],
  };
}

/** The keys a JQL query finds in a fresh world, in the order Jira lists them; throws when the query isn't one it answers. */
export function keysFor(jql: string): string[] {
  const world = makeWorld();
  const found = filterJql(jql, world.issues, jqlContext(world));
  if (!found.ok) throw new Error(`reference JQL not answered: ${jql}`);
  return found.issues.map((i) => i.key);
}

/** An issue as Jira's API returns it. */
function issueJson(world: World, i: WorldIssue) {
  const status = WORKFLOW.find((s) => s.name === i.status)!;
  const project = world.projects.find((p) => p.key === i.project)!;
  return {
    id: i.id,
    key: i.key,
    self: `${API}/issue/${i.id}`,
    fields: {
      summary: i.summary,
      status: { name: status.name, statusCategory: { key: status.categoryKey, name: status.category } },
      assignee: i.assignee && { ...i.assignee, active: world.users.find((u) => u.accountId === i.assignee?.accountId)?.active ?? true },
      duedate: i.duedate,
      priority: { name: i.priority },
      issuetype: { name: i.issuetype },
      project: { key: project.key, name: project.name },
      created: i.created,
      comment: { total: i.comments.length },
    },
  };
}

const notFound = () =>
  failure('Jira API returned status 404: {"errorMessages":["Issue does not exist or you do not have permission to see it."],"errors":{}}');

/** A flag's value when it was given one. */
const value = (call: FixtureCall, flag: string) => (typeof call.flags[flag] === "string" ? (call.flags[flag] as string) : undefined);

/** The help texts of the CLI the fixtures know, by command (trimmed to usage, the command's own options and examples). */
const HELP: Record<string, string> = {
  "issue search":
    'Search issues using JQL (Jira Query Language) and return matching issues as JSON\n\nUsage: jira issue search [OPTIONS] --jql <JQL>\n\nOptions:\n      --jql <JQL>                  JQL query string, e.g. "project=KAN AND status=\\"Done\\""\n      --max-results <MAX_RESULTS>  Maximum number of issues to return (default: 50, max: 100) [default: 50]\n      --page-token <PAGE_TOKEN>    Cursor token for the next page, from the nextPageToken field of a previous response\n      --fields <FIELDS>            Comma-separated Jira field names to include in each issue (server-side). Reduces response size.\n      --stale-days <STALE_DAYS>    Only include issues not updated in at least N days. Adds "AND updated <= -Nd" to --jql server-side\n\nExamples:\n  jira issue search --jql "project=KAN AND status=\\"In Progress\\"" --select issues.key,issues.fields.summary\n  jira issue search --jql "assignee=5b10ac8d82e05b22cc7d4ef5 ORDER BY created DESC" --max-results 10 --select issues.key,issues.fields.summary,nextPageToken\n  jira issue search --jql "project=KAN" --fields summary,status,priority --select issues.key,issues.fields.summary,issues.fields.status.name,issues.fields.priority.name\n\nPagination: the response includes a nextPageToken field when more results exist.\nPass its value to --page-token on the next call to fetch the following page.\n\nTo filter by a person, use their account ID (find it with `jira user search --query <name>`),\nnot currentUser(): that resolves to the account the CLI acts as (the service account, or\nthe person with --user <USER_ID>), not necessarily the person you are working for.',
  "issue get":
    "Fetch a single issue by key (e.g. PROJ-123) and print it as JSON\n\nUsage: jira issue get [OPTIONS] <KEY>\n\nArguments:\n  <KEY>  Issue key, e.g. PROJ-123\n\nExamples:\n  jira issue get PROJ-123 --select key,fields.summary,fields.status.name\n  jira issue get PROJ-123 --select fields.summary,fields.status.name,fields.assignee.displayName,fields.priority.name",
  "issue create":
    "Create a new issue in a Jira project\n\nUsage: jira issue create [OPTIONS] --project <PROJECT> --type <ISSUE_TYPE> --summary <SUMMARY>\n\nOptions:\n      --project <PROJECT>          Project key, e.g. KAN\n      --type <ISSUE_TYPE>          Issue type name, e.g. Task, Bug, Story\n      --summary <SUMMARY>          One-line summary of the issue\n      --description <DESCRIPTION>  Optional description (Markdown)\n      --assignee <ASSIGNEE>        Optional assignee account ID\n      --priority <PRIORITY>        Optional priority name, e.g. High, Medium, Low\n      --parent <PARENT>            Optional parent issue key, e.g. KAN-10\n\nExamples:\n  jira issue create --project KAN --type Task --summary \"Fix login bug\"\n  jira issue create --project KAN --type Bug --summary \"Crash on startup\" --description \"Happens on macOS 14\" --priority High",
  "issue transition":
    "Move an issue to a different status via a workflow transition\n\nUsage: jira issue transition [OPTIONS] --to <TO> <KEY>\n\nArguments:\n  <KEY>  Issue key, e.g. PROJ-123\n\nOptions:\n      --to <TO>  Target status name, e.g. \"In Progress\" or \"Done\"\n\nExample: jira issue transition KAN-4 --to \"In Progress\"\n\nUse the exact status name as it appears in Jira. If the name does not match any available transition, the command fails and lists the valid options.",
  "issue assign":
    "Assign or unassign an issue\n\nUsage: jira issue assign [OPTIONS] <KEY>\n\nArguments:\n  <KEY>  Issue key, e.g. PROJ-123\n\nOptions:\n      --assignee <ASSIGNEE>  Account ID of the user to assign. Find one with `jira user search --query <name>`\n      --unassign             Remove the current assignee instead of assigning a new one\n\nExamples:\n  jira issue assign KAN-4 --assignee 5b10ac8d82e05b22cc7d4ef5\n  jira issue assign KAN-4 --unassign\n\nExactly one of --assignee or --unassign must be passed.",
  "issue comment add":
    "Add a comment to an issue and print the created comment as JSON\n\nUsage: jira issue comment add [OPTIONS] --body <BODY> <KEY>\n\nArguments:\n  <KEY>  Issue key, e.g. PROJ-123\n\nOptions:\n      --body <BODY>        Comment text (Markdown). Embed `{{mention:ACCOUNT_ID}}` anywhere in this text to tag a user at that exact position\n      --mention <MENTION>  Account ID of a user to tag/mention at the start of the comment\n\nExamples:\n  jira issue comment add KAN-4 --body \"Blocked by network issue, retrying tomorrow\"\n  jira issue comment add KAN-4 --mention 5b10ac8d82e05b22cc7d4ef5 --body \"can you take a look?\"",
  "issue delete": "Usage: jira issue delete [OPTIONS] <KEY>\n\nOptions:\n      --confirm          Acknowledge that this action is permanent and irreversible\n      --delete-subtasks  Also delete subtasks; required if the issue has any\n\nExample: jira issue delete KAN-5 --confirm",
};

/** The flags every command takes. */
const GLOBAL_FLAGS = ["--select", "--select-all", "--user", "--help", "-h"];

/** The command lines the fixtures check the way clap does (from their help): usage, required flags, the command's own flags. */
const USAGE: Record<string, { usage: string; required: Array<[string, string]>; flags: string[]; key?: boolean }> = {
  "issue search": { usage: "jira issue search [OPTIONS] --jql <JQL>", required: [["--jql", "<JQL>"]], flags: ["--max-results", "--page-token", "--fields", "--stale-days"] },
  "issue get": { usage: "jira issue get [OPTIONS] <KEY>", required: [], flags: [], key: true },
  "issue transitions": { usage: "jira issue transitions [OPTIONS] <KEY>", required: [], flags: [], key: true },
  "issue create": {
    usage: "jira issue create [OPTIONS] --project <PROJECT> --type <ISSUE_TYPE> --summary <SUMMARY>",
    required: [
      ["--project", "<PROJECT>"],
      ["--type", "<ISSUE_TYPE>"],
      ["--summary", "<SUMMARY>"],
    ],
    flags: ["--description", "--assignee", "--priority", "--parent"],
  },
  "issue transition": { usage: "jira issue transition [OPTIONS] --to <TO> <KEY>", required: [["--to", "<TO>"]], flags: [], key: true },
  "issue assign": { usage: "jira issue assign [OPTIONS] <KEY>", required: [], flags: ["--assignee", "--unassign"], key: true },
  "issue comment add": { usage: "jira issue comment add [OPTIONS] --body <BODY> <KEY>", required: [["--body", "<BODY>"]], flags: ["--mention"], key: true },
};

/** clap's refusal of a command line, exit 2 as the real CLI exits. */
const usageError = (message: string, usage: string): CliResult => ({
  ok: false,
  exitCode: 2,
  error: `jira exited with code 2: error: ${message}\n\nUsage: ${usage}\n\nFor more information, try '--help'.`,
});

/** A fixture refusing `command`'s lines clap would refuse: a flag it doesn't
 * have first, then the required ones left out; passes every other line on. */
function usageFixture(command: string): Fixture {
  const spec = USAGE[command]!;
  return {
    command: command.split(" "),
    switches: ["--unassign", "--select-all", "--help", "-h"],
    result: (call) => {
      const known = new Set([...GLOBAL_FLAGS, ...spec.flags, ...spec.required.map(([flag]) => flag)]);
      const unknown = Object.keys(call.flags).find((flag) => !known.has(flag));
      if (unknown !== undefined) return usageError(`unexpected argument '${unknown}' found`, spec.usage);
      if (call.flags["--help"] !== undefined || call.flags["-h"] !== undefined) return undefined;
      const missing = spec.required.filter(([flag]) => typeof call.flags[flag] !== "string").map(([flag, meta]) => `${flag} ${meta}`);
      if (spec.key && call.positionals.length === 0) missing.push("<KEY>");
      if (missing.length > 0) {
        return usageError(`the following required arguments were not provided:\n${missing.map((m) => `  ${m}`).join("\n")}`, spec.usage);
      }
      const max = call.flags["--max-results"];
      if (typeof max === "string" && !/^\d+$/.test(max)) {
        return usageError(`invalid value '${max}' for '--max-results <MAX_RESULTS>': invalid digit found in string`, spec.usage);
      }
      // Reconstructed, not recorded: the help says exactly one of the two must be passed.
      if (command === "issue assign" && (typeof call.flags["--assignee"] === "string") === (call.flags["--unassign"] === true)) {
        return usageError("the following required arguments were not provided:\n  <--assignee <ASSIGNEE>|--unassign>", spec.usage);
      }
      return undefined;
    },
  };
}

/** A mention node for an account id, as Jira's document format writes it. */
function mentionNode(world: World, id: string) {
  const user = world.users.find((u) => u.accountId === id);
  return { type: "mention", attrs: { id, text: `@${user?.displayName ?? "Unknown"}`, accessLevel: "" } };
}

/** A comment's body as Jira's document format: the `--mention` first, then the text, each inline `{{mention:ID}}` a mention node where it was written. */
function commentBody(world: World, text: string, mention: string | undefined) {
  const paragraphs: unknown[] = [];
  if (mention !== undefined) paragraphs.push({ type: "paragraph", content: [mentionNode(world, mention), { type: "text", text: " " }] });
  const content = text
    .split(/\{\{mention:([^}]+)\}\}/)
    .map((part, n) => (n % 2 === 1 ? mentionNode(world, part) : { type: "text", text: part }))
    .filter((node) => node.type === "mention" || ("text" in node && node.text !== ""));
  paragraphs.push({ type: "paragraph", content });
  return { type: "doc", version: 1, content: paragraphs };
}

/** Why Jira refuses `accountId` as an issue's assignee, or undefined when it can be one. */
function assigneeRefusal(world: World, accountId: string, field: string): CliResult | undefined {
  const user = world.users.find((u) => u.accountId === accountId);
  if (!user) return failure(`Jira API returned status 400: {"errorMessages":[],"errors":{"${field}":"Specified user does not exist or you do not have required permissions"}}`);
  if (!user.active) return failure(`Jira API returned status 400: {"errorMessages":[],"errors":{"assignee":"User '${user.displayName}' cannot be assigned issues."}}`);
  return undefined;
}

/** The issue types an issue can be created with: the ones this world's issues have. */
const ISSUE_TYPES = [...new Set(SEEDS.map((s) => s[6]))];
/** Jira's default priority scheme. */
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];

/** The fixtures answering the jira CLI from `world`, writes included. */
export function jiraFixtures(world: World): Fixture[] {
  const find = (key: string | undefined) => world.issues.find((i) => i.key === key);
  const help = (command: string[]): Fixture => ({
    command,
    switches: ["--help", "-h"],
    result: (call) => {
      if (call.flags["--help"] === undefined && call.flags["-h"] === undefined) return undefined;
      return { ok: true, data: HELP[command.join(" ")]! };
    },
  });

  return [
    ...Object.keys(USAGE).map(usageFixture),
    ...Object.keys(HELP).map((c) => help(c.split(" "))),
    {
      command: ["issue", "search"],
      result: (call): CliResult | undefined => {
        const jql = value(call, "--jql");
        // --stale-days filters on `updated`, which the made-up issues don't have: a hole, not a guess.
        if (jql === undefined || call.flags["--stale-days"] !== undefined) return undefined;
        const found = filterJql(jql, world.issues, jqlContext(world));
        if (!found.ok && "error" in found) return failure(`Jira API returned status 400: ${JSON.stringify({ errorMessages: [found.error], errors: {} })}`);
        if (!found.ok) return undefined;
        const { issues, ...rest } = page(found.issues, call);
        return printed({ ...rest, issues: issues.map((i) => issueJson(world, i)) }, call);
      },
    },
    {
      command: ["issue", "get"],
      result: (call) => {
        const issue = find(call.positionals[0]);
        if (!issue) return notFound();
        return printed({ ...issueJson(world, issue), browse_url: `${SITE}/browse/${issue.key}` }, call);
      },
    },
    {
      command: ["issue", "transitions"],
      result: (call) => {
        if (!find(call.positionals[0])) return notFound();
        const transitions = WORKFLOW.map((s) => ({
          id: s.id,
          name: s.name,
          hasScreen: false,
          isAvailable: true,
          isGlobal: true,
          to: { name: s.name, statusCategory: { key: s.categoryKey, name: s.category } },
        }));
        return printed({ expand: "transitions", transitions }, call, { exempt: true });
      },
    },
    {
      command: ["issue", "transition"],
      result: (call) => {
        const to = value(call, "--to");
        if (to === undefined) return undefined;
        const issue = find(call.positionals[0]);
        if (!issue) return notFound();
        const status = WORKFLOW.find((s) => s.name.toLowerCase() === to.toLowerCase());
        if (!status) {
          return failure(`transition "${to}" not found for this issue in its current state. Available transitions: ${WORKFLOW.map((s) => s.name).join(", ")}`);
        }
        issue.status = status.name;
        issue.statusCategory = status.category;
        return { ok: true, data: { key: issue.key, to: status.name, transitioned: true } };
      },
    },
    {
      command: ["issue", "assign"],
      switches: ["--unassign"],
      result: (call) => {
        const accountId = value(call, "--assignee");
        const unassign = call.flags["--unassign"] === true;
        if ((accountId === undefined) === !unassign) return undefined;
        const issue = find(call.positionals[0]);
        if (!issue) return notFound();
        if (unassign) {
          issue.assignee = null;
          return { ok: true, data: { assigned: true, assignee: null, key: issue.key } };
        }
        const refusal = assigneeRefusal(world, accountId!, "accountId");
        if (refusal) return refusal;
        const user = world.users.find((u) => u.accountId === accountId)!;
        issue.assignee = { accountId: user.accountId, displayName: user.displayName };
        return { ok: true, data: { assigned: true, assignee: user.accountId, key: issue.key } };
      },
    },
    {
      command: ["issue", "comment", "add"],
      result: (call) => {
        const body = value(call, "--body");
        if (body === undefined) return undefined;
        const issue = find(call.positionals[0]);
        if (!issue) return notFound();
        const mention = value(call, "--mention");
        const id = String(200000 + world.issues.reduce((n, i) => n + i.comments.length, 0));
        issue.comments.push({ id, body, ...(mention === undefined ? {} : { mention }) });
        return {
          ok: true,
          data: {
            author: { ...MERCURY, active: true },
            body: commentBody(world, body, mention),
            created: NOW.toISOString(),
            id,
            self: `${API}/issue/${issue.id}/comment/${id}`,
          },
        };
      },
    },
    {
      command: ["issue", "create"],
      result: (call) => {
        const projectKey = value(call, "--project");
        const type = value(call, "--type");
        const summary = value(call, "--summary");
        if (projectKey === undefined || type === undefined || summary === undefined) return undefined;
        if (!world.projects.some((p) => p.key === projectKey)) {
          return failure('Jira API returned status 400: {"errorMessages":[],"errors":{"project":"valid project is required"}}');
        }
        const issuetype = ISSUE_TYPES.find((t) => t.toLowerCase() === type.toLowerCase());
        if (!issuetype) return failure('Jira API returned status 400: {"errorMessages":[],"errors":{"issuetype":"Specify a valid issue type"}}');
        const priorityName = value(call, "--priority");
        const priority = priorityName === undefined ? "Medium" : PRIORITIES.find((p) => p.toLowerCase() === priorityName.toLowerCase());
        if (!priority) return failure(`Jira API returned status 400: {"errorMessages":[],"errors":{"priority":"Priority name '${priorityName}' is not valid"}}`);
        const assigneeId = value(call, "--assignee");
        const refusal = assigneeId === undefined ? undefined : assigneeRefusal(world, assigneeId, "assignee");
        if (refusal) return refusal;
        const number = 1 + Math.max(0, ...world.issues.filter((i) => i.project === projectKey).map((i) => Number(i.key.split("-")[1])));
        const assignee = world.users.find((u) => u.accountId === assigneeId);
        const issue: WorldIssue = {
          key: `${projectKey}-${number}`,
          id: String(20000 + world.issues.length),
          project: projectKey,
          summary,
          status: "To Do",
          statusCategory: "To Do",
          assignee: assignee ? { accountId: assignee.accountId, displayName: assignee.displayName } : null,
          duedate: null,
          created: NOW.toISOString(),
          priority,
          issuetype,
          comments: [],
        };
        world.issues.push(issue);
        return { ok: true, data: { browse_url: `${SITE}/browse/${issue.key}`, id: issue.id, key: issue.key, self: `${API}/issue/${issue.id}` } };
      },
    },
    {
      command: ["user", "search"],
      result: (call) => {
        const query = value(call, "--query")?.toLowerCase();
        if (query === undefined) return undefined;
        // Every word of the query at the start of one of the name's words ("ada c" finds Ada Conti,
        // a full name finds its person), or the query at the start of the email; not any part of them.
        const tokens = query.split(/\s+/).filter(Boolean);
        const users = world.users.filter((u) => {
          const words = u.displayName.toLowerCase().split(/\s+/);
          return tokens.every((t) => words.some((w) => w.startsWith(t))) || u.emailAddress.toLowerCase().startsWith(query);
        });
        return printed(
          users.map((u) => ({ ...u, accountType: "atlassian", self: `${API}/user?accountId=${u.accountId}` })),
          call,
        );
      },
    },
    {
      command: ["project", "search"],
      result: (call) => {
        const query = value(call, "--query")?.toLowerCase() ?? "";
        const values = world.projects
          .filter((p) => p.key.toLowerCase().includes(query) || p.name.toLowerCase().includes(query))
          .map((p, n) => ({ id: String(10100 + n), key: p.key, name: p.name, projectTypeKey: "software", self: `${API}/project/${p.key}` }));
        return printed({ isLast: true, values }, call);
      },
    },
  ];
}
