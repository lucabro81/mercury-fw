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

const INVALID = "That code isn't valid: it may have expired or been used already. Ask for a new one on the account you want to link to.";
const TERMINAL = "The terminal can't link accounts.";

type Pending = { owner: LinkOwner; ownerName: string; expiresAt: number; redeemedBy?: string };

export function createLinking(deps: { people: People; links: LinkStore; now?: () => number; log?: (msg: string) => void }) {
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
      if (principal === OPERATOR_PRINCIPAL) return { ok: false, error: TERMINAL };
      const identified = await deps.people.identify(principal);
      if (!identified.ok) return { ok: false, error: identified.message };
      if (identified.operator) return { ok: false, error: TERMINAL };
      const owner: LinkOwner = deps.links.ownerOf(userKey(principal)) ?? { id: principal.id, provider: principal.provider };
      prune();
      for (const [code, pending] of codes) if (userKey(pending.owner) === userKey(owner)) codes.delete(code);
      const code = newCode();
      const expiresAt = now() + LINK_CODE_TTL_MS;
      codes.set(code, { owner, ownerName: identified.person.displayName ?? identified.person.key, expiresAt });
      return { ok: true, code, expiresAt: new Date(expiresAt).toISOString() };
    },

    /** The reply to `text` from `principal` when it's a link code, or null when it isn't one. */
    redeem: async (principal: Principal, text: string): Promise<string | null> => {
      if (!isLinkCode(text)) return null;
      if (principal === OPERATOR_PRINCIPAL || principal.provider === "none") return TERMINAL;
      prune();
      const code = text.trim();
      const pending = codes.get(code);
      if (pending === undefined) return INVALID;
      const identity = userKey(principal);
      if (identity === userKey(pending.owner)) return "That code is for linking another account to this one.";
      // The owner was linked to someone else after the code was made: linking to it now would chain.
      if (deps.links.ownerOf(userKey(pending.owner)) !== undefined) return INVALID;
      // A code belongs to the first account that sends it: someone else who
      // read it (a shared space) can't take the link over.
      if (pending.redeemedBy !== undefined && pending.redeemedBy !== identity) return INVALID;
      if (deps.links.owns(identity)) {
        codes.delete(code);
        return `Other accounts are linked to this one: unlink them first, or link them to ${pending.ownerName} directly.`;
      }
      if (pending.redeemedBy !== identity) {
        pending.redeemedBy = identity;
        return `This will link this account to ${pending.ownerName}: from then on Mercury treats them as one person, with ${pending.ownerName}'s private area and roles. Send the same code again to confirm.`;
      }
      codes.delete(code);

      const [alone, owner] = await Promise.all([
        deps.people.identifyUnlinked(principal),
        deps.people.identifyUnlinked({ id: pending.owner.id, provider: pending.owner.provider }),
      ]);
      if (!alone.ok && alone.reason === "unavailable") return "I can't check this account right now. Ask for a new code and try again in a few minutes.";
      if (alone.ok && alone.person.key !== identity && (!owner.ok || alone.person.key !== owner.person.key)) {
        return `This account belongs to someone else in the directory: it can't be linked to ${pending.ownerName}.`;
      }

      try {
        deps.links.link(identity, pending.owner);
      } catch (err) {
        log(`[identity] couldn't link ${identity}: ${err instanceof Error ? err.message : String(err)}`);
        return "I can't link accounts right now. Ask whoever runs this assistant to check its logs.";
      }
      deps.people.forget(principal);
      log(`[identity] linked ${identity} to ${userKey(pending.owner)}`);
      return `Linked: this account is now ${pending.ownerName}.`;
    },
  };
}

export type Linking = ReturnType<typeof createLinking>;
