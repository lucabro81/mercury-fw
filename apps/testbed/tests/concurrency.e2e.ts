/**
 * Concurrent turns, end to end, on a test bed app with the HTTP channel and
 * the static auth provider (the same setup as `http-auth.e2e.ts`): runs as it
 * is, with no plugin, once the app's `AUTH_STATIC_TOKENS` holds the two tokens
 * below (see README.md) and the service is running (`bunx mfw start`). From
 * the app's folder: `bunx mfw e2e ../../tests/concurrency.e2e.ts`.
 *
 * The cases: Alice and Bob talk at the same time, each in a conversation of
 * their own, and neither gets the other's word back; and Alice sends two turns
 * at once on one conversation (two tabs on one chat), and each gets its own
 * answer. That the core runs those two one after the other can't be told from
 * outside (the archive stores each turn's question and answer together once it
 * ends, and the model server may queue them anyway): the turn runner's own
 * tests guard it.
 */
import { e2e } from "@mercury-fw/cli/e2e";

/** Words nobody would guess, one per person or tab. */
const ALICE_WORD = "tamarind-58";
const BOB_WORD = "persimmon-92";
const FIRST_TAB = "kumquat-14";
const SECOND_TAB = "loquat-63";

/** The two turns that leave `word` in a conversation and ask it back. */
const rememberAndRecall = (word: string) => [
  `Remember this word for later in this conversation: ${word}. Just reply OK.`,
  "What word did I ask you to remember? Reply with the word only.",
];

export default e2e({
  users: { alice: "alice-test-token", bob: "bob-test-token" },
  cases: [
    {
      name: "Alice and Bob at the same time each get their own word back",
      channel: "http",
      lanes: [
        { as: "alice", turns: rememberAndRecall(ALICE_WORD) },
        { as: "bob", turns: rememberAndRecall(BOB_WORD) },
      ],
      check: (run, expect) => {
        const [alice, bob] = run.lanes!;
        expect.that("every turn served with 200", run.turns.every((t) => t.status === 200));
        expect.that("Alice gets her word", alice!.last.answer.includes(ALICE_WORD));
        expect.that("Alice doesn't get Bob's", !alice!.last.answer.includes(BOB_WORD));
        expect.that("Bob gets his word", bob!.last.answer.includes(BOB_WORD));
        expect.that("Bob doesn't get Alice's", !bob!.last.answer.includes(ALICE_WORD));
      },
    },
    {
      name: "two turns at once on one conversation each get their own answer",
      channel: "http",
      as: "alice",
      lanes: [
        { conversation: "two-tabs", turns: [`Reply with exactly this word and nothing else: ${FIRST_TAB}`] },
        { conversation: "two-tabs", turns: [`Reply with exactly this word and nothing else: ${SECOND_TAB}`] },
      ],
      check: (run, expect) => {
        const [first, second] = run.lanes!;
        expect.that("both served with 200", run.turns.every((t) => t.status === 200));
        expect.that("the first tab gets its word", first!.last.answer.includes(FIRST_TAB));
        expect.that("the first tab doesn't get the other's", !first!.last.answer.includes(SECOND_TAB));
        expect.that("the second tab gets its word", second!.last.answer.includes(SECOND_TAB));
        expect.that("the second tab doesn't get the other's", !second!.last.answer.includes(FIRST_TAB));
      },
    },
  ],
});
