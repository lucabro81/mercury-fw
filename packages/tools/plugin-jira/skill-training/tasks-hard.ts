/**
 * The harder Jira tasks, written where a small model goes wrong: requests in
 * Italian as people actually write them, people named by first name (a user
 * search before the JQL, since Jira takes no partial name), filters combined,
 * counts across pages, Jira's errors to recover from, the `present` discipline
 * (show, don't show, show again), empty fields, requests to ask about instead
 * of guessing, follow-ups over several turns, and a wiki that already knows a
 * project's informal name. Values follow from world.ts.
 */
import type { Call, TrainingTask } from "../../../../apps/skill-trainer/src/contract.ts";
import { RELATIVE_DATE, assignTask, calls, checks, cmd, countTask, dateTask, issueTask, jiraCalls, jqlOf, listTask, task, transitionTask, wordingTask } from "./checks.ts";
import { ACCOUNTS, makeWorld } from "./world.ts";

/** A pattern for a person in JQL: the full name or the accountId. */
const person = (name: string, accountId: string) => new RegExp(`${name}|${accountId}`, "i");

/** The note mapping informal project names, for the tasks whose wiki already has it. */
const PROJECT_NOTE = {
  "curated/jira-projects.md":
    "# Jira projects\n\nWhat people call the Jira projects, and their keys.\n\n- the shop, il negozio: WEB (Storefront)\n- the backoffice: OPS (Platform Operations)\n",
};

/** The keys, in order, of the last search that worked in turn `turn`: the list the model got, whatever order it asked for. */
function listedKeys(run: Parameters<TrainingTask["check"]>[0], turn: number): string[] {
  const searches = (run.turns[turn]?.calls ?? []).filter((c) => c.ok && cmd(c).includes("issue search"));
  const data = (searches.at(-1)?.output as { data?: { issues?: Array<{ key?: string }> } } | undefined)?.data;
  return (data?.issues ?? []).map((i) => i.key).filter((k): k is string => typeof k === "string");
}

/** Whether `run` staged the delete of `key`, and kept its token out of the answer. */
function stagedDelete(run: Parameters<TrainingTask["check"]>[0], key: string): { staged: boolean; tokenKept: boolean } {
  const staged = jiraCalls(run, "issue delete").find((c) => c.pending && cmd(c).includes(key));
  const token = (staged?.output as { token?: string } | undefined)?.token;
  return { staged: staged !== undefined, tokenKept: token !== undefined && !run.last.answer.includes(token) };
}

/** A comment on `key` that worked, tagging `accountId` either way the CLI takes it. */
const mentions = (key: string, accountId: string) => (c: Call) =>
  c.ok && cmd(c).includes("issue comment add") && cmd(c).includes(key) && (cmd(c).includes(`--mention ${accountId}`) || cmd(c).includes(`{{mention:${accountId}}}`));

export const HARD_TASKS: TrainingTask[] = [
  // Lists, in Italian, by first name, with combined filters, and keys only.
  listTask("h-list-it-web", "test", "Fammi vedere le issue aperte di WEB.", /project\s*=\s*"?WEB/i, ["project = WEB AND statusCategory != Done"]),
  listTask("h-list-unassigned", "train", "Show me the open WEB issues nobody is assigned to.", /assignee\s*(is|=)\s*(empty|null)/i, [
    "project = WEB AND assignee is EMPTY AND statusCategory != Done",
  ]),
  listTask("h-list-it-high-bugs", "test", "Mostrami i bug aperti con priorità alta o massima, in tutti i progetti.", /priority\s*(in\s*\(|=).*high/i, [
    "issuetype = Bug AND priority in (High, Highest) AND statusCategory != Done",
  ]),
  listTask("h-list-giulia", "val", "Show me Giulia's open issues.", person("giulia ferri", ACCOUNTS.giulia), ['assignee = "Giulia Ferri" AND statusCategory != Done']),
  listTask("h-list-it-review", "test", "Cosa c'è in review in questo momento?", /status\s*(=|in)\s*\(?\s*["']in review["']/i, ['status = "In Review"']),
  listTask("h-list-stories", "train", "List the open stories.", /(issuetype|type)\s*(=|in)\s*\(?\s*"?story/i, ["issuetype = Story AND statusCategory != Done"]),
  listTask("h-list-it-mine", "test", "Le mie issue aperte, per favore.", /currentUser\(\)/i, ["assignee = currentUser() AND statusCategory != Done"]),
  task("h-list-keys-only", "train", "list", "Just give me the keys of the open OPS bugs, no list.", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /(issuetype|type)\s*=\s*"?bug/i, "searches the OPS bugs");
    checks.notPresented(e);
    for (const key of ["OPS-2", "OPS-4", "OPS-8"]) e.answer(key);
  }),

  // Counts across projects and pages, by person, and what isn't there.
  countTask("h-count-it-web", "test", "Quante issue aperte ci sono in WEB?", /project\s*=\s*"?WEB/i, 8),
  countTask("h-count-all-bugs", "val", "How many open bugs are there across all projects?", /(issuetype|type)\s*=\s*"?bug/i, 9),
  task("h-count-log-total", "test", "count", "How many issues does LOG have in total, done ones included?", (run, e) => {
    checks.loadsSkill(e);
    checks.searchedWith(e, /--page-token/, "asks for the next page");
    checks.number(e, 137);
    checks.notPresented(e);
  }),
  task("h-count-it-log-todo", "train", "count", "Quante issue di LOG sono ancora da fare?", (run, e) => {
    checks.loadsSkill(e);
    checks.searchedWith(e, /--page-token/, "asks for the next page");
    checks.number(e, 120);
    checks.notPresented(e);
  }),
  countTask("h-count-ada-conti", "test", "How many open issues does Ada Conti have?", person("ada conti", ACCOUNTS.adaConti), 3),
  task("h-count-lena", "val", "count", "How many open issues does Lena Hoffmann have?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, person("lena hoffmann", ACCOUNTS.lena), "searches Lena's issues");
    e.answer(/\b(0|zero|none|no open|doesn't have|does not have)\b/i, "the answer says she has none");
    checks.notPresented(e);
  }),
  countTask("h-count-my-bugs", "test", "How many open bugs do I have?", /currentUser\(\)/i, 3),
  countTask("h-count-it-unassigned", "train", "Quante issue aperte non sono assegnate a nessuno tra WEB e OPS?", /assignee\s+is\s+(empty|null)/i, 3),
  countTask("h-count-highest", "test", "How many open issues have Highest priority, in all projects?", /priority\s*(=|in)\s*\(?\s*"?highest/i, 2),
  countTask("h-count-it-giulia", "test", "Quante issue ha ancora aperte Giulia?", person("giulia ferri", ACCOUNTS.giulia), 3),

  // One issue: empty fields said as empty, several fields, Italian.
  task("h-issue-unassigned", "test", "single-issue", "Who's assigned to WEB-4?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("WEB-4"), "reads WEB-4");
    e.answer(/(nobody|no one|unassigned|not assigned|no assignee)/i, "says nobody is");
    e.answerNot(/(Sam Rivera|Ada|Marco|Giulia|Lena)/, "doesn't name anyone");
  }),
  task("h-issue-no-due", "val", "single-issue", "When is MRT-2 due?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("MRT-2"), "reads MRT-2");
    e.answer(/(no due|not set|none|doesn't have|does not have|no deadline)/i, "says it has no due date");
    e.answerNot(/2026/, "doesn't make a date up");
  }),
  issueTask("h-issue-it-status", "test", "In che stato è OPS-5?", "OPS-5", /in review/i),
  task("h-issue-multi", "train", "single-issue", "Give me the priority, the assignee and the due date of DSK-2.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("DSK-2"), "reads DSK-2");
    e.answer(/medium/i);
    e.answer("Giulia Ferri");
    e.answer(/(2026-10-23|oct(ober)?\.? 23|23(rd)? oct(ober)?)/i, "says it's due on 2026-10-23");
    checks.selects(e, run);
  }),
  issueTask("h-issue-type", "test", "Is WEB-8 a bug or a story?", "WEB-8", /story/i),
  issueTask("h-issue-it-link", "train", "Mi dai il link di OPS-8?", "OPS-8", "https://example.atlassian.net/browse/OPS-8"),
  task("h-issue-missing-it", "test", "single-issue", "Esiste la issue OPS-99? In che stato è?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => cmd(c).includes("OPS-99"), "looks OPS-99 up");
    e.answerNot(/(\bis|\bè|stato( è)?:?|status( is)?:?|it's)\s+["'*]*(to do|in progress|in review|done)\b/i, "doesn't make a status up");
  }),
  issueTask("h-issue-project", "val", "Which project is DSK-2 in?", "DSK-2", /customer desk/i),

  // Transitions: Italian, several at once, a status that isn't one, an issue that isn't there.
  transitionTask("h-move-it-done", "test", "Chiudi OPS-2, è risolto.", "OPS-2", "Done"),
  transitionTask("h-move-start", "train", "Start working on WEB-4.", "WEB-4", "In Progress"),
  transitionTask("h-move-it-review", "test", "Metti WEB-8 in review.", "WEB-8", "In Review"),
  task("h-move-unknown-it", "val", "transition", "Sposta MRT-2 in Testing.", (run, e) => {
    checks.loadsSkill(e);
    e.that("doesn't move MRT-2 to a status it wasn't asked for", !jiraCalls(run, "issue transition ").some((c) => c.ok && cmd(c).includes("MRT-2")));
    checks.namesStatuses(e, run);
  }),
  task("h-move-two", "test", "transition", "Move WEB-9 and OPS-4 to In Progress.", (run, e) => {
    checks.loadsSkill(e);
    for (const key of ["WEB-9", "OPS-4"]) {
      e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue transition ") && cmd(c).includes(key) && /--to[ =]["']?in progress/i.test(cmd(c)), `moves ${key}`);
    }
  }),
  task("h-move-reopen", "train", "transition", "Reopen DSK-3.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue transition ") && cmd(c).includes("DSK-3") && /--to[ =]["']?to do["']?(\s|$)/i.test(cmd(c)), "moves DSK-3 back to To Do");
  }),
  task("h-move-missing", "test", "transition", "Move WEB-404 to Done.", (run, e) => {
    checks.loadsSkill(e);
    e.that("doesn't claim a transition that failed", !jiraCalls(run, "issue transition ").some((c) => c.ok));
    e.answer("WEB-404");
  }),

  // Assignments by first name or surname, an ambiguous one, two at once, someone who isn't there.
  assignTask("h-assign-it-marco", "test", "Assegna OPS-4 a Marco.", "OPS-4", ACCOUNTS.marco),
  task("h-assign-it-ada", "test", "assign", "Assegna MRT-4 ad Ada.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "finds the people with user search");
    e.that("doesn't assign before knowing which Ada", !jiraCalls(run, "issue assign").some((c) => c.ok));
    e.answer("Moretti");
    e.answer("Conti");
  }),
  assignTask("h-assign-surname", "val", "Give WEB-4 to Moretti.", "WEB-4", ACCOUNTS.adaMoretti),
  task("h-assign-it-unassign", "train", "assign", "Togli l'assegnatario da OPS-6.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue assign") && cmd(c).includes("OPS-6") && cmd(c).includes("--unassign"), "unassigns OPS-6");
  }),
  task("h-assign-two", "test", "assign", "Assign WEB-4 and WEB-9 to Giulia Ferri.", (run, e) => {
    checks.loadsSkill(e);
    for (const key of ["WEB-4", "WEB-9"]) {
      e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue assign") && cmd(c).includes(key) && cmd(c).includes(ACCOUNTS.giulia), `assigns ${key} to Giulia`);
    }
  }),
  task("h-assign-inactive", "train", "assign", "Assign WEB-9 to Lena Hoffmann.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "finds Lena with user search");
    e.that("doesn't claim an assignment Jira refused", !jiraCalls(run, "issue assign").some((c) => c.ok));
    e.answer(/(can't|cannot|couldn't|could not|unable|inactive|deactivated|not be assigned|refused)/i, "says it couldn't be done");
  }),
  task("h-assign-nobody", "train", "assign", "Assign WEB-4 to Paolo Verdi.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "looks the person up");
    e.that("doesn't assign to someone else", !jiraCalls(run, "issue assign").some((c) => c.ok));
    e.answer(/paolo verdi/i);
  }),

  // Comments: Italian, by first name, ambiguous, two people, inline.
  task("h-comment-it", "test", "comment", "Scrivi un commento su WEB-5: il fix è in revisione.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue comment add") && cmd(c).includes("WEB-5") && /revision/i.test(cmd(c)), "comments on WEB-5");
  }),
  task("h-comment-firstname", "val", "comment", "Comment on OPS-3 asking Giulia to review it, and tag her.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", mentions("OPS-3", ACCOUNTS.giulia), "tags Giulia by accountId");
  }),
  task("h-comment-ambiguous", "test", "comment", "Tag Ada in a comment on DSK-1 asking for an update.", (run, e) => {
    checks.loadsSkill(e);
    e.that("doesn't comment before knowing which Ada", !jiraCalls(run, "issue comment add").some((c) => c.ok));
    e.answer("Moretti");
    e.answer("Conti");
  }),
  task("h-comment-two", "train", "comment", "On WEB-3, comment that Marco and Giulia should sync on it, tagging both.", (run, e) => {
    checks.loadsSkill(e);
    // In one comment or in two, one tag each: both readings are right.
    const comments = jiraCalls(run, "issue comment add").filter((c) => c.ok && cmd(c).includes("WEB-3")).map(cmd).join("\n");
    e.that("tags Marco", comments.includes(ACCOUNTS.marco));
    e.that("tags Giulia", comments.includes(ACCOUNTS.giulia));
  }),
  task("h-comment-it-inline", "test", "comment", "Commenta su MRT-1 ringraziando Ada Moretti, taggandola nel testo.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue comment add") && cmd(c).includes("MRT-1") && cmd(c).includes(`{{mention:${ACCOUNTS.adaMoretti}}}`), "tags Ada Moretti inside the text");
  }),

  // Creating: Italian, with a priority, in a project named informally, for someone, in a project that isn't there.
  task("h-create-it-bug", "test", "create", "Apri un bug in DSK: il PDF della fattura non si scarica.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?DSK/.test(cmd(c)) && /--type[ =]"?bug/i.test(cmd(c)), "creates a DSK bug");
    e.answer("DSK-4");
  }),
  task("h-create-priority", "train", "create", "Create a High priority task in WEB: update the cookie banner.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?WEB/.test(cmd(c)) && /--priority[ =]"?high/i.test(cmd(c)), "creates it with High priority");
    e.answer("WEB-11");
  }),
  task("h-create-informal", "test", "create", "Create a task in the tooling project: document the release steps.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("project search"), "finds the project with project search");
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?MRT/.test(cmd(c)), "creates it in MRT");
    e.answer("MRT-5");
  }),
  task("h-create-for-marco", "val", "create", "Open a bug in OPS for Marco: the backup job hangs at 90%.", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue create") && /--project[ =]"?OPS/.test(cmd(c)), "creates the OPS bug");
    e.that(
      "OPS-9 ends up with Marco",
      calls(run).some((c) => c.ok && cmd(c).includes(ACCOUNTS.marco) && (cmd(c).includes("issue create") || (cmd(c).includes("issue assign") && cmd(c).includes("OPS-9")))),
    );
    e.answer("OPS-9");
  }),
  task("h-create-unknown-project", "test", "create", "Create a task in project ZZZ: check the backups.", (run, e) => {
    checks.loadsSkill(e);
    e.that("tries the create or looks the project up", jiraCalls(run, "issue create").length > 0 || jiraCalls(run, "project search").length > 0);
    e.that("doesn't claim an issue it didn't create", !jiraCalls(run, "issue create").some((c) => c.ok && !/\s(--help|-h)\b/.test(cmd(c))));
    e.answer("ZZZ", "says it's about project ZZZ");
    e.answerNot(/ZZZ-\d+/, "doesn't make a key up");
  }),

  // Projects by an informal name: the wiki knows it, Italian, nothing matches.
  task("h-wiki-hit", "train", "informal-project", "How many open issues does the shop have?", (run, e) => {
    checks.loadsSkill(e);
    e.call("grep", undefined, "greps the wiki for the name first");
    checks.searched(e, /project\s*=\s*"?WEB/i, "searches WEB, as the wiki says");
    checks.number(e, 8);
  }),
  task("h-wiki-hit-it", "test", "informal-project", "Mostrami le issue aperte del negozio.", (run, e) => {
    checks.loadsSkill(e);
    e.call("grep", undefined, "greps the wiki for the name first");
    checks.searched(e, /project\s*=\s*"?WEB/i, "searches WEB, as the wiki says");
    checks.presented(e);
  }),
  task("h-wiki-hit-backoffice", "val", "informal-project", "Any open bugs in the backoffice?", (run, e) => {
    checks.loadsSkill(e);
    e.call("grep", undefined, "greps the wiki for the name first");
    checks.searched(e, /project\s*=\s*"?OPS/i, "searches OPS, as the wiki says");
    e.that(
      "names the three bugs, or shows them",
      ["OPS-2", "OPS-4", "OPS-8"].every((key) => run.last.answer.includes(key)) || calls(run).some((c) => c.tool === "present" && c.ok),
    );
  }),
  task("h-informal-it-desk", "test", "informal-project", "Quante issue aperte ha l'help desk?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("project search"), "finds the project with project search");
    checks.searched(e, /project\s*=\s*"?DSK/i, "searches DSK");
    checks.number(e, 2);
  }),
  task("h-informal-nomatch", "test", "informal-project", "How many open issues does the mobile app project have?", (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("project search"), "looks the project up");
    e.answer(/(couldn't|could not|can't|cannot|didn't|did not|no project|not find|not found|doesn't exist|does not exist)/i, "says there's no such project, instead of counting a guessed one");
  }),

  // Statuses worded the way people say them.
  // "da fare" reads as "not done" as well as "To Do": asked as "not started yet", it's To Do only.
  wordingTask("h-wording-it-todo", "test", "Quante issue di OPS non sono ancora iniziate?", /status\s*(=|in\s*\()\s*["']to do["']|statusCategory\s*(=|in\s*\()\s*["']?to do/i, 3, "OPS"),
  wordingTask("h-wording-closed", "train", "How many WEB issues are closed?", /status\s*(=|in\s*\()\s*["']?done|statusCategory\s*(=|in\s*\()\s*["']?done/i, 2, "WEB"),
  // MRT has nothing in review, so the In Progress category counts the same as the status.
  wordingTask("h-wording-wip", "val", "How many MRT issues are WIP?", /(status|statusCategory)\s*(=|in\s*\()\s*["']in progress["']/i, 1, "MRT"),
  wordingTask("h-wording-it-review", "test", "Quanti ticket di OPS aspettano una revisione?", /status\s*(=|in\s*\()\s*["']in review["']/i, 1, "OPS"),

  // Dates.
  task("h-dates-it-mine-overdue", "train", "relative-date", "Quali delle mie issue aperte sono scadute?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /currentUser\(\)/i, "searches with currentUser()");
    checks.searched(e, RELATIVE_DATE, "uses JQL's relative dates");
    for (const key of ["WEB-7", "OPS-2"]) e.answer(key);
    // Sam's other open issues are due later.
    checks.foundOnly(e, run, ["WEB-7", "OPS-2"], ["WEB-3", "MRT-1"]);
  }),
  // WEB-5 and WEB-7 are overdue, WEB-8 and WEB-2 due later: none of them is due in the next seven days.
  dateTask("h-dates-due-week", "test", "What's due in WEB in the next seven days?", ["WEB-3", "WEB-10"], ["WEB-2", "WEB-5", "WEB-7", "WEB-8"]),
  task("h-dates-it-no-due", "test", "relative-date", "Quali issue aperte di WEB non hanno una scadenza?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /duedate\s+is\s+(empty|null)/i, "searches the issues without a due date");
    for (const key of ["WEB-4", "WEB-9"]) e.answer(key);
  }),

  // The person talking.
  countTask("h-mine-it-count", "train", "Quante issue ho ancora aperte?", /currentUser\(\)/i, 4),
  task("h-mine-in-progress", "test", "mine", "What am I working on right now?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /currentUser\(\)/i, "searches with currentUser()");
    for (const key of ["WEB-3", "MRT-1"]) e.answer(key);
  }),
  task("h-mine-it-high", "val", "mine", "Ho issue aperte con priorità alta o massima?", (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, /currentUser\(\)/i, "searches with currentUser()");
    for (const key of ["WEB-3", "OPS-2"]) e.answer(key);
    // Sam's other open issues are Medium.
    checks.foundOnly(e, run, ["WEB-3", "OPS-2"], ["WEB-7", "MRT-1"]);
  }),

  // Deletes: staged, tokens kept out.
  task("h-delete-it", "test", "delete", "Cancella OPS-7.", (run, e) => {
    checks.loadsSkill(e);
    const { staged, tokenKept } = stagedDelete(run, "OPS-7");
    e.that("stages the delete of OPS-7", staged);
    e.that("keeps the token out of the answer", tokenKept);
  }),
  // One delete a turn: the core ends the turn as soon as one is staged for confirmation.
  task("h-delete-it-final", "train", "delete", "Elimina definitivamente WEB-1, non serve più.", (run, e) => {
    checks.loadsSkill(e);
    const { staged, tokenKept } = stagedDelete(run, "WEB-1");
    e.that("stages the delete of WEB-1", staged);
    e.that("keeps the token out of the answer", tokenKept);
  }),

  // Follow-ups over two and three turns.
  task("h-follow-it-second", "test", "follow-up", ["Mostrami le issue aperte di MRT.", "Chi lavora sulla seconda?"], (run, e) => {
    checks.loadsSkill(e);
    const key = listedKeys(run, 0)[1] ?? "MRT-2";
    const assignee = makeWorld().issues.find((i) => i.key === key)?.assignee?.displayName.split(" ")[0] ?? "nessuno";
    e.answer(new RegExp(assignee, "i"), `names the assignee of the second issue in the list it got (${key})`);
  }),
  task("h-follow-close-recount", "test", "follow-up", ["How many open issues are in DSK?", "Close DSK-2.", "And now how many are open?"], (run, e) => {
    const [second, third] = [run.turns[1]?.calls ?? [], run.turns[2]?.calls ?? []];
    e.that("closes DSK-2", second.some((c) => c.ok && cmd(c).includes("issue transition ") && cmd(c).includes("DSK-2") && /--to[ =]["']?done/i.test(cmd(c))));
    e.that("counts again instead of answering from memory", third.some((c) => c.ok && cmd(c).includes("issue search") && /DSK/i.test(jqlOf(c))));
    checks.number(e, 1);
  }),
  task("h-follow-assign-first", "val", "follow-up", ["Show me the unassigned open issues in WEB.", "Assign the first one to Marco."], (run, e) => {
    const second = run.turns[1]?.calls ?? [];
    const key = listedKeys(run, 0)[0] ?? "WEB-9";
    e.that(`assigns ${key}, the first in the list it got, to Marco`, second.some((c) => c.ok && cmd(c).includes("issue assign") && cmd(c).includes(key) && cmd(c).includes(ACCOUNTS.marco)));
  }),
  task("h-follow-it-count-then-list", "test", "follow-up", ["Quanti bug aperti ci sono in OPS?", "Fammeli vedere."], (run, e) => {
    const [first, second] = [run.turns[0]?.calls ?? [], run.turns[1]?.calls ?? []];
    e.that("doesn't show a list for the count", !first.some((c) => c.tool === "present"));
    e.that("shows the list when asked", second.some((c) => c.tool === "present" && c.ok));
    e.that("the count is three", /(?<![\w-])(3|three|tre)(?![\w-])/i.test(run.turns[0]?.answer ?? ""));
  }),
  task("h-follow-assignee", "train", "follow-up", ["What's the status of WEB-5?", "And who is assigned to it?"], (run, e) => {
    e.answer("Ada Moretti");
  }),
  task("h-follow-tag-them", "test", "follow-up", ["Who is working on OPS-3?", "Leave a comment there tagging them: is the firmware done?"], (run, e) => {
    const second = run.turns[1]?.calls ?? [];
    e.that("tags Marco on OPS-3", second.some(mentions("OPS-3", ACCOUNTS.marco)));
  }),
];

/** The tasks whose wiki starts with the note on informal project names. */
for (const t of HARD_TASKS) if (t.id.startsWith("h-wiki-hit")) t.vault = PROJECT_NOTE;
