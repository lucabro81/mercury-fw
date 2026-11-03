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
 * one they saved, else the channel's hint, else the default). A token that
 * resolved leaves the reply in the archive, with how it went (#370), for
 * whoever the core tracks: never the operator.
 */
import type { ChannelRuntimeContext, ConfirmOutcome, ConfirmReply } from "@mercury-fw/channel-types";
import { isTokenShaped, resolveConfirmation, type ConfirmDeps, type ResolvedAction } from "@mercury-fw/confirm-engine";
import type { VerbatimExchange } from "../memory/memory-provider.ts";
import { confirmationId } from "../session/turn-trace.ts";
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

/**
 * `confirm` and `resolveConfirmation` over `deps`, each resolving as the person
 * `identify` says the caller is, replying in their language (`texts`, English
 * when absent), and archiving how a resolved token went through `archive`
 * (the verbatim archive's capture), when given.
 */
export function bindConfirm(
  deps: Omit<ConfirmDeps, "owner">,
  identify: People["identify"] = createPeople({ directory: "none" }).identify,
  redeemLink?: Linking["redeem"],
  texts: Texts = englishTexts(),
  archive?: (exchange: VerbatimExchange) => Promise<void>,
): Required<Pick<ChannelRuntimeContext, "confirm" | "resolveConfirmation">> {
  /**
   * Resolves `token` for the person `key` and, once it resolved, archives the
   * reply the person gets (`replyOf`; none when the turn resumes instead).
   * Fail-soft: the archive is enrichment, the reply stands regardless.
   */
  async function resolveFor(
    token: string,
    sessionKey: string,
    key: string,
    tracked: boolean,
    replyOf: (outcome: Awaited<ReturnType<typeof resolveConfirmation>>) => string,
  ) {
    let resolved: ResolvedAction | undefined;
    const outcome = await resolveConfirmation(token, sessionKey, { ...deps, owner: key, onResolved: (action) => (resolved = action) });
    if (archive && tracked && resolved !== undefined) {
      try {
        await archive({
          sessionKey,
          userId: key,
          role: "assistant",
          content: resolved.status === "resume" ? "" : replyOf(outcome),
          confirmation: {
            id: confirmationId(resolved.token),
            status: resolved.status,
            ...(resolved.label === undefined ? {} : { choice: resolved.label }),
          },
        });
      } catch (err) {
        console.log(`[verbatim-archive] capture failed, confirmation unaffected: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    return outcome;
  }

  return {
    confirm: async (token, sessionKey, principal, hint) => {
      if (redeemLink && isLinkCode(token)) {
        const reply = await redeemLink(principal, token, hint);
        return reply === null ? null : { text: reply };
      }
      if (!isTokenShaped(token.trim())) return null;
      const identified = await identify(principal, hint);
      if (!identified.ok) return { text: identified.message };
      const { t } = texts.forPerson(identified.person.key, hint);
      const outcome = await resolveFor(token, sessionKey, identified.person.key, !identified.operator, (o) => confirmReply(o, t)?.text ?? "");
      return confirmReply(outcome, t);
    },
    resolveConfirmation: async (token, sessionKey, principal, hint) => {
      if (!isTokenShaped(token.trim())) return { status: "not-a-token", text: null };
      const identified = await identify(principal, hint);
      const { t } = texts.forPerson(identified.ok ? identified.person.key : undefined, hint);
      if (!identified.ok) return { status: "not-found", text: t("core.confirm.not-found") };
      const outcome = await resolveFor(token, sessionKey, identified.person.key, !identified.operator, (o) => confirmReply(o, t)?.text ?? "");
      return { ...outcome, text: confirmReply(outcome, t)?.text ?? null };
    },
  };
}
