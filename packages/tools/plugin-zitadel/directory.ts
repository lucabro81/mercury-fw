/**
 * ZITADEL as the user directory: people are ZITADEL users, their roles the
 * project's roles (`ZITADEL_PROJECT_ID`), read through the `zitadel` CLI as its
 * service user, from code and never from the model. A role granted or revoked
 * in ZITADEL's console decides what the person may make Mercury do.
 *
 * Only an OIDC subject is resolved (the app's `auth-oidc` points at this
 * ZITADEL, so the subject is the user's id); any other channel identity is
 * unknown until chat identities are joined to ZITADEL users. A user ZITADEL
 * doesn't find, or one that isn't active, is unknown; any other CLI failure
 * throws, so the core refuses rather than guess.
 */
import type { DirectoryPerson, DirectoryPlugin } from "@mercury-fw/channel-types";
import { runCli } from "@mercury-fw/cli-engine";

const PROJECT_ENV = "ZITADEL_PROJECT_ID";

/** A ZITADEL user id: digits only, so it's one argument that can't read as a flag. */
const USER_ID = /^\d{1,32}$/;

type UserGet = {
  user?: {
    state?: string;
    username?: string;
    human?: { profile?: { displayName?: string }; email?: { email?: string; isVerified?: boolean } };
  };
};
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
      const projectId = ctx.env[PROJECT_ENV]?.trim();
      if (!projectId) throw new Error(`${PROJECT_ENV} is not set: the ZITADEL project whose roles count`);

      return {
        resolve: async (principal): Promise<DirectoryPerson | null> => {
          if (principal.provider !== "oidc" || !USER_ID.test(principal.id)) return null;
          const id = principal.id;

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
          const user = (typeof got.data === "object" && got.data !== null ? (got.data as UserGet).user : undefined);
          if (user === undefined) throw new Error("zitadel user get printed no user");
          if (user.state !== "USER_STATE_ACTIVE") return null;

          const granted = await runCliFn("zitadel", [
            "user",
            "authorizations",
            id,
            "--project-id",
            projectId,
            "--state",
            "active",
            "--select",
            "authorizations.roles.key,authorizations.state",
          ]);
          if (!granted.ok) throw new Error(`zitadel user authorizations failed: ${granted.error}`);
          if (typeof granted.data !== "object" || granted.data === null) throw new Error("zitadel user authorizations printed no JSON");
          // One project: a person has one role assignment on it, well within the CLI's page of 100.
          const authorizations = (granted.data as Authorizations).authorizations ?? [];
          const roles = [
            ...new Set(
              authorizations
                .filter((a) => a.state === "STATE_ACTIVE")
                .flatMap((a) => (a.roles ?? []).map((r) => r.key).filter((k): k is string => typeof k === "string")),
            ),
          ];

          const displayName = user.human?.profile?.displayName ?? user.username;
          const email = user.human?.email?.isVerified === true ? user.human.email.email : undefined;
          return {
            id,
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            roles,
          };
        },
      };
    },
  };
}

export const zitadelDirectory: DirectoryPlugin = createZitadelDirectory();
