/**
 * The HTTP surface's authentication, end to end, on a test bed app with the
 * HTTP channel and the static auth provider: runs as it is, with no plugin,
 * once the app's `AUTH_STATIC_TOKENS` holds the two tokens below (see
 * README.md) and the service is running (`bunx mfw start`). From the app's
 * folder: `bunx mfw e2e ../../tests/http-auth.e2e.ts`.
 *
 * The cases: a token the app doesn't know gets a 401 and no turn; a known
 * one gets an answer; and a conversation belongs to whoever opened it, so Bob
 * sending Alice's conversation id lands in a conversation of his own and
 * doesn't see what she said there, while Alice still does.
 */
import { e2e } from "@mercury-fw/cli/e2e";

/** A word nobody would guess, for Alice to leave in her conversation. */
const WORD = "pomegranate-77";

export default e2e({
  users: { alice: "alice-test-token", bob: "bob-test-token", stranger: "not-a-token" },
  cases: [
    {
      name: "a token the app doesn't know: 401, no turn",
      channel: "http",
      as: "stranger",
      turns: ["hi"],
      check: (run, expect) => {
        expect.that("refused with 401", run.last.status === 401);
        expect.answer("unauthorized");
      },
    },
    {
      name: "a known token: an answer",
      channel: "http",
      as: "alice",
      turns: ["Reply with the single word: ready"],
      check: (run, expect) => {
        expect.that("served with 200", run.last.status === 200);
        expect.answer(/ready/i);
      },
    },
    {
      name: "Bob, in Alice's conversation id, doesn't see what she said",
      channel: "http",
      as: "alice",
      turns: [
        `Remember this word for later in this conversation: ${WORD}. Just reply OK.`,
        { text: "What word did I ask you to remember? If I didn't ask you anything, say so.", as: "bob" },
        "What word did I ask you to remember?",
      ],
      check: (run, expect) => {
        expect.that("Bob doesn't get the word", !run.turns[1]!.answer.includes(WORD));
        expect.answer(WORD, "Alice still gets it");
      },
    },
  ],
});
