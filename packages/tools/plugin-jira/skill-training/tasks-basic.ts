/**
 * The first Jira tasks: one or more per rule of the skill, in English, mostly
 * one turn each. Values follow from world.ts: change a seed there and the
 * counts here move.
 */
import type { TrainingTask } from "../../../../apps/skill-trainer/src/contract.ts";
import { assignTask, calls, checks, cmd, countTask, dateTask, issueTask, jiraCalls, jqlOf, listTask, task, transitionTask, wordingTask } from "./checks.ts";
import { ACCOUNTS } from "./world.ts";

export const BASIC_TASKS: TrainingTask[] = [
  // Lists the user wants to see.
  listTask("list-web-open", "train", "Show me the open issues in WEB.", /project\s*=\s*"?WEB/i, ["project = WEB AND statusCategory != Done"]),
  listTask("list-ops-open", "train", "List the OPS issues that aren't done yet.", /project\s*=\s*"?OPS/i, ["project = OPS AND statusCategory != Done"]),
  listTask("list-mrt-in-progress", "val", "What's in progress in MRT? Show me the list.", /project\s*=\s*"?MRT.*(in progress|statusCategory)/i, [
    'project = MRT AND status = "In Progress"',
    'project = MRT AND statusCategory = "In Progress"',
  ]),
  listTask("list-dsk-open", "test", "Can I see the open tickets of the DSK project?", /project\s*=\s*"?DSK/i, ["project = DSK AND statusCategory != Done"]),
  listTask("list-web-bugs", "train", "List the open bugs in WEB.", /(issuetype|type)\s*=\s*"?bug/i, ["project = WEB AND issuetype = Bug AND statusCategory != Done"]),
  listTask("list-marco", "val", "Show me the issues assigned to Marco Bianchi that are still open.", new RegExp(`marco bianchi|${ACCOUNTS.marco}`, "i"), [
    'assignee = "Marco Bianchi" AND statusCategory != Done',
  ]),
  // Open or not, both readings are right: OPS-7 is a Highest that's done.
  listTask("list-ops-highest", "test", "Show me the OPS issues whose priority is Highest.", /priority\s*(=|in)\s*\(?["']?highest/i, [
    "project = OPS AND priority = Highest",
    "project = OPS AND priority = Highest AND statusCategory != Done",
  ]),

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
    checks.searchedWith(e, /--page-token/, "asks for the next page");
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
  issueTask("issue-due", "train", "When is WEB-3 due?", "WEB-3", /(2026-10-24|oct(ober)?\.? 24|24(th)? oct(ober)?)/i),
  issueTask("issue-link", "test", "Give me the link to MRT-1.", "MRT-1", "https://example.atlassian.net/browse/MRT-1"),
  issueTask("issue-priority", "train", "What priority does DSK-1 have?", "DSK-1", /\bhigh\b/i),
  issueTask("issue-summary", "val", "What is OPS-8 about?", "OPS-8", /502/),
  // An issue that isn't there: said so, no status made up.
  task("issue-missing", "test", "single-issue", "What's the status of WEB-404?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => cmd(c).includes("WEB-404"), "looks WEB-404 up");
    e.answer("WEB-404");
    e.answerNot(/(\bis|status( is)?:?|it's)\s+["'*]*(to do|in progress|in review|done)\b/i, "doesn't make a status up");
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
    checks.namesStatuses(e, run);
  }),

  // Assignments, through the person's accountId.
  assignTask("assign-marco", "train", "Assign WEB-4 to Marco Bianchi.", "WEB-4", ACCOUNTS.marco),
  assignTask("assign-giulia", "val", "Give OPS-4 to Giulia.", "OPS-4", ACCOUNTS.giulia),
  assignTask("assign-surname", "test", "Assign MRT-4 to Ferri.", "MRT-4", ACCOUNTS.giulia),
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
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?WEB/.test(cmd(c)) && /--type[ =]"?bug/i.test(cmd(c)), "creates a WEB bug");
    e.answer("WEB-11");
  }),
  task("create-assigned", "val", "create", "Open a task in OPS to renew the VPN certificate and give it to Giulia Ferri.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?OPS/.test(cmd(c)), "creates the OPS task");
    e.that(
      "OPS-9 ends up with Giulia",
      calls(run).some((c) => c.ok && cmd(c).includes(ACCOUNTS.giulia) && (cmd(c).includes("issue create") || (cmd(c).includes("issue assign") && cmd(c).includes("OPS-9")))),
    );
    e.answer("OPS-9");
  }),
  task("create-task", "test", "create", "Make a task in MRT: pin the Bun version in CI.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?MRT/.test(cmd(c)), "creates the MRT task");
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
  wordingTask("wording-todo", "train", "How many WEB issues are todo?", /status\s*(=|in\s*\()\s*["']to do["']|statusCategory\s*(=|in\s*\()\s*["']?to do/i, 5, "WEB"),
  wordingTask("wording-review", "val", "How many tickets are waiting for review in WEB?", /status\s*(=|in\s*\()\s*["']in review["']/i, 1, "WEB"),
  wordingTask("wording-progress", "test", "How many OPS issues have the status in progres?", /status\s*(=|in\s*\()\s*["']in progress["']/i, 2, "OPS"),

  // Dates relative to today.
  dateTask("dates-overdue", "train", "Which open issues in WEB are overdue?", ["WEB-5", "WEB-7"], ["WEB-2", "WEB-3", "WEB-8", "WEB-10"]),
  dateTask("dates-created-week", "val", "Which OPS issues were created in the last seven days?", ["OPS-2", "OPS-6", "OPS-8"], ["OPS-3", "OPS-4", "OPS-5"]),
  // DSK-1 is due today: `duedate >= now()` leaves it out (a due date is its day's midnight, as in
  // Jira) and `duedate >= startOfDay()` takes it in. Both are right, so only DSK-2 is required.
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
    checks.searched(e, new RegExp(`ada moretti|${ACCOUNTS.adaMoretti}`, "i"), "filters by Ada Moretti in JQL, by name or accountId");
    e.answer("WEB-5");
    e.answer("OPS-6");
  }),

  // Delete: staged, the token kept out of the answer.
  task("delete-staged", "train", "delete", "Delete WEB-6, we don't need it any more.", (run, e) => {
    checks.loadsSkill(e);
    const staged = jiraCalls(run, "issue delete").find((c) => c.pending && cmd(c).includes("WEB-6"));
    e.that("stages the delete of WEB-6", staged !== undefined);
    const token = (staged?.output as { token?: string } | undefined)?.token;
    e.that("keeps the token out of the answer", token !== undefined && !run.last.answer.includes(token));
  }),
  task("delete-staged-other", "test", "delete", "Remove DSK-3 from Jira.", (run, e) => {
    checks.loadsSkill(e);
    const staged = jiraCalls(run, "issue delete").find((c) => c.pending && cmd(c).includes("DSK-3"));
    e.that("stages the delete of DSK-3", staged !== undefined);
    const token = (staged?.output as { token?: string } | undefined)?.token;
    e.that("keeps the token out of the answer", token !== undefined && !run.last.answer.includes(token));
  }),

  // Follow-ups: recall what was said, re-query what may have changed.
  task("followup-requery-filter", "train", "follow-up", ["Show me the open issues in WEB.", "Which of those are Marco's?"], (run, e) => {
    checks.loadsSkill(e);
    const second = run.turns[1]?.calls ?? [];
    // "Marco" alone isn't a value Jira takes for assignee: the full name or the accountId is.
    e.that("filters by searching again, with Marco in the JQL", second.some((c) => c.ok && cmd(c).includes("issue search") && new RegExp(`marco bianchi|${ACCOUNTS.marco}`, "i").test(jqlOf(c))));
    e.that("names WEB-8, or shows the filtered list", run.last.answer.includes("WEB-8") || second.some((c) => c.tool === "present" && c.ok));
  }),
  task("followup-requery-state", "val", "follow-up", ["Show me the open issues in OPS.", "Move OPS-4 to In Progress.", "Is OPS-4 still To Do?"], (run, e) => {
    const third = run.turns[2]?.calls ?? [];
    e.that(
      "reads OPS-4 again instead of answering from memory",
      third.some((c) => c.ok && /issue (get|search)/.test(cmd(c)) && (cmd(c).includes("OPS-4") || /project\s*=\s*"?OPS/i.test(jqlOf(c)))),
    );
    e.answer(/in progress/i);
  }),
  task("followup-recall", "test", "follow-up", ["How many open issues are there in DSK?", "What did you search to find that?"], (run, e) => {
    const second = run.turns[1]?.calls ?? [];
    e.that(
      "recalls the earlier call or answers without a new search",
      second.some((c) => c.tool === "recall_tool_calls") || !second.some((c) => c.tool === "jiraCommand" && cmd(c).includes("issue search")),
    );
    e.answer(/DSK/, "the answer says which project it searched");
    e.answer(/(status|done|open|not (yet )?(finished|closed|resolved))/i, "and that it looked at the open ones");
  }),
  task("followup-show-again", "train", "follow-up", ["Show me the open bugs in WEB.", "Show me that list again."], (run, e) => {
    const second = run.turns[1]?.calls ?? [];
    e.that("shows the list again with present", second.some((c) => c.tool === "present" && c.ok));
    // Three of the four bugs in the text, in any order, is the list typed out.
    const typed = ["WEB-10", "WEB-7", "WEB-5", "WEB-3"].filter((key) => new RegExp(`${key}(?!\\d)`).test(run.last.answer));
    e.that("doesn't type the list out", typed.length < 3);
  }),
];
