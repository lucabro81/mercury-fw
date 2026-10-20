/**
 * Linking a second account to a person, by a one-time code: the person asks
 * for it on the account Mercury knows (`start`), then sends it from the other
 * account, twice (`redeem`). The first time Mercury says whom the account
 * would be linked to, the second time links it, so someone handed another
 * person's code sees whose account they'd be joining before anything happens.
 * A code belongs to the first account that sends it, so someone else reading
 * it (in a shared space) can't use it once it's been sent; it's meant for a
 * one-to-one conversation.
 *
 * A code is `xxxx-xxxx-xxxx` (a shape no confirmation token has), valid for ten
 * minutes, single-use, one per owner, and kept in memory: a restart only means
 * asking for a new one. Redeeming works before the core decides whether it
 * talks to the sender, since linking is how someone the directory doesn't know
 * on one channel becomes the person they are on another.
 *
 * Rules: the operator never links or is linked; the owner stored is always an
 * account that isn't linked itself, and an account others are linked to isn't
 * linked in turn (no chains); an account the directory already knows as
 * someone else is never linked.
 */
import type { Principal } from "@mercury-fw/channel-types";
import type { LinkOwner, LinkStore } from "./links.ts";
import { OPERATOR_PRINCIPAL, type People } from "./people.ts";
import { userKey } from "./user-key.ts";
import { DEFAULT_ASSISTANT_NAME } from "../session/assistant-name.ts";
import { englishTexts, type Texts } from "../i18n/i18n.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CODE = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;
export const LINK_CODE_TTL_MS = 10 * 60_000;

/** Whether `text`, trimmed, is shaped like a link code. */
export function isLinkCode(text: string): boolean {
  return CODE.test(text.trim());
}

/** A fresh code: three groups of four from a 62-character alphabet. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

/** `ownerKey` is the person who asked for the code: the replies are in their language. */
type Pending = { owner: LinkOwner; ownerName: string; ownerKey: string; expiresAt: number; redeemedBy?: string };

export function createLinking(deps: {
  people: People;
  links: LinkStore;
  now?: () => number;
  log?: (msg: string) => void;
  /** What the replies call the assistant. */
  assistantName?: string;
  /** The replies' texts (`core.link.*`); English when absent. */
  texts?: Texts;
}) {
  const texts = deps.texts ?? englishTexts();
  /** The language of whoever isn't known, with no code to go by: the channel's hint, else the default. */
  const fallback = (hint?: string) => texts.forPerson(undefined, hint).t;
  const assistantName = deps.assistantName ?? DEFAULT_ASSISTANT_NAME;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const codes = new Map<string, Pending>();

  /** Drops the expired codes. */
  function prune(): void {
    for (const [code, pending] of codes) if (pending.expiresAt <= now()) codes.delete(code);
  }

  return {
    /** A code for linking another account to the person `principal` is. */
    start: async (principal: Principal): Promise<{ ok: true; code: string; expiresAt: string } | { ok: false; error: string }> => {
      if (principal === OPERATOR_PRINCIPAL) return { ok: false, error: fallback()("core.link.terminal") };
      const identified = await deps.people.identify(principal);
      if (!identified.ok) return { ok: false, error: identified.message };
      if (identified.operator) return { ok: false, error: fallback()("core.link.terminal") };
      const owner: LinkOwner = deps.links.ownerOf(userKey(principal)) ?? { id: principal.id, provider: principal.provider };
      prune();
      for (const [code, pending] of codes) if (userKey(pending.owner) === userKey(owner)) codes.delete(code);
      const code = newCode();
      const expiresAt = now() + LINK_CODE_TTL_MS;
      codes.set(code, {
        owner,
        ownerName: identified.person.displayName ?? identified.person.key,
        ownerKey: identified.person.key,
        expiresAt,
      });
      return { ok: true, code, expiresAt: new Date(expiresAt).toISOString() };
    },

    /** The reply to `text` from `principal` when it's a link code, or null when it isn't one; in the language of whoever asked for the code, else the channel's `hint`'s. */
    redeem: async (principal: Principal, text: string, hint?: string): Promise<string | null> => {
      if (!isLinkCode(text)) return null;
      if (principal === OPERATOR_PRINCIPAL || principal.provider === "none") return fallback(hint)("core.link.terminal");
      prune();
      const code = text.trim();
      const pending = codes.get(code);
      if (pending === undefined) return fallback(hint)("core.link.invalid");
      const { t } = texts.forPerson(pending.ownerKey, hint);
      const owner = { owner: pending.ownerName };
      const identity = userKey(principal);
      if (identity === userKey(pending.owner)) return t("core.link.same-account");
      // The owner was linked to someone else after the code was made: linking to it now would chain.
      if (deps.links.ownerOf(userKey(pending.owner)) !== undefined) return t("core.link.invalid");
      // A code belongs to the first account that sends it: someone else who
      // read it (a shared space) can't take the link over.
      if (pending.redeemedBy !== undefined && pending.redeemedBy !== identity) return t("core.link.invalid");
      if (deps.links.owns(identity)) {
        codes.delete(code);
        return t("core.link.has-linked", owner);
      }
      if (pending.redeemedBy !== identity) {
        pending.redeemedBy = identity;
        return t("core.link.confirm", { ...owner, assistant: assistantName });
      }
      codes.delete(code);

      const [alone, ownerAlone] = await Promise.all([
        deps.people.identifyUnlinked(principal),
        deps.people.identifyUnlinked({ id: pending.owner.id, provider: pending.owner.provider }),
      ]);
      if (!alone.ok && alone.reason === "unavailable") return t("core.link.cant-check");
      if (alone.ok && alone.person.key !== identity && (!ownerAlone.ok || alone.person.key !== ownerAlone.person.key)) {
        return t("core.link.someone-else", owner);
      }

      // Others may have been linked to this account since its first send.
      if (deps.links.owns(identity)) return t("core.link.has-linked", owner);
      try {
        deps.links.link(identity, pending.owner);
      } catch (err) {
        log(`[identity] couldn't link ${identity}: ${err instanceof Error ? err.message : String(err)}`);
        return t("core.link.failed");
      }
      deps.people.forget(principal);
      log(`[identity] linked ${identity} to ${userKey(pending.owner)}`);
      return t("core.link.done", owner);
    },
  };
}

export type Linking = ReturnType<typeof createLinking>;
