/**
 * ZITADEL as the user directory: people are ZITADEL users, their roles the
 * project's roles (`ZITADEL_PROJECT_ID`), read through the `zitadel` CLI as its
 * service user, from code and never from the model. A role granted or revoked
 * in ZITADEL's console decides what the person may make Mercury do.
 *
 * An OIDC subject is the user it names (the app's `auth-oidc` points at this
 * ZITADEL). A Google Chat sender is the one active user with the sender's
 * email, verified, whose links to the Google identity provider
 * (`ZITADEL_GOOGLE_IDP_ID`) hold that very Google account (Chat's
 * `users/<id>` is the id ZITADEL stores for the link): the email alone is the
 * sender saying who they are, the link is ZITADEL confirming it. Anything short
 * of that, and any other channel identity, is unknown; any CLI failure but a
 * user ZITADEL doesn't find throws, so the core refuses rather than guess.
 */
import type { DirectoryPerson, DirectoryPlugin } from "@mercury-fw/channel-types";
import { runCli } from "@mercury-fw/cli-engine";

const PROJECT_ENV = "ZITADEL_PROJECT_ID";
const GOOGLE_IDP_ENV = "ZITADEL_GOOGLE_IDP_ID";

/** A ZITADEL user id: digits only, so it's one argument that can't read as a flag. */
const USER_ID = /^\d{1,32}$/;

type User = {
  state?: string;
  username?: string;
  human?: { profile?: { displayName?: string }; email?: { email?: string; isVerified?: boolean } };
};
type UserGet = { user?: User };
type UserSearch = { result?: Array<User & { userId?: string }> };
type IdpLinks = { result?: Array<{ idpId?: string; userId?: string }> };

/** An email that is one argument and can't read as a flag. */
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+$/;
type Authorizations = { authorizations?: Array<{ state?: string; roles?: Array<{ key?: string }> }> };

/** Builds the directory. `runCliFn` is injectable for tests; the default spawns the real binary. */
export function createZitadelDirectory(deps: { runCliFn?: typeof runCli } = {}): DirectoryPlugin {
  const runCliFn = deps.runCliFn ?? runCli;
  return {
    // The contract this directory is written for, as a literal: importing
    // DIRECTORY_API_VERSION would report whichever contract is installed.
    apiVersion: 1,
    name: "zitadel",
    build: (ctx) => {
      const configured = ctx.env[PROJECT_ENV]?.trim();
      if (!configured) throw new Error(`${PROJECT_ENV} is not set: the ZITADEL project whose roles count`);
      const projectId: string = configured;
      // The identity provider whose links confirm a Chat sender: Google's, as ZITADEL names it. Without it, nobody is joined from Chat.
      const googleIdpId = ctx.env[GOOGLE_IDP_ENV]?.trim() || undefined;

      /** `args` run as the service user; throws naming the command when it fails or prints no JSON. */
      async function read(command: string, args: string[]): Promise<object> {
        const result = await runCliFn("zitadel", ["user", command, ...args]);
        if (!result.ok) throw new Error(`zitadel user ${command} failed: ${result.error}`);
        if (typeof result.data !== "object" || result.data === null) throw new Error(`zitadel user ${command} printed no JSON`);
        return result.data;
      }

      /** The role keys of `id`'s active role assignments on the project. */
      async function rolesOf(id: string): Promise<string[]> {
        const granted = (await read("authorizations", [
          id,
          "--project-id",
          projectId,
          "--state",
          "active",
          "--select",
          "authorizations.roles.key,authorizations.state",
        ])) as Authorizations;
        // One project: a person has one role assignment on it, well within the CLI's page of 100.
        return [
          ...new Set(
            (granted.authorizations ?? [])
              .filter((a) => a.state === "STATE_ACTIVE")
              .flatMap((a) => (a.roles ?? []).map((r) => r.key).filter((k): k is string => typeof k === "string")),
          ),
        ];
      }

      /** The person `id` is, from what ZITADEL says about the user, with their roles. */
      async function personOf(id: string, user: User): Promise<DirectoryPerson> {
        const roles = await rolesOf(id);
        const displayName = user.human?.profile?.displayName ?? user.username;
        const email = user.human?.email?.isVerified === true ? user.human.email.email : undefined;
        return {
          id,
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
          roles,
        };
      }

      /** An OIDC subject: the user it names. */
      async function bySubject(id: string): Promise<DirectoryPerson | null> {
        const got = await runCliFn("zitadel", [
          "user",
          "get",
          id,
          "--select",
          "user.state,user.username,user.human.profile.displayName,user.human.email.email,user.human.email.isVerified",
        ]);
        if (!got.ok) {
          if (/no such resource \(404\)/.test(got.error)) return null;
          throw new Error(`zitadel user get failed: ${got.error}`);
        }
        const user = typeof got.data === "object" && got.data !== null ? (got.data as UserGet).user : undefined;
        if (user === undefined) throw new Error("zitadel user get printed no user");
        if (user.state !== "USER_STATE_ACTIVE") return null;
        return personOf(id, user);
      }

      /** A Google Chat sender: the one active user with their email, verified, whose IdP links hold that Google account. */
      async function byChatSender(email: string, googleId: string): Promise<DirectoryPerson | null> {
        const found = (await read("search", [
          "--email-exact",
          email,
          "--select",
          "result.userId,result.username,result.state,result.human.profile.displayName,result.human.email.email,result.human.email.isVerified",
        ])) as UserSearch;
        const users = found.result ?? [];
        if (users.length !== 1) return null;
        const [user] = users as [User & { userId?: string }];
        if (typeof user.userId !== "string" || !USER_ID.test(user.userId)) return null;
        if (user.state !== "USER_STATE_ACTIVE") return null;
        if (user.human?.email?.isVerified !== true || user.human.email.email?.toLowerCase() !== email.toLowerCase()) return null;
        const links = (await read("idp-links", [user.userId, "--select", "result.idpId,result.userId"])) as IdpLinks;
        if (!(links.result ?? []).some((link) => link.idpId === googleIdpId && link.userId === googleId)) return null;
        return personOf(user.userId, user);
      }

      return {
        resolve: async (principal): Promise<DirectoryPerson | null> => {
          if (principal.provider === "oidc") return USER_ID.test(principal.id) ? bySubject(principal.id) : null;
          if (principal.provider === "google-chat") {
            const email = principal.claims?.email;
            const googleId = /^users\/(\d{1,32})$/.exec(principal.id)?.[1];
            if (googleIdpId === undefined || typeof email !== "string" || !EMAIL.test(email) || googleId === undefined) return null;
            return byChatSender(email, googleId);
          }
          return null;
        },
      };
    },
  };
}

export const zitadelDirectory: DirectoryPlugin = createZitadelDirectory();
