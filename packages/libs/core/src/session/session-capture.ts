/**
 * Layer-3 capture of live sessions: who each tracked session belongs to, how
 * much of its history is already mirrored to memory, and the two
 * mid-conversation trigger that mirrors the rest, the message-count threshold
 * (`maybeCapture`, after a turn). The idle sweep does the final capture itself
 * and calls `close`.
 *
 * Every capture runs on its own, as background work (`deps.job`, the core's
 * queue for the model, #383): nothing waits for it, not even the session's
 * next turn.
 *
 * The marker counts messages of the conversation's current view
 * (`getCapturable()`), which a compression restarts: a view shorter than the
 * marker restarts the count from it. Each trigger fixes the slice it captures
 * and moves the marker on the spot, before anything else can read it. A
 * capture that fails puts it back, unless something moved it again meanwhile.
 */
import type { TurnSink } from "../router/provider.ts";
import type { Message } from "./history.ts";
import { englishTexts, type Texts, type Translate } from "../i18n/i18n.ts";

type CaptureCallbacks = { onToolStart: TurnSink["onToolStart"]; onToolFinish: TurnSink["onToolFinish"] };

export type SessionCaptureDeps = {
  /** Mirrors `messages` of the session `sessionKey`, owned by `userId`, to memory; rejects on failure. `trigger` is for the traces. */
  capture: (userId: string, sessionKey: string, messages: Message[], trigger: "threshold") => Promise<void>;
  /** How many new messages a session needs before `maybeCapture` mirrors them. */
  threshold: number;
  /** The detail line a capture's status shows, from the messages it captures, in the session's person's language (`t`). */
  describe?: (pending: Message[], t: Translate) => string;
  /** The status's texts, in the language of the person the session is; English when absent. */
  texts?: Texts;
  log?: (message: string) => void;
  /** Runs one capture as background work (the core's queue for the model); run directly when absent. */
  job?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export type SessionCapture = {
  /** Starts (or keeps) tracking `sessionKey` as `userId`'s. */
  track(sessionKey: string, userId: string): void;
  /** The turn's tool-status callbacks, which a capture starting from now on reports to. */
  registerCallbacks(sessionKey: string, callbacks: CaptureCallbacks): void;
  /** The user a tracked session belongs to. */
  userOf(sessionKey: string): string | undefined;
  /** Starts capturing what's new in `messages` once there are `threshold` new ones, without waiting for it; a failed capture leaves those messages for the next trigger. */
  maybeCapture(sessionKey: string, messages: Message[]): Promise<void>;
  /** Forgets the session, once the idle sweep closed it. */
  close(sessionKey: string): void;
  /** Resolves once every background capture started so far has settled (tests, shutdown). */
  settled(): Promise<void>;
};

/** Builds the capture state for one instance. */
export function createSessionCapture(deps: SessionCaptureDeps): SessionCapture {
  const log = deps.log ?? ((message: string) => console.error(message));
  const texts = deps.texts ?? englishTexts();
  const users = new Map<string, string>();
  // How many of a session's current view are already mirrored to memory.
  const markers = new Map<string, number>();
  const callbacks = new Map<string, CaptureCallbacks>();
  const inFlight = new Set<Promise<unknown>>();
  const job = deps.job ?? (<T,>(fn: () => Promise<T>) => fn());

  /** Keeps `running` until it settles, for `settled()`. */
  const track = (running: Promise<unknown>) => {
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
  };

  /** Captures `pending`, reporting to the session's current callbacks; resolves whether it succeeded. */
  function capturePending(sessionKey: string, userId: string, pending: Message[], trigger: "threshold"): Promise<boolean> {
    const status = callbacks.get(sessionKey);
    return job(async () => {
      const captureId = crypto.randomUUID();
      const { t } = texts.forPerson(userId);
      // The capture can run long after its turn: a channel gone by now never loses it.
      const ping = (fn: () => void) => {
        try {
          fn();
        } catch (err) {
          log(`[capture] status for ${sessionKey} not shown: ${String(err)}`);
        }
      };
      ping(() => status?.onToolStart(t("core.status.remembering"), deps.describe?.(pending, t), captureId));
      try {
        await deps.capture(userId, sessionKey, pending, trigger);
        ping(() => status?.onToolFinish?.(captureId, "success"));
        return true;
      } catch (err) {
        log(`[capture] failed for ${sessionKey}, will retry next trigger: ${String(err)}`);
        ping(() => status?.onToolFinish?.(captureId, "failed"));
        return false;
      }
    }).catch(() => false);
  }

  return {
    track(sessionKey, userId) {
      users.set(sessionKey, userId);
    },
    registerCallbacks(sessionKey, cbs) {
      callbacks.set(sessionKey, cbs);
    },
    userOf: (sessionKey) => users.get(sessionKey),
    async maybeCapture(sessionKey, messages) {
      const userId = users.get(sessionKey);
      if (userId === undefined) return;
      // Shorter than what was captured: the conversation compressed, its view starts over.
      if (messages.length < (markers.get(sessionKey) ?? 0)) markers.set(sessionKey, 0);
      const marker = markers.get(sessionKey) ?? 0;
      if (messages.length - marker < deps.threshold) return;
      const upTo = messages.length;
      markers.set(sessionKey, upTo);
      track(
        capturePending(sessionKey, userId, messages.slice(marker), "threshold").then((ok) => {
          if (!ok && markers.get(sessionKey) === upTo) markers.set(sessionKey, marker);
        }),
      );
    },
    close(sessionKey) {
      users.delete(sessionKey);
      markers.delete(sessionKey);
      callbacks.delete(sessionKey);
    },
    async settled() {
      await Promise.all([...inFlight]);
    },
  };
}
