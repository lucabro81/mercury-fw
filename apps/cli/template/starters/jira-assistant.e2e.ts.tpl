/**
 * The jira-assistant starter's check: asked for the person's open issues, the
 * agent loads the Jira skill and searches with `--select`, never guessing. It
 * names no project or issue of yours, so it runs as it is; add cases with
 * what your Jira actually holds.
 */
import { e2e } from "@mercury-fw/cli/e2e";

/** The command line of a `jiraCommand` call. */
const command = (input: unknown) => String((input as { command?: unknown }).command ?? "");

export default e2e({
  plugins: ["jira"],
  cases: [
    {
      name: "finds my open issues with a search, loading the skill first",
      turns: ["Which Jira issues assigned to me are still open?"],
      repeat: 3,
      check: (run, expect) => {
        expect.call("read_skill", (c) => (c.input as { name?: string }).name === "jira", "loads the jira skill");
        expect.call("jiraCommand", (c) => command(c.input).startsWith("jira issue search"), "searches the issues");
        expect.everyCall("jiraCommand", (c) => command(c.input).includes("--select "), "every jira command has --select");
        expect.everyCall("jiraCommand", (c) => c.ok, "no jira command failed");
      },
    },
  ],
});
