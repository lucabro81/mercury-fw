/**
 * The Jira skill's training data for the skill trainer (apps/skill-trainer):
 * the plugin built on the trainer's fake CLI, answered from a made-up Jira
 * (world.ts) made anew for every task, and the tasks the skill is scored on
 * (tasks-basic.ts, tasks-hard.ts), checked with checks.ts.
 */
import type { SkillTraining } from "../../../../apps/skill-trainer/src/contract.ts";
import { formatter, formatterPlugin } from "../../../formatters/formatter/index.ts";
import type { JiraDisplays } from "../index.ts";
import { createJiraPlugin } from "../plugin.ts";
import { BASIC_TASKS } from "./tasks-basic.ts";
import { HARD_TASKS } from "./tasks-hard.ts";
import { jiraFixtures, makeWorld } from "./world.ts";

/** One issue in a list, as `mfw create` writes the rule into a new app: without
 * a formatter the list has no rendered items, so no `displayRef` to present. */
const jiraIssueLine = (issue: JiraDisplays["issue-list"]) => `${issue.key} ${issue.status ? `[${issue.status}] ` : ""}${issue.summary}\n${issue.url}`;

export default {
  skill: "jira",
  plugin: (runCliFn) => formatterPlugin(createJiraPlugin({ runCliFn }), formatter<JiraDisplays>({ "issue-list": { item: jiraIssueLine, empty: "No matching issues." } })),
  fixtures: () => jiraFixtures(makeWorld()),
  tasks: [...BASIC_TASKS, ...HARD_TASKS],
} satisfies SkillTraining;

