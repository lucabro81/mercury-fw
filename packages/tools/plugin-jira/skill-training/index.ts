/**
 * The Jira skill's training data for the skill trainer (apps/skill-trainer):
 * the plugin built on the trainer's fake CLI, answered from a made-up Jira
 * (world.ts) made anew for every task, and the tasks the skill is scored on.
 * One or more tasks per rule of the skill; the checks look at the calls, their
 * arguments and the facts the answer has to carry, never at its wording.
 * Values follow from world.ts: change a seed there and the counts here move.
 */
import type { Call, Expect, Run, SkillTraining, Split, TrainingTask } from "../../../../apps/skill-trainer/src/contract.ts";
import { formatter, formatterPlugin } from "../../../formatters/formatter/index.ts";
import type { JiraDisplays } from "../index.ts";
import { createJiraPlugin } from "../plugin.ts";
import { ACCOUNTS, jiraFixtures, makeWorld } from "./world.ts";

/** A jiraCommand call's command line. */
const cmd = (c: Call) => String((c.input as { command?: unknown }).command ?? "");
const calls = (run: Run) => run.turns.flatMap((t) => t.calls);
const jiraCalls = (run: Run, sub: string) => calls(run).filter((c) => c.tool === "jiraCommand" && cmd(c).includes(sub));

/** The reads the CLI refuses without `--select`. */
const READS = ["issue search", "issue get", "user search", "project search"];

/** The checks most tasks share. */
const checks = {
  loadsSkill: (e: Expect) => e.call("read_skill", (c) => (c.input as { name?: string }).name === "jira", "loads the jira skill"),
  /** A search that worked whose command matches `pattern`. */
  searched: (e: Expect, pattern: RegExp, label: string) => e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue search") && pattern.test(cmd(c)), label),
  /** Every read went out with `--select` (or `--select-all`). */
  selects: (e: Expect, run: Run) =>
    e.that(
      "every read has --select",
      calls(run).filter((c) => c.tool === "jiraCommand" && READS.some((r) => cmd(c).includes(r))).every((c) => /--select(-all)?\b/.test(cmd(c))),
    ),
  presented: (e: Expect) => e.call("present", (c) => c.ok, "shows the list with present"),
  notPresented: (e: Expect) => e.callCount({ max: 0 }, "present", "doesn't show a list it wasn't asked for"),
  /** The answer has `n` as a number of its own. */
  number: (e: Expect, n: number) => e.answer(new RegExp(`\\b${n}\\b`), `the answer says ${n}`),
};

const task = (id: string, split: Split, taskType: string, turn: string | TrainingTask["turns"], check: (run: Run, e: Expect) => void): TrainingTask => ({
  id,
  split,
  taskType,
  turns: Array.isArray(turn) ? turn : [turn],
  check,
});

/** A list the user wants to see: searched as asked, shown with present. */
const listTask = (id: string, split: Split, turn: string, jql: RegExp) =>
  task(id, split, "list", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, jql, "searches the right issues");
    checks.searched(e, /issues\.key/, "selects the list's paths");
    checks.presented(e);
    checks.selects(e, run);
  });

/** A count: searched as asked, answered as a number, no list shown. */
const countTask = (id: string, split: Split, turn: string, jql: RegExp, n: number) =>
  task(id, split, "count", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, jql, "searches the right issues");
    checks.number(e, n);
    checks.notPresented(e);
    checks.selects(e, run);
  });

/** One field of one issue: read with issue get (or a search), answered with the fact. */
const issueTask = (id: string, split: Split, turn: string, key: string, fact: string | RegExp) =>
  task(id, split, "single-issue", turn, (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes(key) && /issue (get|search)/.test(cmd(c)), `reads ${key}`);
    e.answer(fact);
    checks.notPresented(e);
    checks.selects(e, run);
  });

/** A move to `status`: the transition made with the status's name, said done. */
const transitionTask = (id: string, split: Split, turn: string, key: string, status: string) =>
  task(id, split, "transition", turn, (run, e) => {
    checks.loadsSkill(e);
    const to = new RegExp(`--to[ =]["']?${status}["']?(\\s|$)`, "i");
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue transition ") && cmd(c).includes(key) && to.test(cmd(c)), `moves ${key} to ${status}`);
    e.answer(key, `the answer names ${key}`);
  });

/** An assignment to a person found by name: user search, then assign with their accountId. */
const assignTask = (id: string, split: Split, turn: string, key: string, accountId: string) =>
  task(id, split, "assign", turn, (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "finds the person with user search");
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue assign") && cmd(c).includes(key) && cmd(c).includes(accountId), `assigns ${key} with the person's accountId`);
    checks.selects(e, run);
  });

/** A filter the user words as Jira doesn't: the right status searched in the end, the issues counted. */
const wordingTask = (id: string, split: Split, turn: string, status: RegExp, n: number) =>
  task(id, split, "status-wording", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, status, "searches the status by its Jira name");
    checks.number(e, n);
    checks.selects(e, run);
  });

/** A filter on dates: Jira's relative syntax, never a date it computed. */
const dateTask = (id: string, split: Split, turn: string, keys: string[]) =>
  task(id, split, "relative-date", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /now\(\)|[-+]?\d+[dwh]\b/, "uses JQL's relative dates");
    e.that("doesn't write a computed date", !jiraCalls(run, "issue search").some((c) => /\d{4}-\d{2}-\d{2}/.test(cmd(c))));
    for (const key of keys) e.answer(key);
    checks.selects(e, run);
  });

const tasks: TrainingTask[] = [
  // Lists the user wants to see.
  listTask("list-web-open", "train", "Show me the open issues in WEB.", /project\s*=\s*"?WEB/i),
  listTask("list-ops-open", "train", "List the OPS issues that aren't done yet.", /project\s*=\s*"?OPS/i),
  listTask("list-mrt-in-progress", "val", "What's in progress in MRT? Show me the list.", /project\s*=\s*"?MRT.*(in progress|statusCategory)/i),
  listTask("list-dsk-open", "test", "Can I see the open tickets of the DSK project?", /project\s*=\s*"?DSK/i),
  listTask("list-web-bugs", "train", "List the open bugs in WEB.", /(issuetype|type)\s*=\s*"?bug/i),
  listTask("list-marco", "val", "Show me the issues assigned to Marco Bianchi that are still open.", new RegExp(`marco bianchi|${ACCOUNTS.marco}`, "i")),
  listTask("list-ops-highest", "test", "Show me the highest priority issues in OPS.", /priority\s*=\s*"?highest/i),

  // Counts: an answer, no list.
  countTask("count-web-open", "train", "How many open issues are there in WEB?", /project\s*=\s*"?WEB/i, 8),
  countTask("count-ops-open", "val", "How many OPS issues are still open?", /project\s*=\s*"?OPS/i, 6),
  countTask("count-mrt-open", "test", "How many open issues does the MRT project have?", /project\s*=\s*"?MRT/i, 3),
  countTask("count-dsk-open", "train", "How many DSK tickets are not done?", /project\s*=\s*"?DSK/i, 2),
  countTask("count-web-bugs", "train", "How many open bugs are in WEB?", /(issuetype|type)\s*=\s*"?bug/i, 4),
  countTask("count-marco", "test", "How many open issues does Marco Bianchi have?", new RegExp(`marco bianchi|${ACCOUNTS.marco}`, "i"), 3),
  countTask("count-giulia", "val", "How many issues is Giulia Ferri still working on, across all projects?", new RegExp(`giulia ferri|${ACCOUNTS.giulia}`, "i"), 3),
  // Counting past one page: every page's issues added up.
  task("count-log-paged", "train", "count", "How many open issues are there in LOG?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /--page-token/, "asks for the next page");
    checks.number(e, 120);
    checks.notPresented(e);
  }),
  task("count-log-done", "val", "count", "How many LOG issues are done, and how many are left?", (run, e) => {
    checks.loadsSkill(e);
    checks.number(e, 17);
    checks.number(e, 120);
    checks.notPresented(e);
  }),

  // One issue, one fact.
  issueTask("issue-status", "train", "What's the status of WEB-5?", "WEB-5", /in review/i),
  issueTask("issue-assignee", "val", "Who is working on OPS-3?", "OPS-3", "Marco Bianchi"),
  issueTask("issue-due", "train", "When is WEB-3 due?", "WEB-3", /(2026-10-24|24)/),
  issueTask("issue-link", "test", "Give me the link to MRT-1.", "MRT-1", "https://example.atlassian.net/browse/MRT-1"),
  issueTask("issue-priority", "train", "What priority does DSK-1 have?", "DSK-1", /high/i),
  issueTask("issue-summary", "val", "What is OPS-8 about?", "OPS-8", /502/),
  // An issue that isn't there: said so, no status made up.
  task("issue-missing", "test", "single-issue", "What's the status of WEB-404?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => cmd(c).includes("WEB-404"), "looks WEB-404 up");
    e.answer("WEB-404");
    e.answerNot(/\b(to do|in progress|in review|done)\b/i, "doesn't make a status up");
  }),

  // Transitions, by the status's name.
  transitionTask("move-in-progress", "train", "Move WEB-9 to In Progress.", "WEB-9", "In Progress"),
  transitionTask("move-done", "train", "Mark OPS-4 as done.", "OPS-4", "Done"),
  transitionTask("move-review", "val", "Put DSK-2 in review.", "DSK-2", "In Review"),
  transitionTask("move-close", "test", "Close WEB-10, it's fixed.", "WEB-10", "Done"),
  transitionTask("move-back-todo", "train", "MRT-1 isn't really started, put it back to To Do.", "MRT-1", "To Do"),
  // A status that isn't one: the valid ones read, none guessed.
  task("move-unknown-status", "val", "transition", "Move WEB-4 to Blocked.", (run, e) => {
    checks.loadsSkill(e);
    e.that("doesn't move WEB-4 to a status it wasn't asked for", !jiraCalls(run, "issue transition ").some((c) => c.ok && cmd(c).includes("WEB-4")));
    e.answer(/to do|in progress|in review|done/i, "the answer says which statuses there are");
  }),

  // Assignments, through the person's accountId.
  assignTask("assign-marco", "train", "Assign WEB-4 to Marco Bianchi.", "WEB-4", ACCOUNTS.marco),
  assignTask("assign-giulia", "val", "Give OPS-4 to Giulia.", "OPS-4", ACCOUNTS.giulia),
  assignTask("assign-lena-surname", "test", "Assign MRT-4 to Hoffmann.", "MRT-4", ACCOUNTS.lena),
  assignTask("assign-ada-conti", "train", "Assign DSK-3 to Ada Conti.", "DSK-3", ACCOUNTS.adaConti),
  // Two people answer to the name: asked, not guessed.
  task("assign-ambiguous", "train", "assign", "Assign WEB-9 to Ada.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "finds the people with user search");
    e.that("doesn't assign before knowing which Ada", !jiraCalls(run, "issue assign").some((c) => c.ok));
    e.answer("Moretti");
    e.answer("Conti");
  }),
  task("unassign", "val", "assign", "Nobody should be on WEB-7 for now, unassign it.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue assign") && cmd(c).includes("WEB-7") && cmd(c).includes("--unassign"), "unassigns WEB-7");
  }),

  // Comments and mentions.
  task("comment-plain", "train", "comment", "Add a comment to WEB-3: fix deployed to staging.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue comment add") && cmd(c).includes("WEB-3") && /staging/i.test(cmd(c)), "comments on WEB-3");
  }),
  task("comment-mention", "train", "comment", "Comment on OPS-2 that the disk was cleaned up, and tag Lena Hoffmann.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "finds Lena with user search");
    e.call(
      "jiraCommand",
      (c) => c.ok && cmd(c).includes("issue comment add") && cmd(c).includes("OPS-2") && (cmd(c).includes(`--mention ${ACCOUNTS.lena}`) || cmd(c).includes(`{{mention:${ACCOUNTS.lena}}}`)),
      "mentions Lena by accountId",
    );
  }),
  task("comment-ask", "val", "comment", "On WEB-8, ask Marco in a comment whether the colour filter is ready.", (run, e) => {
    checks.loadsSkill(e);
    e.call(
      "jiraCommand",
      (c) => c.ok && cmd(c).includes("issue comment add") && cmd(c).includes("WEB-8") && (cmd(c).includes(`--mention ${ACCOUNTS.marco}`) || cmd(c).includes(`{{mention:${ACCOUNTS.marco}}}`)),
      "mentions Marco by accountId",
    );
  }),
  task("comment-inline-mention", "test", "comment", "Comment on DSK-2: thanks to Giulia Ferri for the quick refund, tag her where her name is.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue comment add") && cmd(c).includes(`{{mention:${ACCOUNTS.giulia}}}`), "tags Giulia inside the text");
  }),

  // Creating issues: done, and the new key said.
  task("create-bug", "train", "create", "Create a bug in WEB: the promo banner overlaps the menu.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project\s+"?WEB/.test(cmd(c)) && /--type\s+"?bug/i.test(cmd(c)), "creates a WEB bug");
    e.answer("WEB-11");
  }),
  task("create-assigned", "val", "create", "Open a task in OPS to renew the VPN certificate and give it to Giulia Ferri.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project\s+"?OPS/.test(cmd(c)), "creates the OPS task");
    e.that(
      "OPS-9 ends up with Giulia",
      calls(run).some((c) => c.ok && cmd(c).includes(ACCOUNTS.giulia) && (cmd(c).includes("issue create") || (cmd(c).includes("issue assign") && cmd(c).includes("OPS-9")))),
    );
    e.answer("OPS-9");
  }),
  task("create-task", "test", "create", "Make a task in MRT: pin the Bun version in CI.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project\s+"?MRT/.test(cmd(c)), "creates the MRT task");
    e.answer("MRT-5");
  }),

  // A project by an informal name: the wiki first, then project search, then the key written down.
  task("informal-project-count", "train", "informal-project", "How many open issues does the build tooling project have?", (run, e) => {
    checks.loadsSkill(e);
    e.call("grep", undefined, "greps the wiki for the name first");
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("project search"), "finds the project with project search");
    checks.searched(e, /project\s*=\s*"?MRT/i, "searches MRT");
    checks.number(e, 3);
    e.call("write_file", (c) => /MRT/.test(JSON.stringify(c.input)), "writes the key down in the wiki");
  }),
  task("informal-project-list", "val", "informal-project", "Show me what's open on the customer desk.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("project search"), "finds the project with project search");
    checks.searched(e, /project\s*=\s*"?DSK/i, "searches DSK");
    checks.presented(e);
  }),
  task("informal-project-logs", "test", "informal-project", "How many tickets are still open in the log archive?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("project search"), "finds the project with project search");
    checks.number(e, 120);
  }),

  // A status worded the way people say it.
  wordingTask("wording-todo", "train", "How many WEB issues are todo?", /status\s*=\s*"to do"|status\s*=\s*'to do'|statusCategory\s*=\s*"?to do/i, 5),
  wordingTask("wording-review", "val", "How many tickets are waiting for review in WEB?", /status\s*=\s*"in review"/i, 1),
  wordingTask("wording-progress", "test", "How many OPS issues have the status in progres?", /status\s*=\s*["']in progress["']/i, 2),

  // Dates relative to today.
  dateTask("dates-overdue", "train", "Which open issues in WEB are overdue?", ["WEB-5", "WEB-7"]),
  dateTask("dates-created-week", "val", "Which OPS issues were created in the last week?", ["OPS-2", "OPS-6", "OPS-8"]),
  // DSK-1 is due today, which `duedate >= now()` leaves out as Jira does: only DSK-2 is a sure answer.
  dateTask("dates-due-soon", "test", "What's due in DSK in the next five days?", ["DSK-2"]),

  // The person talking: currentUser().
  task("mine-open", "train", "mine", "How many issues do I have open?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /currentUser\(\)/i, "searches with currentUser()");
    checks.number(e, 4);
  }),
  task("mine-list", "test", "mine", "Show me my open issues.", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /currentUser\(\)/i, "searches with currentUser()");
    checks.presented(e);
  }),
  task("someone-else", "val", "mine", "What is Ada Moretti working on? Just the keys.", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /ada moretti/i, "filters by Ada Moretti's name in JQL");
    e.answer("WEB-5");
    e.answer("OPS-6");
  }),

  // Delete: staged, the token kept out of the answer.
  task("delete-staged", "train", "delete", "Delete WEB-6, we don't need it any more.", (run, e) => {
    checks.loadsSkill(e);
    const staged = jiraCalls(run, "issue delete").find((c) => c.pending && cmd(c).includes("WEB-6"));
    e.that("stages the delete of WEB-6", staged !== undefined);
    const token = (staged?.output as { token?: string } | undefined)?.token;
    e.that("keeps the token out of the answer", token === undefined || !run.last.answer.includes(token));
  }),
  task("delete-staged-other", "test", "delete", "Remove DSK-3 from Jira.", (run, e) => {
    checks.loadsSkill(e);
    const staged = jiraCalls(run, "issue delete").find((c) => c.pending && cmd(c).includes("DSK-3"));
    e.that("stages the delete of DSK-3", staged !== undefined);
    const token = (staged?.output as { token?: string } | undefined)?.token;
    e.that("keeps the token out of the answer", token === undefined || !run.last.answer.includes(token));
  }),

  // Follow-ups: recall what was said, re-query what may have changed.
  task("followup-requery-filter", "train", "follow-up", ["Show me the open issues in WEB.", "Which of those are Marco's?"], (run, e) => {
    checks.loadsSkill(e);
    const second = run.turns[1]?.calls ?? [];
    e.that("filters by searching again, with Marco in the JQL", second.some((c) => c.ok && cmd(c).includes("issue search") && /marco/i.test(cmd(c))));
    e.answer("WEB-8");
  }),
  task("followup-requery-state", "val", "follow-up", ["Show me the open issues in OPS.", "Move OPS-4 to In Progress.", "Is OPS-4 still To Do?"], (run, e) => {
    const third = run.turns[2]?.calls ?? [];
    e.that("reads OPS-4 again instead of answering from memory", third.some((c) => c.ok && cmd(c).includes("OPS-4") && /issue (get|search)/.test(cmd(c))));
    e.answer(/in progress/i);
  }),
  task("followup-recall", "test", "follow-up", ["How many open issues are there in DSK?", "What did you search to find that?"], (run, e) => {
    const second = run.turns[1]?.calls ?? [];
    e.that(
      "recalls the earlier call or answers without a new search",
      second.some((c) => c.tool === "recall_tool_calls") || !second.some((c) => c.tool === "jiraCommand" && cmd(c).includes("issue search")),
    );
    e.answer(/project\s*=\s*"?DSK/i, "the answer says the JQL");
  }),
  task("followup-show-again", "train", "follow-up", ["Show me the open bugs in WEB.", "Show me that list again."], (run, e) => {
    const second = run.turns[1]?.calls ?? [];
    e.that("shows the list again with present", second.some((c) => c.tool === "present" && c.ok));
    e.that("doesn't type the list out", !/WEB-3[\s\S]*WEB-5[\s\S]*WEB-7/.test(run.last.answer));
  }),
];

/** One issue in a list, as `mfw create` writes the rule into a new app: without
 * a formatter the list has no rendered items, so no `displayRef` to present. */
const jiraIssueLine = (issue: JiraDisplays["issue-list"]) => `${issue.key} ${issue.status ? `[${issue.status}] ` : ""}${issue.summary}\n${issue.url}`;

export default {
  skill: "jira",
  plugin: (runCliFn) => formatterPlugin(createJiraPlugin({ runCliFn }), formatter<JiraDisplays>({ "issue-list": { item: jiraIssueLine, empty: "No matching issues." } })),
  fixtures: () => jiraFixtures(makeWorld()),
  tasks,
} satisfies SkillTraining;
