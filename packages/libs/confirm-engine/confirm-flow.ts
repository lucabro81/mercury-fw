/**
 * Deterministic text interception for the "confirm" half of the
 * confirm-required flow (something stages an action and hands back a token —
 * see `confirmation-staging.ts` for the "propose" half). `resolveConfirmation` is called
 * from each channel BEFORE the model ever sees the message, same pattern as
 * `/dump` (`tool-log.ts`) and `NO_REPLY` — running a previously-approved
 * mutation must never depend on the model's own tool-calling judgment.
 *
 * It knows nothing about what the staged action is: it runs the opaque `run`
 * thunk (see `StagedAction`) and reports the outcome. A CLI delete, a future
 * memory purge — same path, because the doing was closed over at stage time.
 */
import type { ConfirmOutcome } from "@mercury-fw/channel-types";
import { isTokenShaped, type ConfirmationStore } from "./confirmation-store.ts";

/**
 * Signature of the persistent confirmation-note writer the core injects (the
 * app's `writeConfirmationNote`, kept in `wiki/`). Declared here so this library
 * stays free of any app import; the real writer is structurally assignable.
 */
export type WriteConfirmationNote = (
  vaultPath: string,
  owner: string,
  token: string,
  fields: { status: "pending" | "confirmed" | "failed"; requestedAt: string; resolvedAt: string | null; command: string },
) => Promise<void>;

/** A confirmed action whose result goes back to the model: the tool call it
 * resumes the turn as (`toolName`, `input`), what it returned (`output`), and
 * what it was (`describe`, `label` of the choice taken) for the history. */
export type ResumedAction = { describe: string; label?: string; toolName: string; input: unknown; output: unknown };

export type ConfirmDeps = {
  store: ConfirmationStore;
  /** Keeps a confirmed action's result for `sessionKey`'s resumed turn. Without
   * it, a resumable action's result goes to the person like any other. */
  onResume?: (sessionKey: string, action: ResumedAction) => void;
  /** The person confirming (the core's user key): the token resolves only if they staged it. */
  owner: string;
  vaultPath: string;
  writeConfirmationNoteFn: WriteConfirmationNote;
  now?: () => Date;
};

/**
 * Resolves `input` to a structured {@link ConfirmOutcome} (from
 * `@mercury-fw/channel-types`) without ever invoking the model: `not-a-token`
 * when it doesn't look like a bare confirmation token (the caller goes on with
 * its normal flow), `not-found` for an unknown, expired or someone else's
 * token, and for a match the staged action's outcome, once it ran. No keyword
 * to type or match: the gate is `store.take()`'s existence/session/owner/expiry
 * check. A card button click on Google Chat and a bare token typed on the
 * terminal both resolve through this same path; what the person is told is the
 * core's, in their language.
 */
export async function resolveConfirmation(
  input: string,
  sessionKey: string,
  deps: ConfirmDeps,
): Promise<ConfirmOutcome> {
  const token = input.trim();
  if (!isTokenShaped(token)) {
    return { status: "not-a-token" };
  }

  const staged = deps.store.take(sessionKey, deps.owner, token);
  if (!staged) {
    return { status: "not-found" };
  }

  const result = await staged.run();
  const command = staged.label === undefined ? staged.describe : `${staged.describe} — ${staged.label}`;
  const resolvedAt = (deps.now?.() ?? new Date()).toISOString();
  // Overwrites the same note the propose half wrote (see
  // `confirmation-staging.ts`) so the persistent record reflects what actually
  // happened, never stuck saying "pending" — see the stale-primer bug this
  // guards against. Same resilience tradeoff as the propose side: a
  // wiki-write failure must not stop the user from getting their result.
  try {
    await deps.writeConfirmationNoteFn(deps.vaultPath, deps.owner, staged.noteToken ?? token, {
      status: result.ok ? "confirmed" : "failed",
      requestedAt: staged.requestedAt ?? resolvedAt,
      resolvedAt,
      command,
    });
  } catch (err) {
    console.error(`[confirm-flow] failed to write confirmation note: ${String(err)}`);
  }
  if (!result.ok) return { status: "failed", error: result.error };
  if (staged.resume && deps.onResume) {
    deps.onResume(sessionKey, {
      describe: staged.describe,
      ...(staged.label === undefined ? {} : { label: staged.label }),
      toolName: staged.resume.toolName,
      input: staged.resume.input,
      output: result.data,
    });
    return { status: "resume" };
  }
  return { status: "ok", data: result.data };
}

