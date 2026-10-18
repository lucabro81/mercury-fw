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
import type { StageChoices, StageConfirmation } from "@mercury-fw/plugin-types";
import type { WriteConfirmationNote } from "./confirm-flow.ts";

export type { StageChoices, StageConfirmation };

/** What both staging closures are bound to (see the module comment). */
type StagingDeps = {
  store: ConfirmationStore;
  sessionKey: string;
  /** The person staging the action (the core's user key): the only one who can confirm it, and whose note it is. */
  owner: string;
  vaultPath: string;
  /** The note writer, injected by the core (the app's `writeConfirmationNote`). */
  writeConfirmationNoteFn: WriteConfirmationNote;
  /** Test seam; defaults to `() => new Date()`. */
  nowFn?: () => Date;
};

/** Writes the "pending" note of what was staged under `token`; best-effort, a failure is only logged. */
async function writePendingNote(deps: StagingDeps, token: string, requestedAt: string, describe: string): Promise<void> {
  try {
    await deps.writeConfirmationNoteFn(deps.vaultPath, deps.owner, token, {
      status: "pending",
      requestedAt,
      resolvedAt: null,
      command: describe,
    });
  } catch (err) {
    console.error(`[confirmation-staging] failed to write confirmation note: ${String(err)}`);
  }
}

/** Stages one action behind one token. */
export function createStageConfirmation(deps: StagingDeps): StageConfirmation {
  const nowFn = deps.nowFn ?? (() => new Date());

  return async (action) => {
    const requestedAt = nowFn().toISOString();
    const token = deps.store.stage(deps.sessionKey, deps.owner, { run: action.run, describe: action.describe, requestedAt });
    await writePendingNote(deps, token, requestedAt, action.describe);
    return token;
  };
}

/**
 * Stages one action offered as several choices, as one group of the store.
 * The group gets one note, under its first token: the one a channel shows
 * first and the history's `[REQ:<token>]` marker carries.
 */
export function createStageChoices(deps: StagingDeps): StageChoices {
  const nowFn = deps.nowFn ?? (() => new Date());

  return async (action) => {
    if (action.choices.length === 0) throw new Error("stageChoices needs at least one choice");
    const requestedAt = nowFn().toISOString();
    const tokens = deps.store.stageGroup(
      deps.sessionKey,
      deps.owner,
      action.choices.map((c) => ({
        run: c.run,
        describe: action.describe,
        requestedAt,
        label: c.label,
        ...(c.resume === undefined ? {} : { resume: c.resume }),
      })),
    );
    await writePendingNote(deps, tokens[0]!, requestedAt, action.describe);
    return action.choices.map((c, i) => ({ label: c.label, token: tokens[i]! }));
  };
}
