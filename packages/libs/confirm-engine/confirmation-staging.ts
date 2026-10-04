/**
 * The "stage" side of the confirm-required flow, as a core-owned closure handed
 * to whoever needs to defer an irreversible action (today the CLI tool; a
 * future memory-deleting plugin all the same). It mints the confirmation token,
 * stashes the opaque action in the `ConfirmationStore`, and writes the "pending"
 * paper-trail note — so the caller never touches the store internals or the
 * wiki, and the confirmation subsystem stays the one place that knows an action
 * is confirmable. The "resolve" side (running the staged thunk once the token
 * comes back) is `tryConfirm` in `confirm-flow.ts`.
 *
 * Bound per session (sessionKey/owner/vaultPath) at the composition root, so
 * the returned function takes only the action itself. `owner` is the person
 * staging it: only they can confirm it, and the note is written for them. The
 * note's write is best-effort: a failure is logged, never thrown, so it can't
 * stop the user from seeing and confirming the action.
 */
import type { ConfirmationStore } from "./confirmation-store.ts";
import type { StageConfirmation } from "@mercury-fw/plugin-types";
import type { WriteConfirmationNote } from "./confirm-flow.ts";

export type { StageConfirmation };

export function createStageConfirmation(deps: {
  store: ConfirmationStore;
  sessionKey: string;
  /** The person staging the action (the core's user key): the only one who can confirm it, and whose note it is. */
  owner: string;
  vaultPath: string;
  /** The note writer, injected by the core (the app's `writeConfirmationNote`). */
  writeConfirmationNoteFn: WriteConfirmationNote;
  /** Test seam; defaults to `() => new Date()`. */
  nowFn?: () => Date;
}): StageConfirmation {
  const write = deps.writeConfirmationNoteFn;
  const nowFn = deps.nowFn ?? (() => new Date());

  return async (action) => {
    const requestedAt = nowFn().toISOString();
    const token = deps.store.stage(deps.sessionKey, deps.owner, { run: action.run, describe: action.describe, requestedAt });
    try {
      await write(deps.vaultPath, deps.owner, token, {
        status: "pending",
        requestedAt,
        resolvedAt: null,
        command: action.describe,
      });
    } catch (err) {
      console.error(`[confirmation-staging] failed to write confirmation note: ${String(err)}`);
    }
    return token;
  };
}
