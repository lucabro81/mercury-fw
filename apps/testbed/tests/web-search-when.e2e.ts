/**
 * #294: the model searches when the question shows it needs to (something
 * that changes over time), and doesn't for what needs no search (a lasting
 * fact, a calculation).
 *
 * Needs an app with the web search plugin (`--plugins web-search`), on the
 * REPL. The first case only checks that the model searches, not what the
 * search engine finds.
 */
import { e2e } from "@mercury-fw/cli/e2e";

export default e2e({
  plugins: ["web-search"],
  cases: [
    {
      name: "searches for a software's latest version, which changes over time",
      repeat: 5,
      minPasses: 5,
      turns: ["Qual è l'ultima versione di Bun?"],
      check: (_run, expect) => {
        expect.call("web_search", undefined, "searches the web");
      },
    },
    {
      name: "answers a lasting fact without searching",
      repeat: 5,
      minPasses: 5,
      turns: ["Chi ha scritto I promessi sposi?"],
      check: (_run, expect) => {
        expect.callCount({ max: 0 }, "web_search", "doesn't search");
        expect.callCount({ max: 0 }, "web_fetch", "doesn't read a page");
        expect.answer(/Manzoni/, "answers Manzoni");
      },
    },
    {
      name: "does a calculation without searching",
      repeat: 5,
      minPasses: 5,
      turns: ["Quanto fa 12 per 7?"],
      check: (_run, expect) => {
        expect.callCount({ max: 0 }, "web_search", "doesn't search");
        expect.answer(/\b84\b/, "answers 84");
      },
    },
  ],
});
