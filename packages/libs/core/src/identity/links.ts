/**
 * The account links Mercury owns: a channel identity (`<provider>:<id>`) that
 * belongs to the person another principal is, because they proved they hold
 * both (see `linking.ts`) or the operator said so (`mfw identity link`).
 *
 * Kept in one JSON file on the vault's volume, outside every path the model and
 * the HTTP reads can reach and out of the vault's git (see `vault-init.ts`),
 * written whole and atomically. The file is reread whenever it changed on
 * disk, so a change made from another process (`mfw identity`) reaches the
 * running service. An unreadable file applies no link: each identity is then
 * on its own, which never gives anyone more than they had.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Principal } from "@mercury-fw/channel-types";

/** Where the account links live on the vault's volume (`vault-init.ts` keeps `.mercury/` out of its git). */
export function linksPath(vaultPath: string): string {
  return resolve(vaultPath, ".mercury", "identity-links.json");
}

/** Who an identity belongs to: the owner's principal, as the core identifies it. */
export type LinkOwner = Pick<Principal, "id" | "provider">;

type Link = { owner: LinkOwner; linkedAt: string };
type LinkFile = { version: 1; links: Record<string, Link> };

export type LinkStore = {
  /** The owner of `identity`, or undefined when it isn't linked. */
  ownerOf: (identity: string) => LinkOwner | undefined;
  /** Links `identity` to `owner`, moving it when it was linked to someone else. */
  link: (identity: string, owner: LinkOwner) => void;
  /** Whether other accounts are linked to `identity`. */
  owns: (identity: string) => boolean;
  /** Removes `identity`'s link; false when it had none. */
  unlink: (identity: string) => boolean;
  list: () => Array<{ identity: string; owner: LinkOwner; linkedAt: string }>;
};

export function createLinkStore(opts: { path: string; now?: () => Date; log?: (msg: string) => void }): LinkStore {
  const { path } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((msg: string) => console.error(msg));
  let links = new Map<string, Link>();
  /** The file's mtime and size when it was last read or written; undefined when there was none. */
  let seen: string | undefined;
  /** Whether the file was there but couldn't be read: then nothing is written over it. */
  let unreadable = false;

  /** The file's mtime and size, or undefined when it doesn't exist. */
  function mtime(): string | undefined {
    try {
      const st = statSync(path);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  /** Rereads the file when it changed since it was last seen. */
  function fresh(): void {
    const current = mtime();
    if (current === seen) return;
    seen = current;
    unreadable = false;
    if (current === undefined) {
      links = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LinkFile>;
      links = new Map();
      for (const [identity, link] of Object.entries(parsed.links ?? {})) {
        const owner = (link as Partial<Link> | undefined)?.owner as Partial<LinkOwner> | undefined;
        if (typeof owner?.id !== "string" || typeof owner.provider !== "string") {
          log(`[identity] skipped a malformed account link in ${path}: ${identity}`);
          continue;
        }
        links.set(identity, { owner: { id: owner.id, provider: owner.provider }, linkedAt: String((link as Link).linkedAt ?? "") });
      }
    } catch (err) {
      log(`[identity] can't read the account links in ${path}, none applied: ${err instanceof SyntaxError ? "not JSON" : String(err)}`);
      links = new Map();
      unreadable = true;
    }
  }

  /** Throws when the file is there but couldn't be read, rather than write over what it holds. */
  function refuseUnreadable(): void {
    if (unreadable) throw new Error(`the account links in ${path} can't be read: fix or remove the file first`);
  }

  /** Writes every link, whole, through a temporary file renamed over the old one. */
  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    const file: LinkFile = { version: 1, links: Object.fromEntries(links) };
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, path);
    seen = mtime();
  }

  return {
    ownerOf: (identity) => {
      fresh();
      return links.get(identity)?.owner;
    },
    link: (identity, owner) => {
      fresh();
      refuseUnreadable();
      links.set(identity, { owner: { id: owner.id, provider: owner.provider }, linkedAt: now().toISOString() });
      save();
    },
    owns: (identity) => {
      fresh();
      return [...links.values()].some((link) => `${link.owner.provider}:${link.owner.id}` === identity);
    },
    unlink: (identity) => {
      fresh();
      refuseUnreadable();
      if (!links.delete(identity)) return false;
      save();
      return true;
    },
    list: () => {
      fresh();
      return [...links].map(([identity, link]) => ({ identity, owner: link.owner, linkedAt: link.linkedAt }));
    },
  };
}
