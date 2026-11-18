/**
 * The web-researcher starter's check: asked about something current, the
 * agent searches the web and answers with a link to where it read it, or
 * asks the person's go to open the page it would read it in.
 */
import { e2e } from "@mercury-fw/cli/e2e";

export default e2e({
  plugins: ["web-search"],
  cases: [
    {
      name: "searches the web for something current, and links its source",
      turns: ["What is the latest stable release of the Bun JavaScript runtime? Tell me where you read it."],
      repeat: 3,
      check: (run, expect) => {
        expect.call("web_search", undefined, "searches the web");
        expect.everyCall("web_search", (c) => c.ok, "no search failed");
        // Reading a page on a site it hasn't read from before waits for the
        // person's go, and the turn stops there: then the source is the page it
        // asked to open.
        const asked = run.last.calls.some((c) => c.tool === "web_fetch" && c.pending);
        expect.that("links its source, or asks to open it", asked || /https?:\/\//.test(run.last.answer));
      },
    },
  ],
});
