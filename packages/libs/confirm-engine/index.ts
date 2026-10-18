/**
 * The confirm-required mechanism the core owns end to end: the stateful
 * `ConfirmationStore` (mints tokens, stashes opaque staged actions with a TTL),
 * the "stage" half (`createStageConfirmation`, handed to whoever defers an
 * irreversible action) and the "resolve" half (`resolveConfirmation`/`tryConfirm`,
 * run before the model ever sees a message so a previously-approved mutation
 * never depends on the model).
 *
 * The core creates the single store instance and binds the store/vault/writer,
 * then hands channels only the injected `confirm`/`resolveConfirmation` closures
 * (via `ChannelRuntimeContext`) — a channel never imports this library. Nothing
 * here imports the app; the note writer is an injected `WriteConfirmationNote`.
 */
export {
  createConfirmationStore,
  isTokenShaped,
  type ConfirmationStore,
  type StagedAction,
} from "./confirmation-store.ts";
export {
  resolveConfirmation,
  tryConfirm,
  type ConfirmDeps,
  type ResumedAction,
  type WriteConfirmationNote,
} from "./confirm-flow.ts";
export { createStageChoices, createStageConfirmation, type StageChoices, type StageConfirmation } from "./confirmation-staging.ts";
