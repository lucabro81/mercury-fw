/**
 * Deduplicates what `src/index.ts` used to do twice: two near-identical
 * ~50-line closures, one per channel, that (1) tracked the session for
 * Layer-3 capture when the channel has a real per-user identity, (2) ran
 * `runTurn` with a channel-specific tool set/system prompt/output sink,
 * and (3) mirrored new messages to Qdrant and extracted procedural
 * corrections once the turn resolved. `createTurnRunner` is that shared
 * body, parameterized entirely by `Provider`/`InboundTurn`/`TurnSink`
 * (`src/router/provider.ts`) so it doesn't know or care which provider a
 * given turn came from — same channel-agnostic spirit as `runTurn` itself.
 */
import type { LanguageModel, Tool } from "ai";
import { runTurn } from "../session/agent-turn.ts";
import type { StepInfo } from "../session/step-info.ts";
// `PostTurnGuard` is part of the plugin contract (a plugin's `build()` may
// return these to inspect/rewrite the model's finished text), so it lives in
// `@mercury-fw/plugin-types` and is re-exported here for the core callers that
// import it from this module. No plugin ships one today; the mechanism stays
// generic for future use. A guard that throws is caught by the core and never
// blocks delivery — a guard failure is a quality miss, not a reason to
// withhold an already-generated answer.
import type { PostTurnGuard } from "@mercury-fw/plugin-types";
export type { PostTurnGuard };
import type { SessionHistory } from "../session/history.ts";
import { recordStep } from "../session/tool-log-buffer.ts";
import type { HandleTurn, InboundTurn, TurnSink } from "./provider.ts";
import { createPeople, type Identified, type TurnWho } from "../identity/people.ts";
export type { TurnWho };
import { createSessionLock, type SessionLock } from "./session-lock.ts";

export type TurnRunnerDeps = {
  model: LanguageModel;
  /** Both variants, precomposed by the composition root; selected per turn by `turn.multiUser`. Used when `systemPromptsFor` is absent. */
  systemPrompts: { singleUser: string; multiUser: string };
  /** The prompts for what `who` is offered (see `plugins/offering.ts`); `systemPrompts` for everyone when absent. */
  systemPromptsFor?: (who: TurnWho) => { singleUser: string; multiUser: string };
  /**
   * Who the turn's principal is (see `identity/people.ts`); refused, the turn
   * answers the refusal and runs nothing. Defaults to no directory: the person
   * is whoever the channel says.
   */
  identify?: (principal: InboundTurn["principal"]) => Promise<Identified>;
  /** `key` is the person's key, `who` whom the tools are offered to and act for. */
  buildTools: (
    sessionKey: string,
    key: string,
    who: TurnWho,
    onToolStart?: TurnSink["onToolStart"],
    onToolFinish?: TurnSink["onToolFinish"],
  ) => Record<string, Tool>;
  /**
   * `key` is the user key, forwarded (not interpreted here) so a provider's
   * own closure can decide whether to seed a first-ever session with a
   * context primer (see `src/session/context-primer.ts`); `undefined` when
   * nobody vouched for the person, since a primer needs a real identity.
   */
  getOrCreateHistory: (sessionKey: string, trackForCapture: boolean, key: string | undefined) => Promise<SessionHistory> | SessionHistory;
  /** Layer-3 session tracking (sessionUsers map + idle scanner touch). Only for turns whose person a provider vouched for. */
  trackSession: (sessionKey: string, key: string, at: number) => void;
  /** Refreshes this turn's tool-status callbacks for out-of-band capture messages. */
  registerCaptureCallback: (sessionKey: string, onToolStart: TurnSink["onToolStart"], onToolFinish: TurnSink["onToolFinish"]) => void;
  /** Mid-conversation Layer-3 capture threshold check. Only for turns whose person a provider vouched for. */
  maybeCapture: (sessionKey: string, history: SessionHistory) => Promise<void>;
  /**
   * Archives one message of the verbatim user↔model exchange (issue #4).
   * Wired by the composition root to the verbatim-archive provider; absent
   * on an instance with no such provider. Only called for turns whose person
   * a provider vouched for (the archive is per-person, like Layer-3 capture),
   * with `userId` set to the space-independent user key, and only ever with
   * the model's own answer text — never the appended `present` displays.
   */
  captureVerbatim?: (msg: {
    sessionKey: string;
    userId: string;
    role: "user" | "assistant";
    content: string;
  }) => Promise<void>;
  processToolCorrections: (steps: StepInfo[], onToolStart: TurnSink["onToolStart"], onToolFinish: TurnSink["onToolFinish"]) => Promise<void>;
  logStep: (prefix: string, step: StepInfo) => void;
  /** Test seam; defaults to the real `recordStep`. */
  recordStepFn?: typeof recordStep;
  /** Test seam; defaults to the real `runTurn`. */
  runTurnFn?: typeof runTurn;
  /**
   * Post-turn guards contributed by loaded plugins, run in order over the
   * model's finished text (see `PostTurnGuard`). Empty/absent on an instance
   * with no plugin that registers one. The composition root builds these; the
   * core knows nothing about what any of them does.
   */
  postTurnGuards?: PostTurnGuard[];
  /**
   * Test seam; defaults to `console.log`. Receives a guard's own `log` line,
   * or the core's own note when a guard throws. Exists to measure real-world
   * guard frequency before investing further.
   */
  logPostTurnGuardFn?: (message: string) => void;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Returns the display artifacts the model surfaced via `present` this turn
   * (see `display-store.ts`), in stash order, to append after the model's
   * text. Absent on an instance with no display store — nothing is appended.
   * The old unconditional splicing of every tool-produced display is gone:
   * an artifact is shown only when the model explicitly presented it.
   */
  takeSurfacedDisplays?: (sessionKey: string) => string[];
  /**
   * Serialises everything that touches one session: this runner's turns and
   * whatever else the composition root runs on a session (the idle sweep).
   * Defaults to a lock of the runner's own.
   */
  sessionLock?: SessionLock;
};

/** Builds the shared `HandleTurn` every provider's driver calls once it has a real message to run through the model. */
export function createTurnRunner(deps: TurnRunnerDeps): HandleTurn {
  const postTurnGuards = deps.postTurnGuards ?? [];
  const logPostTurnGuard = deps.logPostTurnGuardFn ?? ((message: string) => console.log(message));
  const sessionLock = deps.sessionLock ?? createSessionLock();
  const identify = deps.identify ?? createPeople({ directory: "none" }).identify;

  // One turn at a time per session, post-turn work included (it reads the
  // history and the capture markers); a turn whose client went away while
  // it waited never starts, but its sink is still released.
  return async (turn: InboundTurn, sink: TurnSink): Promise<void> => {
    let started = false;
    await sessionLock.run(
      turn.sessionKey,
      () => {
        started = true;
        return runTurnLocked(turn, sink);
      },
      turn.abortSignal,
    );
    if (!started) sink.dispose();
  };

  async function runTurnLocked(turn: InboundTurn, sink: TurnSink): Promise<void> {
    // Someone the core won't talk to gets the refusal, and nothing of theirs
    // is created: no history, no capture.
    const identified = await identify(turn.principal);
    if (!identified.ok) {
      try {
        await sink.finalize(identified.message);
      } finally {
        sink.dispose();
      }
      return;
    }
    const who: TurnWho = { person: identified.person, operator: identified.operator };
    // The person's key is what every per-person store uses. The operator still
    // gets one, so its wiki area works like anyone's, but it's never tracked
    // for Layer-3 capture.
    const key = who.person.key;
    const tracked = !who.operator;
    const prompts = deps.systemPromptsFor?.(who) ?? deps.systemPrompts;
    if (tracked) {
      deps.trackSession(turn.sessionKey, key, (deps.now ?? Date.now)());
      deps.registerCaptureCallback(turn.sessionKey, sink.onToolStart, sink.onToolFinish);
    }

    const steps: StepInfo[] = [];
    let history: SessionHistory;
    // The model's own answer text (post-guards, before any surfaced `present`
    // display is appended) — what the verbatim archive stores as the
    // assistant's message. Assigned once the turn resolves successfully.
    let assistantText = "";

    try {
      // Inside the try, not before it: a failure building the history
      // (e.g. the context-primer's Qdrant query) must still release the
      // sink (see TurnSink.dispose's doc comment) — a stuck-note timer
      // already scheduled when the sink was constructed keeps running
      // otherwise, firing on its own 60s schedule regardless of whether
      // the turn itself already failed and was reported.
      history = await deps.getOrCreateHistory(turn.sessionKey, tracked, tracked ? key : undefined);
      const text = await (deps.runTurnFn ?? runTurn)(history, turn.text, {
        model: deps.model,
        tools: deps.buildTools(turn.sessionKey, key, who, sink.onToolStart, sink.onToolFinish),
        system: turn.multiUser ? prompts.multiUser : prompts.singleUser,
        onTextChunk: sink.onTextChunk,
        onReasoningChunk: sink.onReasoningChunk,
        onReasoningEnd: sink.onReasoningEnd,
        onStepFinish: (step) => {
          steps.push(step);
          deps.logStep(turn.logPrefix, step);
          (deps.recordStepFn ?? recordStep)(turn.channel, turn.sessionKey, key, step);
          sink.onStep?.(step);
        },
        onUsage: sink.onUsage,
        abortSignal: turn.abortSignal,
      });

      let correctedText = text;
      // Plugin-contributed post-turn guards, run in order. `shouldRun` gates
      // both the rewrite and its status indicator (so a guard that doesn't
      // engage shows nothing), and reuses the same onToolStart/onToolFinish
      // machinery already shared with real tool calls and Layer-3 capture pings
      // — terminal's dim-print and Google Chat's status-card patching both
      // handle any (label, detail?, toolCallId?) triple generically. A guard
      // that throws is caught here and never blocks delivery.
      for (const guard of postTurnGuards) {
        if (!guard.shouldRun(correctedText)) {
          continue;
        }
        sink.onToolStart(guard.statusLabel, undefined, guard.statusId);
        try {
          const guarded = await guard.run(correctedText, steps);
          sink.onToolFinish?.(guard.statusId, guarded.outcome);
          if (guarded.log !== undefined) {
            logPostTurnGuard(guarded.log);
          }
          correctedText = guarded.text;
        } catch (err) {
          sink.onToolFinish?.(guard.statusId, "failed");
          logPostTurnGuard(
            `[post-turn-guard] guard "${guard.statusId}" threw, kept text unchanged: ${String(err instanceof Error ? err.message : err)}`,
          );
        }
      }

      if (correctedText !== text) {
        history.replaceLastAssistantMessage(correctedText);
      }
      assistantText = correctedText;

      // Append only what the model chose to `present` this turn — never the
      // whole set of tool-produced displays. Appending (not replacing) keeps
      // the already-streamed prefix intact, so terminal.ts's safe-slice holds.
      const surfaced = deps.takeSurfacedDisplays?.(turn.sessionKey) ?? [];
      const finalText = [correctedText, ...surfaced].filter((part) => part !== "").join("\n\n");
      await sink.finalize(finalText);
    } finally {
      sink.dispose();
    }

    if (tracked) {
      // Activity at the end too: a turn longer than the idle timeout must not
      // look idle the moment it ends.
      deps.trackSession(turn.sessionKey, key, (deps.now ?? Date.now)());
      await deps.maybeCapture(turn.sessionKey, history);
      // Fail-soft: the verbatim archive is pure enrichment (principle #3).
      // The answer is already delivered; a capture failure must never
      // propagate out of this awaited handler and take the process down.
      if (deps.captureVerbatim) {
        // The archive is per-person and space-independent, so it keys on the
        // user key (the same identity the wiki and the rest of memory use),
        // not the space-scoped session.
        try {
          await deps.captureVerbatim({ sessionKey: turn.sessionKey, userId: key, role: "user", content: turn.text });
          await deps.captureVerbatim({
            sessionKey: turn.sessionKey,
            userId: key,
            role: "assistant",
            content: assistantText,
          });
        } catch (err) {
          console.log(
            `[verbatim-archive] capture failed, turn unaffected: ${String(err instanceof Error ? err.message : err)}`,
          );
        }
      }
    }
    await deps.processToolCorrections(steps, sink.onToolStart, sink.onToolFinish);
  }
}
