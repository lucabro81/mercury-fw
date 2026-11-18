/**
 * The web-researcher starter's check: asked about something current, the
 * agent searches the web and answers with a link to where it read it.
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
        expect.answer(/https?:\/\//, "links its source");
      },
    },
  ],
});
