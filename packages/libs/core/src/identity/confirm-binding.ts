/**
 * The confirmation capability a channel gets (`ctx.confirm`,
 * `ctx.resolveConfirmation`), bound to this instance's store, vault and note
 * writer. The channel passes the caller's principal and the core identifies
 * the person, the same way the turn runner does before staging: a token
 * resolves only for whoever staged it, and its note is the one they staged.
 * Someone the core won't talk to confirms nothing. A link code (see
 * `linking.ts`) arrives the same way, before the model and raw, and goes to
 * linking, whoever sent it. Anything else is left to the turn without asking
 * who sent it. What the person is told is the core's, in their language (the
 * one they saved, else the channel's hint, else the default).
 */
import type { ChannelRuntimeContext, ConfirmOutcome, ConfirmReply } from "@mercury-fw/channel-types";
import { isTokenShaped, resolveConfirmation, type ConfirmDeps } from "@mercury-fw/confirm-engine";
import { createPeople, type People } from "./people.ts";
import { isLinkCode, type Linking } from "./linking.ts";
import { englishTexts, type Texts, type Translate } from "../i18n/i18n.ts";

/**
 * What the person is told about a resolved confirmation, in `t`'s language;
 * `null` when the input wasn't a token. A confirmed action's result is never
 * shown as it is (it's data, for the system): the reply says it was done.
 */
export function confirmReply(outcome: ConfirmOutcome, t: Translate): ConfirmReply | null {
  switch (outcome.status) {
    case "not-a-token":
      return null;
    case "not-found":
      return { text: t("core.confirm.not-found") };
    case "failed":
      return { text: t("core.confirm.failed", { error: outcome.error }) };
    case "ok":
      return { text: t("core.confirm.done") };
    case "resume":
      return { text: t("core.confirm.resume"), resume: true };
  }
}

/** `confirm` and `resolveConfirmation` over `deps`, each resolving as the person `identify` says the caller is, replying in their language (`texts`, English when absent). */
export function bindConfirm(
  deps: Omit<ConfirmDeps, "owner">,
  identify: People["identify"] = createPeople({ directory: "none" }).identify,
  redeemLink?: Linking["redeem"],
  texts: Texts = englishTexts(),
): Required<Pick<ChannelRuntimeContext, "confirm" | "resolveConfirmation">> {
  return {
    confirm: async (token, sessionKey, principal, hint) => {
      if (redeemLink && isLinkCode(token)) {
        const reply = await redeemLink(principal, token, hint);
        return reply === null ? null : { text: reply };
      }
      if (!isTokenShaped(token.trim())) return null;
      const identified = await identify(principal, hint);
      if (!identified.ok) return { text: identified.message };
      const outcome = await resolveConfirmation(token, sessionKey, { ...deps, owner: identified.person.key });
      return confirmReply(outcome, texts.forPerson(identified.person.key, hint).t);
    },
    resolveConfirmation: async (token, sessionKey, principal, hint) => {
      if (!isTokenShaped(token.trim())) return { status: "not-a-token", text: null };
      const identified = await identify(principal, hint);
      const { t } = texts.forPerson(identified.ok ? identified.person.key : undefined, hint);
      if (!identified.ok) return { status: "not-found", text: t("core.confirm.not-found") };
      const outcome = await resolveConfirmation(token, sessionKey, { ...deps, owner: identified.person.key });
      return { ...outcome, text: confirmReply(outcome, t)?.text ?? null };
    },
  };
}
