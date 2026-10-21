/**
 * #291: asked what it can do, the model answers from the list of the plugins
 * offered to the person, each with its description, in the person's
 * language, saying what each one lets it do rather than naming tools.
 *
 * Needs an app with the web search plugin (`--plugins web-search`); a question
 * about what it can do needs no tool, so the case runs with no credentials.
 */
import { e2e } from "@mercury-fw/cli/e2e";

export default e2e({
  plugins: ["web-search"],
  cases: [
    {
      name: "says what it can do from its plugins, in Italian, without naming tools",
      repeat: 5,
      minPasses: 5,
      turns: ["Ciao, cosa sai fare?"],
      check: (run, expect) => {
        expect.callCount({ max: 0 }, "web_search");
        expect.callCount({ max: 0 }, "web_fetch");
        expect.answer(/\b(web|internet|online)\b/i, "names the web search");
        expect.answer(/\b(cerc|ricerc|leggo|leggere|pagin)/i, "in Italian");
        expect.answerNot(/web_search|web_fetch/, "names no tool");
      },
    },
  ],
});
