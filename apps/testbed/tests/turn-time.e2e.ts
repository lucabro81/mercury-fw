/**
 * #293: every turn reaches the model after when and where the person wrote
 * it, in the time zone they're in; told where they are, the model saves it
 * (`set_time_zone`) and the next turn is stamped there.
 *
 * Runs on any test bed app, with no plugin and no credentials, on the REPL.
 * Each case says where the person is first, so it doesn't depend on a zone an
 * earlier run saved.
 */
import { e2e } from "@mercury-fw/cli/e2e";

/** The answer's turn may start a few minutes before the check runs. */
const LATELY = [0, 5 * 60_000];

/** The weekday in `timeZone`, in Italian, now and a few minutes ago (a midnight in between). */
function weekdays(timeZone: string): string[] {
  const format = new Intl.DateTimeFormat("it-IT", { timeZone, weekday: "long" });
  return LATELY.map((ago) => format.format(new Date(Date.now() - ago)));
}

/** The hour in `timeZone`, now and a few minutes ago, as `HH`. */
function hours(timeZone: string): string[] {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" });
  return LATELY.map((ago) => format.format(new Date(Date.now() - ago)));
}

/** A `set_time_zone` call saving `zone`. */
const saving = (zone: string) => (call: { input: unknown }) => (call.input as { timeZone?: string }).timeZone === zone;

export default e2e({
  cases: [
    {
      name: "knows today's weekday where the person is, without a tool and without echoing the stamp",
      repeat: 5,
      minPasses: 5,
      turns: ["Sono a Roma.", "Che giorno della settimana è oggi? Rispondi con il giorno soltanto."],
      check: (run, expect) => {
        expect.call("set_time_zone", saving("Europe/Rome"), "saves Rome");
        expect.that("no tool on the question", run.last.calls.length === 0);
        const days = weekdays("Europe/Rome");
        expect.that(`answers ${days.join(" or ")}`, days.some((day) => run.last.answer.toLowerCase().includes(day)));
        expect.answerNot(/\[\w+day \d{4}-/, "doesn't repeat the stamp");
      },
    },
    {
      name: "told it's in Tokyo, tells Tokyo's time",
      repeat: 5,
      minPasses: 5,
      turns: ["Sono a Tokyo.", "Che ore sono adesso? Rispondi con l'ora nel formato HH:MM, nient'altro."],
      check: (run, expect) => {
        expect.call("set_time_zone", saving("Asia/Tokyo"), "saves Tokyo");
        const hh = hours("Asia/Tokyo");
        expect.that(`answers ${hh.join(" or ")}:MM`, hh.some((h) => new RegExp(`\\b${h}[:.]\\d{2}\\b`).test(run.last.answer)));
      },
    },
  ],
});
