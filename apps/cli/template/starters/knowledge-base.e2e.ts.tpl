/**
 * The knowledge-base starter's check: asked about a topic, the agent loads
 * the Confluence skill and searches Confluence before answering. It names no
 * page or space of yours, so it runs as it is; add cases with what your
 * Confluence actually holds.
 */
import { e2e } from "@mercury-fw/cli/e2e";

/** The command line of a `confluenceCommand` call. */
const command = (input: unknown) => String((input as { command?: unknown }).command ?? "");

export default e2e({
  plugins: ["confluence"],
  cases: [
    {
      name: "looks a topic up in Confluence, loading its skill first",
      turns: ["What does our Confluence say about onboarding? Name the pages you used."],
      repeat: 3,
      check: (run, expect) => {
        expect.call("read_skill", (c) => (c.input as { name?: string }).name === "confluence", "loads the confluence skill");
        expect.call("confluenceCommand", (c) => command(c.input).startsWith("confluence page search"), "searches the pages");
        expect.everyCall("confluenceCommand", (c) => c.ok, "no confluence command failed");
      },
    },
  ],
});
