/**
 * The HTTP surface's authentication, end to end, on a test bed app with the
 * HTTP channel and the static auth provider: runs as it is, with no plugin,
 * once the app's `AUTH_STATIC_TOKENS` holds the two tokens below (see
 * README.md) and the service is running (`bunx mfw start`). From the app's
 * folder: `bunx mfw e2e ../../tests/http-auth.e2e.ts`.
 *
 * The cases: a token the app doesn't know gets a 401 and no turn; a known
 * one gets an answer; a conversation belongs to whoever opened it, so Bob
 * sending Alice's conversation id lands in a conversation of his own and
 * doesn't see what she said there, while Alice still does; and a note the
 * model writes for Alice lands in her own area of the wiki, where Bob's
 * wiki tools can't find it.
 */
import { e2e } from "@mercury-fw/cli/e2e";

/** A word nobody would guess, for Alice to leave in her conversation. */
const WORD = "pomegranate-77";
/** Another one, for the note Alice has Mercury write. */
const NOTE_WORD = "quince-31";
/** Where Alice's note lands in the vault: her area, named after her user key. */
const ALICE_NOTE = '"$WIKI_VAULT_PATH/users/static%3Aalice/notes/e2e-isolation.md"';

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
    {
      name: "a note written for Alice stays in her area, out of Bob's reach",
      channel: "http",
      as: "alice",
      before: ({ cli }) => cli(`rm -f ${ALICE_NOTE}`),
      turns: [
        `Write a note for me in the wiki at personal/notes/e2e-isolation.md whose content is exactly: ${NOTE_WORD}. Then reply OK.`,
        {
          text: `Search the wiki for ${NOTE_WORD} and tell me what you find. If you find nothing, reply exactly: NOTHING FOUND.`,
          as: "bob",
        },
      ],
      check: async (run, expect, { cli }) => {
        expect.call("write_file", undefined, "Alice's turn writes the note");
        const note = await cli(`cat ${ALICE_NOTE}`);
        expect.that("the note is in Alice's area", note.code === 0 && note.output.includes(NOTE_WORD));
        // Bob's question names the word, so the answer may repeat it: what
        // matters is that his search finds nothing, and no path to the note.
        expect.answer("NOTHING FOUND", "Bob doesn't find it");
        expect.answerNot("e2e-isolation", "Bob doesn't learn where it is");
      },
    },
  ],
});
