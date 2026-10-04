/**
 * Layer-3 capture of live sessions: who each tracked session belongs to, how
 * much of its history is already mirrored to memory, and the two
 * mid-conversation triggers that mirror the rest, the message-count threshold
 * (`maybeCapture`, after a turn) and a Layer-1 compression (`onCompress`).
 * The idle sweep does the final capture itself and calls `close`.
 *
 * The marker counts messages of the history's current view (`getMessages()`),
 * which a compression restarts. So `onCompress` fixes the slice it captures and
 * resets the marker on the spot, before anything else can read it, and its
 * capture, running on its own, never touches the marker again.
 */
import type { TurnSink } from "../router/provider.ts";
import type { Message } from "./history.ts";

type CaptureCallbacks = { onToolStart: TurnSink["onToolStart"]; onToolFinish: TurnSink["onToolFinish"] };

export type SessionCaptureDeps = {
  /** Mirrors `messages` of the session `sessionKey`, owned by `userId`, to memory; rejects on failure. */
  capture: (userId: string, sessionKey: string, messages: Message[]) => Promise<void>;
  /** How many new messages a session needs before `maybeCapture` mirrors them. */
  threshold: number;
  /** The detail line a capture's status shows, from the messages it captures. */
  describe?: (pending: Message[]) => string;
  log?: (message: string) => void;
};

export type SessionCapture = {
  /** Starts (or keeps) tracking `sessionKey` as `userId`'s. */
  track(sessionKey: string, userId: string): void;
  /** The turn's tool-status callbacks, which a capture starting from now on reports to. */
  registerCallbacks(sessionKey: string, callbacks: CaptureCallbacks): void;
  /** The user a tracked session belongs to. */
  userOf(sessionKey: string): string | undefined;
  /** Captures what's new in `messages` once there are `threshold` new ones; the marker moves only on success. */
  maybeCapture(sessionKey: string, messages: Message[]): Promise<void>;
  /** For `createSessionHistory`'s `onBeforeCompress`: captures what wasn't captured yet of `messages`, in the background. */
  onCompress(sessionKey: string, messages: Message[]): void;
  /** Forgets the session, once the idle sweep closed it. */
  close(sessionKey: string): void;
  /** Resolves once every background capture started so far has settled (tests, shutdown). */
  settled(): Promise<void>;
};

/** Builds the capture state for one instance. */
export function createSessionCapture(deps: SessionCaptureDeps): SessionCapture {
  const log = deps.log ?? ((message: string) => console.error(message));
  const users = new Map<string, string>();
  // How many of a session's current view are already mirrored to memory.
  const markers = new Map<string, number>();
  const callbacks = new Map<string, CaptureCallbacks>();
  const inFlight = new Set<Promise<unknown>>();

  /** Captures `pending`, reporting to the session's current callbacks; resolves whether it succeeded. */
  async function capturePending(sessionKey: string, userId: string, pending: Message[]): Promise<boolean> {
    const status = callbacks.get(sessionKey);
    const captureId = crypto.randomUUID();
    status?.onToolStart("Mi sto segnando un'informazione importante…", deps.describe?.(pending), captureId);
    try {
      await deps.capture(userId, sessionKey, pending);
      status?.onToolFinish?.(captureId, "success");
      return true;
    } catch (err) {
      log(`[capture] failed for ${sessionKey}, will retry next trigger: ${String(err)}`);
      status?.onToolFinish?.(captureId, "failed");
      return false;
    }
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
      const marker = markers.get(sessionKey) ?? 0;
      if (messages.length - marker < deps.threshold) return;
      if (await capturePending(sessionKey, userId, messages.slice(marker))) {
        markers.set(sessionKey, messages.length);
      }
    },
    onCompress(sessionKey, messages) {
      const userId = users.get(sessionKey);
      if (userId === undefined) return;
      const pending = messages.slice(markers.get(sessionKey) ?? 0);
      // The view after compression starts fresh, whatever happens to this capture.
      markers.set(sessionKey, 0);
      if (pending.length === 0) return;
      const running = capturePending(sessionKey, userId, pending);
      inFlight.add(running);
      void running.finally(() => inFlight.delete(running));
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
