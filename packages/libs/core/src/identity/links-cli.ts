#!/usr/bin/env bun
/**
 * Maintenance CLI for the account links — runs INSIDE the Mercury container
 * (the links live on the vault's volume): `mfw identity` runs it in a one-off
 * container, by this path. For the operator: listing the links, linking an
 * account by hand where nobody can be shown a code (an instance with no HTTP
 * surface), and undoing a link.
 *
 * It applies the rules linking by code does that it can check on its own (no
 * terminal, no account to itself, no chains), not the directory's: the
 * operator decides. The running service rereads the file, and applies a change
 * once its answer for that identity expires (five minutes at most).
 */
import { createLinkStore, linksPath, type LinkOwner, type LinkStore } from "./links.ts";

const USAGE = [
  "Usage: mfw identity <command>",
  "",
  "Commands:",
  "  links                              the linked accounts",
  "  link <identity> <owner identity>   link an account to another, e.g. link google-chat:users/123 oidc:3123",
  "  unlink <identity>                  undo an account's link",
].join("\n");

/** `<provider>:<id>` split at its first colon, or undefined when it isn't one. */
function parseIdentity(text: string): LinkOwner | undefined {
  const colon = text.indexOf(":");
  if (colon <= 0 || colon === text.length - 1) return undefined;
  return { provider: text.slice(0, colon) as LinkOwner["provider"], id: text.slice(colon + 1) };
}

/** Runs one command over `store`; returns the exit code. */
export function runLinksCli(argv: string[], io: { store: LinkStore; out: (line: string) => void; err: (line: string) => void }): number {
  const { store, out, err } = io;
  const [command, ...args] = argv;
  if (command === "links" && args.length === 0) {
    const links = store.list();
    if (links.length === 0) out("No accounts are linked.");
    for (const link of links) out(`${link.identity} -> ${link.owner.provider}:${link.owner.id} (since ${link.linkedAt})`);
    return 0;
  }
  if (command === "link" && args.length === 2) {
    const [identity, ownerText] = args as [string, string];
    for (const text of [identity, ownerText]) {
      if (parseIdentity(text) === undefined) {
        err(`"${text}" isn't an identity: write it as <provider>:<id>, e.g. static:alice`);
        return 1;
      }
    }
    const owner = parseIdentity(ownerText)!;
    if (identity.startsWith("none:") || owner.provider === "none") {
      err("The terminal is never linked.");
      return 1;
    }
    if (identity === ownerText) {
      err("An account can't be linked to itself.");
      return 1;
    }
    const ownersOwner = store.ownerOf(ownerText);
    if (ownersOwner !== undefined) {
      const root = `${ownersOwner.provider}:${ownersOwner.id}`;
      err(`${ownerText} is itself linked to ${root}: link ${identity} to ${root} instead.`);
      return 1;
    }
    store.link(identity, owner);
    out(`Linked ${identity} to ${ownerText}. The running service applies it within five minutes (at once for an identity it hasn't seen yet).`);
    return 0;
  }
  if (command === "unlink" && args.length === 1) {
    const [identity] = args as [string];
    if (!store.unlink(identity)) {
      err(`${identity} isn't linked.`);
      return 1;
    }
    out(`Unlinked ${identity}. The running service applies it within five minutes.`);
    return 0;
  }
  err(USAGE);
  return 1;
}

if (import.meta.main) {
  const vaultPath = process.env.WIKI_VAULT_PATH;
  if (!vaultPath) {
    console.error("WIKI_VAULT_PATH is not set");
    process.exit(1);
  }
  const store = createLinkStore({ path: linksPath(vaultPath) });
  process.exit(runLinksCli(process.argv.slice(2), { store, out: (l) => console.log(l), err: (l) => console.error(l) }));
}
