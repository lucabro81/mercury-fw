/**
 * Deterministic text interception for the "confirm" half of the
 * confirm-required flow (something stages an action and hands back a token —
 * see `confirmation-staging.ts` for the "propose" half). `tryConfirm` is called
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

/**
 * Returns `null` if `input` doesn't look like a bare confirmation token —
 * the caller should proceed with its normal flow (`runTurn`, etc.).
 * Otherwise always returns a user-facing string, resolved without ever
 * invoking the model: an unknown/expired/wrong-session token gets a
 * canned message, a valid one actually runs the staged action and
 * reports the outcome. No `conferma ` keyword to type or match — the
 * real gate was always `store.take()`'s existence/session/owner/expiry check,
 * not that prefix (see `isTokenShaped`'s own doc comment). A card button
 * click on Google Chat and a bare token typed on the terminal both resolve
 * through this exact same path.
 */
export type ConfirmDeps = {
  store: ConfirmationStore;
  /** The person confirming (the core's user key): the token resolves only if they staged it. */
  owner: string;
  vaultPath: string;
  writeConfirmationNoteFn: WriteConfirmationNote;
  now?: () => Date;
};

/** Resolves a token to a structured {@link ConfirmOutcome} (from `@mercury-fw/channel-types`), running the staged action for a match. See `tryConfirm` for the string-returning wrapper. */
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
  const resolvedAt = (deps.now?.() ?? new Date()).toISOString();
  // Overwrites the same note the propose half wrote (see
  // `confirmation-staging.ts`) so the persistent record reflects what actually
  // happened, never stuck saying "pending" — see the stale-primer bug this
  // guards against. Same resilience tradeoff as the propose side: a
  // wiki-write failure must not stop the user from getting their result.
  try {
    await deps.writeConfirmationNoteFn(deps.vaultPath, deps.owner, token, {
      status: result.ok ? "confirmed" : "failed",
      requestedAt: staged.requestedAt ?? resolvedAt,
      resolvedAt,
      command: staged.describe,
    });
  } catch (err) {
    console.error(`[confirm-flow] failed to write confirmation note: ${String(err)}`);
  }
  return result.ok ? { status: "ok", data: result.data } : { status: "failed", error: result.error };
}

export async function tryConfirm(
  input: string,
  sessionKey: string,
  deps: ConfirmDeps,
): Promise<string | null> {
  const outcome = await resolveConfirmation(input, sessionKey, deps);
  switch (outcome.status) {
    case "not-a-token":
      return null;
    case "not-found":
      return "Nessuna conferma in sospeso per questo token — potrebbe essere scaduta, già usata, o mai esistita.";
    case "failed":
      return `Confermato, ma l'esecuzione è fallita: ${outcome.error}`;
    case "ok":
      return `Confermato ed eseguito: ${JSON.stringify(outcome.data)}`;
  }
}
